/** Lecture read-along timing and geometry: pure functions, no DOM.
 * A session's sentences come from /books/<id>/lectures/<n>, ordered by
 * start with overlaps already clipped (tools/build_lecture_index.py).
 * Times are seconds in the session audio; boxes are
 * [page, x0, y0, x1, y1] in PDF points (top-left origin).
 */

const ROUGH = new Set(['rough_timing', 'interpolated', 'fuzzy_boxes']);

/** Index the sentences for lookup; defensive about order and overlaps. */
export function createLectureTrack(session) {
  const sentences = [...(session?.sentences ?? [])]
    .filter(s => Number.isFinite(s.start) && Number.isFinite(s.end))
    .sort((a, b) => a.start - b.start || a.id - b.id);
  const starts = sentences.map(s => s.start);
  const ends = sentences.map((s, i) => Math.max(s.start, Math.min(s.end, sentences[i + 1]?.start ?? Infinity)));
  return { session, sentences, starts, ends };
}

/** The last sentence starting at or before `time` (binary search).
 * Returns { index, active } — `active` is false in the silence/commentary
 * gap after a sentence ends and before the next starts (the reader keeps
 * a quieter "held" highlight there). index -1: before the first sentence. */
export function sentenceIndexAt(track, time) {
  const { starts, ends } = track;
  let lo = 0, hi = starts.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= time) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return { index: found, active: found >= 0 && time < ends[found] };
}

/** Highlight style: 'exact', 'rough' (interpolated / Quran / fuzzy box), or 'held'. */
export function toneFor(sentence, active = true) {
  if (!active) return 'held';
  return sentence.flags?.some(flag => ROUGH.has(flag)) ? 'rough' : 'exact';
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

/** The sentence whose box on `page` contains the PDF point (x, y). */
export function sentenceAtPoint(track, page, x, y, pad = 2) {
  for (const sentence of track.sentences) {
    for (const box of sentence.boxes ?? []) {
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
