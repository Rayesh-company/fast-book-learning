/**
 * Continuous lecture audio playback with synchronized PDF bounding-box
 * highlighting, automatic page-turning, session selection, speed control,
 * and "without intro" (skip intro to lecture_start) options.
 * Follows specifications in fast-book-audio-delivery/README.fa.md.
 */

function digits(num) {
  return String(num).replace(/\d/g, d => '۰۱۲۳۴۵۶۷۸۹'[d]);
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '۰۰:۰۰';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const pad = n => (n < 10 ? '۰' + digits(n) : digits(n));
  return `${pad(m)}:${pad(s)}`;
}

export function installLectureAudio({
  element,
  reader,
  getContext,
  showPage,
  fetchImpl = fetch,
  createAudioElement,
}) {
  const win = element.ownerDocument.defaultView;
  const doc = element.ownerDocument;
  const life = new win.AbortController();
  const options = { signal: life.signal };

  // Control elements in widget and sheets
  const widgetPlay = element.querySelector('[data-audio-play]');
  const widgetPrev = element.querySelector('[data-audio-previous]');
  const widgetNext = element.querySelector('[data-audio-next]');
  const sheetToggle = element.querySelector('[data-reader-toggle]');
  const sheetStop = element.querySelector('[data-reader-stop]');
  const sheetSpeed = element.querySelector('[data-reader-speed]');
  const sheetSkipIntro = element.querySelector('[data-lecture-skip-intro]');
  const sheetSession = element.querySelector('[data-lecture-session]');
  const sheetSeek = element.querySelector('[data-reader-seek]');
  const statusNodes = element.querySelectorAll('[data-reader-audio-status]');
  const currentTimeNode = element.querySelector('[data-lecture-current-time]');
  const durationNode = element.querySelector('[data-lecture-duration]');

  let sessions = [];
  const sessionCache = new Map();
  let currentSessionNum = 1;
  let currentSessionData = null;
  let audio = null;
  let active = false;
  let loading = false;
  let currentCue = null;
  let currentRate = 1.0;
  let skipIntro = sheetSkipIntro ? sheetSkipIntro.checked : true;
  let revision = 0;

  function setStatus(text) {
    statusNodes.forEach(node => {
      node.textContent = text || '';
    });
  }

  function updateUI() {
    const state = loading ? 'waiting' : active ? 'playing' : 'paused';
    if (widgetPlay) {
      widgetPlay.dataset.state = state;
      widgetPlay.setAttribute(
        'aria-label',
        loading ? 'مکث آماده‌سازی صوت' : active ? 'مکث شنیدن جلسه' : 'پخش جلسهٔ صوتی'
      );
    }
    if (sheetToggle) {
      sheetToggle.textContent = active ? 'مکث' : 'پخش';
      sheetToggle.disabled = loading;
    }
    if (sheetStop) {
      sheetStop.disabled = !active && !audio;
    }
    if (sheetSeek) {
      sheetSeek.disabled = !currentSessionData;
    }
  }

  function populateSessionSelect() {
    if (!sheetSession || !sessions.length) return;
    sheetSession.innerHTML = '';
    for (const s of sessions) {
      const opt = doc.createElement('option');
      opt.value = String(s.session);
      const pagesLabel = s.book_pages
        ? ` (صفحات ${digits(s.book_pages[0])} تا ${digits(s.book_pages[1])})`
        : '';
      opt.textContent = `جلسهٔ ${digits(s.session)}${pagesLabel}`;
      if (s.session === currentSessionNum) opt.selected = true;
      sheetSession.appendChild(opt);
    }
  }

  function findSessionForPage(page) {
    if (!sessions.length) return null;
    return sessions.find(s => s.book_pages && page >= s.book_pages[0] && page <= s.book_pages[1]) || sessions[0];
  }

  async function loadSessionDetails(sessionNum) {
    if (sessionCache.has(sessionNum)) return sessionCache.get(sessionNum);
    const { doc: bookId } = getContext();
    const res = await fetchImpl(`/books/${encodeURIComponent(bookId)}/lectures/${sessionNum}`, {
      signal: life.signal,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || 'دریافت اطلاعات جلسه ممکن نشد.');
    }
    const data = await res.json();
    if (Array.isArray(data.sentences)) {
      data.sentences.sort((a, b) => a.start - b.start);
    }
    if (Array.isArray(data.cues)) {
      data.cues.sort((a, b) => a.start - b.start);
    }
    sessionCache.set(sessionNum, data);
    return data;
  }

  function createAudio() {
    if (audio) return audio;
    audio = createAudioElement
      ? createAudioElement()
      : doc.createElement('audio');
    audio.preload = 'auto';
    audio.playbackRate = currentRate;
    if ('preservesPitch' in audio) audio.preservesPitch = true;

    audio.addEventListener('playing', () => {
      loading = false;
      active = true;
      updateUI();
    }, options);

    audio.addEventListener('pause', () => {
      active = false;
      updateUI();
    }, options);

    audio.addEventListener('waiting', () => {
      loading = true;
      updateUI();
    }, options);

    audio.addEventListener('ended', () => {
      active = false;
      currentCue = null;
      reader.highlight(null);
      setStatus('جلسه به پایان رسید.');
      updateUI();
    }, options);

    audio.addEventListener('error', () => {
      active = false;
      loading = false;
      setStatus('پخش صوت ناموفق بود.');
      updateUI();
    }, options);

    audio.addEventListener('timeupdate', onTimeUpdate, options);
    return audio;
  }

  function findActiveCue(data, t) {
    if (!data) return null;
    const sentences = data.sentences || [];
    const cues = data.cues || [];

    if (sentences.length > 0) {
      for (let i = 0; i < sentences.length; i++) {
        const s = sentences[i];
        const next = sentences[i + 1];
        // Bridge brief pauses between consecutive sentences (up to 1.8s) so highlighting does not flicker
        const effectiveEnd = (next && next.start > s.end && (next.start - s.end) <= 1.8)
          ? next.start
          : s.end;

        if (t >= s.start && t < effectiveEnd) {
          let activePage = s.page;
          if (s.page_end && s.page_end !== s.page && cues.length > 0) {
            const subCue = cues.find(c => c.sentence_id === s.id && t >= c.start && t < c.end);
            if (subCue?.page) {
              activePage = subCue.page;
            } else {
              const nextPgCue = cues.find(c => c.sentence_id === s.id && c.page === s.page_end);
              if (nextPgCue && t >= nextPgCue.start) {
                activePage = s.page_end;
              }
            }
          }
          return {
            id: s.id,
            page: activePage,
            page_end: s.page_end || s.page,
            start: s.start,
            end: effectiveEnd,
            boxes: s.boxes || [],
            text: s.text,
          };
        }
      }
      return null;
    }

    if (cues.length > 0) {
      return cues.find(c => t >= c.start && t < c.end) || null;
    }

    return null;
  }

  async function onTimeUpdate() {
    if (!audio || !currentSessionData) return;
    const t = audio.currentTime;
    const dur = currentSessionData.duration || audio.duration || 0;

    if (sheetSeek && !sheetSeek.matches(':active')) {
      sheetSeek.value = String(t);
    }
    if (currentTimeNode) currentTimeNode.textContent = formatTime(t);

    const cue = findActiveCue(currentSessionData, t);
    const cueKey = cue ? `${cue.id ?? ''}:${cue.page ?? ''}` : null;
    const prevKey = currentCue ? `${currentCue.id ?? ''}:${currentCue.page ?? ''}` : null;

    if (cueKey !== prevKey) {
      currentCue = cue;
      if (cue) {
        reader.highlight(cue);
        if (cue.page && cue.page !== getContext().page) {
          await showPage(cue.page);
          reader.highlight(cue);
        }
      } else {
        reader.highlight(null);
      }
    }
  }

  async function prepareSession(sessionNum, autoPlay = false) {
    const rev = ++revision;
    currentSessionNum = sessionNum;
    if (sheetSession) sheetSession.value = String(sessionNum);

    loading = true;
    updateUI();
    setStatus(`در حال آماده‌سازی جلسهٔ ${digits(sessionNum)}…`);

    try {
      const data = await loadSessionDetails(sessionNum);
      if (rev !== revision || life.signal.aborted) return;
      currentSessionData = data;

      const media = createAudio();
      if (media.src !== data.audio_url && !media.src.endsWith(data.audio_url)) {
        media.src = data.audio_url;
      }
      media.playbackRate = currentRate;

      if (sheetSeek) {
        sheetSeek.max = String(data.duration || 0);
        sheetSeek.value = '0';
      }
      if (durationNode) durationNode.textContent = formatTime(data.duration || 0);
      if (currentTimeNode) currentTimeNode.textContent = formatTime(0);

      // Apply "skip intro" if enabled and audio is starting from scratch
      const startPos = (skipIntro && typeof data.lecture_start === 'number' && data.lecture_start > 0)
        ? data.lecture_start
        : 0;

      if (startPos > 0 && Math.abs(media.currentTime - startPos) > 1) {
        media.currentTime = startPos;
        if (sheetSeek) sheetSeek.value = String(startPos);
        if (currentTimeNode) currentTimeNode.textContent = formatTime(startPos);
      }

      loading = false;
      setStatus('');
      updateUI();

      if (autoPlay) {
        active = true;
        updateUI();
        await media.play().catch(err => {
          if (err.name !== 'AbortError') {
            active = false;
            setStatus('پخش صوت شروع نشد؛ لطفاً دوباره دکمهٔ پخش را لمس کنید.');
            updateUI();
          }
        });
      }
    } catch (err) {
      if (rev !== revision || life.signal.aborted) return;
      loading = false;
      active = false;
      setStatus(err.message || 'بارگذاری صوت ناموفق بود.');
      updateUI();
    }
  }

  async function togglePlay() {
    if (active) {
      pause();
      return;
    }
    if (!currentSessionData || currentSessionData.session !== currentSessionNum) {
      await prepareSession(currentSessionNum, true);
      return;
    }
    if (audio) {
      active = true;
      updateUI();
      try {
        await audio.play();
      } catch (err) {
        if (err.name !== 'AbortError') {
          active = false;
          setStatus('پخش صوت ناموفق بود.');
          updateUI();
        }
      }
    } else {
      await prepareSession(currentSessionNum, true);
    }
  }

  function pause() {
    active = false;
    audio?.pause();
    updateUI();
  }

  function reset() {
    revision++;
    active = false;
    loading = false;
    currentCue = null;
    reader.highlight(null);
    if (audio) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }
    audio = null;
    currentSessionData = null;
    setStatus('');
    updateUI();
  }

  async function seekTo(seconds) {
    if (!audio || !currentSessionData) return;
    const clamped = Math.max(0, Math.min(currentSessionData.duration || 0, seconds));
    audio.currentTime = clamped;
    await onTimeUpdate();
  }

  function jump(deltaSeconds) {
    if (!audio || !currentSessionData) return;
    seekTo(audio.currentTime + deltaSeconds);
  }

  // Event Listeners
  if (widgetPlay) {
    widgetPlay.addEventListener('click', () => togglePlay(), options);
  }
  if (sheetToggle) {
    sheetToggle.addEventListener('click', () => togglePlay(), options);
  }
  if (sheetStop) {
    sheetStop.addEventListener('click', () => {
      pause();
      if (audio) audio.currentTime = 0;
      currentCue = null;
      reader.highlight(null);
      if (sheetSeek) sheetSeek.value = '0';
      if (currentTimeNode) currentTimeNode.textContent = formatTime(0);
    }, options);
  }
  if (widgetPrev) {
    widgetPrev.addEventListener('click', () => jump(-15), options);
  }
  if (widgetNext) {
    widgetNext.addEventListener('click', () => jump(15), options);
  }
  if (sheetSpeed) {
    sheetSpeed.addEventListener('change', () => {
      currentRate = Number(sheetSpeed.value) || 1.0;
      if (audio) audio.playbackRate = currentRate;
    }, options);
  }
  if (sheetSkipIntro) {
    sheetSkipIntro.addEventListener('change', () => {
      skipIntro = sheetSkipIntro.checked;
    }, options);
  }
  if (sheetSession) {
    sheetSession.addEventListener('change', async () => {
      const chosen = Number(sheetSession.value);
      if (chosen && chosen !== currentSessionNum) {
        const wasActive = active;
        pause();
        const data = await loadSessionDetails(chosen);
        if (data.book_pages && data.book_pages[0]) {
          await showPage(data.book_pages[0]);
        }
        await prepareSession(chosen, wasActive);
      }
    }, options);
  }
  if (sheetSeek) {
    sheetSeek.addEventListener('input', () => {
      if (currentTimeNode) currentTimeNode.textContent = formatTime(Number(sheetSeek.value));
    }, options);
    sheetSeek.addEventListener('change', () => {
      seekTo(Number(sheetSeek.value));
    }, options);
  }

  // Initialize
  const initPromise = (async () => {
    try {
      const { doc: bookId, page } = getContext();
      const res = await fetchImpl(`/books/${encodeURIComponent(bookId)}/lectures`, { signal: life.signal });
      if (!res.ok) return false;
      const data = await res.json();
      sessions = Array.isArray(data) ? data : data.sessions || [];
      if (!sessions.length) return false;

      populateSessionSelect();
      const matchingSession = findSessionForPage(page);
      if (matchingSession) {
        currentSessionNum = matchingSession.session;
        if (sheetSession) sheetSession.value = String(currentSessionNum);
      }
      updateUI();
      return true;
    } catch {
      return false;
    }
  })();

  return {
    isLecture: true,
    ready: initPromise,
    togglePlay,
    play: () => togglePlay(),
    pause,
    suspend: pause,
    reset,
    seekTo,
    dispose() {
      reset();
      life.abort();
    },
    get active() {
      return active;
    },
    get session() {
      return currentSessionNum;
    },
    onPageChanged(page) {
      if (!active) {
        const matched = findSessionForPage(page);
        if (matched && matched.session !== currentSessionNum) {
          currentSessionNum = matched.session;
          if (sheetSession) sheetSession.value = String(currentSessionNum);
          currentSessionData = null;
        }
      }
    },
  };
}
