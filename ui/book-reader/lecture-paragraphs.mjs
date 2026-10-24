import { boxesOnPage, pageForTime } from './lecture-sync.mjs';

/** Geometry ties timings to canonical paragraphs; no fuzzy text lookup. */
export function lectureParagraphAnchors(track,page,data) {
  const paragraphs=data.paragraphs.map(p=>({...p,boxes:data.index.items.filter(item=>item.end>p.start&&item.start<p.end).flatMap(span=>{
    const item=data.indexItems?.[span.textItemIndex];if(!item?.str?.trim())return [];
    const x=item.transform[4],y=data.height-item.transform[5],height=item.height||12;
    return [{x0:x,x1:x+item.width,y0:y-height,y1:y}];
  })}));
  const anchors=new Map();
  for (const cue of track.sentences) for(const unit of cue.words?.length?cue.words:[cue]) {
    const time=unit.speech_start??unit.start;
    if(!Number.isFinite(time))continue;
    // A complete sentence can begin on the preceding page. Its word timings,
    // rather than the sentence's first onset, authorize this paragraph seek.
    if(!cue.words?.length&&pageForTime(cue,time)!==page)continue;
    const boxes=boxesOnPage(unit,page);
    let best=null,bestScore=0;
    for (const paragraph of paragraphs) {
      const score=boxes.reduce((sum,box)=>sum+paragraph.boxes.reduce((area,p)=>area+
        Math.max(0,Math.min(box.x1,p.x1)-Math.max(box.x0,p.x0))*Math.max(0,Math.min(box.y1,p.y1)-Math.max(box.y0,p.y0)),0),0);
      if(score>bestScore){best=paragraph;bestScore=score;}
    }
    if(!best)continue;
    const old=anchors.get(best.start);
    if(!old||time<old.time)anchors.set(best.start,{page,start:best.start,end:best.end,time});
  }
  return [...anchors.values()].sort((a,b)=>a.start-b.start);
}
