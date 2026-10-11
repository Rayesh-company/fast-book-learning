import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createLectureTrack, sentenceIndexAt, toneFor, pageForTime, boxesOnPage, sentenceAtPoint,
  sessionForPage, formatClock} from '../../ui/book-reader/lecture-sync.mjs';
import {installLecturePlayer} from '../../ui/book-reader/lecture-player.mjs';
const tick=()=>new Promise(r=>setImmediate(r));
const settle=async(n=8)=>{for(let i=0;i<n;i++)await tick();};

const SESSION={session:1,duration:100,lecture_start:2,audio_url:'/books/b/lectures/1/audio',sentences:[
 {id:0,text:'آیه',page:42,page_end:42,start:2,end:4,flags:['quran','rough_timing'],boxes:[[42,10,10,100,20]]},
 {id:1,text:'جملهٔ اول.',page:42,page_end:42,start:5,end:9,flags:[],boxes:[[42,10,30,100,40]]},
 // book order differs from time order once; input order must not matter
 {id:3,text:'جملهٔ سوم.',page:43,page_end:43,start:20,end:30,flags:[],boxes:[[43,10,10,100,20]]},
 {id:2,text:'جمله‌ای که به صفحهٔ بعد می‌رود.',page:42,page_end:43,start:10,end:22,flags:['interpolated'],
  boxes:[[42,10,500,100,510],[42,10,520,100,530],[42,10,540,100,550],[43,10,0,100,8]]},
 {id:4,text:'بی‌جا',page:43,page_end:43,start:40,end:41,flags:[]},
]};

test('binary search finds the spoken sentence, gaps hold the previous one, overlaps are clipped',()=>{
 const track=createLectureTrack(SESSION);
 assert.deepEqual(track.sentences.map(s=>s.id),[0,1,2,3,4]);
 assert.deepEqual(sentenceIndexAt(track,0),{index:-1,active:false});
 assert.deepEqual(sentenceIndexAt(track,2),{index:0,active:true});      // half-open: start included
 assert.deepEqual(sentenceIndexAt(track,4),{index:0,active:false});     // end excluded → held
 assert.deepEqual(sentenceIndexAt(track,4.5),{index:0,active:false});
 assert.deepEqual(sentenceIndexAt(track,8.99),{index:1,active:true});
 assert.deepEqual(sentenceIndexAt(track,21),{index:3,active:true});     // 2 overlaps 3: clipped at 20
 assert.deepEqual(sentenceIndexAt(track,19.9),{index:2,active:true});
 assert.deepEqual(sentenceIndexAt(track,1e6),{index:4,active:false});
 const big=createLectureTrack({sentences:Array.from({length:5000},(_,i)=>({id:i,start:i*2,end:i*2+1.5}))});
 for(const t of [0,1.6,777.2,9999.4])assert.equal(sentenceIndexAt(big,t).index,Math.floor(t/2));
});

test('tones, page split across a page break, boxes and hit testing',()=>{
 const track=createLectureTrack(SESSION);const [quran,first,spanning]=track.sentences;
 assert.equal(toneFor(quran),'exact');assert.equal(toneFor(first),'exact');assert.equal(toneFor(first,false),'held');
 assert.equal(pageForTime(spanning,10),42);assert.equal(pageForTime(spanning,16),42);assert.equal(pageForTime(spanning,19.9),43);
 assert.equal(pageForTime(first,6),42);
 assert.deepEqual(boxesOnPage(spanning,43),[{page:43,x0:10,y0:0,x1:100,y1:8}]);
 assert.equal(sentenceAtPoint(track,42,50,35).id,1);assert.equal(sentenceAtPoint(track,43,50,15).id,3);
 assert.equal(sentenceAtPoint(track,42,300,35),null);
 const sessions=[{session:1,cover_page:41,book_pages:[42,58]},{session:2,cover_page:62,book_pages:[63,86]}];
 assert.equal(sessionForPage(sessions,41).session,1);assert.equal(sessionForPage(sessions,70).session,2);assert.equal(sessionForPage(sessions,60),null);
 assert.equal(formatClock(65),'۱:۰۵');assert.equal(formatClock(3725),'۱:۰۲:۰۵');
});

