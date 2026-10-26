import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {continuousRects} from '../../ui/book-reader/highlight-geometry.mjs';
import {lectureParagraphAnchors} from '../../ui/book-reader/lecture-paragraphs.mjs';
import {installLecturePlayer} from '../../ui/book-reader/lecture-player.mjs';
import {installPlayerGestures} from '../../ui/mobile/reader-interactions.mjs';
import {pageSessionPickerMarkup,installPageSessionPicker,pagesForSession} from '../../ui/mobile/page-session-picker.mjs';
import {createMobileApp} from '../../ui/mobile/app-ui.mjs';
import {createDemoApi} from '../../ui/mobile/demo-api.mjs';

const tick=()=>new Promise(r=>setImmediate(r));
const settle=async()=>{for(let i=0;i<8;i++)await tick();};
const sessions=[{session:1,cover_page:41,book_pages:[42,43],audio_available:true},{session:2,cover_page:62,book_pages:[63,64],audio_available:true}];

test('continuous strips join word gaps but keep separate lines, columns and independent selections',()=>{
 const rects=[{left:60,top:10,width:30,height:20},{left:10,top:11,width:40,height:18},{left:10,top:40,width:25,height:20},{left:200,top:10,width:20,height:20}];
 const before=structuredClone(rects),strips=continuousRects(rects);
 assert.deepEqual(strips,[{left:10,top:10,width:80,height:20},{left:200,top:10,width:20,height:20},{left:10,top:40,width:25,height:20}]);
 assert.deepEqual(rects,before);
 assert.equal(continuousRects([{left:10,top:0,width:10,height:10},{left:24,top:0,width:10,height:10}],0).length,2);
});

test('two wheels edit a draft, restrict pages to a session including its cover, and permit uncovered pages',()=>{
 const dom=new JSDOM(pageSessionPickerMarkup({page:42})),root=dom.window.document.querySelector('[data-page-session-picker]');
 const changed=[],picker=installPageSessionPicker({root,page:42,count:70,sessions,onChange:value=>changed.push(value)});
 assert.deepEqual(picker.value,{page:42,session:1});
 assert.deepEqual([...root.querySelector('[data-page-wheel]').children].map(n=>n.dataset.value),['all','41','42','43']);
 assert.equal(root.querySelector('[data-page-wheel] [data-value="all"]').textContent,'تمام جلسه');
 assert.deepEqual([...root.querySelector('[data-session-wheel]').children].map(n=>n.dataset.value),['none','eshareh','preface','1','2']);
 root.querySelector('[data-session-wheel] [data-value="2"]').click();
 assert.deepEqual(picker.value,{page:62,session:2});
 assert.equal(root.querySelector('input').value,'۶۲');
 root.querySelector('[data-page-wheel]').dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'End',bubbles:true}));
 assert.deepEqual(picker.value,{page:64,session:2});
 root.querySelector('[data-session-wheel] [data-value="none"]').click();
 assert.deepEqual(picker.value,{page:1,session:null});
 assert.equal(pagesForSession(sessions,null,70).length,70);
 assert.equal(pagesForSession(sessions,'eshareh',70).length,28);
 assert.equal(pagesForSession(sessions,'preface',70).length,6);
 const input=root.querySelector('input');input.value='۶۳';input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));
 assert.deepEqual(picker.value,{page:63,session:2});
 assert.ok(changed.length>=3);
 picker.setSessions([]);assert.equal(root.querySelector('[data-session-wheel]').getAttribute('aria-disabled'),'true');
 assert.equal(root.querySelector('[data-page-wheel]').children.length,70);picker.dispose();dom.window.close();
});

test('disposing the picker cancels a pending scroll selection',async()=>{
 const dom=new JSDOM(pageSessionPickerMarkup()),root=dom.window.document.querySelector('[data-page-session-picker]');let changed=0;
 const picker=installPageSessionPicker({root,page:1,count:5,onChange:()=>changed++});
 const wheel=root.querySelector('[data-page-wheel]');wheel.scrollTop=88;wheel.dispatchEvent(new dom.window.Event('scroll'));picker.dispose();
 await new Promise(r=>setTimeout(r,160));assert.equal(changed,0);dom.window.close();
});

