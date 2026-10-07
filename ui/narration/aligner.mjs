// Extracted from Tuba src/narration/aligner.ts; pure algorithms only.
import { ALIGNER_VERSION, } from "./constants.mjs";
/**
 * Local forced alignment of a generated paragraph WAV with its known speech
 * slice (doc §10). The model behind `AlignmentModelPort` is ONNX wav2vec2
 * (Persian); this module owns everything else: WAV parsing, resampling,
 * transcript mapping, the CTC forced-alignment DP, and the §10.4 validation.
 * Pure and deterministic — the model port is injected so tests can drive
 * synthetic emissions.
 */
export class NarrationAlignmentError extends Error {
    code;
    name = "NarrationAlignmentError";
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
export function parseWavPcm(buffer) {
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    if (buffer.byteLength < 44)
        throw new NarrationAlignmentError("NARRATION_AUDIO_INVALID", "wav too small");
    const riff = String.fromCharCode(buffer[0], buffer[1], buffer[2], buffer[3]);
    const wave = String.fromCharCode(buffer[8], buffer[9], buffer[10], buffer[11]);
    if (riff !== "RIFF" || wave !== "WAVE")
        throw new NarrationAlignmentError("NARRATION_AUDIO_INVALID", "not RIFF/WAVE");
    let fmt = null;
    let dataOffset = -1;
    let dataLength = 0;
    let offset = 12;
    while (offset + 8 <= buffer.byteLength) {
        const id = String.fromCharCode(buffer[offset], buffer[offset + 1], buffer[offset + 2], buffer[offset + 3]);
        const size = view.getUint32(offset + 4, true);
        if (id === "fmt ") {
            fmt = {
                audioFormat: view.getUint16(offset + 8, true),
                channels: view.getUint16(offset + 10, true),
                sampleRate: view.getUint32(offset + 12, true),
                bitsPerSample: view.getUint16(offset + 22, true),
            };
        }
        else if (id === "data") {
            dataOffset = offset + 8;
            dataLength = Math.min(size, buffer.byteLength - dataOffset);
            break;
        }
        offset += 8 + size + (size % 2);
    }
    if (!fmt || dataOffset < 0)
        throw new NarrationAlignmentError("NARRATION_AUDIO_INVALID", "missing fmt/data chunk");
    const isPcm = fmt.audioFormat === 1;
    const isFloat = fmt.audioFormat === 3;
    if (!isPcm && !isFloat)
        throw new NarrationAlignmentError("NARRATION_AUDIO_INVALID", `unsupported audio format ${fmt.audioFormat}`);
    if (fmt.channels < 1 || fmt.channels > 2)
        throw new NarrationAlignmentError("NARRATION_AUDIO_INVALID", `unsupported channel count ${fmt.channels}`);
    if (!isFloat && fmt.bitsPerSample !== 16 && fmt.bitsPerSample !== 8) {
        throw new NarrationAlignmentError("NARRATION_AUDIO_INVALID", `unsupported PCM bit width ${fmt.bitsPerSample}`);
    }
    const bytesPerSample = fmt.bitsPerSample / 8;
    const frameTotal = Math.floor(dataLength / (bytesPerSample * fmt.channels));
    if (frameTotal <= 0)
        throw new NarrationAlignmentError("NARRATION_AUDIO_INVALID", "empty audio data");
    const samples = new Float32Array(frameTotal);
    for (let i = 0; i < frameTotal; i += 1) {
        let acc = 0;
        for (let c = 0; c < fmt.channels; c += 1) {
            const p = dataOffset + (i * fmt.channels + c) * bytesPerSample;
            if (isFloat)
                acc += view.getFloat32(p, true);
            else if (fmt.bitsPerSample === 16)
                acc += view.getInt16(p, true) / 32768;
            else
                acc += (view.getUint8(p) - 128) / 128;
        }
        samples[i] = acc / fmt.channels;
    }
    return { sampleRate: fmt.sampleRate, channels: fmt.channels, bitsPerSample: fmt.bitsPerSample, samples, durationMs: (frameTotal * 1000) / fmt.sampleRate };
}
/** Windowed-sinc (Hann) lowpass resampler; sine-sweep tested (§10.1). */
export function resampleTo16k(samples, fromRate, toRate = 16000) {
    if (fromRate === toRate)
        return samples;
    const ratio = toRate / fromRate;
    const outputLength = Math.max(1, Math.round(samples.length * ratio));
    const out = new Float32Array(outputLength);
    const cutoff = (0.9 * Math.min(fromRate, toRate)) / 2 / fromRate;
    const taps = 61;
    const half = (taps - 1) / 2;
    const step = 1 / ratio;
    // The TTS provider emits 24 kHz PCM. At 24 -> 16 kHz, source positions
    // alternate between integer and half-integer samples, so the 61 filter
    // weights have only two phases. Reuse those weights instead of evaluating
    // sine and cosine millions of times for every paragraph WAV.
    const commonRate = fromRate === 24000 && toRate === 16000;
    const phaseWeights = commonRate ? [0, 0.5].map((phase) => {
        const weights = new Float64Array(taps);
        for (let offset = 0; offset < taps; offset += 1) {
            const x = phase + half - offset;
            const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
            const window = 0.5 * (1 - Math.cos((2 * Math.PI * (x + half)) / taps));
            weights[offset] = sinc * window;
        }
        return weights;
    }) : null;
    for (let j = 0; j < outputLength; j += 1) {
        const t = j * step;
        const i0 = Math.floor(t);
        let acc = 0;
        for (let offset = 0; offset < taps; offset += 1) {
            const k = i0 - half + offset;
            if (k < 0 || k >= samples.length)
                continue;
            if (phaseWeights) {
                acc += samples[k] * phaseWeights[j & 1][offset];
                continue;
            }
            const x = t - k;
            // Ideal-lowpass windowed-sinc kernel: h(x) = sin(2π·fc·x)/(π·x),
            // center value 2·fc (§10.1).
            const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
            // Hann window peaking at the filter center (x = 0).
            const window = 0.5 * (1 - Math.cos((2 * Math.PI * (x + half)) / taps));
            acc += samples[k] * sinc * window;
        }
        out[j] = acc;
    }
    return out;
}
/** Wav2Vec2 feature-extractor normalization: zero mean, unit variance. */
export function normalizeUtterance(samples) {
    let mean = 0;
    for (let i = 0; i < samples.length; i += 1)
        mean += samples[i];
    mean /= samples.length;
    let variance = 0;
    for (let i = 0; i < samples.length; i += 1) {
        const d = samples[i] - mean;
        variance += d * d;
    }
    variance /= Math.max(1, samples.length - 1);
    const std = Math.sqrt(variance) || 1;
    const out = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i += 1)
        out[i] = (samples[i] - mean) / std;
    return out;
}
// ---------------------------------------------------------------------------
// Transcript mapping (§10.2): versioned fixed-order table, canonical spans
// ---------------------------------------------------------------------------
export const TRANSCRIPT_MAP_VERSION = "tuba-fa-transcript-v1";
/** jonatasgrosman/wav2vec2-large-xlsr-53-persian output vocabulary. */
export const ALIGNMENT_VOCAB = {
    "<pad>": 0, "<s>": 1, "</s>": 2, "<unk>": 3, "|": 4, "٬": 5, "و": 6, "ـ": 7, "ئ": 8, "ل": 9,
    "ج": 10, "ک": 11, "R": 12, "ِ": 13, "ع": 14, "َ": 15, "م": 16, "ض": 17, "-": 18, "I": 19,
    "F": 20, "ذ": 21, "ن": 22, "ژ": 23, "A": 24, "ش": 25, "ث": 26, "Y": 27, "د": 28, "ر": 29,
    "ّ": 30, "أ": 31, "ق": 32, "ب": 33, "ح": 34, "ظ": 35, "پ": 36, "ت": 37, "خ": 38, "غ": 39,
    "ط": 40, "ك": 41, "ي": 42, "E": 43, "Ā": 44, "؛": 45, "ی": 46, "چ": 47, "ه": 48, "M": 49,
    "ف": 50, "آ": 51, "ز": 52, "ص": 53, "س": 54, "گ": 55, "N": 56, "ُ": 57, "T": 58, "S": 59,
    "Š": 60, "ٔ": 61, "B": 62, "ء": 63, "ً": 64, "ا": 65, "ى": 66,
};
const BLANK_ID = 0;
const DIACRITICS = new Set(["\u064B", "\u064C", "\u064D", "\u064E", "\u064F", "\u0650", "\u0651", "\u0652", "\u0670"]);
const SKIP_CHARS = new Set(["\u0640", "\u200C", "\u200F", "\u200E", "\uFEFF"]);
const PAUSE_CHARS = new Set([".", "!", "?", "؟", "…", "،", ",", ":", "؛", ";", "٬", "-", "–", "—"]);
const SILENT_CHARS = new Set(["«", "»", "\"", "'", "(", ")", "[", "]", "{", "}", "*", "#", "+", "=", "/", "\\", "_"]);
const PERSIAN_ONES = ["صفر", "یک", "دو", "سه", "چهار", "پنج", "شش", "هفت", "هشت", "نه"];
const PERSIAN_TEENS = ["ده", "یازده", "دوازده", "سیزده", "چهارده", "پانزده", "شانزده", "هفده", "هجده", "نوزده"];
const PERSIAN_TENS = ["", "", "بیست", "سی", "چهل", "پنجاه", "شصت", "هفتاد", "هشتاد", "نود"];
const PERSIAN_HUNDREDS = ["", "صد", "دویست", "سیصد", "چهارصد", "پانصد", "ششصد", "هفتصد", "هشتصد", "نهصد"];
function intToPersianWords(n) {
    if (!Number.isInteger(n) || n < 0 || n > 999_999_999)
        throw new NarrationAlignmentError("NARRATION_ALIGNMENT_FAILED", "number outside the mapping table");
    if (n === 0)
        return PERSIAN_ONES[0];
    const parts = [];
    const millions = Math.floor(n / 1_000_000);
    const thousands = Math.floor((n % 1_000_000) / 1000);
    const rest = n % 1000;
    if (millions > 0)
        parts.push(millions === 1 ? "میلیون" : `${intToPersianWords(millions)} میلیون`);
    if (thousands > 0)
        parts.push(thousands === 1 ? "هزار" : `${intToPersianWords(thousands)} هزار`);
    const hundreds = Math.floor(rest / 100);
    const tensUnits = rest % 100;
    if (hundreds > 0)
        parts.push(PERSIAN_HUNDREDS[hundreds]);
    if (tensUnits >= 10 && tensUnits < 20)
        parts.push(PERSIAN_TEENS[tensUnits - 10]);
    else {
        const tens = Math.floor(tensUnits / 10);
        const ones = tensUnits % 10;
        if (tens > 0)
            parts.push(PERSIAN_TENS[tens]);
        if (ones > 0)
            parts.push(PERSIAN_ONES[ones]);
    }
    return parts.join(" و ");
}
const LATIN_LETTER_NAMES = {
    a: "ای", b: "بی", c: "سی", d: "دی", e: "ای", f: "اف", g: "گی", h: "اچ", i: "آی", j: "جی",
    k: "کی", l: "ال", m: "ام", n: "ان", o: "او", p: "پی", q: "کیو", r: "ار", s: "اس", t: "تی",
    u: "یو", v: "وی", w: "دبلیو", x: "اکس", y: "وای", z: "زد",
};
const NORMALIZE_CHAR = { "ي": "ی", "ك": "ک", "ى": "ی" };
function sentenceIndexFor(spans, position) {
    for (let i = 0; i < spans.length; i += 1) {
        if (position >= spans[i].start && position < spans[i].end)
            return i;
    }
    return spans.length - 1;
}
/** Map speech-slice text to vocab tokens with canonical spans (§10.2). */
export function buildAlignmentTranscript(text, spans) {
    const tokens = [];
    const stats = { mappedChars: 0, unmappableChars: 0, unmappableSamples: [] };
    const pushLetter = (ch, spanStart, spanEnd, sentenceIndex) => {
        const id = ALIGNMENT_VOCAB[ch];
        if (id === undefined)
            throw new NarrationAlignmentError("NARRATION_ALIGNMENT_FAILED", `letter not in vocab: ${ch}`);
        tokens.push({ id, token: ch, spanStart, spanEnd, sentenceIndex });
    };
    const pushSeparator = (spanStart, spanEnd, sentenceIndex) => {
        tokens.push({ id: ALIGNMENT_VOCAB["|"], token: "|", spanStart, spanEnd, sentenceIndex });
    };
    let i = 0;
    let sawBreakSinceWord = true;
    while (i < text.length) {
        const cp = text.codePointAt(i);
        const width = cp > 0xffff ? 2 : 1;
        const ch = String.fromCodePoint(cp);
        const sentenceIndex = sentenceIndexFor(spans, i);
        if (DIACRITICS.has(ch) || SKIP_CHARS.has(ch)) {
            i += width;
            continue;
        }
        if (/\s/u.test(ch) || PAUSE_CHARS.has(ch)) {
            if (!sawBreakSinceWord) {
                pushSeparator(i, i + width, sentenceIndex);
                sawBreakSinceWord = true;
            }
            i += width;
            continue;
        }
        if (SILENT_CHARS.has(ch)) {
            i += width;
            continue;
        }
        const normalized = NORMALIZE_CHAR[ch] ?? ch;
        if (ALIGNMENT_VOCAB[normalized] !== undefined && /[\u0600-\u06FF]/u.test(normalized)) {
            pushLetter(normalized, i, i + width, sentenceIndex);
            stats.mappedChars += width;
            sawBreakSinceWord = false;
            i += width;
            continue;
        }
        if (/[\u06F0-\u06F9\d]/u.test(ch)) {
            // number run: digits with a decimal separator between digits only
            let j = i;
            let numberText = "";
            while (j < text.length) {
                const cj = text[j];
                if (/[\u06F0-\u06F9\d]/u.test(cj)) {
                    const ascii = /[\u06F0-\u06F9]/u.test(cj)
                        ? String("۰۱۲۳۴۵۶۷۸۹".indexOf(cj))
                        : cj;
                    numberText += ascii;
                    j += 1;
                }
                else if ((cj === "٫" || cj === ".") && /[\u06F0-\u06F9\d]/u.test(text[j + 1] ?? "")) {
                    numberText += ".";
                    j += 1;
                }
                else
                    break;
            }
            const [intPart, decPart] = numberText.split(".");
            const words = [intToPersianWords(Number.parseInt(intPart, 10))];
            if (decPart !== undefined) {
                words.push("ممیز");
                words.push(intToPersianWords(Number.parseInt(decPart, 10)));
            }
            for (const [wordIndex, word] of words.entries()) {
                for (const part of word.split(/\s+/u)) {
                    for (const letter of part)
                        pushLetter(letter, i, j, sentenceIndex);
                    pushSeparator(j, j, sentenceIndex);
                }
                if (wordIndex < words.length - 1)
                    pushSeparator(i, j, sentenceIndex);
            }
            sawBreakSinceWord = false;
            stats.mappedChars += j - i;
            i = j;
            continue;
        }
        if (/[A-Za-z]/u.test(ch)) {
            const upper = ch.toUpperCase();
            const inVocab = ALIGNMENT_VOCAB[upper] !== undefined;
            if (inVocab) {
                pushLetter(upper, i, i + width, sentenceIndex);
            }
            else {
                const name = LATIN_LETTER_NAMES[ch.toLowerCase()];
                if (name === undefined) {
                    stats.unmappableChars += width;
                    stats.unmappableSamples.push(ch);
                    i += width;
                    continue;
                }
                for (const part of name.split(/\s+/u)) {
                    for (const letter of part)
                        pushLetter(letter, i, i + width, sentenceIndex);
                    pushSeparator(i + width, i + width, sentenceIndex);
                }
            }
            stats.mappedChars += width;
            sawBreakSinceWord = false;
            i += width;
            continue;
        }
        stats.unmappableChars += width;
        stats.unmappableSamples.push(ch);
        i += width;
    }
    void sawBreakSinceWord;
    return { tokens, stats, mapVersion: TRANSCRIPT_MAP_VERSION };
}
/** Sentences with too many unmappable characters are rejected (§10.2). */
export function transcriptCoverage(transcript) {
    const relevant = transcript.stats.mappedChars + transcript.stats.unmappableChars;
    if (relevant === 0)
        return { ratio: 0, reject: false };
    const ratio = transcript.stats.unmappableChars / relevant;
    return { ratio, reject: transcript.stats.unmappableChars > 2 && ratio > 0.03 };
}
export function ctcForcedAlign(logits, frameCount, vocabSize, tokens) {
    if (tokens.length === 0)
        throw new NarrationAlignmentError("NARRATION_ALIGNMENT_FAILED", "empty transcript");
    if (frameCount < tokens.length)
        throw new NarrationAlignmentError("NARRATION_ALIGNMENT_FAILED", "audio shorter than transcript");
    const frameLogProb = new Float32Array(frameCount * vocabSize);
    for (let t = 0; t < frameCount; t += 1) {
        const row = t * vocabSize;
        let maxV = -Infinity;
        for (let v = 0; v < vocabSize; v += 1)
            if (logits[row + v] > maxV)
                maxV = logits[row + v];
        let sum = 0;
        for (let v = 0; v < vocabSize; v += 1)
            sum += Math.exp(logits[row + v] - maxV);
        const lse = maxV + Math.log(sum);
        for (let v = 0; v < vocabSize; v += 1)
            frameLogProb[row + v] = logits[row + v] - lse;
    }
    const S = tokens.length;
    const blankLp = new Float32Array(frameCount);
    for (let t = 0; t < frameCount; t += 1)
        blankLp[t] = frameLogProb[t * vocabSize + BLANK_ID];
    const NEG_INF = -1e30;
    const d0 = new Float64Array(S + 1);
    const d1 = new Float64Array(S + 1);
    const p0 = new Float64Array(S + 1);
    const p1 = new Float64Array(S + 1);
    const back0 = new Uint8Array(frameCount * (S + 1));
    const back1 = new Uint8Array(frameCount * (S + 1));
    for (let s = 0; s <= S; s += 1) {
        p0[s] = NEG_INF;
        p1[s] = NEG_INF;
    }
    p0[0] = 0;
    for (let t = 0; t < frameCount; t += 1) {
        const row = t * vocabSize;
        for (let s = 0; s <= S; s += 1) {
            const from0 = p0[s] === NEG_INF ? NEG_INF : p0[s] + blankLp[t];
            const from1 = p1[s] === NEG_INF ? NEG_INF : p1[s] + blankLp[t];
            if (from1 > from0) {
                d0[s] = from1;
                back0[t * (S + 1) + s] = 1;
            }
            else {
                d0[s] = from0;
                back0[t * (S + 1) + s] = 0;
            }
            if (s === 0) {
                d1[0] = NEG_INF;
                back1[t * (S + 1)] = 0;
                continue;
            }
            const tokenLp = frameLogProb[row + tokens[s - 1].id];
            const extend = p1[s] === NEG_INF ? NEG_INF : p1[s] + tokenLp;
            const sameAsPrevious = s > 1 && tokens[s - 1].id === tokens[s - 2].id;
            const afterBlank = p0[s - 1] === NEG_INF ? NEG_INF : p0[s - 1] + tokenLp;
            const direct = sameAsPrevious || p1[s - 1] === NEG_INF ? NEG_INF : p1[s - 1] + tokenLp;
            let best = extend;
            let code = 0;
            if (afterBlank >= best) {
                best = afterBlank;
                code = 1;
            }
            if (direct > best) {
                best = direct;
                code = 2;
            }
            d1[s] = best;
            back1[t * (S + 1) + s] = code;
        }
        for (let s = 0; s <= S; s += 1) {
            p0[s] = d0[s];
            p1[s] = d1[s];
        }
    }
    const endLayer = p0[S] >= p1[S] ? 0 : 1;
    const pathScore = endLayer === 0 ? p0[S] : p1[S];
    if (pathScore <= NEG_INF / 2)
        throw new NarrationAlignmentError("NARRATION_ALIGNMENT_FAILED", "transcript cannot be aligned");
    const tokenFrames = tokens.map(() => ({ start: -1, end: -1 }));
    let layer = endLayer;
    let s = S;
    for (let t = frameCount - 1; t >= 0; t -= 1) {
        if (layer === 1) {
            const f = tokenFrames[s - 1];
            if (f.end === -1)
                f.end = t;
            f.start = t;
            const code = back1[t * (S + 1) + s];
            if (code === 1) {
                layer = 0;
                s -= 1;
            }
            else if (code === 2) {
                layer = 1;
                s -= 1;
            }
        }
        else {
            const code = back0[t * (S + 1) + s];
            layer = code === 1 ? 1 : 0;
            if (s === 0 && t === 0)
                break;
        }
        if (t === 0)
            break;
    }
    for (const f of tokenFrames) {
        if (f.start === -1)
            throw new NarrationAlignmentError("NARRATION_ALIGNMENT_FAILED", "token without frames");
    }
    return { tokenFrames, pathScore };
}
/**
 * Align one chunk WAV with its known transcript and validate §10.4: every
 * sentence exactly one non-empty ordered range inside the WAV.
 */
