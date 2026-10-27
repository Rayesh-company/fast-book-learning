import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { pageSessionPickerMarkup, installPageSessionPicker, pagesForSession, sessionForPageWithSections } from '../../ui/mobile/page-session-picker.mjs';
import { createMobileApp } from '../../ui/mobile/app-ui.mjs';
import { createDemoApi } from '../../ui/mobile/demo-api.mjs';
import { installMobileReaders } from '../../ui/mobile/reader-runtime.mjs';

const tick = () => new Promise(r => setImmediate(r));
const settle = async () => { for (let i = 0; i < 8; i++) await tick(); };

const sampleSessions = [
  { session: 1, cover_page: 41, book_pages: [42, 58], audio_available: true },
  { session: 2, cover_page: 62, book_pages: [63, 75], audio_available: true }
];

async function appFixture({ sessions = sampleSessions } = {}) {
  const dom = new JSDOM('<main id="app"></main>', { url: 'http://localhost/mobile/', pretendToBeVisual: true });
  const api = createDemoApi({ storage: dom.window.localStorage, delay: 0, loginRequired: true });
  await api.saveProfile({ usage_purpose: 'learning' });
  const app = createMobileApp({
    root: dom.window.document.querySelector('#app'),
    api,
    storage: dom.window.localStorage,
    fetchImpl: async url => ({
      ok: true,
      json: async () => url.endsWith('/lectures') ? { sessions } : { pages: [] }
    })
  });
  app.state.demo = false;
  await app.ready;
  return {
    dom,
    root: dom.window.document.querySelector('#app'),
    app,
    close() {
      app.dispose();
      dom.window.close();
    }
  };
}

test('session wheel ordering: "بدون جلسه", then "اشاره", then "مقدمه مؤلف", then sessions', () => {
  const dom = new JSDOM(pageSessionPickerMarkup({ page: 1 })), root = dom.window.document.querySelector('[data-page-session-picker]');
  const picker = installPageSessionPicker({ root, page: 1, count: 100, sessions: sampleSessions });

  const sessionWheel = root.querySelector('[data-session-wheel]');
  const options = [...sessionWheel.querySelectorAll('[role="option"]')];

  assert.deepEqual(options.map(o => o.dataset.value), ['none', 'eshareh', 'preface', '1', '2']);
  assert.equal(options[0].textContent, 'بدون جلسه');
  assert.equal(options[1].textContent, 'اشاره');
  assert.equal(options[2].textContent, 'مقدمه مؤلف');
  assert.equal(options[3].textContent, 'جلسهٔ ۱');
  assert.equal(options[4].textContent, 'جلسهٔ ۲');

  picker.dispose();
  dom.window.close();
});

test('when "بدون جلسه" is selected, user can select from page 1 to the end of the entire book', () => {
  const allPages = pagesForSession(sampleSessions, null, 100);
  assert.equal(allPages.length, 100);
  assert.equal(allPages[0], 1);
  assert.equal(allPages[99], 100);
  // Uncovered pages previously excluded session pages, but now includes all
  assert.ok(allPages.includes(41));
  assert.ok(allPages.includes(42));
  assert.ok(allPages.includes(62));

  const dom = new JSDOM(pageSessionPickerMarkup({ page: 1 })), root = dom.window.document.querySelector('[data-page-session-picker]');
  const picker = installPageSessionPicker({ root, page: 1, count: 100, sessions: sampleSessions });

  root.querySelector('[data-session-wheel] [data-value="none"]').click();
  const pageOptions = [...root.querySelectorAll('[data-page-wheel] [role="option"]')];
  assert.equal(pageOptions.length, 100);
  assert.equal(pageOptions[0].dataset.value, '1');
  assert.equal(pageOptions[99].dataset.value, '100');

  picker.dispose();
  dom.window.close();
});

