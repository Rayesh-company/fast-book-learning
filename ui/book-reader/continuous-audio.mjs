/** One paragraph ahead, using the existing trusted narration endpoint. */
export function installContinuousAudio({element, reader, getContext, getPageData, showPage, fetchImpl = fetch}) {
  const win = element.ownerDocument.defaultView;
  const life = new win.AbortController();
  const button = element.querySelector('[data-audio-play]');
  const previous = element.querySelector('[data-audio-previous]');
  const next = element.querySelector('[data-audio-next]');
  const status = element.querySelector('[data-reader-audio-status]');
  let revision = 0, controller, player, cursor, prefetched, active = false, loading = false;
  function update() {
    button.dataset.state = loading ? 'waiting' : active ? 'playing' : 'paused';
    button.setAttribute('aria-label', loading ? 'مکث آماده‌سازی صوت' : active ? 'مکث شنیدن کتاب' : 'پخش کتاب');
    previous.disabled = cursor ? cursor.page === 1 && cursor.paragraph === 0 : getContext().page === 1;
    next.disabled = !!cursor && cursor.page === getContext().numPages && cursor.lastParagraph;
  }
  async function location(page, paragraph = 0) {
    const context = getContext();
    if (page < 1 || page > context.numPages) return null;
    const data = await getPageData(page);
    if (!data.paragraphs.length) throw new Error('متن قابل خواندن این صفحه در دسترس نیست.');
    if (paragraph < 0) return {...data.paragraphs.at(-1), paragraph: data.paragraphs.length-1, lastParagraph:true,pageText:data.index.text};
    if (paragraph >= data.paragraphs.length) return location(page+1);
    return {...data.paragraphs[paragraph], paragraph,lastParagraph:paragraph===data.paragraphs.length-1,pageText:data.index.text};
  }
  async function prepare(position, signal) {
    const {doc} = getContext();
    const {page,start,end,text,pageText} = position;
    const response = await fetchImpl(`/books/${encodeURIComponent(doc)}/narration`, {method:'POST',headers:{'Content-Type':'application/json'},signal,body:JSON.stringify({page,start,end,text,pageText})});
    const body = await response.json();
    if (!response.ok) throw new Error(body.detail || body.message || 'ساخت صدا ناموفق بود.');
    return {position,body};
  }
  function failed(error, rev) {
    if (rev !== revision || life.signal.aborted) return;
    controller?.abort(); player?.dispose();player=null;active = loading = false; prefetched = null;
    status.textContent = error.message || 'پخش صدا ناموفق بود.'; update();
  }
  async function playAt(position, prepared, rev) {
    if (!position) { player?.dispose();player=null;active = loading = false; status.textContent = 'پخش پایان یافت.'; update(); return; }
    cursor = position; loading = true; status.textContent = 'در حال آماده‌کردن صدا…'; update();
    const result = await (prepared || prepare(position, controller.signal));
    if (rev !== revision || controller.signal.aborted) return;
    await showPage(position.page);
    if (rev !== revision || controller.signal.aborted) return;
    player?.dispose();
    const body = result.body;
    const bytes = Uint8Array.from(atob(body.audioBase64), char => char.charCodeAt(0));
    player = reader.loadAudio({bytes,mimeType:body.mimeType,cues:body.cues,onState(state) {
      if (rev !== revision) return;
      if (state === 'playing') { loading = false; update(); }
      if (state === 'ended' && active) advance().catch(error=>failed(error,rev));
      if (state === 'error') failed(new Error('پخش صدا ناموفق بود.'),rev);
    }});
    loading = false;
    status.textContent = body.alignment?.status === 'available' ? '' : 'زمان‌بندی دقیق هایلایت در دسترس نیست.';
    update();
    if (active) await player.play();
    // Rejections are captured immediately; they are surfaced only when needed.
    const signal=controller.signal;
    prefetched = location(cursor.page,cursor.paragraph+1).then(position=>position&&!signal.aborted&&rev===revision ? prepare(position,signal) : null).then(result=>({result}),error=>({error}));
  }
  async function advance() {
    const rev = revision, prepared = prefetched; prefetched = null;
    const position = await location(cursor.page,cursor.paragraph+1);
    const cached = prepared ? await prepared : null;
    if (rev !== revision || !active) return;
    if (cached?.error) throw cached.error;
    await playAt(position,cached?.result ? Promise.resolve(cached.result) : null,rev);
  }
  function reset() { revision++;controller?.abort();player?.dispose();player=null;cursor=null;prefetched=null;active=loading=false;status.textContent='';update(); }
  function pause() { active=false;player?.pause();update(); }
  button.addEventListener('click',async()=>{
    if (active || loading) { if (loading) reset(); else pause(); return; }
    active=true;status.textContent='';update();
    let rev=revision;
    try {
      if (player) { if(player.state==='ended')await advance();else await player.play();return; }
      controller = new AbortController();rev=++revision;
      const position=cursor||await location(getContext().page);
      if (rev===revision) await playAt(position,null,rev);
    } catch(error) { failed(error,rev); }
  },{signal:life.signal});
  async function jump(direction) {
    let rev=revision;
    try {
      const base=cursor || await location(getContext().page);
      if(rev!==revision||life.signal.aborted||!base)return;
      const page=direction<0 && base.paragraph===0 ? base.page-1 : base.page;
      const paragraph=direction<0 && base.paragraph===0 ? -1 : base.paragraph+direction;
      if (page<1) return;
      const resume=active;reset();controller=new AbortController();rev=revision;active=resume;
      const position=await location(page,paragraph); if (rev===revision&&!life.signal.aborted) await playAt(position,null,rev);
    }
    catch(error) { failed(error,rev); }
  }
  previous.addEventListener('click',()=>jump(-1),{signal:life.signal});
  next.addEventListener('click',()=>jump(1),{signal:life.signal});
  update();
  return {reset,pause,suspend:pause,dispose(){reset();life.abort();},get cursor(){return cursor;}};
}
