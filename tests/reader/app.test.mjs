import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createMobileApp } from '../../ui/mobile/app-ui.mjs';
import { createDemoApi } from '../../ui/mobile/demo-api.mjs';

async function fixture(quota=30,{loginRequired=true}={}){
 const dom=new JSDOM('<main id="app"></main>',{url:'http://localhost/mobile/?demo=1',pretendToBeVisual:true});
 const api=createDemoApi({storage:dom.window.localStorage,delay:0,quota,loginRequired});
 const app=createMobileApp({root:dom.window.document.querySelector('#app'),api,storage:dom.window.localStorage});
 await app.ready;
 return {dom,doc:dom.window.document,api,app,close(){app.dispose();dom.window.close();}};
}
const click=(f,a)=>{let t=f.doc.querySelector(`[data-action="${a}"]`);if(!t){f.doc.querySelector('[data-action="menu"]').click();t=f.doc.querySelector(`[data-action="${a}"]`);}t.click();};
const tick=()=>new Promise(r=>setTimeout(r,10));

test('ordinary reading has no question input; asking keeps the exact selected context',async()=>{
 const f=await fixture();assert.equal(f.doc.querySelector('.phone').dataset.type,'reader');
 assert.equal(f.doc.querySelector('.reader-floating').hidden,true);
 const selected={text:'متن انتخاب‌شده',pages:[{page:100,start:8,end:23,text:'متن انتخاب‌شده'}]};
 f.doc.querySelector('.phone').dispatchEvent(new f.dom.window.CustomEvent('reader-question',{bubbles:true,detail:selected}));
 assert.equal(f.doc.querySelector('.question-context').textContent,selected.text);
 assert.equal(f.doc.querySelector('[name="reader-question"]').value,'');
 f.doc.querySelector('[name="reader-question"]').dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert.equal(f.doc.querySelector('.reader-floating').dataset.state,'minimised');assert.equal(f.app.state.readerQuestion.selection.text,selected.text);f.close();
});

test('chat draft and scroll survive notebook and reader navigation',async()=>{
 const f=await fixture();click(f,'open-chat');
 const input=f.doc.querySelector('[name="question"]');input.value='پیش‌نویس';input.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));
 const thread=f.doc.querySelector('.conversation');
 Object.defineProperties(thread,{scrollHeight:{value:600},clientHeight:{value:200}});
 thread.scrollTop=130;
 click(f,'notebook');await tick();click(f,'back');
 assert.equal(f.doc.querySelector('[name="question"]').value,'پیش‌نویس');
 assert.equal(f.doc.querySelector('.conversation').scrollTop,130);
 click(f,'open-reader');click(f,'open-chat');assert.equal(f.doc.querySelector('[name="question"]').value,'پیش‌نویس');f.close();
});

test('page context is captured per message and quota exhaustion still accepts the message',async()=>{
 const f=await fixture(0);click(f,'open-chat');
 const q=f.doc.querySelector('[name="question"]');q.value='یک سؤال';q.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));
 click(f,'send-chat');await f.app.settled();
 assert.match(f.doc.querySelector('.conversation').textContent,/یک سؤال/);
 assert.match(f.doc.querySelector('.conversation').textContent,/سهمیه/);
 assert.equal(f.doc.querySelector('[name="question"]').value,'');
 assert.equal(f.doc.querySelector('[data-action="record"]').disabled,false);
 assert.match(f.doc.querySelector('.message-context').textContent,/۱۰۰/);f.close();
});

test('saving a complete response is durable; opinion edits never rewrite its text',async()=>{
 const f=await fixture();click(f,'open-chat');
 const q=f.doc.querySelector('[name="question"]');q.value='پرسش';q.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));
 click(f,'send-chat');await f.app.settled();click(f,'save-answer');await f.app.settled();
 click(f,'notebook');await f.app.settled();
 const saved=(await f.api.notes())[0];assert.ok(saved.text.length>20);
 f.doc.querySelector(`[data-action="note-open"][data-id="${saved.id}"]`).click();
 click(f,'edit-opinion');f.doc.querySelector('[name="opinion"]').value='نظر خودم';click(f,'save-opinion');await f.app.settled();
 const after=(await f.api.notes()).find(n=>n.id===saved.id);assert.equal(after.text,saved.text);assert.equal(after.opinion,'نظر خودم');f.close();
});