const dataFor=page=>page===42?{
 height:600,index:{items:[{textItemIndex:0,start:0,end:5},{textItemIndex:1,start:6,end:10},{textItemIndex:2,start:11,end:16}]},
 indexItems:[{str:'alpha',width:90,height:10,transform:[1,0,0,1,10,580]},{str:'beta',width:90,height:10,transform:[1,0,0,1,10,560]},{str:'gamma',width:90,height:10,transform:[1,0,0,1,10,90]}],
 paragraphs:[{page,start:0,end:5},{page,start:6,end:10},{page,start:11,end:16}],
}:{height:600,index:{items:[{textItemIndex:0,start:0,end:5}]},indexItems:[{str:'delta',width:90,height:10,transform:[1,0,0,1,10,580]}],paragraphs:[{page,start:0,end:5}]};
const session={session:1,duration:100,lecture_start:2,audio_url:'/books/b/lectures/1/audio',sentences:[
 {id:0,text:'alpha',page:42,start:2,end:4,boxes:[[42,10,10,100,20]]},
 {id:1,text:'beta',page:42,start:5,end:9,boxes:[[42,10,30,100,40]]},
 {id:2,text:'gamma',page:42,start:10,end:18,boxes:[[42,10,500,100,510]]},
 {id:3,text:'delta',page:43,start:20,end:30,boxes:[[43,10,10,100,20]]},
 {id:4,text:'unmapped',page:43,start:50,end:60},
]};
function playerFixture(fetchOverride,dataOverride){
 const dom=new JSDOM('<main><div class="reader-page"><div class="pdf-surface"></div></div><section data-lecture-player><button data-player-expand></button><div data-lecture-bar hidden><select data-lecture-session></select><button data-player-collapse></button><button data-lecture-back></button><button data-lecture-forward></button><select data-lecture-rate><option value="1">1</option><option value="1.5">1.5</option></select><input data-lecture-skip-intro type="checkbox" checked><input data-lecture-seek type="range"><span data-lecture-time></span><span data-lecture-duration></span><p data-lecture-caption></p></div><button data-audio-previous></button><button data-audio-play></button><button data-audio-next></button><p data-lecture-status></p></section></main>',{pretendToBeVisual:true});
 const win=dom.window,element=win.document.querySelector('main');let page=42,plays=0;const calls=[],shown=[];
 class FakeAudio extends win.EventTarget{
  constructor(){super();this.currentTime=0;this.paused=true;this.ended=false;this.attrs={};}
  set src(value){this.attrs.src=value;}get src(){return this.attrs.src;}getAttribute(key){return this.attrs[key]??null;}removeAttribute(key){delete this.attrs[key];}
  async play(){plays++;this.paused=false;this.dispatchEvent(new win.Event('play'));}
  pause(){this.paused=true;this.dispatchEvent(new win.Event('pause'));}
 }
 const audio=new FakeAudio(),highlights=[];
 const player=installLecturePlayer({element,book:'b',createAudio:()=>audio,getPage:()=>page,getPageData:dataOverride??(async page=>dataFor(page)),reader:{highlight:cue=>highlights.push(cue),pointAt:(page,x,y)=>({x,y})},showPage:async value=>{page=value;shown.push(value);},fetchImpl:async(url,options)=>{
  calls.push(url);if(fetchOverride)return fetchOverride(url,options);
  return {ok:true,json:async()=>url.endsWith('/lectures')?{sessions}:url.endsWith('/1')?session:{...session,session:2,audio_url:null}};
 }});
 return {dom,win,element,audio,player,calls,shown,highlights,get plays(){return plays;},set page(value){page=value;},close(){player.dispose();win.close();}};
}

