/** The lecture player (the کتاب‌خوان's recorded sessions): one fixed
 * bottom bar that plays the tarhe-kolli lecture MP3s served from
 * /books/<book>/lectures/. The index (books/<book>.lectures.json)
 * names every session, its duration, and lecture_start/lecture_end —
 * the boundaries the guide's «بدون مقدمه» toggle jumps to. Player-side
 * options never touch the files: the delivery guide is explicit that
 * trimming or re-encoding invalidates the timing, while speed and
 * skip-intro are just playback state.
 *
 * Self-booting: include the module and it mounts the bar; the fetch
 * failing (no package configured) degrades to one honest line. */

const digits = (n) => String(n).replace(/\d/g, (c) => '۰۱۲۳۴۵۶۷۸۹'[c]);
const clock = (seconds) => {
  const total = Math.max(0, Math.floor(seconds || 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${digits(m)}:${digits(String(s).padStart(2, '0'))}`;
};

const STYLES = `
.lecture-player{position:fixed;inset-inline:0;bottom:0;z-index:60;display:flex;flex-wrap:wrap;gap:8px;align-items:center;
  padding:8px 12px calc(8px + env(safe-area-inset-bottom));background:rgba(23,33,43,.96);color:#e8edf2;
  font:13px/1.6 Vazirmatn,"Segoe UI",Tahoma,sans-serif;direction:rtl}
.lecture-player select,.lecture-player input[type=range]{accent-color:#4fae6d}
.lecture-player select{max-width:46vw;padding:4px 8px;border-radius:8px;border:1px solid #2b3a4a;background:#1e2c3a;color:inherit}
.lecture-player input[type=range]{flex:1;min-width:90px}
.lecture-player button{border:1px solid #2b3a4a;border-radius:8px;background:#1e2c3a;color:inherit;padding:4px 10px;cursor:pointer}
.lecture-player button[data-lp-state=playing]{background:#4fae6d;color:#0f1c14;border-color:#4fae6d}
.lecture-player .lp-time{min-width:86px;text-align:center;color:#93a1b1;font-variant-numeric:tabular-nums}
.lecture-player .lp-status{flex-basis:100%;margin:0;color:#93a1b1;font-size:12px}
.lecture-player .lp-off{background:transparent;border-style:dashed;color:#93a1b1}
.lecture-player .lp-off[data-lp-skip=on]{color:#4fae6d;border-color:#4fae6d}
`;

export async function installLecturePlayer({
  root = document,
  fetchImpl = fetch,
  book = new URLSearchParams(root.location?.search || '').get('book') || 'tarhe-kolli',
  mount = null,
  audioFactory = () => root.createElement('audio'),
} = {}) {
  const doc = root.ownerDocument ?? root;
  const bar = doc.createElement('div');
  bar.className = 'lecture-player';
  bar.setAttribute('role', 'region');
  bar.setAttribute('aria-label', 'پخش جلسات صوتی');
  bar.innerHTML = '<p class="lp-status" role="status">در حال خواندن فهرست جلسات…</p>';
  const style = doc.createElement('style');
  style.textContent = STYLES;
  doc.head.append(style);
  (mount ?? doc.body).append(bar);

  let index;
  try {
    // The SLIM summary (a few KB) — the 45MB alignment file is only
    // for word-level sync and a phone never downloads it to play.
    const response = await fetchImpl(`/books/${book}.lectures.summary.json`);
    if (!response.ok) throw new Error(String(response.status));
    index = await response.json();
  } catch {
    bar.querySelector('.lp-status').textContent =
      'صوت جلسات در دسترس نیست؛ بعداً دوباره باز کنید.';
    return bar;
  }

  const sessions = (index.sessions || []).filter((s) => s && s.audio);
  if (!sessions.length) {
    bar.querySelector('.lp-status').textContent = 'هیچ جلسه‌ای در فهرست نیست.';
    return bar;
  }

  const audio = audioFactory();
  // 'none': the session MP3s download only when someone presses play —
  // 'metadata' pulled the first 64KB of session_01 into every page
  // load, on the boot's critical path (the Lighthouse 2026-10-23 run).
  // Durations come from the summary index, so the bar needs no fetch
  // to paint its clock.
  audio.preload = 'none';
  bar.append(audio);
  const sessionPicker = doc.createElement('select');
  sessionPicker.setAttribute('aria-label', 'انتخاب جلسه');
  for (const session of sessions) {
    const option = doc.createElement('option');
    option.value = session.audio;
    option.textContent = `جلسۀ ${digits(session.session)} · ${clock(session.duration)}`;
    sessionPicker.append(option);
  }

  const playButton = doc.createElement('button');
  playButton.type = 'button';
  playButton.textContent = '▶ پخش';
  playButton.setAttribute('aria-label', 'پخش');

  const seek = doc.createElement('input');
  seek.type = 'range';
  seek.min = '0';
  seek.step = '1';
  seek.value = '0';
  seek.setAttribute('aria-label', 'جای پخش');

  const timeLabel = doc.createElement('span');
  timeLabel.className = 'lp-time';
  timeLabel.textContent = `۰۰:۰۰ / ${clock(sessions[0].duration)}`;

  const speed = doc.createElement('select');
  speed.setAttribute('aria-label', 'سرعت پخش');
  for (const [label, value] of [['۰٫۷۵×', 0.75], ['۱×', 1], ['۱٫۲۵×', 1.25], ['۱٫۵×', 1.5], ['۲×', 2]]) {
    const option = doc.createElement('option');
    option.value = String(value);
    option.textContent = label;
    if (value === 1) option.selected = true;
    speed.append(option);
  }

  const skipIntro = doc.createElement('button');
  skipIntro.type = 'button';
  skipIntro.className = 'lp-off';
  skipIntro.textContent = 'بدون مقدمه';
  skipIntro.setAttribute('aria-label', 'پرش از مقدمه');
  skipIntro.setAttribute('data-lp-skip', 'off');

  const status = bar.querySelector('.lp-status');
  status.textContent = '';

  let skipIntroOn = false;
  let current = null;

  const loadSession = (session) => {
    current = session;
    audio.src = `/books/${book}/lectures/${session.audio}`;
    audio.playbackRate = Number(speed.value) || 1;
    seek.max = String(session.duration || 0);
    timeLabel.textContent = `۰۰:۰۰ / ${clock(session.duration)}`;
    // «بدون مقدمه»: the measured boundary the index carries — the
    // player jumps, the file never changes.
    if (skipIntroOn && session.lecture_start > 0) audio.currentTime = session.lecture_start;
    else audio.currentTime = 0;
  };

  sessionPicker.addEventListener('change', () => {
    const session = sessions.find((s) => s.audio === sessionPicker.value);
    if (session) loadSession(session);
  });
  playButton.addEventListener('click', async () => {
    if (!current) loadSession(sessions[0]);
    try {
      if (audio.paused) {
        await audio.play();
        playButton.textContent = '❚❚ توقف';
        playButton.setAttribute('data-lp-state', 'playing');
      } else {
        audio.pause();
        playButton.textContent = '▶ پخش';
        playButton.setAttribute('data-lp-state', 'idle');
      }
    } catch {
      status.textContent = 'پخش شروع نشد؛ دوباره بزنید.';
    }
  });
  speed.addEventListener('change', () => {
    audio.playbackRate = Number(speed.value) || 1;
  });
  skipIntro.addEventListener('click', () => {
    skipIntroOn = !skipIntroOn;
    skipIntro.setAttribute('data-lp-skip', skipIntroOn ? 'on' : 'off');
    if (skipIntroOn && current && current.lecture_start > 0 && audio.currentTime < current.lecture_start) {
      audio.currentTime = current.lecture_start;
    }
  });
  audio.addEventListener('timeupdate', () => {
    seek.value = String(Math.floor(audio.currentTime || 0));
    timeLabel.textContent = `${clock(audio.currentTime)} / ${clock(current?.duration)}`;
  });
  seek.addEventListener('input', () => {
    audio.currentTime = Number(seek.value) || 0;
  });
  audio.addEventListener('ended', () => {
    playButton.textContent = '▶ پخش';
    playButton.setAttribute('data-lp-state', 'idle');
    // The next session, naturally — a course is a course.
    const at = sessions.findIndex((s) => s.audio === sessionPicker.value);
    if (at >= 0 && at + 1 < sessions.length) {
      sessionPicker.value = sessions[at + 1].audio;
      loadSession(sessions[at + 1]);
      audio.play().catch(() => {});
    }
  });

  bar.prepend(seek, timeLabel, playButton, sessionPicker, speed, skipIntro);
  loadSession(sessions[0]);
  return bar;
}

if (typeof document !== 'undefined' && !document.querySelector('.lecture-player')) {
  const boot = () => installLecturePlayer({ root: document }).catch(() => {});
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
}