test('payment return starts uncertain; only verification can show success',async()=>{
 const f=await fixture();click(f,'account');click(f,'subscription');click(f,'buy');await f.app.settled();
 assert.match(f.doc.querySelector('.payment-result').textContent,/بررسی/);
 click(f,'verify-payment');await f.app.settled();assert.match(f.doc.querySelector('.payment-result').textContent,/فعال/);f.close();
});

test('changing book preserves the old chat and opens the last chat of the selected book',async()=>{
 const f=await fixture();click(f,'open-chat');
 const q=f.doc.querySelector('[name="question"]');q.value='گفتگوی کتاب اول';q.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));
 click(f,'send-chat');await f.app.settled();
 click(f,'books');f.doc.querySelector('[data-action="select-book"][data-book="70143-336"]').click();await f.app.settled();
 assert.equal(f.doc.querySelector('.conversation .user-message'),null);
 click(f,'books');f.doc.querySelector('[data-action="select-book"][data-book="tarhe-kolli"]').click();await f.app.settled();
 assert.match(f.doc.querySelector('.conversation').textContent,/گفتگوی کتاب اول/);f.close();
});

test('opening a source from the reader reaches its destination instead of recapturing the old page',async()=>{
 const f=await fixture();f.doc.querySelector('.phone').bookReader={};
 f.doc.querySelector('.phone').dispatchEvent(new f.dom.window.CustomEvent('book-page-ready',{bubbles:true,detail:{page:100,outline:[{title:'فصل بعد',page:42}]}}));
 click(f,'contents');click(f,'outline-page');
 assert.equal(f.doc.querySelector('.phone').dataset.pdfPage,'42');f.close();
});

test('switching conversations abandons the old response even if its transport resolves late',async()=>{
 const f=await fixture();const row=await f.api.createSession('tarhe-kolli','گفتگوی دیگر');
 await f.api.append(row.id,'user',{text:'پیام گفتگو دیگر',book:'tarhe-kolli'});
 let finish;f.api.ask=()=>new Promise(r=>finish=r);
 click(f,'open-chat');const q=f.doc.querySelector('[name="question"]');q.value='پرسش معطل';q.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));click(f,'send-chat');await tick();
 click(f,'menu');await tick();f.doc.querySelector(`[data-action="open-session"][data-id="${row.id}"]`).click();await tick();
 finish({text:'پاسخ قدیمی'});await f.app.settled();
 assert.match(f.doc.querySelector('.conversation').textContent,/پیام گفتگو دیگر/);
 assert.doesNotMatch(f.doc.querySelector('.conversation').textContent,/پاسخ قدیمی/);f.close();
});

test('logging into a new account never inherits the previous account draft or notes',async()=>{
 const f=await fixture();click(f,'open-chat');const q=f.doc.querySelector('[name="question"]');q.value='PRIVATE OLD DRAFT';q.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));
 click(f,'account');click(f,'logout');await f.app.settled();
 f.api.login=async()=>({email:'second@example.test',phone:'09100000001'});
 click(f,'email-login');const form=f.doc.querySelector('[data-auth-form]');form.elements.email.value='second@example.test';form.elements.password.value='test';form.dispatchEvent(new f.dom.window.Event('submit',{bubbles:true,cancelable:true}));await f.app.settled();
 click(f,'open-chat');assert.equal(f.doc.querySelector('[name="question"]').value,'');f.close();
});

test('all displayed outside-book text and links survive saving the complete response',async()=>{
 const f=await fixture();click(f,'open-chat');const q=f.doc.querySelector('[name="question"]');q.value='وب';q.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));click(f,'send-chat');await f.app.settled();click(f,'save-answer');await f.app.settled();
 const saved=(await f.api.notes())[0];assert.match(saved.text,/بیرون از کتاب/);assert.match(saved.text,/https:\/\/fa.wikipedia.org/);f.close();
});

test('leaving the recording view invalidates delayed microphone permission and stops the track',async()=>{
 const f=await fixture();f.app.state.demo=false;click(f,'open-chat');
 let finish,stopped=0,started=0;
 Object.defineProperty(f.dom.window.navigator,'mediaDevices',{value:{getUserMedia:()=>new Promise(r=>finish=r)}});
 f.dom.window.MediaRecorder=class {constructor(){this.state='inactive';}start(){started++;this.state='recording';}stop(){this.state='inactive';}};
 click(f,'record');click(f,'open-reader');finish({getTracks:()=>[{stop(){stopped++;}}]});await f.app.settled();
 assert.equal(started,0);assert.equal(stopped,1);assert.equal(f.doc.querySelector('.recording'),null);f.close();
});