test('unified transport plays recorded audio from the page, skips paragraphs across pages, and preserves pause',async()=>{
 const f=playerFixture();await f.player.ready;
 assert.ok(f.calls.every(url=>url.includes('/lectures')));
 f.element.querySelector('.pdf-surface').dispatchEvent(new f.win.MouseEvent('click',{bubbles:true,clientX:50,clientY:35}));await settle();assert.equal(f.plays,0,'ordinary reading taps must not start the unused player');
 f.element.querySelector('[data-audio-play]').click();await settle();assert.equal(f.audio.currentTime,2);assert.equal(f.audio.paused,false);
 await f.player.skipParagraph(1);assert.equal(f.audio.currentTime,5);assert.equal(f.audio.paused,false);
 f.player.pause();await f.player.skipParagraph(1);assert.equal(f.audio.currentTime,10);assert.equal(f.audio.paused,true);
 await f.player.skipParagraph(1);assert.equal(f.audio.currentTime,20);assert.deepEqual(f.shown,[43]);assert.equal(f.audio.paused,true);
 await f.player.skipParagraph(1);assert.equal(f.audio.currentTime,20);assert.match(f.element.querySelector('[data-lecture-status]').textContent,/آخرین/);
 await f.player.skipParagraph(-1);assert.equal(f.audio.currentTime,10);assert.deepEqual(f.shown,[43,42]);
 await f.player.open();assert.equal(f.audio.paused,true);f.player.setRate(1.5);assert.equal(f.audio.playbackRate,1.5);
 f.player.collapse();assert.equal(f.audio.paused,true);
 f.page=50;await f.player.pageChanged();assert.equal(f.element.querySelector('[data-audio-play]').disabled,true);
 f.page=42;await f.player.pageChanged();assert.equal(f.element.querySelector('[data-audio-play]').disabled,false);
 f.close();
});

test('a long hold consumes play; a cancelled hold and a short play retain ordinary behavior',async()=>{
 const f=playerFixture();await f.player.ready;
 const gestures=installPlayerGestures({root:f.element.querySelector('[data-lecture-player]'),holdMs:15,expand:()=>f.player.open()});
 const play=f.element.querySelector('[data-audio-play]');
 play.dispatchEvent(new f.win.MouseEvent('pointerdown',{bubbles:true,button:0}));await new Promise(r=>setTimeout(r,20));
 play.dispatchEvent(new f.win.MouseEvent('pointerup',{bubbles:true}));play.click();await settle();
 assert.equal(f.player.expanded,true);assert.equal(f.plays,0);
 f.player.collapse();play.dispatchEvent(new f.win.MouseEvent('pointerdown',{bubbles:true,button:0}));
 play.dispatchEvent(new f.win.MouseEvent('pointercancel',{bubbles:true}));await new Promise(r=>setTimeout(r,20));assert.equal(f.player.expanded,false);
 play.dispatchEvent(new f.win.MouseEvent('pointerdown',{bubbles:true,button:0}));play.dispatchEvent(new f.win.MouseEvent('pointerup',{bubbles:true}));play.click();await settle();assert.equal(f.plays,1);
 gestures.dispose();f.close();
});

test('paragraph anchors refuse unplaced timings and never mutate the canonical index',()=>{
 const data=dataFor(42),before=structuredClone(data);
 const anchors=lectureParagraphAnchors({sentences:[...session.sentences,{start:99,end:100,page:42,text:'unknown'}]},42,data);
 assert.deepEqual(anchors.map(x=>x.time),[2,5,10]);assert.deepEqual(data,before);
});

