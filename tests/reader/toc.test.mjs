import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createMobileApp } from '../../ui/mobile/app-ui.mjs';
import { createDemoApi } from '../../ui/mobile/demo-api.mjs';
import { resolveBookToc, activeTocLocation, normalizeTocQuery } from '../../ui/mobile/book-toc.mjs';

async function fixture(book = 'tarhe-kolli', initialPage = 100) {
  const dom = new JSDOM('<main id="app"></main>', {
    url: 'http://localhost/mobile/?demo=1',
    pretendToBeVisual: true
  });
  const api = createDemoApi({ storage: dom.window.localStorage, delay: 0, quota: 30 });
  const app = createMobileApp({
    root: dom.window.document.querySelector('#app'),
    api,
    storage: dom.window.localStorage
  });
  await app.ready;
  if (book !== 'tarhe-kolli') {
    app.state.book = book;
  }
  app.state.positions[app.state.book] = { page: initialPage };
  return {
    dom,
    doc: dom.window.document,
    api,
    app,
    close() {
      app.dispose();
      dom.window.close();
    }
  };
}

const tick = () => new Promise(r => setTimeout(r, 10));

test('normalizeTocQuery handles Persian digits, ZWNJ, Arabic letters, and trims whitespace', () => {
  assert.equal(normalizeTocQuery('جلسهٔ ۱۴'), 'جلسه 14');
  assert.equal(normalizeTocQuery('جلسه 14'), 'جلسه 14');
  assert.equal(normalizeTocQuery('چهاردهم'), 'چهاردهم');
  assert.equal(normalizeTocQuery('نبوت  اسلامی'), 'نبوت اسلامی');
  assert.equal(normalizeTocQuery('يادداشت كتاب'), 'یادداشت کتاب');
});

test('resolveBookToc returns structured TOC for tarhe-kolli and 70143-336, and null for unknown with no outline', () => {
  const tk = resolveBookToc('tarhe-kolli');
  assert.equal(tk.structured, true);
  assert.equal(tk.groups.length, 6);
  assert.equal(tk.groups[1].title, 'ایمان');
  assert.equal(tk.groups[1].items.length, 7);

  const ensan = resolveBookToc('70143-336');
  assert.equal(ensan.structured, true);
  assert.equal(ensan.groups.length, 5);

  const unknown = resolveBookToc('unknown-book', []);
  assert.equal(unknown, null);

  const fallback = resolveBookToc('unknown-book', [{ title: 'مقدمه', page: 1 }]);
  assert.equal(fallback.structured, false);
  assert.equal(fallback.groups[0].items[0].title, 'مقدمه');
});

test('activeTocLocation correctly maps pages to sessions and boundary dividers', () => {
  const tk = resolveBookToc('tarhe-kolli');
  // Front matter
  assert.deepEqual(activeTocLocation(tk, 5), { groupId: 'intro', itemId: 'eshareh' });
  assert.deepEqual(activeTocLocation(tk, 36), { groupId: 'intro', itemId: 'author-preface' });

  // Iman divider and sessions
  assert.deepEqual(activeTocLocation(tk, 40), { groupId: 'iman', itemId: 's-1' });
  assert.deepEqual(activeTocLocation(tk, 45), { groupId: 'iman', itemId: 's-1' });
  assert.deepEqual(activeTocLocation(tk, 100), { groupId: 'iman', itemId: 's-3' });

  // Towhid
  assert.deepEqual(activeTocLocation(tk, 218), { groupId: 'towhid', itemId: 's-8' });

  // Nobovvat
  assert.deepEqual(activeTocLocation(tk, 382), { groupId: 'nobovvat', itemId: 's-14' });

  // Velayat
  assert.deepEqual(activeTocLocation(tk, 655), { groupId: 'velayat', itemId: 's-23' });

  // Indexes
  assert.deepEqual(activeTocLocation(tk, 830), { groupId: 'indexes', itemId: 'idx-ayat' });
});

