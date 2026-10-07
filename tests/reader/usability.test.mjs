import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createMobileApp} from '../../ui/mobile/app-ui.mjs';
import {createDemoApi} from '../../ui/mobile/demo-api.mjs';
import {installMobileReaders} from '../../ui/mobile/reader-runtime.mjs';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture(){
 const dom=new JSDOM('<main id="app"></main>',{url:'http://localhost/mobile/?demo=1',pretendToBeVisual:true});
 const doc=dom.window.document,root=doc.querySelector('#app');
 globalThis.Node=dom.window.Node;
 Object.defineProperty(dom.window.HTMLElement.prototype,'clientWidth',{get(){return this.classList.contains('reader-page')?390:0;}});
 dom.window.HTMLCanvasElement.prototype.getContext=()=>({});
 const api=createDemoApi({storage:dom.window.localStorage,delay:0});
 const app=createMobileApp({root,api});await app.ready;
 class TextLayer{constructor({container,textContentSource}){this.container=container;this.content=textContentSource;}async render(){for(const item of this.content.items){const span=doc.createElement('span');span.textContent=item.str;this.container.append(span);}}cancel(){}}
 const pdfjs={TextLayer,OPS:{showText:44},getDocument(){return{promise:Promise.resolve({numPages:862,async getPage(n){return{pageNumber:n,getViewport:({scale})=>({width:500*scale,height:700*scale,scale}),getTextContent:async()=>({items:[{str:'alpha',width:50,height:12,dir:'ltr',transform:[12,0,0,12,20,650]}]}),getOperatorList:async()=>({fnArray:[],argsArray:[]}),render:()=>({promise:Promise.resolve(),cancel(){}})};}}),destroy(){}};}};
 const runtime=installMobileReaders({root:doc,pdfjsLoader:async()=>pdfjs,fetchImpl:async()=>({ok:true})});await runtime.ready();await tick();
 return{dom,doc,root,app,runtime,close(){runtime.dispose();app.dispose();dom.window.close();}};
}
const click=(f,action)=>f.root.querySelector(`[data-action="${action}"]`).click();
function key(f,key,shiftKey=false){const event=new f.dom.window.KeyboardEvent('keydown',{key,shiftKey,bubbles:true,cancelable:true});f.doc.activeElement.dispatchEvent(event);return event;}

test('wheel panel traps focus, changes pages without confirmation and preserves its PDF on close',async()=>{
 const f=await fixture(),trigger=f.root.querySelector('[data-action="pdf-pages"]'),canvas=f.root.querySelector('.book-reader-canvas');
 trigger.focus();trigger.click();const panel=f.root.querySelector('.pdf-page-sheet'),wheel=panel.querySelector('[data-page-wheel]');
 assert.equal(panel.hidden,false);assert.equal(f.doc.activeElement,wheel);assert.equal(f.root.querySelector('.reader-page').hasAttribute('inert'),true);
 const first=panel.querySelector('button'),last=panel.querySelector('input');last.focus();assert.equal(key(f,'Tab').defaultPrevented,true);assert.equal(f.doc.activeElement,first);
 key(f,'Tab',true);assert.equal(f.doc.activeElement,last);key(f,'Escape');assert.equal(panel.hidden,true);assert.equal(f.doc.activeElement,trigger);assert.equal(f.root.querySelector('.book-reader-canvas'),canvas);
 trigger.click();key(f,'ArrowDown');await f.runtime.ready();assert.equal(f.root.querySelector('[data-page-number]').textContent,'۱۰۱');assert.equal(wheel.getAttribute('aria-activedescendant'),'wheel-page-101');assert.equal(f.root.querySelector('.reader-chrome').hasAttribute('inert'),true);f.close();
});

test('only page/contents/search remain as reading tools; keyboard zoom retains the exact question',async()=>{
 const f=await fixture();click(f,'menu');assert.equal(f.root.querySelector('[data-action="pdf-audio"]'),null);assert.equal(f.root.querySelector('[data-action="pdf-zoom"]'),null);click(f,'close-menu');
 assert.equal(f.root.querySelector('.topbar p'),null);assert.equal(f.root.querySelector('.reader-navigation'),null);
 const selection={text:'lph',pages:[{page:100,start:1,end:4,text:'lph'}]};f.root.querySelector('.phone').dispatchEvent(new f.dom.window.CustomEvent('reader-question',{bubbles:true,detail:selection}));
 const viewport=f.root.querySelector('.reader-page');viewport.focus();key(f,'+');await f.runtime.ready();assert.equal(f.root.querySelector('.phone').dataset.pdfZoom,'1.25');assert.equal(f.app.state.readerQuestion.selection.text,'lph');key(f,'0');await f.runtime.ready();assert.equal(f.root.querySelector('.phone').dataset.pdfZoom,'1');f.close();
});

