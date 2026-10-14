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
 assert.deepEqual([...root.querySelector('[data-page-wheel]').children].map(n=>Number(n.dataset.value)),[41,42,43]);
 root.querySelector('[data-session-wheel] [data-value="2"]').click();
 assert.deepEqual(picker.value,{page:62,session:2});
 assert.equal(root.querySelector('input').value,'۶۲');
 root.querySelector('[data-page-wheel]').dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'End',bubbles:true}));
 assert.deepEqual(picker.value,{page:64,session:2});
 root.querySelector('[data-session-wheel] [data-value="none"]').click();
 assert.deepEqual(picker.value,{page:1,session:null});
 assert.ok(!pagesForSession(sessions,null,70).includes(42));
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
 assert.deepEqual(f.app.state.pages,[62]);assert.deepEqual(f.app.state.positions['tarhe-kolli'],{page:42,zoom:1.5,scroll:120});
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
 f.element.querySelector('[data-player-collapse]').click();assert.equal(f.win.document.activeElement,handle);f.close();
});