test('reader topbar contains accessible TOC trigger and opens contents bottom sheet on tap', async () => {
  const f = await fixture('tarhe-kolli', 100);
  const trigger = f.doc.querySelector('.topbar-toc-trigger');
  assert.ok(trigger, 'topbar should have .topbar-toc-trigger button');
  assert.equal(trigger.getAttribute('data-action'), 'contents');
  assert.equal(trigger.getAttribute('aria-haspopup'), 'dialog');
  assert.match(trigger.textContent, /طرح کلی اندیشۀ اسلامی در قرآن/);
  assert.ok(trigger.querySelector('.topbar-toc-chevron svg'), 'trigger should have chevron icon');

  // Tap topbar book title
  trigger.click();
  await tick();

  const sheet = f.doc.querySelector('.app-sheet.toc-sheet');
  assert.ok(sheet, 'contents sheet with .toc-sheet should open');
  assert.equal(sheet.querySelector('.sheet-title h3').textContent, 'فهرست کتاب');

  // Verify intro group does NOT have a badge tag (user requested removing 'مقدمه' tag)
  assert.equal(sheet.querySelector('.toc-group[data-group="intro"] .toc-group-badge'), null, 'intro group must not have a badge tag');

  // Verify search input is present but NOT focused automatically (to avoid keyboard popping up)
  const searchInput = sheet.querySelector('input[name="toc-search"]');
  assert.ok(searchInput, 'live search input should exist');
  assert.notEqual(f.doc.activeElement, searchInput, 'search input should not steal initial focus');

  // Active section (Iman, since page=100 is in session 3) should be auto-expanded
  const imanGroup = sheet.querySelector('.toc-group[data-group="iman"]');
  assert.ok(imanGroup.classList.contains('is-open'), 'group containing active session should be auto-expanded');
  const triggerBtn = imanGroup.querySelector('.toc-group-trigger');
  assert.equal(triggerBtn.getAttribute('aria-expanded'), 'true');
  assert.equal(triggerBtn.querySelector('.toc-group-badge').textContent, 'فصل ۱');
  assert.ok(triggerBtn.querySelector('.toc-group-chevron svg'), 'group trigger should have accordion chevron');

  // Active session button should have aria-current="location" and "در حال مطالعه" tag
  const activeItem = sheet.querySelector('.toc-item[aria-current="location"]');
  assert.ok(activeItem, 'current reading item must have aria-current="location"');
  assert.equal(activeItem.dataset.id, 's-3');
  assert.match(activeItem.querySelector('.toc-current-tag').textContent, /در حال مطالعه/);

  // Non-expandable leaf items MUST NOT have chevrons/arrows
  assert.equal(sheet.querySelector('.toc-item .toc-item-chevron'), null, 'leaf items must not have chevron');
  assert.equal(sheet.querySelectorAll('.toc-item svg').length, 0, 'leaf items must have zero SVG icons');

  // CRITICAL REQUIREMENT: ZERO page numbers displayed in the TOC items or headers
  const allItemText = sheet.querySelector('.toc-groups').textContent;
  assert.doesNotMatch(allItemText, /صفحه/);
  assert.doesNotMatch(allItemText, /ص\s*\d/);

  f.close();
});

test('drawer menu "فهرست کتاب" opens the TOC sheet', async () => {
  const f = await fixture('tarhe-kolli', 50);
  f.doc.querySelector('[data-action="menu"]').click();
  await tick();
  const drawerContentsBtn = f.doc.querySelector('.drawer [data-action="contents"]');
  assert.ok(drawerContentsBtn);
  drawerContentsBtn.click();
  await tick();

  const sheet = f.doc.querySelector('.app-sheet.toc-sheet');
  assert.ok(sheet);
  assert.equal(f.app.state.sheet?.type, 'contents');
  f.close();
});

