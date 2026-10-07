import { selectedPdfTextRange } from './pdf-text-index.mjs';
import { pdfCaretAt } from './pdf-pointer-selection.mjs';

/** Clamp a native selection to one indexed page, retaining partial words. */
export function capturePageSelection({ page, index, layer }, selectionRange) {
  if (!index?.items.length || !selectionRange.intersectsNode(layer)) return null;
  const selected = [];
  for (const item of index.items) {
    const span = layer.querySelector(`[data-pdf-item-index="${item.textItemIndex}"]`);
    const node = span?.firstChild;
    if (!node || span.childNodes.length !== 1 || node.nodeType !== 3 || node.textContent !== item.sourceText) return null;
    const itemRange = layer.ownerDocument.createRange();
    itemRange.setStart(node, item.start - item.rawStart);
    itemRange.setEnd(node, item.end - item.rawStart);
    // Ignore runs touched only at their boundary.
    if (selectionRange.compareBoundaryPoints(3, itemRange) >= 0 ||
        selectionRange.compareBoundaryPoints(1, itemRange) <= 0) continue;
    const clipped = itemRange.cloneRange();
    if (selectionRange.compareBoundaryPoints(0, itemRange) > 0) clipped.setStart(selectionRange.startContainer, selectionRange.startOffset);
    if (selectionRange.compareBoundaryPoints(2, itemRange) < 0) clipped.setEnd(selectionRange.endContainer, selectionRange.endOffset);
    if (!clipped.collapsed) selected.push(clipped);
  }
  if (!selected.length) return null;
  const range = selected[0].cloneRange();
  const last = selected.at(-1);
  range.setEnd(last.endContainer, last.endOffset);
  const offsets = selectedPdfTextRange(index, layer, range);
  if (!offsets) return null;
  return { page, ...offsets, text: index.text.slice(offsets.start, offsets.end) };
}

/** Tuba's whitespace snapping and pointer selection; touch keeps native handles. */
export function installPointerSelection(layer, onSelection = () => {}, layers = () => [layer]) {
  let anchor = null;
  const doc = layer.ownerDocument;
  const controller = new doc.defaultView.AbortController();
  const options = { signal: controller.signal };
  const layerAt = y => {
    let nearest = layer;
    let distance = Infinity;
    for (const candidate of layers()) {
      const rect = candidate.getBoundingClientRect();
      if (rect.height <= 0) continue;
      const gap = Math.max(rect.top - y, y - rect.bottom, 0);
      if (gap < distance) { nearest = candidate; distance = gap; }
    }
    return nearest;
  };
  layer.tabIndex = -1;
  layer.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.detail > 1 || event.pointerType === 'touch') return;
    const caret = pdfCaretAt(layer, event.clientX, event.clientY);
    if (!caret) return;
    event.preventDefault();
    layer.focus({ preventScroll: true });
    const selection = doc.getSelection();
    anchor = event.shiftKey && selection?.anchorNode && layers().some(candidate => candidate.contains(selection.anchorNode))
      ? { node: selection.anchorNode, offset: selection.anchorOffset } : caret;
    selection?.setBaseAndExtent(anchor.node, anchor.offset, caret.node, caret.offset);
    layer.setPointerCapture(event.pointerId);
  }, options);
  layer.addEventListener('pointermove', event => {
    if (!anchor) return;
    const caret = pdfCaretAt(layerAt(event.clientY), event.clientX, event.clientY);
    if (caret) doc.getSelection()?.setBaseAndExtent(anchor.node, anchor.offset, caret.node, caret.offset);
  }, options);
  const finish = () => { anchor = null; onSelection(); };
  layer.addEventListener('pointerup', finish, options);
  layer.addEventListener('lostpointercapture', finish, options);
  return () => { anchor = null; controller.abort(); };
}
