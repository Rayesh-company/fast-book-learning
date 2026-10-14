import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createMobileApp } from '../../ui/mobile/app-ui.mjs';
import { createDemoApi } from '../../ui/mobile/demo-api.mjs';
import { createApi } from '../../ui/mobile/api.mjs';

function makeSSEResponse(lines = []) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(line));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
  });
}

async function fixture({ profileCompleted = true } = {}) {
  const dom = new JSDOM('<main id="app"></main>', {
    url: 'http://localhost/mobile/',
    pretendToBeVisual: true,
  });
  const api = createDemoApi({
    storage: dom.window.localStorage,
    delay: 0,
    loginRequired: true,
  });
  if (profileCompleted) {
    await api.saveProfile({ usage_purpose: 'learning' });
  }

  const app = createMobileApp({
    root: dom.window.document.querySelector('#app'),
    api,
    storage: dom.window.localStorage,
  });
  app.state.demo = false;
  await app.ready;
  return {
    dom,
    doc: dom.window.document,
    api,
    app,
    close() {
      app.dispose();
      dom.window.close();
    },
  };
}

const tick = () => new Promise(r => setTimeout(r, 10));

test('transitioning from book reader to chat sets scope to page and current reader page', async () => {
  const f = await fixture();
  assert.equal(f.app.state.view, 'reader');
  // Set reader position to page 42
  f.doc.querySelector('.phone').dataset.pdfPage = '42';
  f.app.state.positions['tarhe-kolli'] = { page: 42 };

  // Open drawer menu and click open-chat
  f.doc.querySelector('[data-action="menu"]').click();
  const openChatBtn = f.doc.querySelector('[data-action="open-chat"]');
  assert.ok(openChatBtn, 'open-chat button should exist in reader drawer');
  openChatBtn.click();
  await f.app.settled();

  // Acceptance criteria 1
  assert.equal(f.app.state.view, 'chat');
  assert.equal(f.app.state.scope, 'page');
  assert.deepEqual(f.app.state.pages, [42]);

  // Visual styling and label
  const pill = f.doc.querySelector('.pages-button');
  assert.ok(pill, '.pages-button should exist in composer');
  assert.ok(pill.classList.contains('scope-neutral'), 'active page scope should have .scope-neutral class');
  assert.match(pill.textContent, /صفحه فعلی/);

  f.close();
});

test('new-chat from sidebar or switching books defaults to whole-book scope ("all")', async () => {
  const f = await fixture();
  // Open chat first
  f.doc.querySelector('[data-action="menu"]').click();
  f.doc.querySelector('[data-action="open-chat"]').click();
  await f.app.settled();
  assert.equal(f.app.state.scope, 'page');

  // Trigger new-chat from drawer menu
  f.doc.querySelector('[data-action="menu"]').click();
  const newChatBtn = f.doc.querySelector('[data-action="new-chat"]');
  assert.ok(newChatBtn, 'new-chat button should exist in chat drawer');
  newChatBtn.click();
  await f.app.settled();

  // Acceptance criteria 2: new-chat sets scope to 'all'
  assert.equal(f.app.state.scope, 'all');
  const pillAfterNewChat = f.doc.querySelector('.pages-button');
  assert.ok(pillAfterNewChat.classList.contains('scope-neutral'), 'whole-book scope should have .scope-neutral class');
  assert.match(pillAfterNewChat.textContent, /کل کتاب/);

  // Transition back to page scope
  f.doc.querySelector('[data-action="menu"]').click();
  f.doc.querySelector('[data-action="open-reader"]').click();
  await f.app.settled();
  f.doc.querySelector('[data-action="menu"]').click();
  f.doc.querySelector('[data-action="open-chat"]').click();
  await f.app.settled();
  assert.equal(f.app.state.scope, 'page');

  // Switch book
  f.doc.querySelector('[data-action="menu"]').click();
  f.doc.querySelector('[data-action="books"]').click();
  const otherBookBtn = f.doc.querySelector('[data-action="select-book"][data-book="70143-336"]');
  assert.ok(otherBookBtn, 'second book button should exist');
  otherBookBtn.click();
  await f.app.settled();

  // Acceptance criteria 2: switching books defaults to whole-book scope
  assert.equal(f.app.state.scope, 'all');
  const pillAfterBookSwitch = f.doc.querySelector('.pages-button');
  assert.ok(pillAfterBookSwitch.classList.contains('scope-neutral'), 'switched book should have .scope-neutral class');
  assert.match(pillAfterBookSwitch.textContent, /کل کتاب/);

  f.close();
});

