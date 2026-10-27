import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createMobileApp } from '../../ui/mobile/app-ui.mjs';
import { createDemoApi } from '../../ui/mobile/demo-api.mjs';
import { renderSearchSnippet } from '../../ui/mobile/views.mjs';

test('renderSearchSnippet highlights query words safely', () => {
 const snippet = 'در این زمینه توحید به معنای جهان‌بینی است';
 const html = renderSearchSnippet(snippet, 'توحید');
 assert.match(html, /<mark class="search-match">توحید<\/mark>/);
 assert.match(html, /جهان‌بینی/);
});

test('book search sheet displays scrollable results and closes overlay on selecting result', async () => {
 const dom = new JSDOM('<main id="app"></main>', { url: 'http://localhost/mobile/?demo=1', pretendToBeVisual: true });
 dom.window.fetch = async (url) => {
  if (url.includes('.pages.json')) {
   return {
    ok: true,
    json: async () => ({
     pages: {
      '42': 'فصل اول درباره توحید و آثار آن در جامعه اسلامی صحبت می‌کند.',
      '100': 'ایمان از روی آگاهی در جلسه سوم بررسی می‌شود.'
     }
    })
   };
  }
  return { ok: false, status: 404 };
 };

 const api = createDemoApi({ storage: dom.window.localStorage, delay: 0 });
 const app = createMobileApp({ root: dom.window.document.querySelector('#app'), api, storage: dom.window.localStorage, fetchImpl: dom.window.fetch });
 await app.ready;

 const doc = dom.window.document;
 let highlightedCue = null;
 const mockReader = {
  getPageIndex: (p) => ({
   page: p,
   text: p === 42 ? 'فصل اول درباره توحید و آثار آن در جامعه اسلامی صحبت می‌کند.' : 'متن صفحه'
  }),
  highlight: (cue) => {
   highlightedCue = cue;
  }
 };
 Object.defineProperty(dom.window.HTMLDivElement.prototype, 'bookReader', {
  get() { return this.classList.contains('phone') ? mockReader : undefined; },
  configurable: true
 });

 // Open drawer and click search in book
 doc.querySelector('[data-action="menu"]').click();
 const searchNavBtn = doc.querySelector('[data-action="book-search"]');
 assert.ok(searchNavBtn, 'book-search nav button should exist in menu');
 searchNavBtn.click();

 // Search sheet should be open
 const sheet = doc.querySelector('.search-sheet');
 assert.ok(sheet, 'search-sheet should be open');
 const scrollContainer = doc.querySelector('.search-results-scroll');
 assert.ok(scrollContainer, 'scroll container .search-results-scroll should exist');

 // Type query and submit search
 const input = doc.querySelector('.book-search-input');
 input.value = 'توحید';
 const form = doc.querySelector('[data-book-search]');
 form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));

 await app.settled();

 // Check that search results were rendered
 const resultBtn = doc.querySelector('[data-action="search-page"]');
 assert.ok(resultBtn, 'search-page result card should exist');
 assert.equal(resultBtn.dataset.page, '42');
 assert.match(resultBtn.querySelector('.search-result-snippet').innerHTML, /<mark class="search-match">/);

 // Click the search result
 resultBtn.click();
 await app.settled();

 // Sheet overlay should be closed
 assert.equal(doc.querySelector('.search-sheet'), null, 'sheet should close on result selection');

 // Page changed from 100 to 42, simulate page 42 rendering ready
 doc.querySelector('.phone').dispatchEvent(new dom.window.CustomEvent('book-page-ready', { bubbles: true, detail: { page: 42 } }));

 // Highlight should be applied with cue matching target page and query
 assert.ok(highlightedCue, 'highlight should have been called on page change');
 assert.equal(highlightedCue.page, 42);
 assert.equal(highlightedCue.text, 'توحید');
 assert.equal(highlightedCue.tone, 'search');

 // Now test same-page match: search again while already on page 42
 highlightedCue = null;
 doc.querySelector('[data-action="menu"]').click();
 doc.querySelector('[data-action="book-search"]').click();
 const input2 = doc.querySelector('.book-search-input');
 input2.value = 'اسلامی';
 doc.querySelector('[data-book-search]').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
 await app.settled();

 const resultBtn2 = doc.querySelector('[data-action="search-page"]');
 resultBtn2.click();
 await app.settled();

 // Highlight should be called immediately on same page without waiting for book-page-ready
 assert.ok(highlightedCue, 'highlight should have been called immediately on same page');
 assert.equal(highlightedCue.page, 42);
 assert.equal(highlightedCue.text, 'اسلامی');
 assert.equal(highlightedCue.tone, 'search');

 app.dispose();
 dom.window.close();
});
