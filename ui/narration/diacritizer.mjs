// Extracted from Tuba src/narration/diacritizer.ts; pure algorithms only.
import { DIACRITIZATION_PROFILE_VERSION, SPEECH_VARIANT_POLICY_VERSION } from "./constants.mjs";
import { sha256Hex } from "./identity.mjs";
/**
 * Hidden diacritization gate (doc §7). The canonical text is never rewritten:
 * the model may only insert Arabic/Persian vowelization marks. The validator
 * is pure and strict — byte equality after stripping ONLY the allowed marks
 * from both strings, per-codepoint placement checks, and preservation of any
 * pre-existing marks. No NFC/NFKC, no yeh/kaf conversion, no digit conversion,
 * no trim, no whitespace collapsing — any of those rejects the variant.
 */
export const DIACRITIZER_PROMPT_VERSION = "tuba-fa-diacritizer-prompt-v3";
/** Frozen system instruction, versioned (doc §7). */
export const DIACRITIZER_SYSTEM_INSTRUCTION = [
    "متن فارسی داده‌شده را فقط برای تلفظ طبیعی گفتار اعراب‌گذاری کن.",
    "هیچ نویسهٔ اصلی، واژه، عدد، فاصله، نیم‌فاصله، newline یا علامت را حذف، اضافه،",
    "جابه‌جا یا بازنویسی نکن. فقط نشانه‌های اعراب فارسی/عربی را بلافاصله پس از",
    "نویسهٔ مربوط اضافه کن. در ابهام، صورت درست را از بافت پاراگراف انتخاب کن.",
    "فقط شیء JSON با کلید text برگردان و هیچ متن دیگری ننویس.",
].join("\n");
/** The one corrective retry gives a concrete output example. */
export const DIACRITIZER_CORRECTIVE_INSTRUCTION = [
    DIACRITIZER_SYSTEM_INSTRUCTION,
    "پاسخ پیشین نامعتبر بود. برای واژه‌های فارسیِ بی‌اعراب، واکه‌های کوتاه لازم را واقعاً اضافه کن.",
    "بازگرداندن همان متنِ بی‌اعراب، تبدیل رقم‌ها یا حذف حتی یک حرف (از جمله ه) نامعتبر است.",
    "نمونهٔ قالب: ورودی «کتاب خوب است.»؛ خروجی {\"text\":\"کِتابِ خوب اَست.\"}.",
    "فقط شیء JSON با کلید text برگردان.",
].join("\n");
export const DIACRITIZATION_PROFILE = {
    profileVersion: DIACRITIZATION_PROFILE_VERSION,
    promptVersion: DIACRITIZER_PROMPT_VERSION,
    policyVersion: SPEECH_VARIANT_POLICY_VERSION,
    systemInstruction: DIACRITIZER_SYSTEM_INSTRUCTION,
    temperature: 0.1,
    thinking: { type: "disabled" },
    responseJsonField: "text",
};
/** Allowed additions: only these marks, immediately after a base character. */
const ALLOWED_MARKS = new Set([
    "\u064B", // fathatan
    "\u064C", // dammatan
    "\u064D", // kasratan
    "\u064E", // fatha
    "\u064F", // damma
    "\u0650", // kasra
    "\u0651", // shadda
    "\u0652", // sukun
    "\u0654", // hamza above, used for Persian ezafe after heh (e.g. باغچهٔ)
    "\u0670", // superscript alef
]);
function stripAllowedMarks(text) {
    let out = "";
    for (const ch of text) {
        if (!ALLOWED_MARKS.has(ch))
            out += ch;
    }
    return out;
}
/**
 * Tatweel (U+0640, kashida) is visual justification, not phonetics: PDF
 * canonical text carries it, models drop or keep it inconsistently, and the
 * aligner already skips it. Strip it from candidates and from both sides of
 * every comparison so its presence never decides validity.
 */
const TATWEEL = /\u0640/gu;
export function stripTatweel(text) {
    return text.replace(TATWEEL, "");
}
/**
 * Some PDF text layers (Quran-font quotations in particular) emit each vowel
 * mark as its own space-separated item: «و َ سارِعوا». Both the canonical text
 * and a faithful model echo then carry marks separated from their base letter,
 * which is placement-invalid even though nothing phonetic changed. Reattach
 * every allowed mark stranded by a separator run to the nearest previous
 * letter, else to the nearest following letter, else drop it. Compare-time
 * normalization only — the canonical text itself is never rewritten.
 */
