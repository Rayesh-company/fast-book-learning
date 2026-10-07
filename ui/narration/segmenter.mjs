// Extracted from Tuba src/narration/segmenter.ts; pure algorithms only.
const SENTENCE_TERMINALS = new Set([".", "!", "?", "؟", "…"]);
/** Short structural spans without terminal punctuation become fragments. */
const STRUCTURAL_FRAGMENT_MAX_CHARS = 200;
/** Abbreviations that never end a sentence (versioned, frozen; plan §7.2). */
const ABBREVIATIONS = [
    "دکتر",
    "د.",
    "مهندس",
    "پروف.",
    "استاد",
    "جناب",
    "سرکار",
    "etc",
    "e.g",
    "i.e",
    "dr",
    "mr",
    "mrs",
    "ms",
    "prof",
    "vs",
    "fig",
];
function isWhitespaceChar(char) {
    return char !== undefined && /\s/u.test(char);
}
function codePointSize(codePoint) {
    return codePoint > 0xffff ? 2 : 1;
}
function utf8ByteSize(codePoint) {
    if (codePoint <= 0x7f)
        return 1;
    if (codePoint <= 0x7ff)
        return 2;
    if (codePoint <= 0xffff)
        return 3;
    return 4;
}
function isCombiningMark(char) {
    return /\p{M}/u.test(char);
}
/**
 * Build a same-length segmentation view: soft line wraps become single
 * spaces so sentence segmentation never treats a wrapped line as a boundary,
 * while every offset stays valid against the original text (plan §7.2).
 */
export function buildSegmentationView(text) {
    const chars = [...text];
    // Rebuild with per-code-unit mapping to preserve UTF-16 length exactly.
    const viewUnits = new Array(text.length);
    let index = 0;
    for (const char of chars) {
        const size = codePointSize(char.codePointAt(0));
        if (char === "\n" || char === "\r") {
            for (let offset = 0; offset < size; offset += 1)
                viewUnits[index + offset] = " ";
        }
        else {
            viewUnits[index] = char;
            for (let offset = 1; offset < size; offset += 1)
                viewUnits[index + offset] = "";
        }
        index += size;
    }
    const view = viewUnits.map((unit) => unit ?? "").join("");
    // Real paragraph breaks: two or more consecutive newlines in the original.
    const paragraphStarts = [];
    let runStart = -1;
    let runLength = 0;
    for (let position = 0; position < text.length; position += 1) {
        const char = text[position];
        if (char === "\n" || char === "\r") {
            if (runStart < 0)
                runStart = position;
            runLength += 1;
        }
        else if (runStart >= 0) {
            if (runLength >= 2)
                paragraphStarts.push(position);
            runStart = -1;
            runLength = 0;
        }
    }
    if (runStart >= 0 && runLength >= 2)
        paragraphStarts.push(text.length);
    return { view, paragraphStarts };
}
function endsWithAbbreviation(view, boundary) {
    const before = view.slice(0, boundary).trimEnd().toLowerCase();
    return ABBREVIATIONS.some((abbreviation) => {
        if (!before.endsWith(abbreviation))
            return false;
        // The abbreviation must be a whole word: the character before it must be
        // start-of-text or whitespace, so a word like "آمد." never matches "د.".
        const preceding = before[before.length - abbreviation.length - 1];
        return preceding === undefined || /\s/u.test(preceding);
    });
}
function insideNumberOrAddress(view, boundary) {
    // Boundary directly after a '.' that sits inside a decimal number, a
    // version token, a URL host, or an email address must not split.
    const previous = view[boundary - 1];
    const next = view[boundary];
    if (previous !== ".")
        return false;
    const afterNext = view[boundary + 1];
    if (next === undefined)
        return false;
    // ۳٫۱۴ uses U+066B; "3.14" splits wrongly only when digits surround the dot.
    const prevIsDigit = /\d|[۰-۹]/u.test(previous === "." ? view[boundary - 2] ?? "" : previous);
    const beforeDot = view[boundary - 2] ?? "";
    const dotFollowedByDigit = /\d|[۰-۹]/u.test(next);
    if (dotFollowedByDigit && /\d|[۰-۹]/u.test(beforeDot))
        return true;
    if (next === "." || afterNext === undefined)
        return false;
    // No whitespace on either side of the dot and next is a letter → host/name.
    const noSpaceBefore = /\S/u.test(beforeDot) && beforeDot !== " ";
    const nextIsLetter = /[A-Za-z]/u.test(next);
    const domainTail = /^[a-z]{2,6}(?![a-z])/iu.test(view.slice(boundary));
    if (noSpaceBefore && nextIsLetter && domainTail && /[\w.@-]/iu.test(view.slice(Math.max(0, boundary - 40), boundary))) {
        return true;
    }
    // Decimal guard when the '.' itself is the boundary char and digits flank it.
    if (prevIsDigit && dotFollowedByDigit)
        return true;
    return false;
}
/** Closing punctuation that may be followed by a continuation word. */
const CLOSING_PUNCTUATION = new Set(["»", "\u201d", "\u2019", ")", "]", "}", '"', "'"]);
/** Frozen continuation words that keep a closed quote in the same sentence. */
const CONTINUATION_WORDS = new Set(["و", "اما", "ولی", "سپس", "که", "تا", "هرچند", "چون"]);
function continuesAfterClosedQuote(view, boundary) {
    // The boundary sits right after closing punctuation that follows a
    // sentence terminal; a continuation conjunction keeps it in one sentence.
    // ICU candidates include trailing whitespace, so walk back over it first.
    let cursor = boundary;
    while (cursor > 1 && /\s/u.test(view[cursor - 1] ?? ""))
        cursor -= 1;
    const closer = view[cursor - 1];
    if (!closer || !CLOSING_PUNCTUATION.has(closer))
        return false;
    const terminal = view[cursor - 2];
    if (!terminal || !SENTENCE_TERMINALS.has(terminal))
        return false;
    const rest = view.slice(cursor).trimStart();
    const word = rest.split(/\s/u, 1)[0] ?? "";
    return CONTINUATION_WORDS.has(word);
}
function sentenceSpanCandidates(view) {
    if (typeof Intl === "undefined" || typeof Intl.Segmenter !== "function") {
        throw new Error("Intl.Segmenter is required for narration segmentation");
    }
    const segmenter = new Intl.Segmenter("fa", { granularity: "sentence" });
    const spans = [];
    for (const segment of segmenter.segment(view)) {
        const start = segment.index;
        const end = start + segment.segment.length;
        if (end > start)
            spans.push({ start, end });
    }
    return spans;
}
/**
 * Sentence span planning on the segmentation view (plan §7.2 steps 4–8).
 * Wrong boundaries inside numbers, hosts, and abbreviations are merged;
 * nothing here mutates the original text.
 */
