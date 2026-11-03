/** Lock-screen media controls over the page's single MediaSession. The engine that
 * announced last owns it; a sibling's stale handlers pause nothing (they guard on a
 * null player / a paused element). Browsers without MediaSession skip silently —
 * playback itself is never touched. */
export function createMediaSessionBridge({ win = globalThis.window } = {}) {
  const session = () => win?.navigator?.mediaSession;
  const metadataOf = () => {
    const Ctor = win?.MediaMetadata;
    return typeof Ctor === 'function' ? Ctor : null;
  };
  const supported = () => !!session() && !!metadataOf();
  const api = {
    supported,
    announce({ title, artist, album } = {}) {
      const Ctor = metadataOf();
      if (!session() || !Ctor) return;
      try { session().metadata = new Ctor({ title, artist, album }); } catch {}
    },
    state(kind) {
      if (!session()) return;
      try { session().playbackState = kind === 'playing' ? 'playing' : 'paused'; } catch {}
    },
    position({ position, duration, rate } = {}) {
      if (!session() || typeof session().setPositionState !== 'function') return;
      try {
        if (!Number.isFinite(duration) || duration <= 0) { session().setPositionState(); return; }
        session().setPositionState({
          position: Math.max(0, Math.min(position ?? 0, duration)),
          duration,
          playbackRate: rate && rate > 0 ? rate : 1,
        });
      } catch {}
    },
    handlers(map = {}) {
      const ms = session();
      if (!ms) return;
      for (const [action, handler] of Object.entries(map)) {
        if (typeof handler !== 'function') continue;
        try { ms.setActionHandler(action, handler); } catch {}
      }
    },
    clear() {
      if (!session()) return;
      try { session().metadata = null; } catch {}
      api.state('paused');
    },
  };
  return api;
}