function reattachStrayMarks(text) {
    const groups = [];
    const leading = [];
    for (const char of stripTatweel(text)) {
        if (ALLOWED_MARKS.has(char)) {
            const prior = groups.at(-1);
            if (prior)
                prior.marks.push(char);
            else
                leading.push(char);
        }
        else {
            groups.push({ base: char, marks: [] });
        }
    }
    const isLetter = (group) => /\p{L}/u.test(group.base);
    // A stray mark is ambiguous — we cannot know which neighboring letter it
    // belongs to. Rather than force a second vowel onto a letter that already
    // carries one (an invalid combination), drop it: one lost vowel beats an
    // unusable variant.
    const accepts = (existing, incoming) => {
        const shaddas = existing.filter((mark) => mark === "\u0651").length + (incoming === "\u0651" ? 1 : 0);
        const vowels = existing.length - existing.filter((mark) => mark === "\u0651").length + (incoming === "\u0651" ? 0 : 1);
        return shaddas <= 1 && vowels <= 1;
    };
    const out = groups.map((group) => ({ base: group.base, marks: [] }));
    const deferred = [];
    for (let index = 0; index < groups.length; index += 1) {
        const group = groups[index];
        if (group.marks.length === 0)
            continue;
        if (isLetter(group)) {
            out[index].marks.push(...group.marks);
            continue;
        }
        let target = -1;
        for (let previous = index - 1; previous >= 0; previous -= 1) {
            if (isLetter(groups[previous])) {
                target = previous;
                break;
            }
        }
        if (target === -1) {
            deferred.push({ index, marks: group.marks });
            continue;
        }
        for (const mark of group.marks) {
            if (accepts(out[target].marks, mark))
                out[target].marks.push(mark);
        }
    }
    for (const item of deferred) {
        let target = -1;
        for (let next = item.index + 1; next < groups.length; next += 1) {
            if (isLetter(groups[next])) {
                target = next;
                break;
            }
        }
        if (target === -1)
            continue;
        for (const mark of item.marks) {
            if (accepts(out[target].marks, mark))
                out[target].marks.unshift(mark);
        }
    }
    const firstLetter = out.find((group) => isLetter(group));
    if (firstLetter) {
        for (const mark of leading) {
            if (accepts(firstLetter.marks, mark))
                firstLetter.marks.unshift(mark);
        }
    }
    return out.map((group) => group.base + group.marks.join("")).join("");
}
/**
 * Pure validator (doc §7): the candidate must equal the canonical text with
 * only allowed marks inserted after base characters. Pre-existing marks in
 * the canonical must survive with the same base and order. Returns the list
 * of violations; an empty list accepts the variant.
 */
export function validateSpeechVariant(canonical, candidate) {
    const canon = reattachStrayMarks(canonical);
    const cand = reattachStrayMarks(candidate);
    if (stripAllowedMarks(cand) !== stripAllowedMarks(canon)) {
        return { ok: false, violations: ["base-text-mismatch-after-stripping-allowed-marks"] };
    }
    // Group inserted marks with their base letter. A shadda and one vowel may
    // legitimately follow the same letter, in either order (for example رَّ).
    const groups = (text) => {
        const result = [];
        for (const char of text) {
            if (ALLOWED_MARKS.has(char)) {
                const previous = result.at(-1);
                if (!previous)
                    return null;
                previous.marks.push(char);
            }
            else {
                result.push({ base: char, marks: [] });
            }
        }
        return result;
    };
    const original = groups(canon);
    const proposed = groups(cand);
    if (!original || !proposed || original.length !== proposed.length) {
        return { ok: false, violations: ["mark-not-after-base-character"] };
    }
    for (let index = 0; index < original.length; index += 1) {
        const source = original[index];
        const output = proposed[index];
        if (source.base !== output.base) {
            return { ok: false, violations: ["base-text-mismatch-after-stripping-allowed-marks"] };
        }
        if (output.marks.length > 0 && !/\p{L}/u.test(output.base)) {
            return { ok: false, violations: ["mark-not-after-base-character"] };
        }
        const shaddas = output.marks.filter((mark) => mark === "\u0651").length;
        const vowels = output.marks.length - shaddas;
        if (shaddas > 1 || vowels > 1) {
            return { ok: false, violations: ["conflicting-marks-on-base-character"] };
        }
        // Every canonical mark must survive, but a shadda and its vowel may sit
        // in either order (رَّ == رَ + shadda): compare as a multiset, not a
        // subsequence — the model and the PDF layer order them differently.
        const remaining = [...source.marks];
        for (const mark of output.marks) {
            const at = remaining.indexOf(mark);
            if (at >= 0)
                remaining.splice(at, 1);
        }
        if (remaining.length > 0) {
            return { ok: false, violations: ["canonical-mark-changed"] };
        }
    }
    return { ok: true, violations: [] };
}
/**
 * Project marks back onto the exact canonical base stream when the model only
 * changes separators, the glyph of an unchanged decimal digit, or omits one
 * unambiguous heh. The omitted heh is restored from canonical text without an
 * invented mark. Any other missing/rewritten letter stays invalid. The strict
 * validator still decides whether the result may be persisted or spoken.
 */
