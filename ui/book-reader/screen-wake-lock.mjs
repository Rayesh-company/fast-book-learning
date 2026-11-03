/** Keeps the screen awake while the reading view is on screen (PM call 2026-11-03:
 * audio alone never holds the lock — a low-battery user locks the phone and just listens).
 * The platform drops the sentinel on hide/lock, so re-acquiring on visibilitychange is ours. */
export function createScreenWakeLock({ win = globalThis.window, onChange = () => {} } = {}) {
  const doc = win?.document;
  const wakeLock = () => win?.navigator?.wakeLock;
  // Realm matters: a global AbortSignal fails jsdom's brand check on addEventListener.
  const lifecycle = new (win?.AbortController ?? globalThis.AbortController)();
  let sentinel = null;
  let wanted = false;
  let disposed = false;

  const supported = () => typeof wakeLock()?.request === 'function';
  const release = held => { try { held.release(); } catch {} };

  async function sync() {
    if (disposed) return;
    const should = wanted && supported() && doc?.visibilityState === 'visible';
    if (should && !sentinel) {
      try {
        const held = await wakeLock().request('screen');
        if (disposed) { release(held); return; }
        sentinel = held;
        held.addEventListener?.('release', () => {
          if (sentinel !== held) return; // our own release() already reported
          sentinel = null;
          onChange('released');
        });
        onChange('held');
      } catch {
        // Battery saver, a permission denial or a visibility race: retry on the next sync.
        if (!sentinel) onChange('denied');
      }
    } else if (!should && sentinel) {
      const held = sentinel;
      sentinel = null;
      release(held);
      onChange('released');
    }
  }

  doc?.addEventListener?.('visibilitychange', () => { sync(); }, { signal: lifecycle.signal });
  return {
    set(active) {
      wanted = !!active;
      if (wanted && !supported()) { onChange('unsupported'); return Promise.resolve(); }
      return sync();
    },
    get held() { return !!sentinel; },
    dispose() {
      disposed = true;
      lifecycle.abort();
      if (sentinel) { release(sentinel); sentinel = null; }
    },
  };
}
