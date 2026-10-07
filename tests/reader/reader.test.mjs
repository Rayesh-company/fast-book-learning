import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { emittedPdfTextItems, glyphWordRepairs, pdfTextSeparator } from '../../ui/book-reader/pdf-text.mjs';
import { indexPdfText, selectedPdfTextRange } from '../../ui/book-reader/pdf-text-index.mjs';
import { capturePageSelection, installPointerSelection } from '../../ui/book-reader/selection.mjs';
import { cueAt, validateCues, createNarrationPlayer } from '../../ui/book-reader/playback.mjs';
import { focusRectsForPage } from '../../ui/book-reader/pdf-playback-focus.mjs';
import { createBookReader } from '../../ui/book-reader/index.mjs';
import { buildPdfTextIndex } from '../../ui/book-reader/pdf-content.mjs';
import { installNarrationControls } from '../../ui/book-reader/audio-controls.mjs';

function page(values) {
  const dom = new JSDOM('<div id="surface"><div class="textLayer"></div></div>');
  const { document, Node } = dom.window;
  globalThis.Node = Node;
  const layer = document.querySelector('.textLayer');
  const items = values.map(str => ({ str }));
  const index = indexPdfText({ items }, (left, right) => right ? '\n' : '');
  values.forEach((str, i) => {
    const span = document.createElement('span');
    span.dataset.pdfItemIndex = String(i);
    span.dataset.pdfText = 'true';
    span.textContent = str;
    layer.append(span);
  });
  return { document, layer, index, surface: layer.parentElement, page: 2 };
}

test('partial selection keeps the exact characters of the second repeated phrase', () => {
  const p = page(['سلام دنیا', 'سلام دنیا']);
  const node = p.layer.children[1].firstChild;
  const range = p.document.createRange();
  range.setStart(node, 2); range.setEnd(node, 7);
  assert.deepEqual(selectedPdfTextRange(p.index, p.layer, range), { start: 12, end: 17 });
  const selected = capturePageSelection(p, range);
  assert.equal(selected.text, 'ام دن');
  assert.equal(selected.page, 2);
  assert.equal(selected.start, 12);
});

test('selection spanning lines preserves separators and clamps each page', () => {
  const p = page(['سلام دنیا', 'متن دوم']);
  const after = p.document.createElement('p'); after.textContent = 'outside';
  p.surface.after(after);
  const range = p.document.createRange();
  range.setStart(p.layer.children[0].firstChild, 5);
  range.setEnd(after.firstChild, 3);
  assert.equal(capturePageSelection(p, range).text, 'دنیا\nمتن دوم');
});

test('mouse selection continues across adjacent pages while the first layer captures the pointer', () => {
  const p = page(['alpha']);
  const nextLayer = p.layer.cloneNode(true);
  nextLayer.firstChild.textContent = 'bravo';
  p.surface.after(nextLayer);
  const rect = top => ({left:10,right:90,top,bottom:top+20,width:80,height:20});
  p.layer.getBoundingClientRect = () => ({top:0,bottom:100,height:100});
  nextLayer.getBoundingClientRect = () => ({top:110,bottom:210,height:100});
  p.layer.firstChild.getBoundingClientRect = () => rect(40);
  nextLayer.firstChild.getBoundingClientRect = () => rect(140);
  p.layer.setPointerCapture = () => {};
  const remove = installPointerSelection(p.layer, () => {}, () => [p.layer, nextLayer]);
  const Event = p.document.defaultView.MouseEvent;
  p.layer.dispatchEvent(new Event('pointerdown', {clientX:0,clientY:50,button:0}));
  p.layer.dispatchEvent(new Event('pointermove', {clientX:100,clientY:150}));
  const range = p.document.getSelection().getRangeAt(0);
  assert.equal(capturePageSelection(p, range).text, 'alpha');
  const nextPage = {page:3,layer:nextLayer,index:indexPdfText({items:[{str:'bravo'}]}, () => '')};
  assert.equal(capturePageSelection(nextPage, range).text, 'bravo');
  remove();
});

test('selection refuses stale spans instead of guessing a repeated match', () => {
  const p = page(['same', 'same']);
  const range = p.document.createRange();
  range.selectNodeContents(p.layer.children[1]);
  p.layer.children[0].textContent = 'changed';
  assert.equal(capturePageSelection(p, range), null);
});

test('trimmed page edges do not shift selection by the discarded whitespace', () => {
  const p = page(['  alpha', 'beta  ']);
  const range = p.document.createRange();
  range.setStart(p.layer.children[0].firstChild, 2);
  range.setEnd(p.layer.children[1].firstChild, 4);
  assert.equal(capturePageSelection(p, range).text, 'alpha\nbeta');
});