test('tapping the page pill toggles between active page scope and whole-book scope', async () => {
  const f = await fixture();
  f.doc.querySelector('[data-action="menu"]').click();
  f.doc.querySelector('[data-action="open-chat"]').click();
  await f.app.settled();

  // Initially active page scope
  assert.equal(f.app.state.scope, 'page');
  const pill = f.doc.querySelector('.pages-button');
  assert.ok(pill.classList.contains('scope-neutral'));
  assert.match(pill.textContent, /صفحه فعلی/);

  // Tap page pill -> toggle to 'all'
  pill.click();
  await f.app.settled();

  assert.equal(f.app.state.scope, 'all');
  const pillOutline = f.doc.querySelector('.pages-button');
  assert.ok(pillOutline.classList.contains('scope-neutral'));
  assert.match(pillOutline.textContent, /کل کتاب/);

  // Tap page pill again -> toggle back to 'page'
  pillOutline.click();
  await f.app.settled();

  assert.equal(f.app.state.scope, 'page');
  const pillActiveAgain = f.doc.querySelector('.pages-button');
  assert.ok(pillActiveAgain.classList.contains('scope-neutral'));
  assert.match(pillActiveAgain.textContent, /صفحه فعلی/);

  f.close();
});

test('selecting custom page in modal sets scope to page, and clear-pages resets to whole-book', async () => {
  const f = await fixture();
  f.doc.querySelector('[data-action="menu"]').click();
  f.doc.querySelector('[data-action="open-chat"]').click();
  await f.app.settled();

  // Open pages sheet
  const pagesTrigger = f.doc.querySelector('[data-action="pages"]');
  assert.ok(pagesTrigger, 'a button with data-action="pages" must exist to open sheet');
  pagesTrigger.click();

  const pagesForm = f.doc.querySelector('[data-pages-form]');
  assert.ok(pagesForm, 'data-pages-form must exist in sheet');

  // Input custom page 25
  const singleInput = pagesForm.querySelector('input[name="single"]');
  singleInput.value = '25';
  pagesForm.dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await f.app.settled();

  // Acceptance criteria 4: selecting custom page updates s.scope = 'page'
  assert.equal(f.app.state.scope, 'page');
  assert.deepEqual(f.app.state.pages, [25]);
  const pillCustom = f.doc.querySelector('.pages-button');
  assert.ok(pillCustom.classList.contains('scope-neutral'));
  assert.match(pillCustom.textContent, /۲۵/);

  // Re-open modal and click clear-pages
  f.doc.querySelector('[data-action="pages"]').click();
  const clearBtn = f.doc.querySelector('[data-action="clear-pages"]');
  assert.ok(clearBtn, 'clear-pages button should exist');
  clearBtn.click();
  await f.app.settled();

  // Acceptance criteria 4: clearing pages resets scope to 'all'
  assert.equal(f.app.state.scope, 'all');
  assert.deepEqual(f.app.state.pages, []);
  const pillCleared = f.doc.querySelector('.pages-button');
  assert.ok(pillCleared.classList.contains('scope-neutral'));
  assert.match(pillCleared.textContent, /کل کتاب/);

  f.close();
});

test('submitting a question transmits book, page, and scope in API payload', async () => {
  const f = await fixture();
  f.doc.querySelector('.phone').dataset.pdfPage = '55';
  f.app.state.positions['tarhe-kolli'] = { page: 55 };

  // Go to chat from reader
  f.doc.querySelector('[data-action="menu"]').click();
  f.doc.querySelector('[data-action="open-chat"]').click();
  await f.app.settled();

  let lastAsk = null;
  const originalAsk = f.api.ask.bind(f.api);
  f.api.ask = async (input, options) => {
    lastAsk = input;
    return originalAsk(input, options);
  };

  // Submit question in active page scope
  const textarea = f.doc.querySelector('textarea[name="question"]');
  textarea.value = 'پرسش آزمایشی ۱';
  const chatForm = f.doc.querySelector('[data-chat-form]');
  chatForm.dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await f.app.settled();
  await tick();

  // Acceptance criteria 5: sends { book, page, scope }
  assert.ok(lastAsk, 'api.ask should have been called');
  assert.equal(lastAsk.book, 'tarhe-kolli');
  assert.equal(lastAsk.page, 55);
  assert.equal(lastAsk.scope, 'page');

  // Now toggle to whole-book scope
  f.doc.querySelector('.pages-button').click();
  await f.app.settled();
  assert.equal(f.app.state.scope, 'all');

  const textarea2 = f.doc.querySelector('textarea[name="question"]');
  textarea2.value = 'پرسش آزمایشی ۲';
  const chatForm2 = f.doc.querySelector('[data-chat-form]');
  chatForm2.dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await f.app.settled();
  await tick();

  assert.equal(lastAsk.book, 'tarhe-kolli');
  assert.equal(lastAsk.scope, 'all');

  f.close();
});

