import { readPdfText, pdfTextSeparator } from './pdf-text.mjs';
import { buildPdfTextIndex } from './pdf-content.mjs';
import { capturePageSelection, installPointerSelection } from './selection.mjs';
import { focusRectsForPage } from './pdf-playback-focus.mjs';
import { createNarrationPlayer } from './playback.mjs';
import { continuousRects } from './highlight-geometry.mjs';

// Tuba's original glyph outlines, without browser font substitution/reshaping.
export const PDF_RENDER_OPTIONS = Object.freeze({ disableFontFace: true, useSystemFonts: false });

/** PDF display, exact selection and transient audio focus. No notes/chat/store. */
export function createBookReader({ pdfjs, onSelection = () => {}, onPaintError = () => {} }) {
  const pages = new Map();
  let focus = null;
  let player = null;
  let savedHighlights = [];

  function rangeRects(record, passage) {
    const unit = {text:passage.text,range:{start:passage.start,end:passage.end},
      locatorParts:[{locator:{kind:'exact',page:passage.page},segmentStart:0,range:{start:passage.start,end:passage.end}}]};
    return focusRectsForPage({unit,page:record.page,index:record.index,textLayer:record.layer,surface:record.surface});
  }
  function appendRects(record, overlay, rects) {
    for (const rect of continuousRects(rects)) {
      const span = record.surface.ownerDocument.createElement('span');
      for (const key of ['left','top','width','height']) span.style[key] = `${rect[key]}px`;
      overlay.append(span);
    }
  }
  function paintSaved(record) {
    record.savedOverlay.replaceChildren();
    if (!record.index) return;
    const rects = savedHighlights.filter(p=>p.page===record.page).flatMap(p=>continuousRects(rangeRects(record,p)||[]));
    // Separate selections may overlap, but an unselected gap stays unpainted.
    for(const rect of continuousRects(rects,0)){
      const span=record.surface.ownerDocument.createElement('span');
      for(const key of ['left','top','width','height'])span.style[key]=`${rect[key]}px`;
      record.savedOverlay.append(span);
    }
  }

  function paintFocus(record) {
    record.overlay.replaceChildren();
    if (focus?.tone) record.overlay.dataset.tone = focus.tone; else delete record.overlay.dataset.tone;
    if (!focus || focus.page !== record.page) return;
    if (focus.boxes) { paintBoxes(record); return; }
    if (!record.index) return;
    const unit = { text: focus.text, range: { start: focus.start, end: focus.end },
      locatorParts: [{ locator: { kind: 'exact', page: focus.page }, segmentStart: 0,
        range: { start: focus.start, end: focus.end } }] };
    const rects = focusRectsForPage({ unit, page: record.page, index: record.index,
      textLayer: record.layer, surface: record.surface });
    if (!rects) return; // Never guess geometry for missing/stale text.
    appendRects(record,record.overlay,rects);
  }
  // Precomputed geometry (lecture read-along): PDF-point rectangles,
  // top-left origin, scaled to the page as currently laid out.
  function paintBoxes(record) {
    const scale = record.surface.getBoundingClientRect().width / record.pointWidth;
    if (!Number.isFinite(scale) || scale <= 0) return;
    for (const box of focus.boxes) {
      const span = record.surface.ownerDocument.createElement('span');
      span.style.left = `${box.x0 * scale - 2}px`; span.style.top = `${box.y0 * scale - 1}px`;
      span.style.width = `${(box.x1 - box.x0) * scale + 4}px`; span.style.height = `${(box.y1 - box.y0) * scale + 2}px`;
      record.overlay.append(span);
    }
  }
  const highlight = cue => { focus = cue; for (const record of pages.values()) paintFocus(record); };
  const setHighlights = passages => { savedHighlights = [...passages]; for (const record of pages.values()) paintSaved(record); };

  function mountPage({ page, surface, width, pixelRatio = 1, isCurrent = () => true }) {
    removePage(page.pageNumber);
    const doc = surface.ownerDocument;
    surface.classList.add('book-reader-surface');
    const viewport = page.getViewport({ scale: width / page.getViewport({ scale: 1 }).width });
    surface.style.width = `${viewport.width}px`;
    surface.style.height = `${viewport.height}px`;
    const canvas = doc.createElement('canvas');
    canvas.className = 'book-reader-canvas';
    canvas.setAttribute('aria-label', `تصویر اصلی صفحهٔ ${page.pageNumber}`);
    canvas.width = Math.ceil(viewport.width * pixelRatio);
    canvas.height = Math.ceil(viewport.height * pixelRatio);
    const layer = doc.createElement('div');
    layer.className = 'textLayer';
    layer.setAttribute('aria-label', `متن قابل انتخاب صفحهٔ ${page.pageNumber}`);
    layer.style.setProperty('--total-scale-factor', String(viewport.scale));
    const overlay = doc.createElement('div');
    overlay.className = 'book-reader-playback-focus';
    overlay.setAttribute('aria-hidden', 'true');
    const savedOverlay = doc.createElement('div');
    savedOverlay.className = 'book-reader-saved-highlights'; savedOverlay.setAttribute('aria-hidden','true');
    const record = { page: page.pageNumber, surface, layer, overlay, savedOverlay, index: null, disposed: false,
      pointWidth: viewport.width / viewport.scale };
    const active = () => !record.disposed && isCurrent();
    pages.set(record.page, record);
    let renderTask;
    let textLayer;
    let removeSelection = () => {};
    let observer;
    record.dispose = () => {
      if (record.disposed) return;
      record.disposed = true;
      renderTask?.cancel(); textLayer?.cancel(); observer?.disconnect(); removeSelection();
      layer.remove(); overlay.remove(); savedOverlay.remove(); canvas.remove();
    };
    // Recorded lectures already have PDF-point geometry. Paint independently
    // of text extraction, which can finish much later (or fail) on a cold page.
    surface.append(savedOverlay,overlay);
    const syncScale = () => {
      layer.style.setProperty('--total-scale-factor', String(surface.getBoundingClientRect().width / record.pointWidth));
      paintFocus(record);
      paintSaved(record);
    };
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(syncScale); observer.observe(surface);
    }
    paintFocus(record);
    // Text is prepared separately from canvas painting, as in Tuba. Hidden
    // windows must not hold up selection while requestAnimationFrame waits.
    record.painted = (async () => {
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas is unavailable');
      renderTask = page.render({ canvas, canvasContext: context, viewport,
        transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0] });
      await renderTask.promise;
      if (!active()) return;
      surface.prepend(canvas);
      surface.querySelector('.reader-img')?.remove();
    })().catch(error => { if (active()) onPaintError(error, record.page); });
    record.ready = (async () => {
      const content = await readPdfText(page, pdfjs.OPS.showText);
      if (!active()) return null;
      textLayer = new pdfjs.TextLayer({ container: layer, textContentSource: content, viewport });
      await textLayer.render();
      if (!active()) return null;
      const items = content.items.filter(item => 'str' in item);
      const { emission, indexItems, index } = buildPdfTextIndex(content, record.page);
      const positions = new Map(emission.map((entry, position) => [entry.item, position]));
      const spans = layer.querySelectorAll('span');
      const byPosition = new Map();
      let spanIndex = 0;
      for (const item of items) {
        if (!item.str) continue;
        const span = spans[spanIndex++];
        if (!span) continue;
        const position = positions.get(item);
        if (position === undefined) { span.textContent = ''; continue; }
        span.dataset.pdfItemIndex = String(position);
        span.dataset.separator = pdfTextSeparator(indexItems[position], indexItems[position + 1]);
        if (!emission[position].fromControlMark) span.dataset.pdfText = 'true';
        span.textContent = indexItems[position].str;
        byPosition.set(position, span);
      }
      for (let position = 0; position < indexItems.length; position++) {
        const span = byPosition.get(position);
        if (span) layer.append(span);
      }
      record.index = index;
      surface.append(layer, savedOverlay, overlay);
      removeSelection = installPointerSelection(layer, onSelection,
        () => [...pages.values()].filter(page => page.index && !page.disposed).map(page => page.layer));
      paintFocus(record);
      paintSaved(record);
      return { content, index: record.index };
    })();
    return record;
  }

  function removePage(page) { pages.get(page)?.dispose(); pages.delete(page); }
  function clear() {
    player?.dispose(); player = null; focus = null; savedHighlights = [];
    for (const page of [...pages.keys()]) removePage(page);
  }
  return {
    mountPage, removePage, clear, highlight, setHighlights,
    pause() { player?.pause(); },
    getPageIndex: page => pages.get(page)?.index ?? null,
    /** A client point on a mounted page as PDF points (top-left origin). */
    pointAt(page, clientX, clientY) {
      const record = pages.get(page);
      if (!record || record.disposed) return null;
      const bounds = record.surface.getBoundingClientRect();
      const scale = bounds.width / record.pointWidth;
      if (!(scale > 0)) return null;
      return { x: (clientX - bounds.left) / scale, y: (clientY - bounds.top) / scale };
    },
    captureSelection(selection = pages.values().next().value?.surface.ownerDocument.getSelection()) {
      if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
      const range = selection.getRangeAt(0);
      const selections = [];
      for (const record of [...pages.values()].sort((a, b) => a.page - b.page)) {
        if (!record.index || record.disposed || !range.intersectsNode(record.layer)) continue;
        const selected = capturePageSelection(record, range);
        if (!selected) return null;
        selections.push(selected);
      }
      return selections.length ? { text: selections.map(p => p.text).join('\n'), pages: selections } : null;
    },
    loadAudio(input) {
      player?.dispose();
      const { onFocus = () => {}, ...rest } = input;
      player = createNarrationPlayer({ ...rest, onFocus(cue) { highlight(cue); onFocus(cue); } });
      return player;
    },
  };
}