export function reconcileVariantFormatting(canonical, candidate) {
    const parse = (text) => {
        const groups = [];
        for (const char of reattachStrayMarks(text)) {
            if (ALLOWED_MARKS.has(char)) {
                const prior = groups.at(-1);
                if (!prior)
                    return null;
                prior.marks.push(char);
            }
            else {
                groups.push({ base: char, marks: [] });
            }
        }
        return groups;
    };
    const isSeparator = (char) => char === "\u200C" || /\s/u.test(char);
    const digitValue = (char) => {
        const code = char.codePointAt(0);
        if (code === undefined)
            return null;
        if (code >= 0x30 && code <= 0x39)
            return code - 0x30;
        if (code >= 0x660 && code <= 0x669)
            return code - 0x660;
        if (code >= 0x6f0 && code <= 0x6f9)
            return code - 0x6f0;
        return null;
    };
    const source = parse(canonical);
    const output = parse(candidate);
    if (!source || !output || output.some((group) => isSeparator(group.base) && group.marks.length > 0)) {
        return null;
    }
    const sourceBases = source.filter((group) => !isSeparator(group.base));
    const outputBases = output.filter((group) => !isSeparator(group.base));
    const sameBase = (sourceBase, outputBase) => sourceBase === outputBase ||
        (digitValue(sourceBase) !== null && digitValue(sourceBase) === digitValue(outputBase));
    let omittedHehIndex = -1;
    if (sourceBases.length === outputBases.length) {
        if (sourceBases.some((group, index) => !sameBase(group.base, outputBases[index].base)))
            return null;
    }
    else if (sourceBases.length === outputBases.length + 1) {
        const possible = sourceBases.flatMap((group, omittedIndex) => {
            if (group.base !== "ه")
                return [];
            const matches = sourceBases.every((source, index) => index === omittedIndex || sameBase(source.base, outputBases[index < omittedIndex ? index : index - 1].base));
            return matches ? [omittedIndex] : [];
        });
        if (possible.length !== 1)
            return null;
        omittedHehIndex = possible[0];
    }
    else {
        return null;
    }
    let baseIndex = 0;
    let sourceBaseIndex = 0;
    return source.map((group) => {
        if (isSeparator(group.base))
            return group.base + group.marks.join("");
        if (sourceBaseIndex++ === omittedHehIndex)
            return group.base + group.marks.join("");
        return group.base + outputBases[baseIndex++].marks.join("");
    }).join("");
}
/**
 * Offset map from canonical UTF-16 positions to variant positions (doc §9/§10:
 * chunks speak exact variant slices of canonical ranges). map[i] is the
 * variant index for canonical boundary i, including marks attached to bases
 * before it. Returns null when the base streams diverge (unvalidated input).
 */
