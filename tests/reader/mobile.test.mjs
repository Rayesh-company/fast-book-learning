import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { installMobileReaders } from '../../ui/mobile/reader-runtime.mjs';

const html = await readFile(new URL('../../ui/mobile/preview.html', import.meta.url), 'utf8');
const preview = await readFile(new URL('../../ui/mobile/preview.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

async function fixture(view = 'reader', loginRequired = true) {
  const dom = new JSDOM(html, {url:`http://localhost/mobile/?view=${view}&page=2`,runScripts:'outside-only'});
  const doc = dom.window.document;
  globalThis.Node = dom.window.Node;
  Object.defineProperty(dom.window.HTMLElement.prototype, 'clientWidth', {get(){return this.classList.contains('reader-page') ? 390 : 0;}});
  dom.window.HTMLCanvasElement.prototype.getContext = () => ({});
  dom.window.eval(preview);
  if(!loginRequired)doc.querySelectorAll('.phone').forEach(n=>n.dataset.loginRequired='false');
  class TextLayer {
    constructor({container,textContentSource}) {this.container=container;this.content=textContentSource;}
    async render() {for(const item of this.content.items){const span=doc.createElement('span');span.textContent=item.str;this.container.append(span);}}
    cancel() {}
  }
  const documentRequests = [];
  let destroyed = 0;
  const pdf = {numPages:4,async getPage(n){return {
    pageNumber:n,getViewport:({scale})=>({width:500*scale,height:700*scale,scale}),
    getTextContent:async()=>({items:[{str:'alpha',width:50,height:12,dir:'ltr',transform:[12,0,0,12,20,650]}]}),
    getOperatorList:async()=>({fnArray:[],argsArray:[]}),render:()=>({promise:Promise.resolve(),cancel(){}}),
  };}};
  const pdfjs={TextLayer,OPS:{showText:44},getDocument(options){documentRequests.push(options);return{promise:Promise.resolve(pdf),destroy(){destroyed++;}};}};
  const requests=[];
  const runtime=installMobileReaders({root:doc,pdfjsLoader:async()=>pdfjs,fetchImpl:async(url,options)=>{
    requests.push([url,options]);
    if(url==='/auth/me')return{ok:true};
    return{ok:false,json:async()=>({detail:'سرویس ساخت صدا تنظیم نشده است.'})};
  }});
  await runtime.ready(); await tick();
  return{dom,doc,pdf,pdfjs,runtime,requests,documentRequests,destroyed:()=>destroyed};
}

test('the designed reader frames share a trusted PDF and keep the floating design',async()=>{
  const f=await fixture();
  assert.equal(f.runtime.records.size,3);
  assert.equal(f.documentRequests.length,1);
  assert.equal(f.documentRequests[0].url,'/books/tarhe-kolli/book');
  assert.equal(f.documentRequests[0].disableFontFace,true);
  assert.equal(f.doc.querySelectorAll('.book-reader-canvas').length,3);
  assert.equal(f.doc.querySelector('.topbar p').textContent,'صفحهٔ ۲ از ۴');
  assert.equal(f.doc.querySelector('.reader-floating').hidden,true);
  assert.equal(f.doc.querySelectorAll('.floating-bar').length,2);
  assert.equal(f.doc.querySelectorAll('.response-card').length,1);
  assert.equal(f.doc.querySelector('.reader-page h2'),null);
  f.runtime.dispose();assert.equal(f.destroyed(),1);f.dom.window.close();
});

test('asking the agent is an explicit action on an exact PDF selection, never the default input',async()=>{
  const f=await fixture();
  const phone=f.doc.querySelector('.phone');
  assert.equal(phone.querySelector('.reader-floating').hidden,true);
  assert.equal(phone.querySelector('.reader-selection-actions').hidden,true);
  const node=phone.querySelector('[data-pdf-text]').firstChild;
  const range=f.doc.createRange();range.setStart(node,1);range.setEnd(node,4);
  f.doc.getSelection().addRange(range);
  f.doc.dispatchEvent(new f.dom.window.Event('selectionchange'));
  assert.equal(phone.querySelector('.reader-selection-actions').hidden,false);
  assert.equal(phone.querySelector('.reader-floating').hidden,true);
  phone.querySelector('[data-action="ask-agent"]').click();
  const floating=phone.querySelector('.reader-floating');
  assert.equal(floating.hidden,false);
  assert.equal(floating.querySelector('.question-context').textContent,'lph');
  assert.equal(floating.querySelector('input').value,'');
  assert.equal(f.doc.activeElement,floating.querySelector('input'));
  assert.deepEqual(JSON.parse(JSON.stringify(phone.readerQuestion.selection)),{text:'lph',pages:[{page:2,start:1,end:4,text:'lph'}]});
  assert.equal(f.requests.length,1); // Merely opening the question never submits it.
  floating.querySelector('[data-action="send-reader"]').click();
  assert.equal(phone.querySelector('.reader-floating').dataset.state,'ready');
  floating.querySelector('input').value='معنی این قسمت چیست؟';
  floating.querySelector('[data-action="send-reader"]').click();
  assert.equal(phone.querySelector('.reader-floating').dataset.state,'loading');
  phone.querySelector('[data-action="stop-reader"]').click();
  assert.equal(phone.querySelector('.floating-bar input').value,'معنی این قسمت چیست؟');
  assert.equal(phone.querySelector('.question-context').textContent,'lph');
  phone.querySelector('[data-action="open-chat"]').click();await tick();
  phone.querySelector('[data-action="open-reader"]').click();await tick();await f.runtime.ready();
  assert.equal(phone.querySelector('.floating-bar input').value,'معنی این قسمت چیست؟');
  assert.equal(phone.querySelector('.question-context').textContent,'lph');
  phone.querySelector('[data-action="close-question"]').click();
  assert.equal(phone.querySelector('.reader-floating').hidden,true);
  assert.equal(phone.readerQuestion,null);
  assert.equal(phone.querySelector('.reader-selection-actions').hidden,true);
  f.runtime.dispose();f.dom.window.close();
});

test('cleared selection and page navigation cannot leave a stale ask-agent action',async()=>{
  const f=await fixture();
  const phone=f.doc.querySelector('.phone');
  const select=()=>{
    const node=phone.querySelector('[data-pdf-text]').firstChild;
    const range=f.doc.createRange();range.setStart(node,1);range.setEnd(node,4);
    f.doc.getSelection().addRange(range);
    f.doc.dispatchEvent(new f.dom.window.Event('selectionchange'));
  };
  select();
  f.doc.getSelection().removeAllRanges();
  f.doc.dispatchEvent(new f.dom.window.Event('selectionchange'));
  assert.equal(phone.querySelector('.reader-selection-actions').hidden,true);
  phone.querySelector('[data-action="ask-agent"]').click();
  assert.equal(phone.querySelector('.reader-floating').hidden,true);
  select();phone.querySelector('[data-action="ask-agent"]').click();
  phone.querySelector('[data-pdf-next]').click();await f.runtime.ready();
  assert.equal(phone.querySelector('.reader-floating').hidden,true);
  assert.equal(phone.readerQuestion,null);
  assert.equal(phone.querySelector('.reader-selection-actions').hidden,true);
  f.runtime.dispose();f.dom.window.close();
});

test('real partial selection survives opening the designed menu and reaches narration unchanged',async()=>{
  const f=await fixture();
  const phone=f.doc.querySelector('.phone');
  const node=phone.querySelector('[data-pdf-text]').firstChild;
  const range=f.doc.createRange();range.setStart(node,1);range.setEnd(node,4);
  f.doc.getSelection().addRange(range);
  f.doc.dispatchEvent(new f.dom.window.Event('selectionchange'));
  f.doc.getSelection().removeAllRanges();
  phone.querySelector('[data-action="menu"]').click();
  phone.querySelector('[data-action="pdf-audio"]').click();
  assert.equal(phone.querySelector('.pdf-audio-sheet').hidden,false);
  phone.querySelector('[data-reader-read]').click();await tick();await tick();
  const sent=f.requests.find(([url])=>url.endsWith('/narration'));
  assert.equal(sent[0],'/books/tarhe-kolli/narration');
  assert.deepEqual(JSON.parse(sent[1].body),{page:2,start:1,end:4,text:'lph',pageText:'alpha'});
  assert.equal(phone.querySelector('[data-reader-audio-status]').textContent,'سرویس ساخت صدا تنظیم نشده است.');
  f.runtime.dispose();f.dom.window.close();
});

test('returning from chat preserves the PDF page and chat draft, recreating its actual canvas',async()=>{
  const f=await fixture('chat');
  const phone=f.doc.querySelector('.phone');
  phone.querySelector('textarea').value='پیش‌نویس من';
  phone.querySelector('[data-action="open-reader"]').click();await tick();await f.runtime.ready();
  assert.equal(phone.querySelector('.reader-floating').hidden,true);
  phone.querySelector('[name="page"]').value='۳';
  phone.querySelector('[data-pdf-page-form]').dispatchEvent(new f.dom.window.Event('submit',{bubbles:true,cancelable:true}));
  await f.runtime.ready();
  assert.equal(phone.dataset.pdfPage,'3');
  phone.querySelector('[data-action="open-chat"]').click();await tick();
  assert.equal(f.runtime.records.size,0);
  assert.equal(phone.querySelector('textarea').value,'پیش‌نویس من');
  phone.querySelector('[data-action="open-reader"]').click();await tick();await f.runtime.ready();
  assert.equal(phone.querySelector('.topbar p').textContent,'صفحهٔ ۳ از ۴');
  assert.equal(phone.querySelectorAll('.book-reader-canvas').length,1);
  phone.remove();await tick();assert.equal(f.runtime.records.size,0);
  f.runtime.dispose();f.dom.window.close();
});

test('a failed obsolete page request cannot append an error to the current PDF page',async()=>{
  const f=await fixture();
  const phone=f.doc.querySelector('.phone');
  const original=f.pdf.getPage;
  let rejectOld;
  f.pdf.getPage=n=>n===3?new Promise((resolve,reject)=>{rejectOld=reject;}):original(n);
  const form=phone.querySelector('[data-pdf-page-form]');
  form.elements.page.value='3';form.dispatchEvent(new f.dom.window.Event('submit',{bubbles:true,cancelable:true}));
  const old=f.runtime.records.get(phone).ready;
  form.elements.page.value='4';form.dispatchEvent(new f.dom.window.Event('submit',{bubbles:true,cancelable:true}));
  await f.runtime.ready();rejectOld(new Error('obsolete request failed'));await old;
  assert.equal(phone.dataset.pdfPage,'4');
  assert.equal(phone.querySelector('.pdf-surface [role="alert"]'),null);
  assert.equal(phone.querySelectorAll('.book-reader-canvas').length,1);
  f.runtime.dispose();f.dom.window.close();
});

test('disposing during authentication cannot create a login overlay or a PDF task later',async()=>{
  for(const status of [200,401]){
    const f=await fixture();f.runtime.dispose();
    let finish;
    const runtime=installMobileReaders({root:f.doc,pdfjsLoader:async()=>{throw new Error('Unexpected engine initialization');},
      fetchImpl:()=>new Promise(resolve=>{finish=resolve;})});
    runtime.dispose();finish({ok:status===200,status});await runtime.ready();await tick();
    assert.equal(f.doc.querySelector('.mobile-auth'),null);
    assert.equal(runtime.records.size,0);
    f.dom.window.close();
  }
});

test('clicking PDF content never treats the host zoom metadata as a zoom control',async()=>{
 const f=await fixture();const phone=f.doc.querySelector('.phone');phone.dataset.pdfZoom='1';phone.querySelector('[data-pdf-text]').click();await f.runtime.ready();assert.equal(phone.dataset.pdfZoom,'1');
 phone.querySelector('button[data-pdf-zoom="0.25"]').click();await f.runtime.ready();assert.equal(phone.dataset.pdfZoom,'1.25');f.runtime.dispose();f.dom.window.close();
});


test('the loginless reader mounts the real PDF without any account request',async()=>{
 const f=await fixture('reader',false);assert.equal(f.requests.length,0);assert.equal(f.documentRequests.length,1);assert.equal(f.doc.querySelector('.mobile-auth'),null);assert.equal(f.doc.querySelectorAll('.book-reader-canvas').length,3);f.runtime.dispose();f.dom.window.close();
});
