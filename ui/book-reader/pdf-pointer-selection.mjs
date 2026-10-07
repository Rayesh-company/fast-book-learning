// Extracted from Tuba studio/pdf-pointer-selection.ts. Runtime is independent of Tuba.
/** Absolute-positioned PDF text has no normal line boxes in the whitespace.
 * Snap to the nearest visible run before asking the browser for a caret. */
export function pdfCaretAt(layer, x, y) {
    const runs = [...layer.querySelectorAll("span[data-pdf-text]")].map((span) => ({ span, rect: span.getBoundingClientRect() })).filter(({ rect }) => rect.width > 0 && rect.height > 0);
    if (!runs.length)
        return null;
    const vertical = ({ rect }) => Math.abs(y - (rect.top + rect.height / 2));
    const nearestY = Math.min(...runs.map(vertical));
    const row = runs.filter((run) => vertical(run) <= nearestY + Math.min(3, run.rect.height * .2));
    row.sort((a, b) => Math.max(a.rect.left - x, x - a.rect.right, 0) - Math.max(b.rect.left - x, x - b.rect.right, 0));
    const { span, rect } = row[0];
    const node = span.firstChild;
    if (!node)
        return null;
    const rtl = span.dir === "rtl";
    if (x <= rect.left)
        return { node, offset: rtl ? node.textContent.length : 0 };
    if (x >= rect.right)
        return { node, offset: rtl ? 0 : node.textContent.length };
    const document = layer.ownerDocument;
    const caret = document.caretPositionFromPoint?.(x, rect.top + rect.height / 2);
    if (caret && span.contains(caret.offsetNode))
        return { node: caret.offsetNode, offset: caret.offset };
    // Fallback for engines without caretPositionFromPoint, retaining exact glyph widths.
    let best = { node, offset: 0 };
    let distance = Infinity;
    for (let offset = 0; offset < node.textContent.length; offset++) {
        const range = document.createRange();
        range.setStart(node, offset);
        range.setEnd(node, offset + 1);
        const glyph = range.getBoundingClientRect();
        for (const [edge, index] of [[rtl ? glyph.right : glyph.left, offset], [rtl ? glyph.left : glyph.right, offset + 1]]) {
            if (Math.abs(edge - x) < distance) {
                distance = Math.abs(edge - x);
                best = { node, offset: index };
            }
        }
    }
    return best;
}