test('an obsolete session response and disposed transport cannot restore audio or autoplay',async()=>{
 let resolveOld;
 const f=playerFixture(async url=>{
  if(url.endsWith('/lectures'))return {ok:true,json:async()=>({sessions})};
  if(url.endsWith('/1'))return {ok:true,json:async()=>session};
  return new Promise(resolve=>resolveOld=resolve);
 });await f.player.ready;
 const old=f.player.loadSession(2);await tick();await f.player.loadSession(1);
 resolveOld({ok:true,json:async()=>({...session,session:2,audio_url:'/wrong'})});await old;
 assert.equal(f.audio.src,session.audio_url);assert.equal(f.plays,0);
 f.player.dispose();await f.player.play();assert.equal(f.plays,0);assert.equal(f.audio.src,undefined);f.win.close();
});

async function appFixture({fetchImpl}={}){
 const dom=new JSDOM('<main id="app"></main>',{url:'http://localhost/mobile/?demo=1',pretendToBeVisual:true}),root=dom.window.document.querySelector('main');
 const api=createDemoApi({storage:dom.window.localStorage,delay:0,loginRequired:false});
 const app=createMobileApp({root,api,fetchImpl});await app.ready;
 return {dom,root,api,app,close(){app.dispose();dom.window.close();}};
}
function click(f,action){f.root.querySelector(`[data-action="${action}"]`).click();}

test('chat header restores reading position; choosing page/session edits only chat context and cancellation discards the draft',async()=>{
 const f=await appFixture({fetchImpl:async()=>({ok:true,json:async()=>({sessions})})});
 const phone=f.root.querySelector('.phone');phone.dataset.pdfPage='42';phone.dataset.pdfZoom='1.5';phone.querySelector('.reader-page').scrollTop=120;
 click(f,'menu');click(f,'open-chat');
 click(f,'pages');await f.app.settled();
 f.root.querySelector('[data-session-wheel] [data-value="2"]').click();click(f,'close-sheet');assert.deepEqual(f.app.state.pages,[42]);
 click(f,'pages');await f.app.settled();f.root.querySelector('[data-session-wheel] [data-value="2"]').click();
 f.root.querySelector('[data-pages-form]').dispatchEvent(new f.dom.window.Event('submit',{bubbles:true,cancelable:true}));
 assert.deepEqual(f.app.state.pages,[62,63,64]);assert.equal(f.app.state.sessionContext,2);assert.match(f.root.querySelector('.pages-button').textContent,/جلسه [2۲]/);assert.deepEqual(f.app.state.positions['tarhe-kolli'],{page:42,zoom:1.5,scroll:120});
 const pill=f.root.querySelector('.pages-button'),classes=pill.className;click(f,'toggle-scope');assert.equal(f.root.querySelector('.pages-button').className,classes);
 click(f,'open-reader');assert.equal(f.root.querySelector('.phone').dataset.pdfPage,'42');assert.equal(f.root.querySelector('.phone').dataset.pdfScroll,'120');f.close();
});

test('conversation actions stay inside the open drawer, Escape returns to their trigger, and delete still requires confirmation',async()=>{
 const f=await appFixture();await f.api.createSession('tarhe-kolli','عنوان');click(f,'menu');click(f,'open-chat');click(f,'menu');await f.app.settled();
 const trigger=f.root.querySelector('[data-action="session-more"]');trigger.click();
 assert.ok(f.root.querySelector('.drawer'));assert.ok(!f.root.querySelector('.app-sheet'));assert.equal(trigger.getAttribute('aria-expanded'),'true');
 assert.equal(f.root.querySelectorAll('[role="menuitem"]').length,2);
 f.root.querySelector('[role="menuitem"]').dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
 assert.ok(f.root.querySelector('.drawer'));assert.ok(!f.root.querySelector('.session-popover'));assert.equal(f.dom.window.document.activeElement,trigger);
 trigger.click();f.root.querySelector('.drawer-title').dispatchEvent(new f.dom.window.MouseEvent('pointerdown',{bubbles:true}));assert.equal(f.dom.window.document.activeElement,trigger);assert.ok(!f.root.querySelector('.session-popover'));
 trigger.click();click(f,'confirm-delete-session');assert.ok(f.root.querySelector('[data-action="delete-session"]'));assert.equal((await f.api.sessions()).length,1);f.close();
});

