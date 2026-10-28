/** Lecture read-along timing and geometry: pure functions, no DOM.
 * A session's cues (or legacy sentences) come from /books/<id>/lectures/<n>.
 * Refined cues include separate silence checkpoints and speech bounds.
 * Times are seconds in the session audio; boxes are
 * [page, x0, y0, x1, y1] in PDF points (top-left origin).
 */

/** Index the sentences for lookup; defensive about order and overlaps. */
export function createLectureTrack(session) {
  const focusById = new Map((session?.sentence_focus ?? []).map(s => [s.id, s]));
  const cues = [...(session?.cues ?? session?.sentences ?? [])]
    .filter(s => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
    .sort((a, b) => a.start - b.start || a.id - b.id)
    .map(s => focusById.has(s.sentence_id) ? { ...s, sentence_focus: focusById.get(s.sentence_id) } : s);
  // A visible sentence has one continuous interval, from its first observed
  // speech to its last. Internal cue gaps and pause checkpoints must neither
  // dim nor clear it. Merge only adjacent runs, never across another sentence.
  const sentences = [];
  for (const cue of cues) {
    if (!cue.sentence_focus) { sentences.push(cue); continue; }
    const previous = sentences.at(-1);
    const anchor = cue.speech_start ?? cue.start, end = cue.speech_end ?? cue.end;
    const onset = cue.timing?.sentence_onset;
    const pause = onset?.pause ?? cue.timing?.start_pause;
    const candidate = onset?.start ?? pause?.[1];
    const lowerBound = Math.max(0, anchor - 2.5, previous?.end ?? 0);
    const measured = Array.isArray(pause) && pause.length === 2
      && Number.isFinite(pause[0]) && Number.isFinite(pause[1]) && pause[0] < pause[1]
      && pause[1] - pause[0] >= .2 - 1e-6
      && Number.isFinite(candidate) && candidate === pause[1]
      && candidate >= lowerBound && candidate <= anchor;
    const start = measured ? candidate : anchor;
    if (previous?.sentence_focus && previous.sentence_id === cue.sentence_id) {
      previous.end = previous.speech_end = Math.max(previous.end, end);
      previous.words.push(...(cue.words ?? []));
    } else {
      sentences.push({ ...cue, start, end, speech_start: start, speech_end: end,
        words: [...(cue.words ?? [])] });
    }
  }
  const starts = sentences.map(s => s.start);
  const ends = sentences.map((s, i) => Math.max(s.start, Math.min(s.end, sentences[i + 1]?.start ?? Infinity)));
  const speechStarts = sentences.map(s => Math.max(s.start, s.speech_start ?? s.start));
  const speechEnds = sentences.map((s, i) => Math.min(ends[i], s.speech_end ?? ends[i]));
  return { session, sentences, starts, ends, speechStarts, speechEnds, verified: Boolean(session?.word_alignment) };
}

/** The last sentence starting at or before `time` (binary search).
 * Returns { index, active } — in a pause, the checkpoint chooses the phrase
 * while speech bounds keep its highlight quiet until speech resumes.
 * Legacy commentary gaps hold the last sentence. index -1: before the first. */
export function sentenceIndexAt(track, time) {
  const { starts, ends, speechStarts, speechEnds } = track;
  let lo = 0, hi = starts.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= time) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  const active = found >= 0 && time >= (speechStarts?.[found] ?? starts[found])
    && time < (speechEnds?.[found] ?? ends[found]);
  // Unsupported speech and commentary have no verified cue. Do not hold the
  // last supported word indefinitely through a rejected passage.
  if (track.verified && found >= 0 && time >= ends[found]) return { index: -1, active: false };
  return { index: found, active };
}

/** The page the audio is on at `time`: the page of the last sentence to begin at
 * or before it, even through an unverified gap that shows no focus. null before
 * the first sentence. */
export function pageAtTime(track, time) {
  const { starts, sentences } = track;
  let lo = 0, hi = starts.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= time) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (found < 0) return null;
  const sentence = sentences[found];
  return pageForTime(sentence.sentence_focus ? { ...sentence, ...sentence.sentence_focus } : sentence, time) ?? null;
}

/** Highlight style: 'exact' while the sentence is being spoken, 'held' in gaps between sentences. */
export function toneFor(sentence, active = true) {
  return active ? 'exact' : 'held';
}

/** Pages the sentence's boxes lie on, in order. */
export function sentencePages(sentence) {
  return [...new Set((sentence.boxes ?? []).map(box => box[0]))];
}