export async function alignChunk(input) {
    const wav = parseWavPcm(input.wavBytes);
    const modelRate = input.model.inputSampleRate;
    const resampled = resampleTo16k(wav.samples, wav.sampleRate, modelRate);
    const modelInput = normalizeUtterance(resampled);
    const emissions = await input.model.compute(modelInput);
    const relative = input.sentences.map((sentence) => ({
        start: sentence.range.start - input.sliceStart,
        end: sentence.range.end - input.sliceStart,
    }));
    for (const span of relative) {
        if (span.start < 0 || span.end > input.speechSlice.length) {
            throw new NarrationAlignmentError("NARRATION_ALIGNMENT_FAILED", "sentence range outside the speech slice");
        }
    }
    const transcript = buildAlignmentTranscript(input.speechSlice, relative);
    const coverage = transcriptCoverage(transcript);
    if (coverage.reject) {
        throw new NarrationAlignmentError("NARRATION_ALIGNMENT_FAILED", "speech slice cannot be covered by the alignment vocabulary");
    }
    const { tokenFrames, pathScore } = ctcForcedAlign(emissions.logits, emissions.frameCount, emissions.vocabSize, transcript.tokens);
    const frameMs = wav.durationMs / emissions.frameCount;
    const perSentence = new Map();
    for (let i = 0; i < transcript.tokens.length; i += 1) {
        const f = tokenFrames[i];
        const si = transcript.tokens[i].sentenceIndex;
        const cur = perSentence.get(si) ?? { start: Number.MAX_SAFE_INTEGER, end: -1 };
        if (f.start < cur.start)
            cur.start = f.start;
        if (f.end > cur.end)
            cur.end = f.end;
        perSentence.set(si, cur);
    }
    const timings = [];
    for (const [sentenceIndex, range] of [...perSentence.entries()].sort((a, b) => a[0] - b[0])) {
        const sentence = input.sentences[sentenceIndex];
        if (!sentence)
            throw new NarrationAlignmentError("NARRATION_ALIGNMENT_FAILED", "aligned sentence index outside the catalog");
        timings.push({
            sentenceId: sentence.sentenceId,
            startMs: Math.round(range.start * frameMs),
            // WAV duration can end between integer milliseconds. Rounding the
            // final CTC frame upward would put an otherwise valid sentence outside
            // the actual media duration (for example 2770.958 ms -> 2771 ms).
            endMs: Math.min(Math.round((range.end + 1) * frameMs), Math.floor(wav.durationMs)),
        });
    }
    validateSentenceTimings(timings, wav.durationMs);
    return {
        alignerVersion: `${ALIGNER_VERSION}:${input.model.modelIdentity}`,
        modelIdentity: input.model.modelIdentity,
        durationMs: Math.round(wav.durationMs),
        timings,
        pathScore,
    };
}
/** §10.4 mandatory validation: valid, ordered, inside the WAV. */
export function validateSentenceTimings(timings, durationMs) {
    let previousEnd = 0;
    for (const timing of timings) {
        if (!(timing.startMs < timing.endMs)) {
            throw new NarrationAlignmentError("NARRATION_ALIGNMENT_FAILED", "empty sentence range");
        }
        if (timing.startMs < 0 || timing.endMs > durationMs) {
            throw new NarrationAlignmentError("NARRATION_ALIGNMENT_FAILED", "sentence range outside the WAV duration");
        }
        if (previousEnd > timing.startMs) {
            throw new NarrationAlignmentError("NARRATION_ALIGNMENT_FAILED", "sentence ranges overlap or are unordered");
        }
        previousEnd = timing.endMs;
    }
}
/** §12: only the sentence containing timeMs is active; silence yields null. */
export function sentenceAt(timings, timeMs) {
    for (const timing of timings) {
        if (timeMs >= timing.startMs && timeMs < timing.endMs)
            return timing;
    }
    return null;
}
