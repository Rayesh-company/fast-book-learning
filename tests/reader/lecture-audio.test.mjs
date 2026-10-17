import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { installLectureAudio } from '../../ui/book-reader/lecture-audio.mjs';
import { createBookReader } from '../../ui/book-reader/index.mjs';

const tick = () => new Promise(r => setImmediate(r));

class MockAudio {
  constructor() {
    this.listeners = new Map();
    this.src = '';
    this.currentTime = 0;
    this.duration = 1800;
    this.playbackRate = 1.0;
    this.paused = true;
  }
  addEventListener(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(fn);
  }
  removeEventListener(event, fn) {
    const list = this.listeners.get(event) || [];
    this.listeners.set(event, list.filter(l => l !== fn));
  }
  dispatchEvent(event) {
    const list = this.listeners.get(event.type) || [];
    for (const fn of list) fn(event);
  }
  async play() {
    this.paused = false;
    this.dispatchEvent({ type: 'playing' });
  }
  pause() {
    this.paused = true;
    this.dispatchEvent({ type: 'pause' });
  }
  load() {}
  removeAttribute() {}
}

function fixture({ initialPage = 100, fetchImpl } = {}) {
  const dom = new JSDOM(`
    <main>
      <div class="audio-widget">
        <button data-audio-previous></button>
        <button data-audio-play></button>
        <button data-audio-next></button>
      </div>
      <section class="pdf-audio-sheet">
        <select data-lecture-session></select>
        <input type="checkbox" data-lecture-skip-intro checked>
        <button data-reader-toggle>پخش</button>
        <button data-reader-stop disabled>توقف</button>
        <select data-reader-speed>
          <option value="0.75">0.75x</option>
          <option value="1" selected>1x</option>
          <option value="1.5">1.5x</option>
        </select>
        <input type="range" data-reader-seek min="0" max="0" step="0.5" value="0">
        <span data-lecture-current-time>۰۰:۰۰</span>
        <span data-lecture-duration>۰۰:۰۰</span>
        <p data-reader-audio-status></p>
      </section>
    </main>
  `);
  const element = dom.window.document.querySelector('main');
  const highlighted = [];
  const navigatedPages = [];
  let page = initialPage;
  let createdAudio = null;

  const summary = [
    { session: 1, duration: 1800, lecture_start: 35.5, lecture_end: 1750, book_pages: [100, 124], audio_available: true, audio_url: '/books/tarhe-kolli/lectures/1/audio' },
    { session: 2, duration: 2000, lecture_start: 40.0, lecture_end: 1950, book_pages: [125, 149], audio_available: true, audio_url: '/books/tarhe-kolli/lectures/2/audio' },
  ];

  const sessionDetails = {
    1: {
      session: 1,
      duration: 1800,
      lecture_start: 35.5,
      lecture_end: 1750,
      book_pages: [100, 124],
      audio_available: true,
      audio_url: '/books/tarhe-kolli/lectures/1/audio',
      cues: [
        { start: 35.5, end: 45.0, text: 'بخش اول جلسه', page: 100, boxes: [[10, 20, 100, 30]] },
        { start: 45.0, end: 60.0, text: 'بخش دوم جلسه در صفحه بعد', page: 101, boxes: [[15, 25, 120, 35]] },
      ],
    },
    2: {
      session: 2,
      duration: 2000,
      lecture_start: 40.0,
      lecture_end: 1950,
      book_pages: [125, 149],
      audio_available: true,
      audio_url: '/books/tarhe-kolli/lectures/2/audio',
      cues: [
        { start: 40.0, end: 50.0, text: 'شروع جلسه دوم', page: 125, boxes: [[10, 20, 100, 30]] },
      ],
    },
  };

  const defaultFetch = async (url) => {
    if (url === '/books/tarhe-kolli/lectures') {
      return { ok: true, json: async () => summary };
    }
    const match = url.match(/\/books\/tarhe-kolli\/lectures\/(\d+)$/);
    if (match) {
      const num = Number(match[1]);
      if (sessionDetails[num]) return { ok: true, json: async () => sessionDetails[num] };
    }
    return { ok: false, status: 404, json: async () => ({ detail: 'Not found' }) };
  };

  const audio = installLectureAudio({
    element,
    reader: {
      highlight: (cue) => highlighted.push(cue),
    },
    getContext: () => ({ doc: 'tarhe-kolli', page, numPages: 862 }),
    showPage: async (p) => {
      page = p;
      navigatedPages.push(p);
    },
    fetchImpl: fetchImpl || defaultFetch,
    createAudioElement: () => {
      createdAudio = new MockAudio();
      return createdAudio;
    },
  });

  return {
    dom,
    element,
    audio,
    highlighted,
    navigatedPages,
    get createdAudio() { return createdAudio; },
    getPage: () => page,
    close() {
      audio.dispose();
      dom.window.close();
    },
  };
}

