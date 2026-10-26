/** Layout boundaries are separate from canonical text; offsets never change. */
export function pdfParagraphs(index, items, page) {
  const lines = [];
  for (const span of index.items) {
    const item = items[span.textItemIndex];
    if (!item?.str?.trim()) continue;
    const y = item.transform?.[5] ?? 0, height = item.height || 12;
    let line = lines.at(-1);
    if (!line || Math.abs(line.y - y) > Math.max(line.height, height) * .6) {
      line = { y, height, start: span.start, end: span.end, left: Infinity, right: -Infinity, rtl: item.dir === 'rtl' };
      lines.push(line);
    }
    line.end = Math.max(line.end, span.end);
    line.left = Math.min(line.left, item.transform?.[4] ?? 0);
    line.right = Math.max(line.right, (item.transform?.[4] ?? 0) + (item.width || 0));
  }
  if (!lines.length) return index.text.trim() ? [{ page, start: 0, end: index.text.length, text: index.text }] : [];
  const gaps = lines.slice(1).map((line, i) => Math.abs(lines[i].y - line.y)).filter(n => n > 0).sort((a,b) => a-b);
  const spacing = gaps[Math.floor(gaps.length / 2)] || lines[0].height * 1.5;
  // Justified body text fills every line out to the same trailing edge, while a
  // paragraph's last line stops short of it. Books that do not indent their
  // paragraphs mark the break only this way.
  const bodyHeight = lines.map(l => l.height).sort((a,b) => a-b)[Math.floor(lines.length / 2)];
  const isBody = line => Math.abs(line.height - bodyHeight) <= bodyHeight * .15;
  const percentile = (values, share) => values.sort((a,b) => a-b)[Math.floor((values.length - 1) * share)];
  const bodyLines = lines.filter(isBody);
  const rtlLines = bodyLines.filter(l => l.rtl), ltrLines = bodyLines.filter(l => !l.rtl);
  // A margin needs enough lines to be trustworthy; fewer lines never imply a break.
  const rtlEdge = rtlLines.length >= 4 ? percentile(rtlLines.map(l => l.left), .2) : null;
  const ltrEdge = ltrLines.length >= 4 ? percentile(ltrLines.map(l => l.right), .8) : null;
  const endsShort = line => isBody(line) && (line.rtl
    ? rtlEdge !== null && line.left - rtlEdge > line.height * 1.25
    : ltrEdge !== null && ltrEdge - line.right > line.height * 1.25);
  const starts = [lines[0].start];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i], previous = lines[i-1];
    const indentation = line.rtl ? previous.right - line.right : line.left - previous.left;
    const wrappedBreak = index.text.slice(previous.end, line.start);
    if (/\n\s*\n/u.test(wrappedBreak) || Math.abs(line.y - previous.y) > spacing * 1.4 ||
        indentation > line.height * .7 || Math.abs(line.height - previous.height) > previous.height * .25 ||
        endsShort(previous)) starts.push(line.start);
  }
  return starts.map((start, i) => {
    let end = starts[i+1] ?? index.text.length;
    while (start < end && /\s/u.test(index.text[start])) start++;
    while (end > start && /\s/u.test(index.text[end-1])) end--;
    return { page, start, end, text: index.text.slice(start,end) };
  }).filter(span => span.end > span.start);
}
