/** Recorded lecture transport. The host owns PDF rendering and compact/expanded markup. */
import {createLectureTrack,sentenceIndexAt,toneFor,pageForTime,lineBoxesOnPage,focusForTime,
  sentenceAtPoint,sessionForPage,formatClock} from './lecture-sync.mjs';
import {lectureParagraphAnchors} from './lecture-paragraphs.mjs';

const digits=n=>String(n).replace(/\d/g,d=>'۰۱۲۳۴۵۶۷۸۹'[d]);
export function installLecturePlayer({element,reader,book,getPage,showPage,getPageData,
  fetchImpl=fetch,onActivate=()=>{},onExpanded=()=>{},createAudio}) {
  const doc=element.ownerDocument,win=doc.defaultView,life=new win.AbortController(),signal=life.signal;
  const $=selector=>element.querySelector(selector);
  const unified=!!$('[data-audio-play]');
  const toggle=$('[data-player-expand]')??$('[data-lecture-toggle]'),bar=$('[data-lecture-bar]');
  const select=$('[data-lecture-session]'),play=$('[data-audio-play]')??$('[data-lecture-play]');
  const seek=$('[data-lecture-seek]'),clock=$('[data-lecture-time]'),total=$('[data-lecture-duration]');
  const caption=$('[data-lecture-caption]'),status=$('[data-lecture-status]'),skipIntro=$('[data-lecture-skip-intro]');
  const previous=$('[data-audio-previous]'),next=$('[data-audio-next]'),rate=$('[data-lecture-rate]');
  const miniProgress=$('[data-lecture-mini-progress]'),miniSession=$('[data-mini-session]');
  const viewport=$('.reader-page'),audio=createAudio?createAudio():doc.createElement('audio');
  audio.preload='metadata';audio.playbackRate=1;
  let sessions=[],session=null,track=null,last='',owning=false,loadToken=0,epoch=0,ticker=null,sessionRequest=null;
  let initialPosition=true,expanded=false,listReady,anchorsByPage=new Map(),syncRevision=0,intent=0;
  const say=text=>{if(status)status.textContent=text||'';};
  const valid=(token,revision)=>!signal.aborted&&token===loadToken&&revision===epoch;
  function stopTicker(){if(ticker!==null){clearInterval(ticker);ticker=null;}}
  function setPlayState(){
    const playing=!audio.paused&&!audio.ended;
    play.dataset.state=playing?'playing':'paused';play.setAttribute('aria-label',playing?'مکث درس‌گفتار':'پخش درس‌گفتار');
    element.querySelector('[data-lecture-player]')?.setAttribute('data-playing',String(playing));
    if(playing&&ticker===null){ticker=setInterval(()=>{sync();},50);ticker?.unref?.();}
    else if(!playing)stopTicker();
  }
  function clearFocus(){if(owning)reader.highlight(null);owning=false;last='';}
  function setAvailable(available){play.disabled=!available;if(previous)previous.disabled=!available;if(next)next.disabled=!available;seek.disabled=!available;}
  async function loadList(){
    const response=await fetchImpl(`/books/${encodeURIComponent(book)}/lectures`,{signal});
    if(signal.aborted)return [];
    if(!response.ok){if(response.status!==404)throw new Error('دریافت جلسات ناموفق بود.');say('برای این کتاب صوت جلسه موجود نیست.');return [];}
    const body=await response.json();if(signal.aborted)return [];
    sessions=body.sessions??[];
    select.replaceChildren(...sessions.map(s=>{const option=doc.createElement('option');option.value=String(s.session);const pages=s.book_pages?` (ص ${digits(s.book_pages[0])} تا ${digits(s.book_pages[1])})`:'';option.textContent=`جلسهٔ ${digits(s.session)}${pages}${s.audio_available?'':' (بدون صوت)'}`;return option;}));
    select.disabled=!sessions.length;
    if(toggle&&!unified)toggle.hidden=!sessions.length;
    if(!sessions.length)say('برای این کتاب صوت جلسه موجود نیست.');
    return sessions;
  }
  async function loadSession(number,{automatic=false}={}){
    if(signal.aborted)return;if(!automatic)++intent;
    const token=++loadToken;++epoch;++syncRevision;sessionRequest?.abort();sessionRequest=new win.AbortController();
    audio.pause();audio.removeAttribute('src');audio.currentTime=0;session=null;track=null;anchorsByPage=new Map();clearFocus();setAvailable(false);
    initialPosition=true;caption.textContent='';seek.value='0';clock.textContent=formatClock(0);total.textContent=formatClock(0);seek.setAttribute('aria-valuetext',formatClock(0));
    say('در حال بارگذاری جلسه…');
    try{
      const response=await fetchImpl(`/books/${encodeURIComponent(book)}/lectures/${number}`,{signal:sessionRequest.signal});
      const body=await response.json();if(signal.aborted||token!==loadToken)return;
      if(!response.ok)throw new Error(body.detail||'بارگذاری جلسه ناموفق بود.');
      session=body;track=createLectureTrack(body);select.value=String(number);
      if(miniSession)miniSession.textContent=`جلسهٔ ${digits(number)}`;
      if(miniProgress)miniProgress.style.setProperty('--player-progress','0');
      seek.max=String(Math.ceil(body.duration||0));total.textContent=formatClock(body.duration);
      if(body.audio_url){audio.src=body.audio_url;setAvailable(true);say('');}
      else say('صوت این جلسه روی سرور نیست.');
      setPlayState();
    }catch(error){if(!signal.aborted&&token===loadToken&&error.name!=='AbortError')say('بارگذاری جلسه ناموفق بود؛ دوباره جلسه را انتخاب کنید.');}
  }
  async function ensureForPage(){
    await listReady;if(signal.aborted)return;
    const chosen=sessionForPage(sessions,getPage());
    if(!chosen){if(unified){setAvailable(false);say('این صفحه صوت جلسه ندارد.');}return;}
    if(session?.session!==chosen.session)await loadSession(chosen.session,{automatic:true});
    else setAvailable(Boolean(session.audio_url));
  }
  async function anchors(page){
    if(!getPageData||!track)return [];
    if(!anchorsByPage.has(page)){
      const current=track;
      anchorsByPage.set(page,getPageData(page).then(data=>lectureParagraphAnchors(current,page,data)));
    }
    return anchorsByPage.get(page);
  }
  function reveal(){
    const span=element.querySelector('.book-reader-playback-focus > span');if(!span||!viewport)return;
    const view=viewport.getBoundingClientRect(),box=span.getBoundingClientRect();
    const playerHeight=$('[data-lecture-player]')?.getBoundingClientRect().height??88;
    if(box.top>=view.top+8&&box.bottom<=view.bottom-playerHeight-20)return;
    const reduced=win.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const top=Math.max(0,viewport.scrollTop+box.top-view.top-view.height*.3);
    if(viewport.scrollTo)viewport.scrollTo({top,behavior:reduced?'auto':'smooth'});else viewport.scrollTop=top;
  }
  async function sync(){
    if(!track||signal.aborted||unified&&initialPosition)return;
    const time=audio.currentTime||0;
    if(doc.activeElement!==seek)seek.value=String(Math.floor(time));clock.textContent=formatClock(time);seek.setAttribute('aria-valuetext',formatClock(time));
    if(session?.duration){const pct=Math.min(100,Math.max(0,(time/session.duration)*100));if(miniProgress)miniProgress.style.setProperty('--player-progress',String(pct/100));seek.style.setProperty('--seek-progress',`${pct}%`);}
    const {index,active}=sentenceIndexAt(track,time);
    if(index<0){if(last){clearFocus();caption.textContent='';}return;}
    const focus=focusForTime(track.sentences[index],time,active),sentence=focus.sentence,page=pageForTime(sentence,time);
    const key=`${sentence.sentence_focus?sentence.sentence_id:index}|${page}|${focus.active}`;
    if(key===last)return;last=key;
    caption.textContent=sentence.text;caption.dataset.tone=toneFor(sentence,focus.active);
    const boxes=lineBoxesOnPage(sentence,page);
    if(!boxes.length){clearFocus();last=key;caption.dataset.unplaced='true';return;}
    delete caption.dataset.unplaced;owning=true;
    reader.highlight({page,boxes,tone:toneFor(sentence,focus.active),text:sentence.text,lecture:sentence.id});
    const revision=++syncRevision,token=loadToken;
    if(page!==getPage()){
      try{await showPage(page);}catch{return;}
      if(signal.aborted||revision!==syncRevision||token!==loadToken)return;
    }
    reveal();
  }
  async function start(){
    const action=++intent;
    if(unified)await ensureForPage();
    if(!session?.audio_url||signal.aborted||action!==intent)return;
    const token=loadToken,revision=epoch;
    if(unified&&initialPosition){
      try{
        const points=await anchors(getPage());if(!valid(token,revision)||action!==intent)return;
        if(points.length)audio.currentTime=points[0].time;
        else {
          const cue=track.sentences.find(c=>pageForTime(c,c.speech_start??c.start)===getPage()&&lineBoxesOnPage(c,getPage()).length);
          if(cue)audio.currentTime=cue.speech_start??cue.start;
          else if(getPage()===sessions.find(s=>s.session===session.session)?.cover_page)audio.currentTime=session.lecture_start||0;
          else{say('برای این صفحه زمان‌بندی صوت موجود نیست؛ صفحه یا جلسهٔ دیگری انتخاب کنید.');return;}
        }
      }catch{say('زمان‌بندی این صفحه بارگذاری نشد؛ دوباره پخش را بزنید.');return;}
    }
    if(skipIntro?.checked&&audio.currentTime<(session.lecture_start||0))audio.currentTime=session.lecture_start;
    initialPosition=false;onActivate();
    try{await audio.play();if(!valid(token,revision)||action!==intent)audio.pause();else say('');}
    catch{if(valid(token,revision))say('پخش صوت ممکن نشد؛ دوباره پخش را بزنید.');}
  }
  function pause(){++intent;++epoch;++syncRevision;audio.pause();}
  async function seekTo(time){
    if(!session?.audio_url)return;
    ++intent;++epoch;initialPosition=false;last='';audio.currentTime=Math.max(0,Math.min(session.duration||0,time));await sync();
  }
  async function skipParagraph(direction){
    const action=++intent;
    await ensureForPage();if(!session?.audio_url||action!==intent)return;
    const token=loadToken,revision=epoch,page=getPage(),summary=sessions.find(s=>s.session===session.session);
    try{
      const points=await anchors(page);if(!valid(token,revision)||action!==intent)return;
      let at=-1;
      if(!initialPosition)for(let i=0;i<points.length;i++)if(points[i].time<=audio.currentTime+.05)at=i;
      if(initialPosition)at=0;
      let target=points[at+direction];
      if(!target){
        const first=summary?.cover_page??summary?.book_pages?.[0]??page,lastPage=summary?.book_pages?.[1]??page;
        for(let n=page+direction;n>=first&&n<=lastPage;n+=direction){
          const candidates=await anchors(n);if(!valid(token,revision)||action!==intent)return;
          if(candidates.length){target=direction>0?candidates[0]:candidates.at(-1);break;}
        }
      }
      if(!target){say(direction>0?'به آخرین پاراگراف زمان‌بندی‌شدهٔ جلسه رسیدید.':'به اولین پاراگراف زمان‌بندی‌شدهٔ جلسه رسیدید.');return;}
      const playing=!audio.paused;initialPosition=false;++syncRevision;
      if(target.page!==getPage())await showPage(target.page);
      if(!valid(token,revision)||action!==intent)return;
      audio.currentTime=target.time;last='';await sync();
      if(playing&&audio.paused&&valid(token,revision))await start();say('');
    }catch{if(valid(token,revision))say('زمان‌بندی پاراگراف بارگذاری نشد؛ دوباره تلاش کنید.');}
  }
  function setRate(value){if([.75,1,1.25,1.5,2].includes(value)){audio.playbackRate=value;if(rate)rate.value=String(value);}}
  async function open(){
    const player=element.querySelector('[data-lecture-player]');
    if(player)delete player.dataset.closing;
    const scrim=doc.querySelector('[data-player-scrim]');
    if(scrim)scrim.hidden=false;
    const moveFocus=doc.activeElement===toggle;
    expanded=true;bar.hidden=false;toggle?.setAttribute('aria-expanded','true');onExpanded(true);
    if(moveFocus)(select.disabled?$('[data-player-collapse]'):select)?.focus({preventScroll:true});
    if(!session){await listReady;const chosen=sessionForPage(sessions,getPage())??(!unified?sessions[0]:null);if(chosen)await loadSession(chosen.session,{automatic:true});}
  }
  function collapse(){
    if(!expanded)return;
    expanded=false;toggle?.setAttribute('aria-expanded','false');onExpanded(false);
    const scrim=doc.querySelector('[data-player-scrim]');
    if(scrim)scrim.hidden=true;
    const player=element.querySelector('[data-lecture-player]');
    if(!win.matchMedia?.('(prefers-reduced-motion: reduce)').matches&&player){
      player.dataset.closing='true';
      setTimeout(()=>{delete player.dataset.closing;bar.hidden=true;},190);
    }else{bar.hidden=true;}
  }
  const run=promise=>Promise.resolve(promise).catch(error=>{if(!signal.aborted&&error.name!=='AbortError')say('پخش صوت ممکن نشد؛ دوباره تلاش کنید.');});
  toggle?.addEventListener('click',()=>expanded?collapse():run(open()),{signal});
  $('[data-player-collapse]')?.addEventListener('click',()=>{collapse();toggle?.focus({preventScroll:true});},{signal});
  doc.querySelector('[data-player-scrim]')?.addEventListener('click',()=>collapse(),{signal});
  doc.addEventListener('pointerdown',event=>{
    if(!expanded)return;
    const player=element.querySelector('[data-lecture-player]');
    if(player&&!player.contains(event.target)&&!event.target.closest('[data-player-expand]'))collapse();
  },{signal});
  const sheetHandle=element.querySelector('[data-lecture-handle]')??element.querySelector('.lecture-sheet-handle');
  if(sheetHandle){
    let startY=0,currentY=0,dragging=false;
    const playerNode=element.querySelector('[data-lecture-player]');
    sheetHandle.addEventListener('pointerdown',event=>{
      if(event.button!==0)return;startY=event.clientY;currentY=startY;dragging=true;
      sheetHandle.setPointerCapture?.(event.pointerId);
    },{signal});
    sheetHandle.addEventListener('pointermove',event=>{
      if(!dragging||!playerNode)return;currentY=event.clientY;const diff=Math.max(0,currentY-startY);
      if(diff>0){playerNode.style.transform=`translateY(${diff}px)`;playerNode.style.transition='none';}
    },{signal});
    const stopDrag=()=>{
      if(!dragging||!playerNode)return;dragging=false;const diff=currentY-startY;
      playerNode.style.transform='';playerNode.style.transition='';
      if(diff>=36)collapse();
    };
    sheetHandle.addEventListener('pointerup',stopDrag,{signal});
    sheetHandle.addEventListener('pointercancel',stopDrag,{signal});
    sheetHandle.addEventListener('click',()=>collapse(),{signal});
  }
  doc.addEventListener('keydown',event=>{if(event.key==='Escape'&&expanded){event.preventDefault();collapse();toggle?.focus({preventScroll:true});}},{signal});
  select.addEventListener('change',()=>run((async()=>{
    const number=Number(select.value),pending=loadSession(number),action=intent;await pending;
    if(unified&&action===intent&&session?.session===number){
      const chosen=sessions.find(s=>s.session===number),page=chosen?.cover_page??chosen?.book_pages?.[0];
      if(page)await showPage(page);
    }
  })()),{signal});
  play.addEventListener('click',()=>{if(audio.paused)run(start());else pause();},{signal});
  previous?.addEventListener('click',()=>run(skipParagraph(-1)),{signal});next?.addEventListener('click',()=>run(skipParagraph(1)),{signal});
  $('[data-lecture-back]')?.addEventListener('click',()=>run(seekTo(audio.currentTime-10)),{signal});
  $('[data-lecture-forward]')?.addEventListener('click',()=>run(seekTo(audio.currentTime+10)),{signal});
  rate?.addEventListener('change',()=>setRate(Number(rate.value)),{signal});
  seek.addEventListener('input',()=>{clock.textContent=formatClock(Number(seek.value));seek.setAttribute('aria-valuetext',formatClock(Number(seek.value)));},{signal});
  seek.addEventListener('change',()=>run(seekTo(Number(seek.value))),{signal});
  for(const type of ['timeupdate','seeked'])audio.addEventListener(type,()=>{run(sync());},{signal});
  for(const type of ['play','pause','ended'])audio.addEventListener(type,setPlayState,{signal});
  audio.addEventListener('error',()=>{if(audio.getAttribute('src'))say('پخش صوت ناموفق بود؛ دوباره جلسه را انتخاب کنید.');setPlayState();},{signal});
  $('.pdf-surface')?.addEventListener('click',event=>{
    if(!track||(!unified&&bar.hidden)||unified&&initialPosition||!session?.audio_url||!doc.getSelection()?.isCollapsed)return;
    const point=reader.pointAt(getPage(),event.clientX,event.clientY),sentence=point&&sentenceAtPoint(track,getPage(),point.x,point.y);
    if(!sentence)return;initialPosition=false;audio.currentTime=sentence.start;last='';if(audio.paused)run(start());else run(sync());
  },{signal});
  if(unified)setAvailable(false);
  listReady=loadList().catch(()=>{if(!signal.aborted)say('دریافت جلسات ناموفق بود؛ کتاب‌خوان را دوباره باز کنید.');return [];});
  const ready=unified?listReady.then(()=>ensureForPage()):listReady;
  setPlayState();
  return {open,collapse,loadSession,sync,play:start,pause,seek:seekTo,skipParagraph,setRate,
    async pageChanged(){const chosen=sessionForPage(sessions,getPage());if(!chosen||session?.session!==chosen.session){pause();clearFocus();initialPosition=true;await ensureForPage();}else setAvailable(Boolean(session.audio_url));},
    get track(){return track;},get audio(){return audio;},get sessions(){return sessions;},get expanded(){return expanded;},get ready(){return ready;},
    dispose(){++intent;++loadToken;++epoch;stopTicker();audio.pause();clearFocus();life.abort();sessionRequest?.abort();audio.removeAttribute('src');}};
}