test('initialization loads session summary and maps initial page to session', async () => {
  const f = fixture({ initialPage: 100 });
  const ok = await f.audio.ready;
  assert.equal(ok, true);
  const select = f.element.querySelector('[data-lecture-session]');
  assert.equal(select.children.length, 2);
  assert.equal(select.value, '1');
  assert.match(select.children[0].textContent, /جلسهٔ ۱/);
  f.close();

  const f2 = fixture({ initialPage: 130 });
  await f2.audio.ready;
  assert.equal(f2.element.querySelector('[data-lecture-session]').value, '2');
  f2.close();
});

test('play starts audio, applies skip-intro to lecture_start, and updates UI state', async () => {
  const f = fixture({ initialPage: 100 });
  await f.audio.ready;
  const playButton = f.element.querySelector('[data-audio-play]');
  playButton.click();
  for (let i = 0; i < 6; i++) await tick();

  assert.ok(f.createdAudio);
  assert.equal(f.createdAudio.src, '/books/tarhe-kolli/lectures/1/audio');
  assert.equal(f.createdAudio.currentTime, 35.5);
  assert.equal(playButton.dataset.state, 'playing');
  assert.equal(f.element.querySelector('[data-reader-toggle]').textContent, 'مکث');
  f.close();
});

test('timeupdate highlights cues and automatically turns pages across page boundaries', async () => {
  const f = fixture({ initialPage: 100 });
  await f.audio.ready;
  f.element.querySelector('[data-audio-play]').click();
  for (let i = 0; i < 6; i++) await tick();

  // First cue at 36s (page 100)
  f.createdAudio.currentTime = 36.0;
  f.createdAudio.dispatchEvent({ type: 'timeupdate' });
  await tick();
  assert.equal(f.highlighted.at(-1)?.text, 'بخش اول جلسه');
  assert.equal(f.navigatedPages.length, 0);

  // Second cue at 46s (page 101) - crosses page boundary
  f.createdAudio.currentTime = 46.0;
  f.createdAudio.dispatchEvent({ type: 'timeupdate' });
  await tick();
  assert.deepEqual(f.navigatedPages, [101]);
  assert.equal(f.highlighted.at(-1)?.text, 'بخش دوم جلسه در صفحه بعد');
  f.close();
});

test('speed control updates audio playbackRate', async () => {
  const f = fixture({ initialPage: 100 });
  await f.audio.ready;
  f.element.querySelector('[data-audio-play]').click();
  for (let i = 0; i < 6; i++) await tick();

  const speedSelect = f.element.querySelector('[data-reader-speed]');
  speedSelect.value = '1.5';
  speedSelect.dispatchEvent(new f.dom.window.Event('change'));
  assert.equal(f.createdAudio.playbackRate, 1.5);
  f.close();
});

test('changing session navigates to session start page and updates current session', async () => {
  const f = fixture({ initialPage: 100 });
  await f.audio.ready;
  const select = f.element.querySelector('[data-lecture-session]');
  select.value = '2';
  select.dispatchEvent(new f.dom.window.Event('change'));
  for (let i = 0; i < 6; i++) await tick();

  assert.deepEqual(f.navigatedPages, [125]);
  assert.equal(f.audio.session, 2);
  f.close();
});

test('onPageChanged updates session selector when playback is paused', async () => {
  const f = fixture({ initialPage: 100 });
  await f.audio.ready;
  assert.equal(f.element.querySelector('[data-lecture-session]').value, '1');

  f.audio.onPageChanged(130);
  assert.equal(f.element.querySelector('[data-lecture-session]').value, '2');
  f.close();
});

test('book reader highlight paints boxes with top-left origin coordinates without vertical inversion', async () => {
  const dom = new JSDOM('<div id="surface"></div>');
  const surface = dom.window.document.getElementById('surface');
  const pdfPage = {
    pageNumber: 42,
    getViewport({ scale }) {
      return { width: 411.02 * scale, height: 595.28 * scale, scale };
    },
    async getTextContent() { return { items: [] }; },
    async getOperatorList() { return { fnArray: [], argsArray: [] }; },
    render() { return { promise: Promise.resolve(), cancel() {} }; },
  };
  const reader = createBookReader({
    pdfjs: {
      TextLayer: class { render() { return Promise.resolve(); } cancel() {} },
      OPS: { showText: 44 },
    },
  });
  const mounted = reader.mountPage({ page: pdfPage, surface, width: 411.02 });
  await mounted.ready;
  await mounted.painted;

  // Box from session 1 cue 0 for 'برای': [42, 244.3, 313.0, 269.1, 332.9]
  reader.highlight({
    page: 42,
    boxes: [[42, 244.3, 313.0, 269.1, 332.9]],
  });

  const span = surface.querySelector('.book-reader-playback-focus span');
  assert.ok(span, 'highlight span should be rendered');
  assert.equal(span.style.top, '313px');
  assert.equal(span.style.left, '244.3px');
  assert.equal(span.style.width, '24.8px');
  assert.equal(span.style.height, '19.9px');
});