test('createApi.ask transmits book, page, scope, and optional selection in POST body to /agent/chat', async () => {
  let capturedBody = null;
  const mockFetch = async (url, options) => {
    assert.equal(url, '/agent/chat');
    capturedBody = JSON.parse(options.body);
    return makeSSEResponse([
      'data: {"type":"text-delta","payload":{"text":"پاسخ"}}\n\n',
      'data: {"type":"chat-answer-finalized","payload":{"answer":"پاسخ"}}\n\n',
    ]);
  };

  const api = createApi({ fetchImpl: mockFetch });
  await api.ask({
    question: 'سوال تستی',
    book: 'tarhe-kolli',
    page: 77,
    scope: 'page',
    selection: { text: 'فراز انتخاب شده', page: 77, book: 'tarhe-kolli' },
  });

  assert.ok(capturedBody);
  assert.equal(capturedBody.query, 'سوال تستی');
  assert.equal(capturedBody.book, 'tarhe-kolli');
  assert.equal(capturedBody.page, 77);
  assert.equal(capturedBody.scope, 'page');
  assert.deepEqual(capturedBody.selection, { text: 'فراز انتخاب شده', page: 77, book: 'tarhe-kolli' });
});

test('expandQuestion sets scope to page and updates pill styling and aria-label', async () => {
  const f = await fixture();
  // Set initial scope to all
  f.app.state.scope = 'all';

  // Emit reader-question event
  f.doc.querySelector('#app').dispatchEvent(new f.dom.window.CustomEvent('reader-question', {
    bubbles: true,
    detail: {
      text: 'برشی از متن',
      pages: [{ page: 42, start: 0, end: 10 }],
    },
  }));
  await f.app.settled();

  // Trigger expand-question
  const handle = f.doc.querySelector('[data-action="expand-question"]');
  assert.ok(handle, 'expand-question handle should exist');
  handle.click();
  await f.app.settled();

  assert.equal(f.app.state.view, 'chat');
  assert.equal(f.app.state.scope, 'page');
  assert.deepEqual(f.app.state.pages, [42]);

  const pill = f.doc.querySelector('.pages-button');
  assert.ok(pill.classList.contains('scope-neutral'), 'should have .scope-neutral class');
  assert.match(pill.getAttribute('aria-label'), /تغییر دامنهٔ صفحه/);

  const optionsBtn = f.doc.querySelector('.pages-options-button');
  assert.match(optionsBtn.getAttribute('aria-label'), /انتخاب دامنهٔ صفحه/);

  f.close();
});

test('whole-book messages (scope: "all") do not render a page badge in the conversation', async () => {
  const f = await fixture();
  f.doc.querySelector('[data-action="menu"]').click();
  f.doc.querySelector('[data-action="open-chat"]').click();
  await f.app.settled();

  // Toggle to whole-book scope ('all')
  f.doc.querySelector('.pages-button').click();
  await f.app.settled();
  assert.equal(f.app.state.scope, 'all');

  // Submit a question
  const textarea = f.doc.querySelector('textarea[name="question"]');
  textarea.value = 'پرسش درباره کل کتاب';
  const chatForm = f.doc.querySelector('[data-chat-form]');
  chatForm.dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await f.app.settled();
  await tick();

  // Find user message context in conversation
  const contextEl = f.doc.querySelector('.user-turn .message-context');
  assert.ok(contextEl, 'message-context element should exist');
  assert.equal(contextEl.textContent.trim(), 'طرح کلی اندیشۀ اسلامی در قرآن');
  assert.doesNotMatch(contextEl.textContent, /صفحه/);

  f.close();
});

test('createApi.ask preserves pages interval and derives page from pages', async () => {
  let capturedBody = null;
  const mockFetch = async (url, options) => {
    capturedBody = JSON.parse(options.body);
    return makeSSEResponse([
      'data: {"type":"text-delta","payload":{"text":"پاسخ"}}\n\n',
      'data: {"type":"chat-answer-finalized","payload":{"answer":"پاسخ"}}\n\n',
    ]);
  };

  const api = createApi({ fetchImpl: mockFetch });
  await api.ask({
    question: 'سوال از بازه صفحات',
    book: 'tarhe-kolli',
    pages: [12, 13, 14],
    scope: 'page',
  });

  assert.ok(capturedBody);
  assert.equal(capturedBody.page, 12);
  assert.deepEqual(capturedBody.pages, [12, 13, 14]);
  assert.equal(capturedBody.scope, 'page');
});

