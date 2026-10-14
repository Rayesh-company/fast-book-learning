/** Join selected runs on the same line, without bridging columns or line breaks. */
export function continuousRects(rects, gapFactor=1.5) {
  const lines = [];
  for (const rect of [...rects].sort((a,b) => a.top-b.top || a.left-b.left)) {
    if (!(rect.width > 0 && rect.height > 0)) continue;
    const line = lines.find(line => Math.min(line.top+line.height,rect.top+rect.height)-Math.max(line.top,rect.top) >= Math.min(line.height,rect.height)*.6);
    if (line) line.rects.push(rect);
    else lines.push({...rect,rects:[rect]});
  }
  return lines.flatMap(line => {
    const strips = [];
    for (const rect of line.rects.sort((a,b) => a.left-b.left)) {
      const last = strips.at(-1);
      if (last && rect.left <= last.left+last.width+Math.max(last.height,rect.height)*gapFactor) {
        const right = Math.max(last.left+last.width,rect.left+rect.width);
        const bottom = Math.max(last.top+last.height,rect.top+rect.height);
        last.left = Math.min(last.left,rect.left); last.top = Math.min(last.top,rect.top);
        last.width = right-last.left; last.height = bottom-last.top;
      } else strips.push({...rect});
    }
    return strips;
  });
}