export function mapCanonicalToVariant(canonical, variant) {
    const map = [];
    const pointSize = (codePoint) => (codePoint > 0xffff ? 2 : 1);
    let i = 0;
    let j = 0;
    while (i <= canonical.length) {
        map[i] = j;
        if (i === canonical.length)
            break;
        // Canonical tatweel is justification-only: it maps to the current variant
        // boundary without consuming anything there.
        if (canonical[i] === "\u0640") {
            i += 1;
            continue;
        }
        const cSize = pointSize(canonical.codePointAt(i));
        const cChar = canonical.slice(i, i + cSize);
        // Skip marks the model INSERTED before this canonical char (they attach
        // to the previous base); canonical marks compare in parallel. A canonical
        // mark that normalization relocated (stray space-separated PDF marks)
        // appears in the variant before these separators, i.e. at an already
        // consumed position — absorb it without consuming anything.
        let strayCanonicalMark = false;
        for (;;) {
            if (j >= variant.length) {
                if (ALLOWED_MARKS.has(cChar)) {
                    strayCanonicalMark = true;
                    break;
                }
                return null;
            }
            const vCh = variant.codePointAt(j);
            const vSize = pointSize(vCh);
            const vChar = variant.slice(j, j + vSize);
            if (vChar === cChar)
                break;
            if (vChar === "\u0640" || ALLOWED_MARKS.has(vChar)) {
                j += vSize;
                continue;
            }
            if (ALLOWED_MARKS.has(cChar)) {
                strayCanonicalMark = true;
                break;
            }
            return null;
        }
        if (strayCanonicalMark) {
            i += cSize;
            continue;
        }
        j += pointSize(variant.codePointAt(j));
        i += cSize;
    }
    // trailing marks after the last base belong to the final boundary
    while (j < variant.length) {
        const ch = String.fromCodePoint(variant.codePointAt(j));
        if (!ALLOWED_MARKS.has(ch))
            return null;
        j += ch.length === 2 ? 2 : 1;
        map[canonical.length] = j;
    }
    return map;
}
/** Parse the model response: only {"text": string} JSON is accepted (doc §7). */
export function parseDiacritizerResponse(body) {
    let parsed;
    try {
        parsed = JSON.parse(body);
    }
    catch {
        return { ok: false, reason: "response-is-not-json" };
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { ok: false, reason: "response-is-not-an-object" };
    }
    const record = parsed;
    const keys = Object.keys(record);
    if (keys.length !== 1 || keys[0] !== "text") {
        return { ok: false, reason: "response-must-have-exactly-one-text-field" };
    }
    const text = record.text;
    if (typeof text !== "string") {
        return { ok: false, reason: "text-field-is-not-a-string" };
    }
    return { ok: true, text: stripTatweel(text) };
}
/** Hash of the speech variant text, stored with the variant record. */
export function speechVariantSha256(speechText) {
    return sha256Hex(speechText);
}
/** Safe error view: never carries provider response text (doc §14). */
export function diacritizationError(code, diagnosticId) {
    const messages = {
        NARRATION_DIACRITIZATION_FAILED: "آماده‌سازی متن گفتاری این بخش کامل نشد؛ می‌توانید دوباره تلاش کنید.",
        NARRATION_DIACRITIZATION_INVALID: "متن گفتاری این بخش معتبر تأیید نشد؛ ساخت صدا متوقف ماند.",
        NARRATION_REQUEST_TIMEOUT: "آماده‌سازی متن گفتاری بیش از حد طول کشید.",
        NARRATION_PROVIDER_RATE_LIMITED: "سرویس آماده‌سازی متن موقتاً پراستفاده است.",
        NARRATION_PROVIDER_AUTH_FAILED: "دسترسی به سرویس آماده‌سازی متن تأیید نشد.",
        NARRATION_PROVIDER_CREDIT_EXHAUSTED: "اعتبار سرویس آماده‌سازی متن تمام شده است.",
        NARRATION_PROVIDER_UNAVAILABLE: "سرویس آماده‌سازی متن در دسترس نیست.",
        NARRATION_PROVIDER_NOT_CONFIGURED: "سرویس آماده‌سازی متن تنظیم نشده است.",
    };
    return {
        code,
        category: code === "NARRATION_DIACRITIZATION_INVALID" ? "generation" : "provider",
        messageFa: messages[code],
        retry: code === "NARRATION_DIACRITIZATION_INVALID" || code === "NARRATION_REQUEST_TIMEOUT" ? "same-target" : "same-target",
        diagnosticId,
    };
}