test('sections "اشاره" (7..34) and "مقدمه مؤلف" (35..40) provide their section ranges', () => {
  const esharehPages = pagesForSession(sampleSessions, 'eshareh', 100);
  assert.equal(esharehPages.length, 28);
  assert.equal(esharehPages[0], 7);
  assert.equal(esharehPages.at(-1), 34);

  const prefacePages = pagesForSession(sampleSessions, 'preface', 100);
  assert.equal(prefacePages.length, 6);
  assert.equal(prefacePages[0], 35);
  assert.equal(prefacePages.at(-1), 40);

  assert.equal(sessionForPageWithSections(sampleSessions, 7), 'eshareh');
  assert.equal(sessionForPageWithSections(sampleSessions, 20), 'eshareh');
  assert.equal(sessionForPageWithSections(sampleSessions, 34), 'eshareh');
  assert.equal(sessionForPageWithSections(sampleSessions, 35), 'preface');
  assert.equal(sessionForPageWithSections(sampleSessions, 40), 'preface');
  assert.equal(sessionForPageWithSections(sampleSessions, 41), 1);
  assert.equal(sessionForPageWithSections(sampleSessions, 4), null);
});

test('when a session is selected, "تمام جلسه" is the first option and automatically selected', () => {
  const dom = new JSDOM(pageSessionPickerMarkup({ page: 1 })), root = dom.window.document.querySelector('[data-page-session-picker]');
  const picker = installPageSessionPicker({ root, page: 1, count: 100, sessions: sampleSessions });

  // Click session 1
  root.querySelector('[data-session-wheel] [data-value="1"]').click();

  const pageWheel = root.querySelector('[data-page-wheel]');
  const pageOptions = [...pageWheel.querySelectorAll('[role="option"]')];

  // First option is "تمام جلسه"
  assert.equal(pageOptions[0].dataset.value, 'all');
  assert.equal(pageOptions[0].textContent, 'تمام جلسه');
  assert.equal(pageOptions[0].getAttribute('aria-selected'), 'true');

  // Next options are pages 41 to 58
  assert.equal(pageOptions[1].dataset.value, '41');
  assert.equal(pageOptions[1].textContent, '۴۱');
  assert.equal(pageOptions.at(-1).dataset.value, '58');

  // Picker value indicates whole session
  assert.equal(picker.value.isAll, true);
  assert.equal(picker.value.session, 1);
  assert.equal(picker.value.page, 41);
  assert.deepEqual(picker.value.pages, Array.from({ length: 58 - 41 + 1 }, (_, i) => 41 + i));

  picker.dispose();
  dom.window.close();
});

test('in chat, selecting "تمام جلسه" sets the composer pill text to "جلسه ۱"', async () => {
  const f = await appFixture();

  // Switch to chat view
  f.root.querySelector('[data-action="menu"]').click();
  f.root.querySelector('[data-action="open-chat"]').click();
  await f.app.settled();

  // Open pages sheet
  f.root.querySelector('[data-action="pages"]').click();
  await f.app.settled();

  // Click session 1 in session wheel (auto selects "تمام جلسه")
  f.root.querySelector('[data-session-wheel] [data-value="1"]').click();

  // Submit pages form
  const form = f.root.querySelector('[data-pages-form]');
  form.dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await f.app.settled();

  // Verify state
  assert.equal(f.app.state.sessionContext, 1);
  assert.deepEqual(f.app.state.pages, Array.from({ length: 58 - 41 + 1 }, (_, i) => 41 + i));

  // Verify chat composer pill displays "جلسه ۱" (or "جلسه 1")
  const pill = f.root.querySelector('.pages-button');
  assert.match(pill.textContent, /جلسه [1۱]/);

  f.close();
});