test('audio focus maps trimmed page text back to the original glyph offsets', () => {
  const p = page(['  alpha  ']);
  globalThis.document = p.document;
  const measured = [];
  p.document.defaultView.Range.prototype.getClientRects = function () {
    measured.push(this.toString());
    return [{ left: 10, top: 20, width: 25, height: 12 }];
  };
  const unit = { text: 'alpha', range: { start: 0, end: 5 },
    locatorParts: [{ locator: { kind: 'exact', page: 2 }, segmentStart: 0, range: { start: 0, end: 5 } }] };
  assert.equal(focusRectsForPage({ unit, page: 2, index: p.index, textLayer: p.layer, surface: p.surface })?.length, 1);
  assert.deepEqual(measured, ['alpha']);
});

test('Persian producer control separators contribute spaces without selectable glyphs', () => {
  const item = (str, x, width) => ({ str, dir: 'rtl', width, height: 12, transform: [12, 0, 0, 12, x, 700] });
  const emitted = emittedPdfTextItems([item('سلام', 120, 30), item('\b', 110, 1), item('دنیا', 75, 30)]);
  const items = emitted.map(e => ({ ...e.item, str: e.text, selectable: !e.fromControlMark }));
  assert.equal(indexPdfText({ items }, pdfTextSeparator).text, 'سلام دنیا');
  assert.equal(buildPdfTextIndex({items: emitted.map(e => e.item)}, 1).index.text, 'سلام دنیا');
  assert.equal(emitted.find(e => e.fromControlMark).text, ' ');
});

test('lam-alef repair reverses glyphs without reversing the characters inside a ligature', () => {
  const repairs = glyphWordRepairs([[{unicode:'م'}, {unicode:'لا'}, {unicode:'س'}]]);
  assert.equal(repairs.get('سالم'), 'سلام');
});

const cues = [
  { page: 2, start: 0, end: 4, text: 'سلام', startMs: 200, endMs: 700 },
  { page: 2, start: 5, end: 9, text: 'دنیا', startMs: 900, endMs: 1400 },
];
test('audio focus uses media time, including seeks and silent gaps', async () => {
  class Audio extends EventTarget {
    currentTime = 0; playbackRate = 1; preservesPitch = true;
    async play() { this.dispatchEvent(new Event('playing')); }
    pause() {} removeAttribute() {} load() {}
  }
  const audio = new Audio();
  const focus = [];
  const player = createNarrationPlayer({ bytes: new Uint8Array([1]), mimeType: 'audio/wav', cues,
    createAudioElement: () => audio, onFocus: cue => focus.push(cue?.text ?? null) });
  await player.play();
  audio.currentTime = .4; audio.dispatchEvent(new Event('timeupdate'));
  audio.currentTime = .8; audio.dispatchEvent(new Event('timeupdate'));
  audio.currentTime = 1; audio.dispatchEvent(new Event('seeked'));
  assert.deepEqual(focus.slice(-3), ['سلام', null, 'دنیا']);
  player.dispose();
  const count = focus.length;
  audio.currentTime = .4; audio.dispatchEvent(new Event('timeupdate'));
  assert.equal(focus.length, count);
});

test('invalid or overlapping timing cannot highlight arbitrary book text', () => {
  assert.throws(() => validateCues([{ ...cues[0], end: 5 }]), /text/);
  assert.throws(() => validateCues([cues[0], { ...cues[1], startMs: 600 }]), /timing/);
  assert.equal(cueAt(cues, 700), null);
  assert.equal(cueAt(cues, 900), cues[1]);
});

function renderingFixture() {
  const p = page([]);
  // Canvas and the upstream PDF engine are the external boundary; selection
  // uses real DOM ranges and the production emission/index implementations.
  p.document.defaultView.HTMLCanvasElement.prototype.getContext = () => ({});
  class TextLayer {
    constructor({container, textContentSource}) { this.container = container; this.content = textContentSource; }
    async render() {
      for (const item of this.content.items) {
        const span = p.document.createElement('span'); span.textContent = item.str; this.container.append(span);
      }
    }
    cancel() {}
  }
  const pdfjs = { TextLayer, OPS: {showText: 44} };
  const pdfPage = {
    pageNumber: 2,
    getViewport({scale}) { return {width: 500 * scale, height: 700 * scale, scale}; },
    async getTextContent() { return { items: [{str:'alpha', width:50, height:12, dir:'ltr', transform:[12,0,0,12,20,650]}] }; },
    async getOperatorList() { return {fnArray: [], argsArray: []}; },
    render() { return { promise: Promise.resolve(), cancel() {} }; },
  };
  return {p, reader: createBookReader({pdfjs}), pdfPage};
}

