import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createScreenWakeLock} from '../../ui/book-reader/screen-wake-lock.mjs';
import {createMediaSessionBridge} from '../../ui/book-reader/media-session-bridge.mjs';
import {installNarrationControls} from '../../ui/book-reader/audio-controls.mjs';
const tick=()=>new Promise(r=>setImmediate(r));

function wakeFixture({supported=true}={}){
 const sentinels=[];const docListeners={};
 const doc={_vis:'visible',
  get visibilityState(){return this._vis;},
  addEventListener(type,fn){(docListeners[type]??=[]).push(fn);},
  removeEventListener(){},
  dispatch(type){for(const fn of docListeners[type]??[])fn();}};
 const wakeLock=supported?{request:async()=>{
  const sentinel={_onrelease:null,release:async()=>{sentinel._onrelease?.();},
   addEventListener(type,fn){if(type==='release')sentinel._onrelease=fn;},removeEventListener(){}};
  sentinels.push(sentinel);return sentinel;}}:undefined;
 const win={navigator:{wakeLock},document:doc};
 return {win,doc,sentinels,
  show(){doc._vis='visible';doc.dispatch('visibilitychange');},
  hide(){doc._vis='hidden';doc.dispatch('visibilitychange');}};
}

test('the reading view holds a screen wake lock while open and lets it go when closed',async()=>{
 const f=wakeFixture();const events=[];const lock=createScreenWakeLock({win:f.win,onChange:e=>events.push(e)});
 await lock.set(true);
 assert.equal(f.sentinels.length,1);assert.equal(lock.held,true);assert.deepEqual(events,['held']);
 await lock.set(false);
 assert.equal(lock.held,false);assert.deepEqual(events,['held','released']);
 lock.dispose();
});

test('a lock or hide drops the sentinel and the return re-acquires it',async()=>{
 const f=wakeFixture();const lock=createScreenWakeLock({win:f.win});
 await lock.set(true);
 f.hide();await tick(); // platform drops it on hide; our sync releases the rest
 assert.equal(lock.held,false);
 f.show();await tick();
 assert.equal(lock.held,true);assert.equal(f.sentinels.length,2,'re-acquired, not reused');
 lock.dispose();
});

test('a browser without the Wake Lock API stays silent instead of throwing',async()=>{
 const f=wakeFixture({supported:false});const events=[];const lock=createScreenWakeLock({win:f.win,onChange:e=>events.push(e)});
 await lock.set(true);
 assert.equal(lock.held,false);assert.deepEqual(events,['unsupported']);
 lock.dispose();
});

function sessionFixture(){
 const ms={setActionHandler:(action,fn)=>{ms[action]=fn;},setPositionState(state){ms.lastPosition=state;}};
 const win={navigator:{mediaSession:ms},MediaMetadata:class{constructor(init){Object.assign(this,init);}}};
 return {win,ms};
}

test('the lock screen gets metadata, playback state and play/pause handlers',()=>{
 const {win,ms}=sessionFixture();const media=createMediaSessionBridge({win});
 media.announce({title:'شنیدن صفحهٔ ۳ — پاراگراف ۲',artist:'انسان ۲۵۰ ساله',album:'کتاب‌خوان'});
 media.state('playing');
 media.handlers({play(){},pause(){}});
 media.position({position:5,duration:10,rate:1.5});
 assert.equal(ms.metadata.title,'شنیدن صفحهٔ ۳ — پاراگراف ۲');
 assert.equal(ms.metadata.artist,'انسان ۲۵۰ ساله');
 assert.equal(ms.playbackState,'playing');
 assert.equal(typeof ms.play,'function');assert.equal(typeof ms.pause,'function');
 assert.deepEqual(ms.lastPosition,{position:5,duration:10,playbackRate:1.5});
 media.clear();
 assert.equal(ms.metadata,null);assert.equal(ms.playbackState,'paused');
});

test('a browser without MediaSession skips every bridge call',()=>{
 const media=createMediaSessionBridge({win:{}});
 assert.doesNotThrow(()=>{media.announce({title:'x'});media.state('playing');media.handlers({play(){}});media.clear();});
});

function narrationFixture(document,{fetchImpl}={}){
 const element=document.createElement('div');
 element.innerHTML='<button data-reader-read></button><button data-reader-toggle></button><button data-reader-stop></button><select data-reader-speed><option value="1">1</option></select><input data-reader-seek><p data-reader-audio-status></p>';
 document.body.append(element);
 const players=[];
 const controls=installNarrationControls({element,
  reader:{captureSelection:()=>null,getPageIndex:()=>({text:'متن آزمایشی صفحه'}),loadAudio(input){
   const player={state:'ready',currentTime:0,
    pause(){this.state='paused';input.onState('paused');},
    async play(){this.state='playing';input.onState('playing');},
    async seek(){},setRate(){},dispose(){}};
   players.push(player);return player;}},
  getContext:async()=>({doc:'book',page:2,title:'انسان ۲۵۰ ساله'}),
  fetchImpl:fetchImpl??(async()=>({ok:true,json:async()=>({audioBase64:btoa('bytes'),mimeType:'audio/wav',durationMs:1000,cues:[]})}))});
 return {element,players,controls};
}

// jsdom reports 'prerender'; the lock/unlock cycle is the real-world shape we resume on.
function setVisibility(document,value){
 Object.defineProperty(document,'visibilityState',{value,configurable:true});
 document.dispatchEvent(new document.defaultView.Event('visibilitychange'));
}

test('the platform pausing the element mid-narration resumes from where it stopped on return',async()=>{
 const dom=new JSDOM();const doc=dom.window.document;
 const f=narrationFixture(doc);
 f.element.querySelector('[data-reader-read]').click();
 await tick();await tick();
 assert.equal(f.players.at(-1).state,'playing');
 // The OS suspends the element while the phone is locked; the player reports it honestly now.
 f.players.at(-1).state='paused';
 setVisibility(doc,'hidden');
 setVisibility(doc,'visible');
 await tick();
 assert.equal(f.players.at(-1).state,'playing','resumed without user action');
 f.controls.dispose();dom.window.close();
});

test('a narration the user paused themselves stays paused after returning',async()=>{
 const dom=new JSDOM();const doc=dom.window.document;
 const f=narrationFixture(doc);
 f.element.querySelector('[data-reader-read]').click();
 await tick();await tick();
 f.element.querySelector('[data-reader-toggle]').click(); // user pause
 assert.equal(f.players.at(-1).state,'paused');
 setVisibility(doc,'hidden');
 setVisibility(doc,'visible');
 await tick();
 assert.equal(f.players.at(-1).state,'paused','the user pause is respected');
 f.controls.dispose();dom.window.close();
});