test('saved highlights rehydrate on page readiness independently of transient playback focus',async()=>{
 const f=await appFixture(),selection={text:'متن',pages:[{page:100,start:1,end:4,text:'متن'}]};
 let saved=[],transient=0;f.root.querySelector('.phone').bookReader={setHighlights:passages=>saved=passages,highlight:()=>transient++};
 f.root.dispatchEvent(new f.dom.window.CustomEvent('reader-selection-action',{bubbles:true,detail:{action:'highlight',selection}}));await f.app.settled();
 assert.deepEqual(saved,selection.pages);assert.equal(transient,0);
 click(f,'menu');click(f,'open-chat');click(f,'open-reader');
 f.root.querySelector('.phone').bookReader={setHighlights:passages=>saved=passages};saved=[];
 f.root.querySelector('.phone').dispatchEvent(new f.dom.window.CustomEvent('book-page-ready',{bubbles:true,detail:{page:100}}));assert.deepEqual(saved,selection.pages);f.close();
});

test('pausing during paragraph preparation invalidates a pending play intent',async()=>{
 let finish;
 const f=playerFixture(undefined,()=>new Promise(resolve=>finish=resolve));await f.player.ready;
 const pending=f.player.play();await settle();f.player.pause();finish(dataFor(42));await pending;
 assert.equal(f.plays,0);assert.equal(f.audio.paused,true);f.close();
});

test('paragraph skipping follows the audio position, not the page on screen, and never lands in the middle of a paragraph',async()=>{
  const f=playerFixture();await f.player.ready;
  f.element.querySelector('[data-audio-play]').click();await settle();assert.equal(f.audio.currentTime,2);
  // The audio is inside the paragraph that began at 10, but the reader has flipped on to page 43.
  f.audio.currentTime=12;f.page=43;
  await f.player.skipParagraph(-1);assert.equal(f.audio.currentTime,5,'previous is the paragraph before the one being heard');assert.deepEqual(f.shown,[42]);
  f.audio.currentTime=12;f.page=42;
  await f.player.skipParagraph(1);assert.equal(f.audio.currentTime,20,'next is the first paragraph that begins after the audio');
  f.close();
});

test('the tail of a paragraph running on from the previous page is not a paragraph start',async()=>{
  const crossing={id:2,text:'gamma delta',page:42,start:10,end:18,boxes:[[42,10,500,100,510],[43,10,10,100,20]],words:[
    {text:'gamma',start:10,end:11,boxes:[[42,10,500,100,510]]},{text:'delta',start:12,end:13,boxes:[[43,10,10,100,20]]}]};
  const run={...session,sentences:[session.sentences[0],session.sentences[1],crossing]};
  const f=playerFixture(async url=>({ok:true,json:async()=>url.endsWith('/lectures')?{sessions}:run}));await f.player.ready;
  f.element.querySelector('[data-audio-play]').click();await settle();
  await f.player.skipParagraph(1);assert.equal(f.audio.currentTime,5);
  await f.player.skipParagraph(1);assert.equal(f.audio.currentTime,10);
  await f.player.skipParagraph(1);assert.equal(f.audio.currentTime,10,'time 12 is mid-sentence on page 43; there is no later paragraph to start from');
  assert.match(f.element.querySelector('[data-lecture-status]').textContent,/آخرین/);
  const anchors=lectureParagraphAnchors({sentences:[crossing]},43,dataFor(43));
  assert.deepEqual(anchors.map(a=>[a.time,a.continued]),[[12,true]]);
  f.close();
});

test('a page whose timings failed to load is retried on the next paragraph press',async()=>{
  let failures=1;
  const f=playerFixture(undefined,async page=>{if(page===42&&failures-->0)throw new Error('offline');return dataFor(page);});await f.player.ready;
  await f.player.skipParagraph(1);assert.match(f.element.querySelector('[data-lecture-status]').textContent,/بارگذاری نشد/);
  await f.player.skipParagraph(1);assert.equal(f.audio.currentTime,5);
  f.close();
});