test('timeupdate highlights full sentence boxes and bridges brief pauses without flicker', async () => {
  const customSession = {
    session: 1,
    duration: 1800,
    lecture_start: 20.0,
    lecture_end: 1750,
    book_pages: [42, 58],
    audio_available: true,
    audio_url: '/books/tarhe-kolli/lectures/1/audio',
    sentences: [
      {
        id: 0,
        start: 20.0,
        end: 21.56,
        page: 42,
        page_end: 42,
        text: 'آیه قرآن',
        boxes: [[42, 107.9, 175.7, 303.2, 197.1]],
      },
      {
        id: 1,
        start: 21.56,
        end: 32.42,
        page: 42,
        page_end: 42,
        text: 'جمله اول',
        boxes: [
          [42, 34.0, 313.0, 377.0, 332.9],
          [42, 272.0, 338.0, 377.0, 357.9],
        ],
      },
      {
        id: 2,
        start: 33.0, // 0.58s gap after sentence 1
        end: 38.0,
        page: 42,
        page_end: 42,
        text: 'جمله دوم',
        boxes: [[42, 59.0, 338.0, 268.1, 357.9]],
      },
      {
        id: 3,
        start: 45.0, // 7.0s gap after sentence 2 (unscripted commentary)
        end: 50.0,
        page: 42,
        page_end: 42,
        text: 'جمله سوم',
        boxes: [[42, 34.0, 362.8, 377.0, 383.3]],
      },
    ],
    cues: [
      { id: 0, sentence_id: 1, start: 23.7, end: 26.94, page: 42, text: 'بخش کوچکی از جمله اول', boxes: [[42, 244.3, 313.0, 269.1, 332.9]] },
    ],
  };

  const f = fixture({
    initialPage: 42,
    fetchImpl: async (url) => {
      if (url === '/books/tarhe-kolli/lectures') {
        return { ok: true, json: async () => [{ session: 1, book_pages: [42, 58], audio_available: true }] };
      }
      return { ok: true, json: async () => customSession };
    },
  });

  await f.audio.ready;
  f.element.querySelector('[data-audio-play]').click();
  for (let i = 0; i < 6; i++) await tick();

  // 1. Sentence 0 (Quranic verse at 20.5s, which has NO cues): should be highlighted with full sentence boxes
  f.createdAudio.currentTime = 20.5;
  f.createdAudio.dispatchEvent({ type: 'timeupdate' });
  await tick();
  assert.equal(f.highlighted.at(-1)?.id, 0);
  assert.equal(f.highlighted.at(-1)?.boxes.length, 1);
  assert.equal(f.highlighted.at(-1)?.text, 'آیه قرآن');

  // 2. Sentence 1 at 24.0s (during cue 0): should highlight FULL sentence boxes (both lines, 2 boxes), not just 1 cue box
  f.createdAudio.currentTime = 24.0;
  f.createdAudio.dispatchEvent({ type: 'timeupdate' });
  await tick();
  assert.equal(f.highlighted.at(-1)?.id, 1);
  assert.equal(f.highlighted.at(-1)?.boxes.length, 2); // Full sentence line boxes!

  // 3. Brief gap between sentence 1 and 2 (at 32.7s): should bridge and maintain sentence 1 without flicker
  f.createdAudio.currentTime = 32.7;
  f.createdAudio.dispatchEvent({ type: 'timeupdate' });
  await tick();
  assert.equal(f.highlighted.at(-1)?.id, 1);

  // 4. Sentence 2 starts at 33.0s: moves to sentence 2
  f.createdAudio.currentTime = 34.0;
  f.createdAudio.dispatchEvent({ type: 'timeupdate' });
  await tick();
  assert.equal(f.highlighted.at(-1)?.id, 2);

  // 5. Long gap at 40.0s (> 1.8s gap): clears highlight during unscripted speech
  f.createdAudio.currentTime = 40.0;
  f.createdAudio.dispatchEvent({ type: 'timeupdate' });
  await tick();
  assert.equal(f.highlighted.at(-1), null);

  f.close();
});