test('toggling accordion groups expands and collapses with proper aria attributes', async () => {
  const f = await fixture('tarhe-kolli', 100);
  f.doc.querySelector('.topbar-toc-trigger').click();
  await tick();

  const towhidTrigger = f.doc.querySelector('[data-action="toc-group"][data-group="towhid"]');
  assert.ok(towhidTrigger);
  assert.equal(towhidTrigger.getAttribute('aria-expanded'), 'false');
  const towhidPanel = f.doc.querySelector('#toc-panel-towhid');
  assert.ok(towhidPanel.hasAttribute('hidden'));

  // Click to expand
  towhidTrigger.click();
  await tick();

  const updatedTrigger = f.doc.querySelector('[data-action="toc-group"][data-group="towhid"]');
  assert.equal(updatedTrigger.getAttribute('aria-expanded'), 'true');
  const updatedPanel = f.doc.querySelector('#toc-panel-towhid');
  assert.equal(updatedPanel.hasAttribute('hidden'), false);

  // Click to collapse
  updatedTrigger.click();
  await tick();
  assert.equal(f.doc.querySelector('[data-action="toc-group"][data-group="towhid"]').getAttribute('aria-expanded'), 'false');
  assert.equal(f.doc.querySelector('#toc-panel-towhid').hasAttribute('hidden'), true);

  f.close();
});

test('live search filters sessions and auto-expands matching groups', async () => {
  const f = await fixture('tarhe-kolli', 100);
  f.doc.querySelector('.topbar-toc-trigger').click();
  await tick();

  const searchInput = f.doc.querySelector('input[name="toc-search"]');

  // Search by Persian number '۱۴'
  searchInput.value = '۱۴';
  searchInput.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }));
  await tick();

  assert.ok(f.doc.querySelector('.toc-search-clear'), 'clear button should appear when input has text');
  assert.match(f.doc.querySelector('.toc-search-status').textContent, /مورد یافت شد/);

  // Group 'nobovvat' should be auto-expanded and contain session 14
  const nobovvatPanel = f.doc.querySelector('#toc-panel-nobovvat');
  assert.ok(nobovvatPanel);
  assert.equal(nobovvatPanel.hasAttribute('hidden'), false);
  assert.match(nobovvatPanel.textContent, /فلسفۀ نبوت/);

  // Clear search via clear button
  f.doc.querySelector('[data-action="clear-toc-search"]').click();
  await tick();
  assert.equal(f.doc.querySelector('input[name="toc-search"]').value, '');
  assert.equal(f.doc.querySelector('.toc-search-clear'), null);

  // Search with no results shows friendly fallback with book-search action
  searchInput.value = 'عبارت_غیر_موجود_در_فهرست';
  searchInput.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }));
  await tick();

  const empty = f.doc.querySelector('.toc-search-empty');
  assert.ok(empty, 'empty search state should render');
  assert.ok(empty.querySelector('[data-action="toc-search-in-book"]'));
  assert.ok(empty.querySelector('[data-action="clear-toc-search"]'));

  f.close();
});

test('clicking a TOC session item navigates to its page and closes the sheet', async () => {
  const f = await fixture('tarhe-kolli', 10);
  f.doc.querySelector('.topbar-toc-trigger').click();
  await tick();

  // Click session 1 (page 41)
  const session1Btn = f.doc.querySelector('[data-action="outline-page"][data-page="41"]');
  assert.ok(session1Btn);
  session1Btn.click();
  await tick();

  // Sheet should be closed
  assert.equal(f.app.state.sheet, null);
  // Current page should now be 41
  assert.equal(f.doc.querySelector('.phone').dataset.pdfPage, '41');

  f.close();
});

test('works properly with 70143-336 (ensan 250 saleh)', async () => {
  const f = await fixture('70143-336', 15);
  f.doc.querySelector('.topbar-toc-trigger').click();
  await tick();

  const sheet = f.doc.querySelector('.app-sheet.toc-sheet');
  assert.ok(sheet);

  // Group intro should be open since page=15 is in intro-text (13-24)
  const introGroup = sheet.querySelector('.toc-group[data-group="intro"]');
  assert.ok(introGroup.classList.contains('is-open'));

  // Click chapter 5 (imam hasan, page 113)
  const part1Trigger = sheet.querySelector('[data-action="toc-group"][data-group="part-1"]');
  assert.equal(part1Trigger.querySelector('.toc-group-badge').textContent, 'بخش ۱');
  part1Trigger.click();
  await tick();

  const ch5 = sheet.querySelector('[data-action="outline-page"][data-page="113"]');
  assert.ok(ch5);
  assert.match(ch5.textContent, /امام حسن/);
  ch5.click();
  await tick();

  assert.equal(f.doc.querySelector('.phone').dataset.pdfPage, '113');
  f.close();
});