function fixture({page=42}={}){
 const dom=new JSDOM(`<main><div class="reader-page"><div class="pdf-surface"></div></div><button data-lecture-toggle hidden></button><section data-lecture-bar hidden><select data-lecture-session></select><button data-lecture-back></button><button data-lecture-play></button><button data-lecture-forward></button><input type="checkbox" data-lecture-skip-intro checked><span data-lecture-time></span><input type="range" data-lecture-seek><span data-lecture-duration></span><p data-lecture-caption></p><p data-lecture-status></p></section></main>`);
 const win=dom.window,element=win.document.querySelector('main');
 class FakeAudio extends win.EventTarget{constructor(){super();this.currentTime=0;this.paused=true;this.ended=false;this.attrs={};}
  set src(v){this.attrs.src=v;}get src(){return this.attrs.src;}getAttribute(n){return this.attrs[n]??null;}removeAttribute(n){delete this.attrs[n];}
  async play(){this.paused=false;this.dispatchEvent(new win.Event('play'));}pause(){this.paused=true;this.dispatchEvent(new win.Event('pause'));}
  at(t){this.currentTime=t;this.dispatchEvent(new win.Event('timeupdate'));}}
 const audio=new FakeAudio();const highlights=[],shown=[],calls=[];let current=page,activated=0;
 const sessions=[{session:1,cover_page:41,book_pages:[42,43],audio_available:true},{session:2,cover_page:62,book_pages:[63,86],audio_available:false}];
 const fetchImpl=async url=>{calls.push(url);
  if(url.endsWith('/lectures'))return {ok:true,json:async()=>({sessions})};
  if(url.endsWith('/lectures/1'))return {ok:true,json:async()=>SESSION};
  if(url.endsWith('/lectures/2'))return {ok:true,json:async()=>({...SESSION,session:2,audio_url:null})};
  return {ok:false,json:async()=>({detail:'نیست'})};};
 const reader={highlight(cue){highlights.push(cue);},pointAt:(p,x,y)=>({x,y})};
 const player=installLecturePlayer({element,reader,book:'b',fetchImpl,createAudio:()=>audio,getPage:()=>current,
  showPage:async p=>{shown.push(p);current=p;},onActivate:()=>activated++});
 return {win,element,audio,player,highlights,shown,calls,get activated(){return activated;},close(){player.dispose();win.close();}};
}

test('the player opens on the page\'s session, skips the intro, follows the voice across pages',async()=>{
 const f=fixture();await settle();
 const toggle=f.element.querySelector('[data-lecture-toggle]');assert.equal(toggle.hidden,false);
 toggle.click();await settle();
 assert.equal(f.element.querySelector('[data-lecture-session]').value,'1');
 assert.equal(f.audio.src,'/books/b/lectures/1/audio');
 f.element.querySelector('[data-lecture-play]').click();await settle();
 assert.equal(f.audio.currentTime,2);assert.equal(f.activated,1);assert.equal(f.audio.paused,false);
 f.audio.at(2.5);await settle();
 assert.deepEqual(f.highlights.at(-1),{page:42,boxes:[{page:42,x0:10,y0:10,x1:100,y1:20}],tone:'exact',text:'آیه',lecture:0});
 f.audio.at(6);await settle();assert.equal(f.highlights.at(-1).tone,'exact');
 assert.equal(f.element.querySelector('[data-lecture-caption]').textContent,'جملهٔ اول.');
 const count=f.highlights.length;f.audio.at(6.5);await settle();assert.equal(f.highlights.length,count); // no repaint per tick
 f.audio.at(19.5);await settle();assert.deepEqual(f.shown,[43]);assert.equal(f.highlights.at(-1).page,43);
 f.audio.at(40.5);await settle(); // a sentence without boxes: caption only, highlight cleared
 assert.equal(f.highlights.at(-1),null);assert.equal(f.element.querySelector('[data-lecture-caption]').dataset.unplaced,'true');
 f.close();
});

test('clicking a sentence on the page seeks to it; a session without audio says so',async()=>{
 const f=fixture();await settle();f.element.querySelector('[data-lecture-toggle]').click();await settle();
 const surface=f.element.querySelector('.pdf-surface');
 surface.dispatchEvent(new f.win.MouseEvent('click',{bubbles:true,clientX:50,clientY:35}));await settle();
 assert.equal(f.audio.currentTime,5);assert.equal(f.audio.paused,false);
 const select=f.element.querySelector('[data-lecture-session]');select.value='2';select.dispatchEvent(new f.win.Event('change'));await settle();
 assert.equal(f.element.querySelector('[data-lecture-play]').disabled,true);
 assert.equal(f.element.querySelector('[data-lecture-status]').textContent,'صوت این جلسه روی سرور نیست.');
 f.close();
});

test('without a lecture index the control stays hidden',async()=>{
 const dom=new JSDOM('<main><button data-lecture-toggle hidden></button><section data-lecture-bar hidden><select data-lecture-session></select><button data-lecture-play></button><input data-lecture-seek><span data-lecture-time></span><span data-lecture-duration></span><p data-lecture-caption></p></section></main>');
 const element=dom.window.document.querySelector('main');
 const player=installLecturePlayer({element,reader:{highlight(){}},book:'x',getPage:()=>1,showPage:async()=>{},
  fetchImpl:async()=>({ok:false,json:async()=>({})}),createAudio:()=>Object.assign(new dom.window.EventTarget(),{paused:true,pause(){},removeAttribute(){}})});
 await settle();assert.equal(element.querySelector('[data-lecture-toggle]').hidden,true);player.dispose();dom.window.close();
});