function touch(f,type,touches,changed=touches){const e=new f.dom.window.Event(type,{bubbles:true,cancelable:true});Object.defineProperties(e,{touches:{value:touches},changedTouches:{value:changed}});f.root.querySelector('.reader-page').dispatchEvent(e);return e;}
test('swipe respects zoom/selection, pinch is bounded, and cancelled pinch restores geometry',async()=>{
 const f=await fixture();const point=(x,y)=>({clientX:x,clientY:y});
 touch(f,'touchstart',[point(30,200)]);touch(f,'touchend',[],[point(120,200)]);await f.runtime.ready();assert.equal(f.root.querySelector('.phone').dataset.pdfPage,'101');
 touch(f,'touchstart',[point(30,200),point(130,200)]);touch(f,'touchmove',[point(30,200),point(230,200)]);assert.match(f.root.querySelector('.pdf-surface').style.transform,/scale\(2\)/);touch(f,'touchend',[]);await f.runtime.ready();assert.equal(f.root.querySelector('.phone').dataset.pdfZoom,'2');
 touch(f,'touchstart',[point(30,200)]);touch(f,'touchend',[],[point(120,200)]);assert.equal(f.root.querySelector('.phone').dataset.pdfPage,'101');
 touch(f,'touchstart',[point(30,200),point(130,200)]);touch(f,'touchmove',[point(30,200),point(230,200)]);touch(f,'touchcancel',[]);assert.equal(f.root.querySelector('.pdf-surface').style.transform,'');assert.equal(f.root.querySelector('.phone').dataset.pdfZoom,'2');f.close();
});

test('first-selection guide disappears on exact selection and stays dismissed across reload',async()=>{
 const f=await fixture();assert.ok(f.root.querySelector('.reader-guide'));assert.equal(f.root.querySelector('[name="reader-question"]'),null);
 const node=f.root.querySelector('[data-pdf-text]').firstChild,range=f.doc.createRange();range.setStart(node,1);range.setEnd(node,4);f.doc.getSelection().addRange(range);f.doc.dispatchEvent(new f.dom.window.Event('selectionchange'));
 assert.equal(f.root.querySelector('.reader-guide'),null);assert.equal(f.root.querySelector('[name="reader-question"]'),null);assert.equal(f.app.state.readerGuideSeen,true);
 click(f,'ask-agent');assert.equal(f.root.querySelector('.question-context').textContent,'lph');assert.equal(f.root.querySelector('[name="reader-question"]').value,'');f.runtime.dispose();f.app.dispose();
 const restored=createMobileApp({root:f.root,api:createDemoApi({storage:f.dom.window.localStorage,delay:0})});await restored.ready;assert.equal(f.root.querySelector('.reader-guide'),null);restored.dispose();f.dom.window.close();
});

test('empty notebook returns to its originating chat with draft intact; tabs and search are keyboard usable',async()=>{
 const f=await fixture();click(f,'menu');click(f,'open-chat');const draft=f.root.querySelector('[name="question"]');draft.value='پیش‌نویس من';draft.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));
 click(f,'menu');click(f,'notebook');await f.app.settled();assert.equal(f.root.querySelector('.empty-state [data-action="back"]').textContent,'بازگشت به گفتگو');
 const tab=f.root.querySelector('[aria-selected="true"]');tab.focus();key(f,'ArrowLeft');assert.equal(f.app.state.noteTab,'highlights');assert.equal(f.doc.activeElement.dataset.tab,'highlights');assert.equal(f.root.querySelector('[data-tab="notes"]').tabIndex,-1);
 const search=f.root.querySelector('[name="note-search"]');search.value='ناموجود';search.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));click(f,'clear-note-search');assert.equal(f.root.querySelector('[name="note-search"]').value,'');assert.equal(f.doc.activeElement.name,'note-search');
 f.root.querySelector('.empty-state [data-action="back"]').click();assert.equal(f.root.querySelector('[name="question"]').value,'پیش‌نویس من');f.close();
});

test('a native partial selection survives PDF zoom and suppresses accidental page turns',async()=>{
 const f=await fixture(),node=f.root.querySelector('[data-pdf-text]').firstChild,range=f.doc.createRange();range.setStart(node,1);range.setEnd(node,4);f.doc.getSelection().addRange(range);f.doc.dispatchEvent(new f.dom.window.Event('selectionchange'));
 const point=(x,y)=>({clientX:x,clientY:y});touch(f,'touchstart',[point(30,200)]);touch(f,'touchend',[],[point(120,200)]);assert.equal(f.root.querySelector('.phone').dataset.pdfPage,'100');touch(f,'touchstart',[point(30,200),point(130,200)]);touch(f,'touchmove',[point(30,200),point(155,200)]);touch(f,'touchend',[]);await f.runtime.ready();
 assert.equal(f.doc.getSelection().toString(),'lph');assert.equal(f.root.querySelector('.phone').bookReader.captureSelection().text,'lph');click(f,'ask-agent');assert.equal(f.app.state.readerQuestion.selection.pages[0].start,1);assert.equal(f.app.state.readerQuestion.selection.pages[0].end,4);f.close();
});
