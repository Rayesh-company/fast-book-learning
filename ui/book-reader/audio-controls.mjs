/** Host-facing controls; generation is a separate authenticated server boundary. */
import { createMediaSessionBridge } from './media-session-bridge.mjs';

const digits = n => String(n).replace(/\d/g, c => '۰۱۲۳۴۵۶۷۸۹'[c]);

export function installNarrationControls({ element, reader, getContext, fetchImpl = fetch }) {
  const read = element.querySelector('[data-reader-read]');
  const toggle = element.querySelector('[data-reader-toggle]');
  const stop = element.querySelector('[data-reader-stop]');
  const speed = element.querySelector('[data-reader-speed]');
  const seek = element.querySelector('[data-reader-seek]');
  const status = element.querySelector('[data-reader-audio-status]');
  const abortListeners = new element.ownerDocument.defaultView.AbortController();
  const options = { signal: abortListeners.signal };
  let request = null;
  let player = null;
  let revision = 0;
  let duration = 0;
  const media = createMediaSessionBridge({ win: element.ownerDocument.defaultView });
  let userPaused = false;

  function reset() {
    revision++;
    request?.abort(); request = null;
    player?.dispose(); player = null;
    userPaused = false;
    read.disabled = false; toggle.disabled = true; stop.disabled = true; seek.disabled = true;
    toggle.textContent = 'پخش'; seek.value = '0'; status.textContent = '';
    media.clear();
  }
  function pause() { player?.pause(); }
  function suspend() {
    revision++;
    request?.abort(); request = null;
    pause();
    read.disabled = false;
    if (!player) { stop.disabled = true; status.textContent = ''; }
  }
  function refreshReadLabel() {
    read.textContent = reader.captureSelection()?.pages.length ? 'شنیدن انتخاب' : 'شنیدن صفحه';
  }
  const stateChanged = state => {
    toggle.textContent = state === 'playing' || state === 'waiting' ? 'مکث' : 'پخش';
    if (state === 'error') status.textContent = 'پخش صدا ناموفق بود.';
  };

  read.addEventListener('mousedown', event => event.preventDefault(), options);
  read.addEventListener('click', async () => {
    const selected = reader.captureSelection();
    reset();
    const current = revision;
    request = new AbortController();
    const signal = request.signal;
    read.disabled = true; stop.disabled = false;
    status.textContent = 'در حال آماده‌کردن صدا…';
    try {
      const context = await getContext();
      if (current !== revision) return;
      if (!context) throw new Error('صفحهٔ کتاب آماده نیست؛ دوباره تلاش کنید.');
      const pageIndex = reader.getPageIndex(context.page);
      const passages = selected?.pages ?? [{ page: context.page, start: 0,
        end: pageIndex?.text.length ?? 0, text: pageIndex?.text ?? '' }];
      let position = 0;
      const next = async () => {
        if (current !== revision || signal.aborted) return;
        const passage = passages[position++];
        if (!passage) { status.textContent = 'پخش پایان یافت.'; read.disabled = false; media.state('paused'); return; }
        player?.dispose(); player = null;
        userPaused = false;
        toggle.disabled = true; seek.disabled = true; read.disabled = true;
        status.textContent = 'در حال آماده‌کردن صدا…';
        media.state('paused'); // the gap between paragraphs shows as not-playing on the lock screen
        const pageText = reader.getPageIndex(passage.page)?.text;
        if (!pageText || !passage.text.trim()) throw new Error('متن قابل خواندن این صفحه در دسترس نیست.');
        const response = await fetchImpl(`/books/${encodeURIComponent(context.doc)}/narration`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
          body: JSON.stringify({ ...passage, pageText }),
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.detail || body.message || 'ساخت صدا ناموفق بود.');
        if (current !== revision || signal.aborted) return;
        const bytes = Uint8Array.from(atob(body.audioBase64), char => char.charCodeAt(0));
        duration = body.durationMs / 1000;
        seek.max = String(duration); seek.disabled = false;
        player = reader.loadAudio({ bytes, mimeType: body.mimeType, cues: body.cues,
          rate: Number(speed.value),
          onFocus() { if (player) seek.value = String(player.currentTime); },
          onState(state) {
            stateChanged(state);
            media.state(state === 'playing' || state === 'waiting' ? 'playing' : 'paused');
            if (state === 'ended') next().catch(failed);
          },
        });
        media.announce({ title: `شنیدن صفحهٔ ${digits(passage.page)} — پاراگراف ${digits(position)}`,
          artist: context.title ?? context.doc, album: 'کتاب‌خوان' });
        media.position({ position: 0, duration, rate: Number(speed.value) });
        toggle.disabled = false;
        status.textContent = body.alignment?.status === 'available'
          ? '' : 'صدا آماده است؛ زمان‌بندی دقیق برای هایلایت در دسترس نیست.';
        await player.play();
        read.disabled = false;
      };
      await next();
    } catch (error) { failed(error); }
    function failed(error) {
      if (current !== revision || signal.aborted) return;
      read.disabled = false;
      status.textContent = error.message || 'ساخت صدا ناموفق بود.';
    }
  }, options);
  toggle.addEventListener('click', () => {
    if (!player) return;
    if (player.state === 'playing' || player.state === 'waiting') { userPaused = true; pause(); media.state('paused'); }
    else { userPaused = false; player.play().catch(error => { status.textContent = error.message || 'پخش صدا ناموفق بود.'; }); }
  }, options);
  stop.addEventListener('click', reset, options);
  speed.addEventListener('change', () => player?.setRate(Number(speed.value)), options);
  seek.addEventListener('change', () => {
    if (!player) return;
    player.seek(Math.max(0, Math.min(duration, Number(seek.value)))).catch(() => {
      status.textContent = 'رفتن به این بخش از صدا ناموفق بود.';
    });
  }, options);
  media.handlers({
    play() {
      if (!player || player.state === 'playing' || player.state === 'waiting') return;
      userPaused = false;
      player.play().catch(() => {});
    },
    pause() {
      if (!player || userPaused) return;
      userPaused = true;
      pause();
    },
    seekbackward() { if (player) player.seek(Math.max(0, player.currentTime - 10)).catch(() => {}); },
    seekforward() { if (player) player.seek(Math.min(duration, player.currentTime + 10)).catch(() => {}); },
  });
  // A locked screen can have the platform pause the element mid-narration; coming back,
  // the voice resumes from where it stopped unless the user themselves paused it.
  element.ownerDocument.addEventListener('visibilitychange', () => {
    if (element.ownerDocument.visibilityState !== 'visible') return;
    if (!player || userPaused) return;
    if (player.state !== 'paused' && player.state !== 'ready') return;
    player.play().catch(() => {});
  }, options);
  element.ownerDocument.addEventListener('selectionchange', refreshReadLabel, options);
  reset(); refreshReadLabel();
  return { reset, pause, suspend, dispose() { reset(); abortListeners.abort(); } };
}
