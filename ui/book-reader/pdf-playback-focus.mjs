// Extracted from Tuba studio/pdf-playback-focus.ts. Runtime is independent of Tuba.
import { itemsForOffsetRange } from "./pdf-text-index.mjs";
/**
 * Measure only text that can be tied to the canonical page offset and whose
 * DOM text still equals the canonical slice. Any mismatch falls back to the
 * readable passage; a repeated phrase is never located by fuzzy search.
 * Doc §12: the measured slice is the current SENTENCE's canonical range, not
 * the whole paragraph.
 */
export function focusRectsForPage(input) {
    const { unit, page, index, textLayer, surface } = input;
    const range = input.sentenceRange ?? unit.range;
    const part = unit.locatorParts.find((candidate) => candidate.locator.kind !== "unavailable" && candidate.locator.page === page &&
        candidate.segmentStart !== undefined);
    if (!part || part.segmentStart === undefined)
        return null;
    // The sentence slice must intersect this page's locator part; the measured
    // range is the intersection of the sentence with the page segment.
    const start = Math.max(range.start, part.range.start);
    const end = Math.min(range.end, part.range.end);
    if (end <= start)
        return null;
    const localStart = start - part.segmentStart;
    const localEnd = Math.min(end - part.segmentStart, index.text.length);
    if (localStart < 0 || localEnd <= localStart)
        return null;
    const textStart = start - unit.range.start;
    const expected = unit.text.slice(textStart, textStart + localEnd - localStart);
    if (index.text.slice(localStart, localEnd) !== expected)
        return null;
    const spans = itemsForOffsetRange(index, localStart, localEnd);
    if (!spans?.length)
        return null;
    const bounds = surface.getBoundingClientRect();
    const rects = [];
    for (const item of spans) {
        const span = textLayer.querySelector(`[data-pdf-item-index="${item.textItemIndex}"]`);
        const node = span?.firstChild;
        const indexedItem = index.items.find(candidate => candidate.textItemIndex === item.textItemIndex);
        if (!node || node.nodeType !== Node.TEXT_NODE || !span ||
            node.textContent !== indexedItem.sourceText || item.endInItem > node.textContent.length)
            return null;
        const range = textLayer.ownerDocument.createRange();
        range.setStart(node, item.startInItem);
        range.setEnd(node, item.endInItem);
        for (const rect of range.getClientRects()) {
            if (rect.width <= 0 || rect.height <= 0)
                continue;
            rects.push({
                left: rect.left - bounds.left,
                top: rect.top - bounds.top,
                width: rect.width,
                height: rect.height,
            });
        }
    }
    return rects.length > 0 ? rects : null;
}
