import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createMobileApp} from '../../ui/mobile/app-ui.mjs';
import {createDemoApi} from '../../ui/mobile/demo-api.mjs';

function fixture(){
 const dom=new JSDOM(`<!doctype html><div id="app"></div>`,{url:'https://example.test'});
 const root=dom.window.document.querySelector('#app');
 const api=createDemoApi({storage:dom.window.localStorage,delay:0});
 const app=createMobileApp({root,api});
 const click=action=>{
  const el=root.querySelector(`[data-action="${action}"]`);
  assert.ok(el,`element [data-action="${action}"] should exist`);
  el.click();
 };
 return {dom,root,api,app,click,close(){app.dispose();dom.window.close();}};
}

test('reader topbar has bookmark button that toggles page bookmark with toast and syncs icon state',async()=>{
 const f=fixture();
 await f.app.ready;

 const btn=f.root.querySelector('[data-action="toggle-bookmark"]');
 assert.ok(btn,'bookmark button should exist in reader topbar');
 assert.equal(btn.getAttribute('aria-pressed'),'false');

 // Click to bookmark page 100
 btn.click();
 await f.app.settled();
 assert.equal(btn.getAttribute('aria-pressed'),'true');
 assert.ok(btn.classList.contains('active'));
 assert.match(f.root.querySelector('.toast').textContent,/نشان شد/);

 // Check that bookmark note exists in state
 const bookmarkNotes=f.app.state.notes.filter(n=>n.source?.capture==='bookmark');
 assert.equal(bookmarkNotes.length,1);
 assert.deepEqual(bookmarkNotes[0].pages,[100]);

 // Click again to unbookmark
 btn.click();
 await f.app.settled();
 assert.equal(btn.getAttribute('aria-pressed'),'false');
 assert.ok(!btn.classList.contains('active'));
 assert.match(f.root.querySelector('.toast').textContent,/برداشته شد/);
 assert.equal(f.app.state.notes.filter(n=>n.source?.capture==='bookmark').length,0);

 f.close();
});

test('reader drawer swaps chat/notebook order and renders three collapsible accordion sections below notebook',async()=>{
 const f=fixture();
 await f.app.ready;

 // Open drawer menu in reader
 f.click('menu');
 const drawer=f.root.querySelector('.drawer');
 assert.ok(drawer,'drawer should be open');

 // Under گفتگو و یادداشت group, open-chat must come BEFORE notebook
 const chatBtn=drawer.querySelector('[data-action="open-chat"]');
 const nbBtn=drawer.querySelector('[data-action="notebook"]');
 assert.ok(chatBtn,'open-chat button should exist');
 assert.ok(nbBtn,'notebook button should exist');
 const chatPos=chatBtn.compareDocumentPosition(nbBtn);
 assert.ok(chatPos & f.dom.window.Node.DOCUMENT_POSITION_FOLLOWING,'chat button must precede notebook button');

 // Three accordion sections must exist below notebook
 const highlightsSec=drawer.querySelector('[data-section-id="highlights"]');
 const bookmarksSec=drawer.querySelector('[data-section-id="bookmarks"]');
 const notesSec=drawer.querySelector('[data-section-id="notes"]');
 assert.ok(highlightsSec,'highlights section should exist');
 assert.ok(bookmarksSec,'bookmarks section should exist');
 assert.ok(notesSec,'notes section should exist');

 // Test collapse/expand toggle
 const getHlTrigger=()=>f.root.querySelector('[data-action="toggle-drawer-section"][data-section="highlights"]');
 const getHlContent=()=>f.root.querySelector('[data-section-id="highlights"] .drawer-accordion-content');
 assert.equal(getHlTrigger().getAttribute('aria-expanded'),'true');
 getHlTrigger().click();
 assert.equal(getHlTrigger().getAttribute('aria-expanded'),'false');
 assert.ok(getHlContent().hasAttribute('hidden'));

 getHlTrigger().click();
 assert.equal(getHlTrigger().getAttribute('aria-expanded'),'true');
 assert.ok(!getHlContent().hasAttribute('hidden'));

 f.close();
});

test('bookmark item in drawer navigates to the bookmarked page when clicked',async()=>{
 const f=fixture();
 await f.app.ready;

 // Bookmark page 100 first
 f.click('toggle-bookmark');
 await f.app.settled();

 // Open drawer
 f.click('menu');
 const bmSec=f.root.querySelector('[data-section-id="bookmarks"]');
 const bmItem=bmSec.querySelector('[data-action="drawer-bookmark"][data-page="100"]');
 assert.ok(bmItem,'bookmark item for page 100 should exist in drawer');

 // Change active page to 42
 f.app.state.positions['tarhe-kolli'].page=42;

 // Click bookmark in drawer: should close drawer and navigate to page 100
 bmItem.click();
 assert.equal(f.app.state.menu,false,'drawer should close on navigation');
 assert.equal(f.app.state.positions['tarhe-kolli'].page,100);

 f.close();
});

test('notebook has bookmarks tab and filters bookmarked pages accordingly',async()=>{
 const f=fixture();
 await f.app.ready;

 // Bookmark page 100
 f.click('toggle-bookmark');
 await f.app.settled();

 // Open notebook
 f.click('menu');
 f.click('notebook');
 await f.app.settled();

 const tabs=[...f.root.querySelectorAll('.note-tabs [role="tab"]')];
 assert.deepEqual(tabs.map(t=>t.dataset.tab),['notes','highlights','bookmarks']);
 assert.deepEqual(tabs.map(t=>t.textContent.trim()),['یادداشت‌ها','هایلایت‌ها','بوک‌مارک‌ها']);

 // Click bookmarks tab
 const bmTab=f.root.querySelector('[data-action="note-tab"][data-tab="bookmarks"]');
 bmTab.click();
 assert.equal(f.app.state.noteTab,'bookmarks');

 // Verify the bookmarked row is visible
 const rows=f.root.querySelectorAll('.note-row');
 assert.equal(rows.length,1);
 assert.match(rows[0].textContent,/صفحهٔ ۱۰۰/);

 // Test keyboard navigation across the 3 tabs
 const key=(k)=>{
  const activeTab=f.root.querySelector('.note-tabs [aria-selected="true"]');
  activeTab.focus();
  activeTab.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:k,bubbles:true}));
 };
 key('ArrowLeft');
 assert.equal(f.app.state.noteTab,'notes');
 key('ArrowRight');
 assert.equal(f.app.state.noteTab,'bookmarks');

 f.close();
});