/** Which page should be on screen for this moment of a sentence that may
 * run across a page break: the time is split by each page's box count. */
export function pageForTime(sentence, time) {
  const pages = sentencePages(sentence);
  if (pages.length < 2) return pages[0] ?? sentence.page;
  if (sentence.page_timing === 'word_alignment' && sentence.words?.length) {
    const word = sentence.words.findLast(w => w.start <= time) ?? sentence.words[0];
    return word.boxes?.[0]?.[0] ?? sentence.page;
  }
  // Refined cues move only at acoustic checkpoints. A box-count ratio is
  // not an audio timestamp, especially when a speaker stretches a phrase.
  if (sentence.page_timing === 'checkpoint') return pages[0];
  const weights = pages.map(page => sentence.boxes.filter(box => box[0] === page).length);
  const total = weights.reduce((a, b) => a + b, 0);
  const span = Math.max(1e-6, sentence.end - sentence.start);
  let fraction = Math.min(1, Math.max(0, (time - sentence.start) / span)) * total;
  for (let i = 0; i < pages.length; i++) {
    if (fraction < weights[i]) return pages[i];
    fraction -= weights[i];
  }
  return pages.at(-1);
}

/** Boxes of one page as {page, x0, y0, x1, y1}. */
export function boxesOnPage(sentence, page) {
  return (sentence.boxes ?? []).filter(box => box[0] === page)
    .map(([p, x0, y0, x1, y1]) => ({ page: p, x0, y0, x1, y1 }));
}

/** Paint a sentence as one continuous strip per PDF line. Keep original word
 * geometry for hit testing and timing; never fill the space between lines. */
export function lineBoxesOnPage(sentence, page) {
  const boxes = boxesOnPage(sentence, page)
    .filter(b => [b.x0,b.y0,b.x1,b.y1].every(Number.isFinite) && b.x1 > b.x0 && b.y1 > b.y0)
    .sort((a,b) => (a.y0+a.y1)-(b.y0+b.y1) || a.x0-b.x0);
  const lines = [];
  for (const box of boxes) {
    const height = box.y1-box.y0, center = (box.y0+box.y1)/2;
    const line = lines.find(({anchor}) => {
      const overlap = Math.min(anchor.y1,box.y1)-Math.max(anchor.y0,box.y0);
      const anchorHeight = anchor.y1-anchor.y0;
      return overlap >= Math.min(height,anchorHeight)*.6
        && Math.abs(center-(anchor.y0+anchor.y1)/2) <= Math.max(height,anchorHeight)*.4;
    });
    if (!line) { lines.push({anchor:box,box:{...box}}); continue; }
    line.box.x0 = Math.min(line.box.x0,box.x0);
    line.box.x1 = Math.max(line.box.x1,box.x1);
    line.box.y0 = Math.min(line.box.y0,box.y0);
    line.box.y1 = Math.max(line.box.y1,box.y1);
  }
  return lines.map(line => line.box);
}

/** The full sentence interval decides when to focus. Acoustic word times
 * still control page turns; pauses inside the sentence keep the same tone. */
export function focusForTime(sentence, time, active = true) {
  const focus = sentence.sentence_focus ? { ...sentence, ...sentence.sentence_focus } : sentence;
  if (sentence.sentence_focus) return { sentence: focus, active };
  if (!sentence.words?.length) return { sentence: focus, active };
  return { sentence: focus, active: active && time >= sentence.words[0].start
    && time < sentence.words.at(-1).end };
}

/** The sentence whose box on `page` contains the PDF point (x, y). */
export function sentenceAtPoint(track, page, x, y, pad = 2) {
  for (const sentence of track.sentences) {
    for (const box of sentence.sentence_focus?.boxes ?? sentence.boxes ?? []) {
      if (box[0] === page && x >= box[1] - pad && x <= box[3] + pad && y >= box[2] - pad && y <= box[4] + pad) return sentence;
    }
  }
  return null;
}

/** The session most relevant to a Book page: the one whose pages hold it. */
export function sessionForPage(sessions, page) {
  return sessions.find(s => s.book_pages && page >= (s.cover_page ?? s.book_pages[0]) && page <= s.book_pages[1])
    ?? null;
}

export function formatClock(seconds) {
  const total = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(total / 3600), m = Math.floor(total / 60) % 60, s = total % 60;
  const text = h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  return text.replace(/\d/g, d => '۰۱۲۳۴۵۶۷۸۹'[d]);
}