export function planSentenceSpans(text) {
    const { view, paragraphStarts } = buildSegmentationView(text);
    const candidates = sentenceSpanCandidates(view);
    const paragraphStartSet = new Set(paragraphStarts);
    const merged = [];
    for (const candidate of candidates) {
        const previous = merged[merged.length - 1];
        if (previous) {
            // Guard checks examine the boundary between `previous.end` and the
            // next candidate: the dot may sit directly before the boundary or be
            // carried at the start of the next span.
            const boundary = previous.end;
            const before = view.slice(0, boundary).trimEnd();
            const lastChar = before[before.length - 1] ?? "";
            const boundaryChar = view[boundary] ?? "";
            const wrongBoundary = (lastChar === "." && endsWithAbbreviation(view, boundary)) ||
                (lastChar === "." && insideNumberOrAddress(view, boundary)) ||
                (boundaryChar === "." && insideNumberOrAddress(view, boundary + 1)) ||
                continuesAfterClosedQuote(view, boundary) ||
                (boundaryChar !== "" && continuesAfterClosedQuote(view, boundary + 1));
            if (wrongBoundary || candidate.end <= previous.end) {
                previous.end = Math.max(previous.end, candidate.end);
                continue;
            }
        }
        merged.push({ ...candidate });
    }
    // A real paragraph boundary inside a span is a structural edge: a title
    // without a terminal must not swallow the following paragraph (plan §7.2
    // step 8). Soft wraps never reach here because the view converted them.
    const spans = [];
    for (const span of merged) {
        const edges = [span.start, ...paragraphStarts.filter((edge) => span.start < edge && edge < span.end), span.end];
        for (let index = 0; index < edges.length - 1; index += 1) {
            const edgeStart = edges[index];
            const edgeEnd = edges[index + 1];
            spans.push({
                start: edgeStart,
                end: edgeEnd,
                hasTerminal: false,
                startsAtParagraph: index > 0 || span.start === 0 || paragraphStartSet.has(span.start),
                isLastSpan: false,
            });
        }
    }
    if (spans.length > 0)
        spans[spans.length - 1].isLastSpan = true;
    const result = [];
    for (const [index, span] of spans.entries()) {
        let start = span.start;
        let end = span.end;
        // Trim whitespace by moving offsets; trim() is forbidden (plan §7.2 step 7).
        while (start < end && isWhitespaceChar(text[start]))
            start += 1;
        while (end > start && isWhitespaceChar(text[end - 1]))
            end -= 1;
        if (start >= end)
            continue;
        let hasTerminal = false;
        let scan = end - 1;
        while (scan >= start) {
            const char = text.charAt(scan);
            if (SENTENCE_TERMINALS.has(char)) {
                hasTerminal = true;
                break;
            }
            if (!isWhitespaceChar(text[scan]))
                break;
            scan -= 1;
        }
        result.push({
            start,
            end,
            hasTerminal,
            startsAtParagraph: start === 0 || paragraphStartSet.has(start) || paragraphStartSet.has(start - 1),
            isLastSpan: index === spans.length - 1,
        });
    }
    return result;
}
function classifySpan(span) {
    if (span.hasTerminal)
        return "sentence";
    const length = span.end - span.start;
    if ((span.startsAtParagraph || span.isLastSpan) && length <= STRUCTURAL_FRAGMENT_MAX_CHARS) {
        return "structural-fragment";
    }
    return "sentence";
}
/**
 * Group adjacent sentences into physical paragraphs (doc §5): paragraph breaks
 * come from real blank-line boundaries only; soft PDF wraps never split.
 * Paragraphs larger than MAX_PARAGRAPH_CHARS split at sentence boundaries:
 * diacritization and alignment run per unit, and page-scale blobs (tables of
 * contents, front matter) exceed the provider's reliable output window, which
 * fails the whole unit instead of degrading it.
 */
export const MAX_PARAGRAPH_CHARS = 1500;
export function planParagraphSpans(text) {
    const sentences = planSentenceSpans(text);
    const paragraphs = [];
    let current = null;
    for (const sentence of sentences) {
        if (current && (sentence.startsAtParagraph || sentence.end - current.start >= MAX_PARAGRAPH_CHARS)) {
            paragraphs.push(current);
            current = null;
        }
        if (!current) {
            current = { ...sentence, sentenceCount: 1 };
        }
        else {
            current.end = sentence.end;
            current.hasTerminal = sentence.hasTerminal;
            current.isLastSpan = sentence.isLastSpan;
            current.sentenceCount += 1;
        }
    }
    if (current)
        paragraphs.push(current);
    return paragraphs;
}