test('in chat, selecting "اشاره" or "مقدمه مؤلف" sets the composer pill text accordingly', async () => {
  const f = await appFixture();

  f.root.querySelector('[data-action="menu"]').click();
  f.root.querySelector('[data-action="open-chat"]').click();
  await f.app.settled();

  // Select "اشاره"
  f.root.querySelector('[data-action="pages"]').click();
  await f.app.settled();
  f.root.querySelector('[data-session-wheel] [data-value="eshareh"]').click();
  f.root.querySelector('[data-pages-form]').dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await f.app.settled();

  assert.equal(f.app.state.sessionContext, 'eshareh');
  assert.deepEqual(f.app.state.pages, Array.from({ length: 34 - 7 + 1 }, (_, i) => 7 + i));
  assert.match(f.root.querySelector('.pages-button').textContent, /اشاره/);

  // Select "مقدمه مؤلف"
  f.root.querySelector('[data-action="pages"]').click();
  await f.app.settled();
  f.root.querySelector('[data-session-wheel] [data-value="preface"]').click();
  f.root.querySelector('[data-pages-form]').dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await f.app.settled();

  assert.equal(f.app.state.sessionContext, 'preface');
  assert.deepEqual(f.app.state.pages, Array.from({ length: 40 - 35 + 1 }, (_, i) => 35 + i));
  assert.match(f.root.querySelector('.pages-button').textContent, /مقدمه مؤلف/);

  f.close();
});

test('selecting a specific page instead of "تمام جلسه" displays the page number in the composer', async () => {
  const f = await appFixture();

  f.root.querySelector('[data-action="menu"]').click();
  f.root.querySelector('[data-action="open-chat"]').click();
  await f.app.settled();

  f.root.querySelector('[data-action="pages"]').click();
  await f.app.settled();

  // Click session 1
  f.root.querySelector('[data-session-wheel] [data-value="1"]').click();

  // Click page 42 instead of "تمام جلسه"
  f.root.querySelector('[data-page-wheel] [data-value="42"]').click();

  // Submit form
  f.root.querySelector('[data-pages-form]').dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await f.app.settled();

  // Session context is cleared when selecting a specific page
  assert.equal(f.app.state.sessionContext, null);
  assert.deepEqual(f.app.state.pages, [42]);

  // Pill displays active page or page number
  const pill = f.root.querySelector('.pages-button');
  assert.match(pill.textContent, /صفحه/);

  f.close();
});

test('in reader view (allowAll: false), "تمام جلسه" does NOT exist and only page numbers appear', () => {
  const dom = new JSDOM(pageSessionPickerMarkup({ page: 42 })), root = dom.window.document.querySelector('[data-page-session-picker]');
  const picker = installPageSessionPicker({ root, page: 42, count: 100, sessions: sampleSessions, allowAll: false });

  const pageWheel = root.querySelector('[data-page-wheel]');
  let pageOptions = [...pageWheel.querySelectorAll('[role="option"]')];

  // In session 1, options are only pages 41..58, NO "all" / "تمام جلسه"
  assert.ok(!pageOptions.some(o => o.dataset.value === 'all'));
  assert.ok(!pageOptions.some(o => o.textContent.includes('تمام')));
  assert.equal(pageOptions[0].dataset.value, '41');
  assert.equal(picker.value.isAll, false);
  assert.equal(picker.value.page, 42);

  // Click session 2
  root.querySelector('[data-session-wheel] [data-value="2"]').click();
  pageOptions = [...pageWheel.querySelectorAll('[role="option"]')];
  assert.ok(!pageOptions.some(o => o.dataset.value === 'all'));
  assert.ok(!pageOptions.some(o => o.textContent.includes('تمام')));
  assert.equal(pageOptions[0].dataset.value, '62');
  assert.equal(pageOptions.at(-1).dataset.value, '75');
  assert.equal(picker.value.page, 62);
  assert.equal(root.querySelector('input').value, '۶۲');

  // Click "اشاره"
  root.querySelector('[data-session-wheel] [data-value="eshareh"]').click();
  pageOptions = [...pageWheel.querySelectorAll('[role="option"]')];
  assert.ok(!pageOptions.some(o => o.dataset.value === 'all'));
  assert.ok(!pageOptions.some(o => o.textContent.includes('تمام')));
  assert.equal(pageOptions[0].dataset.value, '7');
  assert.equal(pageOptions.at(-1).dataset.value, '34');
  assert.equal(picker.value.page, 7);
  assert.equal(root.querySelector('input').value, '۷');

  // Click "مقدمه مؤلف"
  root.querySelector('[data-session-wheel] [data-value="preface"]').click();
  pageOptions = [...pageWheel.querySelectorAll('[role="option"]')];
  assert.ok(!pageOptions.some(o => o.dataset.value === 'all'));
  assert.ok(!pageOptions.some(o => o.textContent.includes('تمام')));
  assert.equal(pageOptions[0].dataset.value, '35');
  assert.equal(pageOptions.at(-1).dataset.value, '40');
  assert.equal(picker.value.page, 35);
  assert.equal(root.querySelector('input').value, '۳۵');

  picker.dispose();
  dom.window.close();
});