test('live guarded quotes remain visible, page-linked and complete when saved',async()=>{
 const f=await fixture();f.api.ask=async()=>({blocks:[{type:'heading',text:'عنوان'},{type:'paragraph',parts:[{text:'مقدمه'},{quote:'قرآن کتابی برای زندگی است',source:0,book_label:'طرح کلی اندیشۀ اسلامی در قرآن',pages_label:'صفحات 740 تا 745',first_page_label:'صفحه 740'},{text:'توضیح'}]}],citations:[{reference:'chunk 101 of document tarhe-kolli (pages 740-745)',passage:'قرآن کتابی برای زندگی است'}]});
 click(f,'open-chat');const q=f.doc.querySelector('[name="question"]');q.value='پرسش';q.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));click(f,'send-chat');await f.app.settled();
 const quote=f.doc.querySelector('.assistant .cite-sent');assert.ok(quote);assert.equal(quote.textContent,'قرآن کتابی برای زندگی است');assert.equal(quote.dataset.page,'740');assert.equal(quote.dataset.book,'tarhe-kolli');
 click(f,'save-answer');await f.app.settled();assert.match((await f.api.notes())[0].text,/قرآن کتابی برای زندگی است/);f.doc.querySelector('.assistant .cite-sent').click();await f.app.settled();assert.equal(f.doc.querySelector('.phone').dataset.pdfPage,'740');f.close();
});

test('an initial storage failure is visible on the attempted message and retry stores it exactly once',async()=>{
 for(const phase of ['createSession','append']){
  const f=await fixture();const original=f.api[phase];let fail=true;f.api[phase]=async(...args)=>{if(fail){fail=false;throw new Error('SERVER OFFLINE');}return original(...args);};
  click(f,'open-chat');const q=f.doc.querySelector('[name="question"]');q.value='ارسال اول';q.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));click(f,'send-chat');await f.app.settled();
  assert.equal(f.doc.querySelector('.user-message').textContent,'ارسال اول');assert.match(f.doc.querySelector('.send-failure').textContent,/تلاش دوباره/);assert.match(f.doc.querySelector('.user-turn').textContent,/SERVER OFFLINE/);
  click(f,'retry');await f.app.settled();assert.equal(f.doc.querySelectorAll('.user-message').length,1);assert.equal((await f.api.session(f.app.state.sessionId)).messages.filter(m=>m.role==='user').length,1);f.close();
 }
});

test('refreshing an open drawer keeps keyboard focus inside the dialog',async()=>{
 const f=await fixture();click(f,'open-chat');click(f,'menu');await f.app.settled();
 assert.ok(f.doc.activeElement.closest('.drawer'));f.close();
});

test('reload restores whether the conversation was following its newest messages',async()=>{
 const f=await fixture();click(f,'open-chat');const thread=f.doc.querySelector('.conversation');Object.defineProperties(thread,{scrollHeight:{value:600},clientHeight:{value:200}});thread.scrollTop=130;thread.dispatchEvent(new f.dom.window.Event('scroll'));f.app.dispose();
 const next=createMobileApp({root:f.doc.querySelector('#app'),api:f.api,storage:f.dom.window.localStorage});await next.ready;assert.equal(next.state.follow,false);assert.equal(f.doc.querySelector('.conversation').scrollTop,130);next.dispose();f.close();
});

test('stopping a request offers an explicit retry without a duplicate stored question',async()=>{
 const f=await fixture();let finish;f.api.ask=()=>new Promise(r=>finish=r);click(f,'open-chat');const q=f.doc.querySelector('[name="question"]');q.value='پرسش متوقف';q.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));click(f,'send-chat');await tick();click(f,'stop');finish({text:'نباید برسد'});await f.app.settled();
 assert.ok(f.doc.querySelector('[data-action="retry"]'));assert.doesNotMatch(f.doc.querySelector('.conversation').textContent,/نباید برسد/);f.api.ask=async()=>({text:'پاسخ دوباره'});click(f,'retry');await f.app.settled();assert.equal((await f.api.session(f.app.state.sessionId)).messages.filter(m=>m.role==='user').length,1);f.close();
});


