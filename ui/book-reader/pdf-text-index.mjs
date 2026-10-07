// Extracted from Tuba studio/pdf-text-index.ts. Runtime is independent of Tuba.
/**
 * PDF text-item to canonical-offset index (plan §8.2). The index reproduces
 * `pdfPlainText` exactly — `index.text === pdfPlainText(content)` is a tested
 * invariant — so a proven DOM offset range can be paired with the canonical
 * text range it came from without any fuzzy matching.
 */
/**
 * Build the index with the very same items and separator helper that
 * `pdfPlainText` uses, so the two texts cannot drift.
 */
export function indexPdfText(content, separator) {
    const items = content.items;
    const rawParts = [];
    const spans = [];
    let cursor = 0;
    for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        const next = items[index + 1];
        const itemStart = cursor;
        const itemEnd = itemStart + item.str.length;
        cursor = itemEnd;
        const separatorText = separator(item, next);
        const separatorStart = cursor;
        const separatorEnd = separatorStart + separatorText.length;
        cursor = separatorEnd;
        rawParts.push(item.str, separatorText);
        spans.push({ start: itemStart, end: itemEnd, separatorStart, separatorEnd });
    }
    const raw = rawParts.join("");
    // pdfPlainText trims page-edge whitespace; shift every span by the same
    // amount so offsets stay valid against the trimmed text.
    const trimStart = raw.length - raw.trimStart().length;
    const text = raw.trim();
    const indexed = [];
    for (const [textItemIndex, span] of spans.entries()) {
        const start = span.start - trimStart;
        const end = span.end - trimStart;
        const separatorStart = span.separatorStart - trimStart;
        const separatorEnd = span.separatorEnd - trimStart;
        // PDF.js omits empty text items from its DOM text layer. They can still
        // contribute separators to the canonical page text, but have no selectable
        // characters or span to validate against. Producer control marks emitted
        // as spaces contribute spacing but their DOM spans show the raw mark.
        if (span.end <= span.start || end <= 0 || start >= text.length || items[textItemIndex].selectable === false)
            continue;
        indexed.push({
            textItemIndex,
            sourceText: items[textItemIndex].str,
            rawStart: start,
            start: Math.max(0, start),
            end: Math.min(text.length, end),
            separatorStart: Math.max(0, Math.min(text.length, separatorStart)),
            separatorEnd: Math.max(0, Math.min(text.length, separatorEnd)),
        });
    }
    return { text, items: indexed };
}
/** Map a PDF.js DOM selection through item identity and exact page offsets. */
export function selectedPdfTextRange(index, textLayer, range) {
    const indexedSpans = index.items.map((item) => {
        const span = textLayer.querySelector(`span[data-pdf-item-index="${item.textItemIndex}"]`);
        if (!span || span.childNodes.length !== 1 || span.firstChild?.nodeType !== Node.TEXT_NODE || span.textContent !== item.sourceText)
            return null;
        return span;
    });
    if (indexedSpans.some((span) => !span))
        return null;
    const offsetOf = (node, offset) => {
        if (node.nodeType !== Node.TEXT_NODE)
            return null;
        const span = node.parentElement?.closest("span[data-pdf-item-index]");
        if (!span || !textLayer.contains(span) || span.firstChild !== node)
            return null;
        const item = index.items.find((candidate) => candidate.textItemIndex === Number(span.dataset.pdfItemIndex));
        if (!item)
            return null;
        const local = item.rawStart + offset;
        return local >= item.start && local <= item.end ? local : null;
    };
    let start = offsetOf(range.startContainer, range.startOffset);
    let end = offsetOf(range.endContainer, range.endOffset);
    if (start === null || end === null || end <= start)
        return null;
    while (start < end && /\s/u.test(index.text[start]))
        start += 1;
    while (end > start && /\s/u.test(index.text[end - 1]))
        end -= 1;
    return end > start ? { start, end } : null;
}
/**
 * Locate the text items that carry one canonical-offset range. Returns null
 * when the range does not fit this page's indexed text — the honesty rule
 * (§8.3): no fuzzy match, no guessed geometry.
 */
export function itemsForOffsetRange(index, start, end) {
    if (start < 0 || end > index.text.length || end <= start)
        return null;
    const overlaps = [];
    for (const item of index.items) {
        const intersectionStart = Math.max(item.start, start);
        const intersectionEnd = Math.min(item.end, end);
        if (intersectionEnd <= intersectionStart)
            continue;
        overlaps.push({
            textItemIndex: item.textItemIndex,
            startInItem: intersectionStart - item.rawStart,
            endInItem: intersectionEnd - item.rawStart,
        });
    }
    if (overlaps.length === 0)
        return null;
    return overlaps;
}