test('a sentence spanning pages seeks to the first timed word on the requested page, never its earlier onset',()=>{
 const cue={start:2,end:30,speech_start:2,boxes:[[41,10,10,100,20]],sentence_focus:{boxes:[[41,10,10,100,20],[42,10,10,100,20]]},words:[
  {start:2,end:3,boxes:[[41,10,10,100,20]]},{start:12,end:13,boxes:[[42,10,10,100,20]]},
  {start:15,end:16,boxes:[[42,10,30,100,40]]},
 ]};
 assert.deepEqual(lectureParagraphAnchors({sentences:[cue]},42,dataFor(42)).map(p=>p.time),[12,15]);
 assert.equal(lectureParagraphAnchors({sentences:[{start:2,end:30,boxes:[[41,10,10,100,20],[42,10,10,100,20]]}]},42,dataFor(42)).length,0);
});

test('keyboard expansion moves focus to the session control and collapsing restores the handle',async()=>{
 const f=playerFixture();await f.player.ready;
 const handle=f.element.querySelector('[data-player-expand]');handle.focus();handle.click();await settle();
 assert.equal(f.win.document.activeElement,f.element.querySelector('[data-lecture-session]'));
 f.element.querySelector('[data-player-collapse]').click();assert.equal(f.win.document.activeElement,handle);
 handle.click();await settle();assert.equal(f.player.expanded,true);
 f.win.document.dispatchEvent(new f.win.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
 assert.equal(f.player.expanded,false);assert.equal(f.win.document.activeElement,handle);
 f.close();
});

test('clicking the speed button opens popover panel and selecting rate updates playback rate and text',async()=>{
  const dom=new JSDOM('<main><button data-player-expand></button><div data-lecture-bar hidden><select data-lecture-session></select><button data-player-collapse></button><button data-lecture-back></button><button data-lecture-forward></button><div class="lecture-rate-wrap" data-lecture-rate-wrap><button type="button" class="lecture-rate-chip" data-lecture-rate data-rate="1" aria-expanded="false" aria-controls="lecture-rate-panel"><span class="rate-label">سرعت</span><span class="rate-value" data-rate-value>۱×</span></button><div id="lecture-rate-panel" class="lecture-rate-popover" data-lecture-rate-panel role="group" hidden><button type="button" data-rate-option="0.75" aria-pressed="false"><span class="rate-option-text">۰.۷۵×</span></button><button type="button" data-rate-option="1" aria-pressed="true"><span class="rate-option-text">۱×</span></button><button type="button" data-rate-option="1.25" aria-pressed="false"><span class="rate-option-text">۱.۲۵×</span></button><button type="button" data-rate-option="1.5" aria-pressed="false"><span class="rate-option-text">۱.۵×</span></button><button type="button" data-rate-option="2" aria-pressed="false"><span class="rate-option-text">۲×</span></button></div></div><input data-lecture-skip-intro type="checkbox" checked><input data-lecture-seek type="range"><span data-lecture-time></span><span data-lecture-duration></span><p data-lecture-caption></p></div><button data-audio-previous></button><button data-audio-play></button><button data-audio-next></button><p data-lecture-status></p></main>');
  const element=dom.window.document.querySelector('main');
  class FakeAudio extends dom.window.EventTarget{constructor(){super();this.currentTime=0;this.playbackRate=1;this.paused=true;this.attrs={};}
   set src(v){this.attrs.src=v;}get src(){return this.attrs.src;}getAttribute(k){return this.attrs[k]??null;}removeAttribute(k){delete this.attrs[k];}
   async play(){this.paused=false;this.dispatchEvent(new dom.window.Event('play'));}pause(){this.paused=true;this.dispatchEvent(new dom.window.Event('pause'));}}
  const audio=new FakeAudio();
  const player=installLecturePlayer({element,book:'b',createAudio:()=>audio,getPage:()=>42,fetchImpl:async url=>({ok:true,json:async()=>url.endsWith('/lectures')?{sessions}:session})});
  await player.ready;
  const rateBtn=element.querySelector('[data-lecture-rate]');
  const ratePanel=element.querySelector('#lecture-rate-panel');
  assert.equal(audio.playbackRate,1);
  assert.equal(rateBtn.querySelector('[data-rate-value]').textContent,'۱×');
  assert.equal(ratePanel.hidden,true);
  assert.equal(rateBtn.getAttribute('aria-expanded'),'false');

  // Clicking rateBtn opens the popover panel
  rateBtn.click();
  assert.equal(ratePanel.hidden,false);
  assert.equal(rateBtn.getAttribute('aria-expanded'),'true');

  // Selecting 1.25x option updates playbackRate and closes panel
  const opt125=ratePanel.querySelector('[data-rate-option="1.25"]');
  opt125.click();
  assert.equal(audio.playbackRate,1.25);
  assert.equal(rateBtn.getAttribute('data-rate'),'1.25');
  assert.equal(rateBtn.querySelector('[data-rate-value]').textContent,'۱.۲۵×');
  assert.equal(ratePanel.hidden,true);
  assert.equal(rateBtn.getAttribute('aria-expanded'),'false');

  // Re-open and select 2x option
  rateBtn.click();
  assert.equal(ratePanel.hidden,false);
  const opt2=ratePanel.querySelector('[data-rate-option="2"]');
  opt2.click();
  assert.equal(audio.playbackRate,2);
  assert.equal(rateBtn.getAttribute('data-rate'),'2');
  assert.equal(rateBtn.querySelector('[data-rate-value]').textContent,'۲×');
  assert.equal(ratePanel.hidden,true);

  // Escape key closes rate panel when open
  rateBtn.click();
  assert.equal(ratePanel.hidden,false);
  dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
  assert.equal(ratePanel.hidden,true);
  assert.equal(rateBtn.getAttribute('aria-expanded'),'false');

  // Calling setRate directly also updates playbackRate and button label
  player.setRate(1.5);
  assert.equal(audio.playbackRate,1.5);
  assert.equal(rateBtn.getAttribute('data-rate'),'1.5');
  assert.equal(rateBtn.querySelector('[data-rate-value]').textContent,'۱.۵×');

  player.dispose();
  dom.window.close();
});

test('adjust mode player markup renders swapped paragraph/10s buttons and combined footer row',async()=>{
  const {mainView}=await import('../../ui/mobile/views.mjs');
  const html=mainView({view:'reader',book:'tarhe-kolli',positions:{},readerQuestion:null});
  const dom=new JSDOM(html);
  const doc=dom.window.document;

  const transport=doc.querySelector('.audio-transport');
  assert.ok(transport,'audio transport exists');
  const parNext=transport.querySelector('.transport-paragraph[data-audio-next]');
  const parPrev=transport.querySelector('.transport-paragraph[data-audio-previous]');
  const secFwd=transport.querySelector('.transport-seconds[data-lecture-forward]');
  const secBack=transport.querySelector('.transport-seconds[data-lecture-back]');
  assert.ok(parNext,'paragraph next button exists in transport');
  assert.ok(parPrev,'paragraph previous button exists in transport');
  assert.ok(secFwd,'10s forward button exists in transport');
  assert.ok(secBack,'10s back button exists in transport');

  const sheet=doc.querySelector('#lecture-details');
  assert.ok(sheet,'lecture-details sheet exists');
  // Paragraph buttons must NOT exist inside the expanded sheet
  const sheetParPrev=sheet.querySelector('[data-audio-previous]');
  const sheetParNext=sheet.querySelector('[data-audio-next]');
  assert.equal(sheetParPrev,null,'paragraph previous button is removed from sheet');
  assert.equal(sheetParNext,null,'paragraph next button is removed from sheet');

  // Combined controls row
  const footerRow=sheet.querySelector('.lecture-controls-row.lecture-footer-row');
  assert.ok(footerRow,'lecture footer row exists');
  const sessionSelect=footerRow.querySelector('select[data-lecture-session]');
  assert.ok(sessionSelect,'session picker is inside controls row');
  const skipToggle=footerRow.querySelector('.lecture-skip-toggle [data-lecture-skip-intro]');
  assert.ok(skipToggle,'skip intro toggle is inside footer row');
  const toggleLabel=footerRow.querySelector('.lecture-skip-toggle .toggle-label');
  assert.equal(toggleLabel.textContent.trim(),'بدون مقدمه','label is simplified to without preamble');

  const rateWrap=footerRow.querySelector('[data-lecture-rate-wrap]');
  assert.ok(rateWrap,'rate wrap exists inside footer row');
  const rateBtn=rateWrap.querySelector('.lecture-rate-chip[data-lecture-rate]');
  assert.ok(rateBtn,'rate button is inside rate wrap');
  assert.equal(rateBtn.tagName,'BUTTON','rate control is an interactive button');
  assert.equal(rateBtn.getAttribute('data-rate'),'1');
  assert.match(rateBtn.textContent,/سرعت/);
  assert.match(rateBtn.textContent,/۱×/);

  const ratePanel=rateWrap.querySelector('#lecture-rate-panel');
  assert.ok(ratePanel,'rate popover panel exists inside rate wrap');
  assert.equal(ratePanel.hidden,true,'rate popover panel is initially hidden');
  const options=ratePanel.querySelectorAll('[data-rate-option]');
  assert.equal(options.length,5,'popover offers 5 playback rate options');

  dom.window.close();
});

test('multi-button interaction: 10s seek buttons in transport and paragraph step in collapsed mode trigger player actions',async()=>{
  const {mainView}=await import('../../ui/mobile/views.mjs');
  const html=`<main>${mainView({view:'reader',book:'tarhe-kolli',positions:{},readerQuestion:null})}</main>`;
  const dom=new JSDOM(html);
  const win=dom.window,element=win.document.querySelector('main');
  class FakeAudio extends win.EventTarget{constructor(){super();this.currentTime=0;this.playbackRate=1;this.paused=true;this.attrs={};}
   set src(v){this.attrs.src=v;}get src(){return this.attrs.src;}getAttribute(k){return this.attrs[k]??null;}removeAttribute(k){delete this.attrs[k];}
   async play(){this.paused=false;this.dispatchEvent(new win.Event('play'));}pause(){this.paused=true;this.dispatchEvent(new win.Event('pause'));}}
  const audio=new FakeAudio();
  const player=installLecturePlayer({element,book:'b',createAudio:()=>audio,getPage:()=>42,getPageData:async()=>dataFor(42),reader:{highlight(){},pointAt:(p,x,y)=>({x,y})},showPage:async()=>{},fetchImpl:async url=>({ok:true,json:async()=>url.endsWith('/lectures')?{sessions}:session})});
  await player.ready;
  await player.open();
  assert.equal(player.expanded,true);

  element.querySelector('[data-audio-play]').click();
  await settle();
  assert.equal(audio.currentTime,2);

  const fwdBtn=element.querySelector('.audio-transport [data-lecture-forward]');
  fwdBtn.click();
  await settle();
  assert.equal(audio.currentTime,12);

  const backBtn=element.querySelector('.audio-transport [data-lecture-back]');
  backBtn.click();
  await settle();
  assert.equal(audio.currentTime,2);

  // In collapsed mode, paragraph buttons in transport trigger paragraph navigation
  player.collapse();
  assert.equal(player.expanded,false);

  const parNext=element.querySelector('.audio-transport [data-audio-next]');
  parNext.click();
  await settle();
  assert.equal(audio.currentTime,5);

  const parPrev=element.querySelector('.audio-transport [data-audio-previous]');
  parPrev.click();
  await settle();
  assert.equal(audio.currentTime,2);

  player.dispose();
  win.close();
});