test('the shared preview opens without login, even after an earlier guest session',async()=>{
 const f=await fixture(30,{loginRequired:false});await f.api.logout();f.app.dispose();const next=createMobileApp({root:f.doc.querySelector('#app'),api:f.api,storage:f.dom.window.localStorage});await next.ready;
 assert.equal(f.doc.querySelector('.phone').dataset.type,'reader');assert.equal(f.doc.querySelector('.phone').dataset.loginRequired,'false');assert.equal(f.doc.querySelector('[data-auth-form]'),null);
 f.doc.querySelector('[data-action="menu"]').click();f.doc.querySelector('[data-action="account"]').click();assert.equal(f.doc.querySelector('[data-action="logout"]'),null);next.dispose();f.close();
});

test('copy still works on a local network HTTP page without the secure clipboard API',async()=>{
 const f=await fixture();click(f,'open-chat');const q=f.doc.querySelector('[name="question"]');q.value='پرسش';q.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));click(f,'send-chat');await f.app.settled();let copied='';f.doc.execCommand=command=>{assert.equal(command,'copy');copied=f.doc.activeElement.value;return true;};click(f,'copy-answer');assert.match(copied,/برای فهم این بخش/);assert.equal(f.doc.querySelector('[data-clipboard-fallback]'),null);f.close();
});

test('excerpt, minimise, restore and chat handoff retain exact context and both drafts',async()=>{
 const f=await fixture();click(f,'open-chat');let input=f.doc.querySelector('[name="question"]');input.value='پیش‌نویس قدیمی';input.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));click(f,'open-reader');
 const selection={text:'یک دو سه چهار پنج شش هفت هشت نه ده',pages:[{page:100,start:10,end:49,text:'یک دو سه چهار پنج شش هفت هشت نه ده'}]};
 f.doc.querySelector('.phone').dispatchEvent(new f.dom.window.CustomEvent('reader-question',{bubbles:true,detail:selection}));
 assert.equal(f.doc.querySelector('.question-context').textContent,'یک دو سه … هشت نه ده');assert.equal(f.doc.querySelector('[data-action="close-question"]'),null);
 input=f.doc.querySelector('[name="reader-question"]');assert.ok(f.doc.querySelector('[data-action="reader-record"]'));input.value='این چه معنایی دارد؟';input.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));assert.ok(f.doc.querySelector('[data-action="send-reader"]'));assert.equal(f.doc.querySelector('[data-action="reader-record"]'),null);assert.equal(input,f.doc.querySelector('[name="reader-question"]'));
 f.doc.querySelector('.reader-page').dispatchEvent(new f.dom.window.Event('pointerdown',{bubbles:true}));assert.equal(f.doc.querySelector('[name="reader-question"]'),null);assert.equal(f.app.state.readerQuestion.draft,'این چه معنایی دارد؟');click(f,'restore');
 click(f,'expand-question');assert.equal(f.doc.querySelector('.phone').dataset.type,'chat');assert.equal(f.doc.querySelector('[name="question"]').value,'این چه معنایی دارد؟');assert.equal(f.app.state.messages.length,0);
 click(f,'send-chat');await f.app.settled();assert.deepEqual(JSON.parse(JSON.stringify(f.app.state.messages[0].payload.selection)),selection);
 click(f,'open-reader');assert.equal(f.app.state.drafts['tarhe-kolli'],'پیش‌نویس قدیمی');assert.ok(f.app.state.readerQuestion.answer);f.close();
});

test('minimising and expanding an in-flight reader answer never cancel or duplicate the request',async()=>{
 const f=await fixture();let resolve,requests=0;f.api.ask=()=>{requests++;return new Promise(r=>resolve=r);};
 const selection={text:'alpha',pages:[{page:100,start:0,end:5,text:'alpha'}]};f.doc.querySelector('.phone').dispatchEvent(new f.dom.window.CustomEvent('reader-question',{bubbles:true,detail:selection}));
 const input=f.doc.querySelector('[name="reader-question"]');input.value='توضیح بده';input.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));click(f,'send-reader');while(!resolve)await tick();
 f.doc.querySelector('.reader-page').dispatchEvent(new f.dom.window.Event('pointerdown',{bubbles:true}));assert.equal(f.app.state.busy,true);click(f,'restore');click(f,'expand-question');resolve({text:'پاسخ آزمایشی'});await f.app.settled();
 assert.equal(requests,1);assert.equal(f.app.state.messages.length,2);assert.match(f.doc.querySelector('.conversation').textContent,/پاسخ آزمایشی/);f.close();
});
