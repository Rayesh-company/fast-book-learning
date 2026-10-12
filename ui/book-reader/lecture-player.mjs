/** Lecture read-along: the session's recorded audio plays and the
 * sentence being spoken is highlighted on the rendered PDF page, from
 * precomputed page boxes (/books/<id>/lectures/<n>). The page turns and
 * scrolls to follow the voice; a click on a sentence seeks to it.
 * The host owns page rendering (showPage) and the markup (views.mjs).
 */
import { createLectureTrack, sentenceIndexAt, toneFor, pageForTime, lineBoxesOnPage, focusForTime,
  sentenceAtPoint, sessionForPage, formatClock } from './lecture-sync.mjs';

const digits = n => String(n).replace(/\d/g, d => '۰۱۲۳۴۵۶۷۸۹'[d]);

export function installLecturePlayer({ element, reader, book, getPage, showPage,
  fetchImpl = fetch, onActivate = () => {}, createAudio }) {
  const doc = element.ownerDocument, win = doc.defaultView;
  const life = new win.AbortController(), signal = life.signal;
  const $ = selector => element.querySelector(selector);
  const toggle = $('[data-lecture-toggle]'), bar = $('[data-lecture-bar]');
  const select = $('[data-lecture-session]'), play = $('[data-lecture-play]');
  const seek = $('[data-lecture-seek]'), clock = $('[data-lecture-time]');
  const total = $('[data-lecture-duration]'), caption = $('[data-lecture-caption]');
  const status = $('[data-lecture-status]'), skipIntro = $('[data-lecture-skip-intro]');
  const viewport = $('.reader-page');
  const audio = createAudio ? createAudio() : doc.createElement('audio');
  audio.preload = 'metadata';
  let sessions = [], session = null, track = null, last = '', turning = null, loadToken = 0, owning = false;
  let listReady = null, ticker = null;

  const say = text => { if (status) status.textContent = text || ''; };
  function stopTicker() {
    if (ticker !== null) { clearInterval(ticker); ticker = null; }
  }
  function setPlayState() {
    const playing = !audio.paused && !audio.ended;
    play.dataset.state = playing ? 'playing' : 'paused';
    play.setAttribute('aria-label', playing ? 'مکث درس‌گفتار' : 'پخش درس‌گفتار');
    if (playing && ticker === null) {
      // Match the acoustic frame cadence. This timer only redraws focus;
      // media currentTime remains the clock for pauses, speed changes and seeks.
      ticker = setInterval(() => { sync(); }, 20);
      ticker?.unref?.();
    } else if (!playing) {
      stopTicker();
    }
  }

  async function loadList() {
    const response = await fetchImpl(`/books/${encodeURIComponent(book)}/lectures`, { signal });
    if (!response.ok) return [];
    const body = await response.json();
    sessions = body.sessions ?? [];
    select.innerHTML = sessions.map(s => `<option value="${s.session}">جلسهٔ ${digits(s.session)}${s.audio_available ? '' : ' (بدون صوت)'}</option>`).join('');
    if (sessions.length) toggle.hidden = false;
    return sessions;
  }

  async function loadSession(number) {
    const token = ++loadToken;
    audio.pause();
    clearFocus();
    say('در حال بارگذاری جلسه…');
    const response = await fetchImpl(`/books/${encodeURIComponent(book)}/lectures/${number}`, { signal });
    const body = await response.json();
    if (token !== loadToken) return;
    if (!response.ok) { say(body.detail || 'بارگذاری جلسه ناموفق بود.'); return; }
    session = body; track = createLectureTrack(body); last = '';
    select.value = String(number);
    seek.max = String(Math.ceil(body.duration || 0)); seek.value = '0';
    total.textContent = formatClock(body.duration);
    clock.textContent = formatClock(0);
    caption.textContent = '';
    if (body.audio_url) { audio.src = body.audio_url; play.disabled = false; say(''); }
    else { audio.removeAttribute('src'); play.disabled = true; say('صوت این جلسه روی سرور نیست.'); }
    setPlayState();
  }

  function clearFocus() {
    if (owning) reader.highlight(null);
    owning = false; last = '';
  }

  function reveal() {
    const span = element.querySelector('.book-reader-playback-focus > span');
    if (!span || !viewport) return;
    const view = viewport.getBoundingClientRect(), box = span.getBoundingClientRect();
    if (box.top >= view.top + 8 && box.bottom <= view.bottom - 96) return;
    const reduced = win.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const top = viewport.scrollTop + box.top - view.top - view.height * 0.3;
    if (viewport.scrollTo) viewport.scrollTo({ top: Math.max(0, top), behavior: reduced ? 'auto' : 'smooth' });
    else viewport.scrollTop = Math.max(0, top);
  }

  async function sync() {
    if (!track) return;
    const time = audio.currentTime || 0;
    if (doc.activeElement !== seek) seek.value = String(Math.floor(time));
    clock.textContent = formatClock(time);
    const { index, active } = sentenceIndexAt(track, time);
    if (index < 0) { if (last) { clearFocus(); caption.textContent = ''; } return; }
    const focus = focusForTime(track.sentences[index], time, active);
    const sentence = focus.sentence;
    const page = pageForTime(sentence, time);
    const key = `${sentence.sentence_focus ? sentence.sentence_id : index}|${page}|${focus.active}`;
    if (key === last) return;
    last = key;
    caption.textContent = sentence.text;
    caption.dataset.tone = toneFor(sentence, focus.active);
    const boxes = lineBoxesOnPage(sentence, page);
    if (!boxes.length) { clearFocus(); last = key; caption.dataset.unplaced = 'true'; return; }
    delete caption.dataset.unplaced;
    owning = true;
    reader.highlight({ page, boxes, tone: toneFor(sentence, focus.active), text: sentence.text, lecture: sentence.id });
    if (page !== getPage()) {
      const turn = turning = showPage(page);
      try { await turn; } catch { return; }
      if (turn !== turning) return;
      turning = null;
    }
    reveal();
  }

  async function start() {
    if (!session?.audio_url) return;
    if (skipIntro?.checked && audio.currentTime < (session.lecture_start || 0)) audio.currentTime = session.lecture_start;
    onActivate();
    try { await audio.play(); } catch (error) { say('پخش صوت ممکن نشد.'); }
  }

  async function open() {
    bar.hidden = false; toggle.setAttribute('aria-expanded', 'true');
    if (!session) {
      await (listReady ??= loadList());
      const chosen = sessionForPage(sessions, getPage()) ?? sessions[0];
      if (chosen) await loadSession(chosen.session);
    }
  }

  toggle.addEventListener('click', () => {
    if (bar.hidden) open().catch(() => say('بارگذاری درس‌گفتار ناموفق بود.'));
    else { bar.hidden = true; toggle.setAttribute('aria-expanded', 'false'); }
  }, { signal });
  select.addEventListener('change', () => loadSession(Number(select.value)).catch(() => say('بارگذاری جلسه ناموفق بود.')), { signal });
  play.addEventListener('click', () => { if (audio.paused) start(); else audio.pause(); }, { signal });
  $('[data-lecture-back]')?.addEventListener('click', () => { audio.currentTime = Math.max(0, audio.currentTime - 10); }, { signal });
  $('[data-lecture-forward]')?.addEventListener('click', () => { audio.currentTime = Math.min(session?.duration ?? Infinity, audio.currentTime + 10); }, { signal });
  seek.addEventListener('input', () => { clock.textContent = formatClock(Number(seek.value)); }, { signal });
  seek.addEventListener('change', () => { audio.currentTime = Number(seek.value); }, { signal });
  for (const type of ['timeupdate', 'seeked']) audio.addEventListener(type, () => { sync(); }, { signal });
  for (const type of ['play', 'pause', 'ended']) audio.addEventListener(type, setPlayState, { signal });
  audio.addEventListener('error', () => { if (audio.getAttribute('src')) say('پخش صوت ناموفق بود.'); setPlayState(); }, { signal });

  // A plain click on a highlighted-able sentence seeks the voice there.
  $('.pdf-surface')?.addEventListener('click', event => {
    if (!track || bar.hidden || !session?.audio_url) return;
    if (!doc.getSelection()?.isCollapsed) return;
    const point = reader.pointAt(getPage(), event.clientX, event.clientY);
    const sentence = point && sentenceAtPoint(track, getPage(), point.x, point.y);
    if (!sentence) return;
    audio.currentTime = sentence.start;
    last = '';
    if (audio.paused) start(); else sync();
  }, { signal });

  listReady = loadList().catch(() => []);
  setPlayState();
  return {
    open, loadSession, sync,
    pause() { audio.pause(); },
    get track() { return track; },
    get audio() { return audio; },
    get ready() { return listReady; },
    dispose() { stopTicker(); audio.pause(); clearFocus(); life.abort(); audio.removeAttribute('src'); },
  };
}