test('text geometry follows page width and the canvas retains device resolution', async () => {
  const {p, reader, pdfPage} = renderingFixture();
  const mounted = reader.mountPage({page:pdfPage, surface:p.surface, width:750, pixelRatio:2});
  await mounted.ready; await mounted.painted;
  assert.equal(mounted.layer.style.getPropertyValue('--total-scale-factor'), '1.5');
  const canvas = p.surface.querySelector('canvas');
  assert.equal(canvas.width, 1500);
  assert.equal(canvas.height, 2100);
  assert.equal(reader.getPageIndex(2).text, 'alpha');
  reader.clear();
});

test('disposing a page during parsing prevents late layers from replacing the next page', async () => {
  const {p, reader, pdfPage} = renderingFixture();
  let finish;
  pdfPage.getTextContent = () => new Promise(resolve => { finish = resolve; });
  const mounted = reader.mountPage({page:pdfPage, surface:p.surface, width:500});
  reader.removePage(2);
  finish({items:[]});
  assert.equal(await mounted.ready, null);
  await mounted.painted;
  assert.equal(p.surface.querySelector('canvas'), null);
  assert.equal(reader.getPageIndex(2), null);
});

function controlsFixture(document) {
  const element = document.createElement('div');
  element.innerHTML = '<button data-reader-read></button><button data-reader-toggle></button><button data-reader-stop></button><select data-reader-speed><option value="1">1</option></select><input data-reader-seek><p data-reader-audio-status></p>';
  document.body.append(element);
  return element;
}

test('audio generation receives exactly the partial book selection and reports server failure', async () => {
  const {p, reader, pdfPage} = renderingFixture();
  await reader.mountPage({page:pdfPage, surface:p.surface, width:500}).ready;
  const node = p.surface.querySelector('[data-pdf-text]').firstChild;
  const range = p.document.createRange(); range.setStart(node, 1); range.setEnd(node, 4);
  const selection = p.document.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  const element = controlsFixture(p.document);
  const status = element.querySelector('[data-reader-audio-status]');
  let sent;
  const failure = new Promise(resolve => {
    const observer = new p.document.defaultView.MutationObserver(() => {
      if (status.textContent === 'سرویس ساخت صدا تنظیم نشده است.') { observer.disconnect(); resolve(); }
    });
    observer.observe(status, {childList:true});
  });
  const controls = installNarrationControls({element, reader, getContext:async()=>({doc:'book',page:2}),
    async fetchImpl(url, options) {
      sent = [url, JSON.parse(options.body)];
      return {ok:false, async json() {return {detail:'سرویس ساخت صدا تنظیم نشده است.'};}};
    }});
  element.querySelector('[data-reader-read]').click();
  await failure;
  assert.deepEqual(sent, ['/books/book/narration', {page:2,start:1,end:4,text:'lph',pageText:'alpha'}]);
  assert.equal(element.querySelector('[data-reader-read]').disabled, false);
  controls.dispose(); reader.clear();
});

test('switching the book while its context loads prevents a stale generation request', async () => {
  const {p, reader} = renderingFixture();
  const element = controlsFixture(p.document);
  let finish;
  let requests = 0;
  const controls = installNarrationControls({element, reader,
    getContext:()=>new Promise(resolve=>{finish=resolve;}),
    fetchImpl:async()=>{requests++;throw new Error('Unexpected stale request');}});
  element.querySelector('[data-reader-read]').click();
  controls.reset();
  finish({doc:'old-book',page:2});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(requests, 0);
  assert.equal(element.querySelector('[data-reader-read]').disabled, false);
  assert.equal(element.querySelector('[data-reader-audio-status]').textContent, '');
  controls.dispose();
});

test('closing the reader during generation prevents delayed autoplay', async () => {
  const {p, reader, pdfPage} = renderingFixture();
  await reader.mountPage({page:pdfPage,surface:p.surface,width:500}).ready;
  const element = controlsFixture(p.document);
  let finish;
  let audioLoads = 0;
  let signal;
  const loadAudio = reader.loadAudio;
  reader.loadAudio = input => { audioLoads++; return loadAudio(input); };
  const controls = installNarrationControls({element,reader,getContext:async()=>({doc:'book',page:2}),
    fetchImpl:async(url,options)=>{signal=options.signal;return new Promise(resolve=>{finish=resolve;});}});
  element.querySelector('[data-reader-read]').click();
  await new Promise(resolve=>setImmediate(resolve));
  controls.suspend();
  assert.equal(signal.aborted, true);
  finish({ok:true,json:async()=>({audioBase64:'AQ==',mimeType:'audio/wav',durationMs:1000,cues:[]})});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(audioLoads, 0);
  assert.equal(element.querySelector('[data-reader-read]').disabled, false);
  assert.equal(element.querySelector('[data-reader-audio-status]').textContent, '');
  controls.dispose(); reader.clear();
});