test('in book reader runtime, opening the page picker sheet has no "تمام جلسه" option', async () => {
  const dom = new JSDOM('<main id="app"></main>', { url: 'http://localhost/mobile/?demo=1', pretendToBeVisual: true });
  const doc = dom.window.document, root = doc.querySelector('#app');
  globalThis.Node = dom.window.Node;
  Object.defineProperty(dom.window.HTMLElement.prototype, 'clientWidth', { get() { return this.classList.contains('reader-page') ? 390 : 0; } });
  dom.window.HTMLCanvasElement.prototype.getContext = () => ({});
  const api = createDemoApi({ storage: dom.window.localStorage, delay: 0 });
  const app = createMobileApp({ root, api });
  await app.ready;

  class TextLayer {
    constructor({ container, textContentSource }) { this.container = container; this.content = textContentSource; }
    async render() {
      for (const item of this.content.items) {
        const span = doc.createElement('span');
        span.textContent = item.str;
        this.container.append(span);
      }
    }
    cancel() {}
  }
  const pdfjs = {
    TextLayer,
    OPS: { showText: 44 },
    getDocument() {
      return {
        promise: Promise.resolve({
          numPages: 100,
          async getPage(n) {
            return {
              pageNumber: n,
              getViewport: ({ scale }) => ({ width: 500 * scale, height: 700 * scale, scale }),
              getTextContent: async () => ({ items: [{ str: 'test', width: 50, height: 12, dir: 'ltr', transform: [12, 0, 0, 12, 20, 650] }] }),
              getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
              render: () => ({ promise: Promise.resolve(), cancel() {} })
            };
          }
        }),
        destroy() {}
      };
    }
  };

  const runtime = installMobileReaders({
    root: doc,
    pdfjsLoader: async () => pdfjs,
    fetchImpl: async url => ({
      ok: true,
      json: async () => url.endsWith('/lectures') ? { sessions: sampleSessions } : { pages: [] }
    })
  });
  await runtime.ready();
  await tick();

  // In reader view, click the page badge to open the page sheet
  const trigger = root.querySelector('[data-action="pdf-pages"]');
  trigger.click();

  const panel = root.querySelector('.pdf-page-sheet');
  assert.equal(panel.hidden, false);

  const pageWheel = panel.querySelector('[data-page-wheel]');
  const pageOptions = [...pageWheel.querySelectorAll('[role="option"]')];

  // Ensure NO "all" or "تمام جلسه" option is present in the reader sheet
  assert.ok(!pageOptions.some(o => o.dataset.value === 'all'));
  assert.ok(!pageOptions.some(o => o.textContent.includes('تمام')));

  // Switch session in session wheel
  const session1Btn = panel.querySelector('[data-session-wheel] [data-value="1"]');
  if (session1Btn) {
    session1Btn.click();
    const updatedPageOptions = [...pageWheel.querySelectorAll('[role="option"]')];
    assert.ok(!updatedPageOptions.some(o => o.dataset.value === 'all'));
    assert.ok(!updatedPageOptions.some(o => o.textContent.includes('تمام')));
    assert.equal(updatedPageOptions[0].dataset.value, '41');
  }

  runtime.dispose();
  app.dispose();
  dom.window.close();
});
