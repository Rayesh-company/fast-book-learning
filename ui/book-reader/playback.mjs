import { HtmlAudioPlaybackPort } from './html-audio-playback.mjs';

export function validateCues(cues) {
  let previousEnd = 0;
  if (!Array.isArray(cues)) throw new TypeError('Invalid timing list');
  for (const cue of cues) {
    if (!Number.isFinite(cue.startMs) || !Number.isFinite(cue.endMs) ||
        cue.startMs < previousEnd || cue.endMs <= cue.startMs) throw new TypeError('Invalid or overlapping timing');
    if (!Number.isInteger(cue.page) || cue.page < 1 || !Number.isInteger(cue.start) ||
        !Number.isInteger(cue.end) || cue.start < 0 || cue.end <= cue.start ||
        typeof cue.text !== 'string' || cue.text.length !== cue.end - cue.start) throw new TypeError('Invalid text range');
    previousEnd = cue.endMs;
  }
}

// Same half-open timing contract as Tuba narration/aligner.ts: silence is null.
export function cueAt(cues, timeMs) {
  return cues.find(cue => timeMs >= cue.startMs && timeMs < cue.endMs) ?? null;
}

export function createNarrationPlayer({ bytes, mimeType, cues, rate = 1,
  onFocus = () => {}, onState = () => {}, createAudioElement }) {
  validateCues(cues);
  cues = cues.map(cue => ({ ...cue }));
  if (!(bytes instanceof Uint8Array) || !bytes.length) throw new TypeError('Audio bytes are required');
  const media = new HtmlAudioPlaybackPort({ createAudioElement }).createMedia({ bytes, mimeType, rate });
  let disposed = false;
  let state = 'ready';
  const focus = () => { if (!disposed) onFocus(cueAt(cues, media.currentTime * 1000)); };
  const update = value => { if (!disposed) { state = value; onState(value); } };
  media.onPlaying(() => { update('playing'); focus(); });
  media.onTimeUpdate(focus);
  media.onSeeking(() => onFocus(null));
  media.onSeeked(focus);
  media.onWaiting(() => { update('waiting'); onFocus(null); });
  media.onEnded(() => { update('ended'); onFocus(null); });
  media.onError(() => { update('error'); onFocus(null); });
  return {
    play: () => media.play(),
    pause() { media.pause(); update('paused'); },
    seek: seconds => media.seek(seconds),
    setRate: rate => media.setRate(rate),
    get currentTime() { return media.currentTime; },
    get state() { return state; },
    dispose() { if (disposed) return; onFocus(null); media.detach(); disposed = true; },
  };
}
