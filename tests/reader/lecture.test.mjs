import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createLectureTrack, sentenceIndexAt, toneFor, pageForTime, boxesOnPage, lineBoxesOnPage, sentenceAtPoint,
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

test('continuous sentence strips join RTL words per line without merging pages or changing source geometry',()=>{
 const sentence={boxes:[
  [42,60,10,100,30],[42,12,11,40,29],[42,42,10,58,30],
  [42,70,36,100,56],[42,35,37,65,55],[43,1,10,8,30],
 ]};
 const original=JSON.stringify(sentence);
 assert.deepEqual(lineBoxesOnPage(sentence,42),[
  {page:42,x0:12,y0:10,x1:100,y1:30},
  {page:42,x0:35,y0:36,x1:100,y1:56},
 ]);
 assert.deepEqual(lineBoxesOnPage(sentence,43),[{page:43,x0:1,y0:10,x1:8,y1:30}]);
 assert.equal(JSON.stringify(sentence),original);
});

function fixture({page=42,sessionData=SESSION}={}){
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
  if(url.endsWith('/lectures/1'))return {ok:true,json:async()=>sessionData};
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

test('the player uses phrase boxes and moves at a measured silent checkpoint before speech resumes',async()=>{
 const sessionData={...SESSION,cues:[
  {id:0,sentence_id:1,text:'عبارت اول',start:2,end:4.7,speech_start:2,speech_end:4.5,page:42,
   page_timing:'checkpoint',boxes:[[42,10,30,45,40]]},
  {id:1,sentence_id:1,text:'عبارت دوم',start:4.7,end:9,speech_start:4.9,speech_end:9,page:43,
   page_timing:'checkpoint',boxes:[[43,10,10,45,20]]},
 ]};
 const f=fixture({sessionData});await f.player.ready;await f.player.open();
 f.audio.at(4.49);await settle();
 assert.equal(f.highlights.at(-1).text,'عبارت اول');
 assert.equal(f.highlights.at(-1).boxes[0].x1,45);
 f.audio.at(4.5);await settle();assert.equal(f.highlights.at(-1).tone,'held');
 f.audio.at(4.7);await settle();
 assert.equal(f.highlights.at(-1).text,'عبارت دوم');
 assert.equal(f.highlights.at(-1).tone,'held');assert.deepEqual(f.shown,[43]);
 f.audio.at(4.9);await settle();assert.equal(f.highlights.at(-1).tone,'exact');
 f.audio.at(3);await settle();assert.equal(f.highlights.at(-1).text,'عبارت اول');
 f.close();
});

test('verified playback holds a complete phrase until the pause and clears unsupported speech',async()=>{
 const sessionData={...SESSION,word_alignment:{method:'local_ctc'},cues:[
  {id:0,text:'سلام کتاب',start:2,end:4,speech_start:2,speech_end:3.8,page:42,
   boxes:[[42,25,30,45,40],[42,10,30,24,40]],words:[
    {text:'سلام',start:2,end:3,boxes:[[42,25,30,45,40]]},
    {text:'کتاب',start:3.1,end:3.8,boxes:[[42,10,30,24,40]]},
   ]},
  {id:1,text:'بعدی',start:20,end:21,page:43,boxes:[[43,10,30,45,40]],
   words:[{text:'بعدی',start:20,end:21,boxes:[[43,10,30,45,40]]}]},
 ]};
 const f=fixture({sessionData});await f.player.ready;await f.player.open();
 f.audio.at(2.5);await settle();assert.equal(f.highlights.at(-1).text,'سلام کتاب');
 assert.deepEqual(f.highlights.at(-1).boxes,[{page:42,x0:10,y0:30,x1:45,y1:40}]);
 const count=f.highlights.length;
 f.audio.at(3.05);await settle();assert.equal(f.highlights.length,count);
 f.audio.at(3.5);await settle();assert.equal(f.highlights.length,count);
 f.audio.at(3.9);await settle();assert.equal(f.highlights.at(-1).tone,'held');
 f.audio.at(10);await settle();assert.equal(f.element.querySelector('[data-lecture-caption]').textContent,'');
 f.audio.at(20.2);await settle();assert.equal(f.highlights.at(-1).text,'بعدی');
 f.audio.at(2.5);await settle();assert.equal(f.highlights.at(-1).text,'سلام کتاب');
 f.close();
});

test('sentence focus spans acoustic phrases and page turns without borrowing coarse sentence timing',async()=>{
 const whole={id:7,text:'ایمان داشتن به رسالت خود.',boxes:[[42,10,30,45,40],[43,10,30,45,40]],page:42,page_end:43};
 const sessionData={...SESSION,word_alignment:{method:'local_ctc'},sentence_focus:[whole],cues:[
  {id:0,sentence_id:7,text:'ایمان',start:2,end:4,speech_start:2,speech_end:3.8,page:42,
   boxes:[whole.boxes[0]],page_timing:'word_alignment',words:[{text:'ایمان',start:2,end:3.8,boxes:[whole.boxes[0]]}]},
  {id:1,sentence_id:7,text:'رسالت خود.',start:4,end:8,speech_start:4.2,speech_end:8,page:43,
   boxes:[whole.boxes[1]],page_timing:'word_alignment',words:[{text:'رسالت',start:4.2,end:8,boxes:[whole.boxes[1]]}]},
  {id:2,sentence_id:8,text:'جملهٔ بعدی.',start:12,end:13,page:43,boxes:[whole.boxes[1]]},
 ]};
 const f=fixture({sessionData});await f.player.ready;await f.player.open();
 f.audio.at(2.5);await settle();assert.equal(f.highlights.at(-1).text,whole.text);
 assert.equal(f.highlights.at(-1).page,42);
 f.audio.at(3.9);await settle();assert.equal(f.highlights.at(-1).tone,'exact');
 f.audio.at(4.3);await settle();assert.equal(f.highlights.at(-1).text,whole.text);
 assert.equal(f.highlights.at(-1).page,43);assert.deepEqual(f.shown,[43]);
 f.audio.at(9);await settle();assert.equal(f.highlights.at(-1),null);
 f.audio.at(12.2);await settle();assert.equal(f.highlights.at(-1).text,'جملهٔ بعدی.');
 f.audio.at(2.5);await settle();assert.equal(f.highlights.at(-1).text,whole.text);
 f.close();
});

test('sentence highlight never fades or clears at internal pauses and unsupported word gaps',async()=>{
 const whole={id:7,text:'ایمان داشتن به رسالت خود.',boxes:[[42,10,30,100,40]],page:42};
 const next={id:8,text:'جملهٔ بعدی.',boxes:[[42,10,50,100,60]],page:42};
 const cue=(id,sentence_id,start,end,speech_start=start,speech_end=end)=>({id,sentence_id,start,end,speech_start,speech_end,
  page:42,page_timing:'word_alignment',text:'جزء جمله',boxes:[whole.boxes[0]],
  words:[{text:'جزء',start:speech_start,end:speech_end,boxes:[whole.boxes[0]]}]});
 const sessionData={...SESSION,word_alignment:{method:'local_ctc'},sentence_focus:[whole,next],cues:[
  cue(0,7,1.8,4,2,3.8),cue(1,7,4,5.2,4.2,5.2),cue(2,7,10,12),cue(3,8,17.8,20,18,20),
 ]};
 const f=fixture({sessionData});await f.player.ready;await f.player.open();
 f.audio.at(2.1);await settle();const first=f.highlights.at(-1),count=f.highlights.length;
 assert.equal(first.text,whole.text);assert.equal(first.tone,'exact');
 for(const time of [3.9,4.1,4.4,5.3,8,10.1,11.99]) {
  f.audio.at(time);await settle();
  assert.deepEqual(f.highlights.at(-1),first,`sentence focus changed at ${time}`);
  assert.equal(f.highlights.length,count,`sentence focus repainted at ${time}`);
  assert.equal(f.element.querySelector('[data-lecture-caption]').textContent,whole.text);
 }
 f.audio.at(12);await settle();assert.equal(f.highlights.at(-1),null);
 f.audio.at(17.9);await settle();assert.equal(f.highlights.at(-1),null);
 f.audio.at(18);await settle();assert.equal(f.highlights.at(-1).text,next.text);
 f.audio.at(8);await settle();assert.deepEqual(f.highlights.at(-1),first);
 f.close();
});

test('sentence highlighting starts when speech resumes after the measured pause, before a delayed CTC anchor',async()=>{
 const whole={id:7,text:'به رسالت خود ایمان دارد.',boxes:[[42,10,30,100,40]],page:42};
 const sessionData={...SESSION,word_alignment:{method:'local_ctc'},sentence_focus:[whole],cues:[
  {id:0,sentence_id:7,text:'به',start:4.5,end:8,speech_start:5,speech_end:8,page:42,page_timing:'word_alignment',
   timing:{start_pause:[4.3,4.7]},boxes:whole.boxes,words:[{text:'به',start:5,end:8,boxes:whole.boxes}]},
 ]};
 const f=fixture({sessionData});await f.player.ready;await f.player.open();
 f.audio.at(4.71);await settle();assert.equal(f.highlights.at(-1)?.text,whole.text);
 assert.equal(f.highlights.at(-1)?.tone,'exact');
 const count=f.highlights.length;
 f.audio.at(5.1);await settle();assert.equal(f.highlights.length,count);
 f.close();
});

test('without a lecture index the control stays hidden',async()=>{
 const dom=new JSDOM('<main><button data-lecture-toggle hidden></button><section data-lecture-bar hidden><select data-lecture-session></select><button data-lecture-play></button><input data-lecture-seek><span data-lecture-time></span><span data-lecture-duration></span><p data-lecture-caption></p></section></main>');
 const element=dom.window.document.querySelector('main');
 const player=installLecturePlayer({element,reader:{highlight(){}},book:'x',getPage:()=>1,showPage:async()=>{},
  fetchImpl:async()=>({ok:false,json:async()=>({})}),createAudio:()=>Object.assign(new dom.window.EventTarget(),{paused:true,pause(){},removeAttribute(){}})});
 await settle();assert.equal(element.querySelector('[data-lecture-toggle]').hidden,true);player.dispose();dom.window.close();
});
