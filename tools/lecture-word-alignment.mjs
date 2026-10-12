/** Acoustic word anchors for recorded lectures. No proportional text timing.
 * Recognized CTC characters provide optional, monotonic anchors; missing Book
 * characters may be deleted. Each accepted word is then locally forced aligned
 * within its observed acoustic neighbourhood, never across unrelated speech.
 */
import {ALIGNMENT_VOCAB, buildAlignmentTranscript, ctcForcedAlign} from '../ui/narration/aligner.mjs';

const letters = Object.fromEntries(Object.entries(ALIGNMENT_VOCAB).map(([k, v]) => [v, k]));
const fold = c => ({'ي':'ی','ى':'ی','ك':'ک','آ':'ا','أ':'ا','إ':'ا','ٱ':'ا','ئ':'ی','ؤ':'و','ۀ':'ه','ة':'ه'}[c] ?? c);
const audible = c => /^[\u0621-\u064a\u067e\u0686\u0698\u06a9\u06af\u06ccA-Z]$/u.test(c);
export const WORD_ALIGNMENT_VERSION = 'lecture-ctc-words-v3';
const equivalentLabels=new Map();
for(const [id,char] of Object.entries(letters)) if(audible(char)) {
  const key=fold(char);
  equivalentLabels.set(key,[...(equivalentLabels.get(key) ?? []),Number(id)]);
}
function wordTranscript(text) {
  // Normalization affects model input only; the Book text and PDF offsets stay
  // intact. The model has separate Arabic/Persian spellings for some letters.
  const speech=[...text].map(fold).join('');
  const tr=buildAlignmentTranscript(speech,[{start:0,end:speech.length}]);
  tr.tokens=tr.tokens.map(t=>({...t,token:fold(t.token),id:ALIGNMENT_VOCAB[fold(t.token)] ?? t.id}));
  return tr;
}
const isConjunction = text => wordTranscript(text).tokens.filter(t=>audible(t.token)).map(t=>t.token).join('')==='و';
function canonicalLogits(input,vocabSize) {
  const out=new Float32Array(input);
  for(let row=0;row<out.length;row+=vocabSize) {
    for(const [letter,ids] of equivalentLabels) {
      if(ids.length<2) continue;
      const max=Math.max(...ids.map(id=>input[row+id]));
      const sum=ids.reduce((s,id)=>s+Math.exp(input[row+id]-max),0);
      for(const id of ids) out[row+id]=-Infinity;
      out[row+ALIGNMENT_VOCAB[letter]]=max+Math.log(sum);
    }
  }
  return out;
}

export function decodeCharacters(emissions, offset = 0) {
  const {logits, frameCount, vocabSize} = emissions;
  const result = [];
  let previous = 0;
  for (let t = 0; t < frameCount; t++) {
    let id = 0;
    for (let v = 1; v < vocabSize; v++) if (logits[t*vocabSize+v] > logits[t*vocabSize+id]) id = v;
    if (id && id === previous && result.at(-1)?.id === id) result.at(-1).end = offset + (t + 1)*.02;
    else if (id && id !== previous && audible(letters[id] ?? '')) {
      result.push({id, char:fold(letters[id]), start:offset+t*.02, end:offset+(t+1)*.02});
    }
    previous = id;
  }
  return result;
}

/** Edit alignment permits omissions and extra speech. The old sentence range
 * is only a search neighbourhood, never a clock for its constituent words. */
export function matchCharacters(words, heard, maxDistance = 16, freeEdges = false) {
  const wanted = [];
  words.forEach((w, wi) => {
    const transcript = wordTranscript(w.text);
    let letterIndex=0;
    for (const token of transcript.tokens) if (audible(token.token)) wanted.push({char:fold(token.token), wi, letterIndex:letterIndex++});
  });
  const n = wanted.length, m = heard.length, width = m + 1;
  const back = new Uint8Array((n+1)*width);
  let previous = Float64Array.from({length:width}, (_,j) => j);
  let endRow=0,endCost=previous[m];
  for (let i = 1; i <= n; i++) {
    // A fixed audio window may contain only part of a long source sentence.
    // Free Book prefix/suffix prevents its unheard remainder from stealing
    // character matches from words actually present in this window.
    const next = new Float64Array(width); next[0] = freeEdges ? 0 : i;
    const w = words[wanted[i-1].wi];
    for (let j = 1; j <= m; j++) {
      const h = heard[j-1];
      const distance = Math.max(0, w.coarse_start-h.end, h.start-w.coarse_end);
      const equal = wanted[i-1].char === h.char && distance <= maxDistance;
      // Substitutions carry no timing evidence; tiny penalties resolve repeated
      // letters in favour of their own sentence, without a character-speed prior.
      let best = previous[j-1] + (equal ? distance*.08 : 1.1), code = equal ? 1 : 0;
      if (previous[j]+1 < best) { best=previous[j]+1; code=2; }
      if (next[j-1]+1 < best) { best=next[j-1]+1; code=3; }
      next[j]=best; back[i*width+j]=code;
    }
    previous=next;
    if(next[m]<endCost) {endCost=next[m];endRow=i;}
  }
  const matches = words.map(() => []), counts = words.map(() => 0);
  for (const c of wanted) counts[c.wi]++;
  let i=freeEdges ? endRow : n,j=m;
  while (i && j) {
    const code=back[i*width+j];
    if (code===1) {matches[wanted[i-1].wi].push({...heard[j-1],letterIndex:wanted[i-1].letterIndex}); i--;j--;}
    else if (code===2) i--;
    else if (code===3) j--;
    else {i--;j--;}
  }
  return matches.map((ms, wi) => ({matches:ms.reverse(), coverage:counts[wi] ? ms.length/counts[wi] : 0, count:counts[wi]}));
}

/** Align a missing run together between observed words. Greedy recognition is
 * an anchor source, not a prerequisite for every Book word. Blank frames and
 * extra speech remain acoustic evidence; unsupported words are rejected. */
function recoverBoundedPhrases(words, emissions, offset, accepted, anchors) {
  const strong=orderedWords(accepted).words.filter(w=>w.coverage>=.5 && w.support>=.75 &&
    (wordTranscript(w.text).tokens.filter(t=>t.token!=='|').length>=3 || w.coverage===1 && w.support===1));
  const positions=new Map(words.map((w,i)=>[w.word_id,i]));
  const boundaries=[null,...strong,null],recovered=[];
  for(let i=0;i<boundaries.length-1;i++) {
    const left=boundaries[i],right=boundaries[i+1];
    const start=left ? positions.get(left.word_id)+1 : 0;
    const end=right ? positions.get(right.word_id) : words.length;
    const group=words.slice(start,end);
    if(!group.length || group.length>12 || (!left && !right)) continue;
    if(group.some((w,j)=>j && w.word_id!==group[j-1].word_id+1)) continue;
    // At an open window edge, the source sentence only limits the search.
    // No word timestamp is calculated from its old sentence duration.
    if(!left && group.some(w=>w.sentence_id!==right.sentence_id)) continue;
    if(!right && group.some(w=>w.sentence_id!==left.sentence_id)) continue;
    const lo=Math.max(offset,left?.end ?? Math.max(group[0].coarse_start-.6,right.start-6));
    const hi=Math.min(offset+emissions.frameCount*.02,right?.start ?? Math.min(group.at(-1).coarse_end+16,left.end+6));
    if(hi<=lo || hi-lo>(left && right ? 8 : 6)) continue;
    const f0=Math.max(0,Math.ceil((lo-offset)/.02-1e-6));
    const f1=Math.min(emissions.frameCount,Math.floor((hi-offset)/.02+1e-6));
    const tokens=[],spans=[];
    for(const word of group) {
      const local=wordTranscript(word.text).tokens.filter(t=>t.token!=='|');
      spans.push({word,start:tokens.length,count:local.length});
      tokens.push(...local,{id:ALIGNMENT_VOCAB['|'],token:'|'});
    }
    tokens.pop();
    if(!tokens.length || f1-f0<tokens.length) continue;
    const logits=canonicalLogits(emissions.logits.subarray(f0*emissions.vocabSize,f1*emissions.vocabSize),emissions.vocabSize);
    let alignment;
    try {alignment=ctcForcedAlign(logits,f1-f0,emissions.vocabSize,tokens);} catch {continue;}
    for(const {word,start:tokenStart,count} of spans) {
      if(!count || (count===1 && !isConjunction(word.text))) continue;
      if(count===2 && (!left || !right) && group.length===1) continue;
      const probabilities=[];
      for(let k=tokenStart;k<tokenStart+count;k++) {
        const range=alignment.tokenFrames[k];let best=0;
        for(let t=range.start;t<=range.end;t++) {
          const row=t*emissions.vocabSize;let max=-Infinity,sum=0;
          for(let v=0;v<emissions.vocabSize;v++) max=Math.max(max,logits[row+v]);
          for(let v=0;v<emissions.vocabSize;v++) sum+=Math.exp(logits[row+v]-max);
          best=Math.max(best,Math.exp(logits[row+tokens[k].id]-max)/sum);
        }
        probabilities.push(best);
      }
      const direct=probabilities.filter(p=>p>=.1).length/count;
      const allLetters=probabilities.every(p=>p>=.03);
      const strongEvidence=direct>=(count<=2 ? 1 : .5);
      const weakEvidence=allLetters && (count>=3 || count===2 && group.length>1);
      if(!strongEvidence && !weakEvidence) continue;
      const speechStart=offset+(f0+alignment.tokenFrames[tokenStart].start)*.02;
      const speechEnd=offset+(f0+alignment.tokenFrames[tokenStart+count-1].end+1)*.02;
      const duration=speechEnd-speechStart;
      if(duration<=0 || count>1 && duration<.05 || duration>Math.max(1.8,count*.24)) continue;
      // Low-posterior recovery requires every letter in a compact interval.
      if(!strongEvidence && duration>1.2) continue;
      recovered.push({...word,start:speechStart,end:speechEnd,
        coverage:anchors[positions.get(word.word_id)].coverage,
        support:strongEvidence ? direct : 1,support_threshold:strongEvidence ? .1 : .03,
        context_recovery:true,recovery_kind:'bounded_phrase'});
    }
  }
  return recovered;
}

export function alignWords(words, emissions, offset, coreStart, coreEnd) {
  const heard=decodeCharacters(emissions,offset);
  const anchors=matchCharacters(words,heard);
  const partial=matchCharacters(words,heard,16,true);
  // Complete-sentence matching handles omissions; the edge-free pass recovers
  // a sentence clipped by the window. Only admit additional observations that
  // fit between the strong, ordered anchors from the complete pass.
  for(let wi=0;wi<words.length;wi++) {
    const other=partial[wi];
    if(other.coverage<=anchors[wi].coverage || other.coverage<.5) continue;
    const left=anchors.slice(0,wi).findLast(a=>a.coverage>=.8)?.matches.at(-1);
    const right=anchors.slice(wi+1).find(a=>a.coverage>=.8)?.matches[0];
    if((!left || other.matches[0].start>=left.end) && (!right || other.matches.at(-1).end<=right.start)) anchors[wi]=other;
  }
  // Character edit distance may distribute the letters of one fully heard
  // word among several omitted Book words. Preserve complete word anchors
  // first, and release those letters from contradictory partial matches.
  const decoded=heard.map(h=>h.char).join(''),complete=[];
  for(let wi=0;wi<words.length;wi++) {
    const chars=wordTranscript(words[wi].text).tokens.filter(t=>audible(t.token)).map(t=>t.token).join('');
    if(chars.length<3) continue;
    for(let at=decoded.indexOf(chars);at>=0;at=decoded.indexOf(chars,at+1)) {
      const matches=heard.slice(at,at+chars.length).map((h,letterIndex)=>({...h,letterIndex}));
      const start=matches[0].start,end=matches.at(-1).end;
      if(end-start>Math.max(1.8,chars.length*.24)) continue;
      complete.push({...words[wi],wi,start,end,matches,coverage:chars.length,support:0});
    }
  }
  const protectedWords=orderedWords(complete).words;
  const occupied=new Set(protectedWords.flatMap(w=>w.matches.map(h=>h.start)));
  const byIndex=new Map(protectedWords.map(w=>[w.wi,w]));
  for(let wi=0;wi<words.length;wi++) {
    const full=byIndex.get(wi);
    if(full) anchors[wi]={matches:full.matches,coverage:1,count:full.matches.length};
    else {
      const matches=anchors[wi].matches.filter(h=>!occupied.has(h.start));
      anchors[wi]={...anchors[wi],matches,coverage:anchors[wi].count ? matches.length/anchors[wi].count : 0};
    }
  }
  const accepted=[];
  for (let wi=0;wi<words.length;wi++) {
    const w=words[wi], a=anchors[wi];
    if(a.count===1 && !isConjunction(w.text)) continue;
    const anchored=a.matches.length && a.coverage>=.5 && (a.count<=2 || a.matches.length>=2);
    let lo,hi;
    if(anchored) {
      const first=a.matches[0].start,last=a.matches.at(-1).end;
      if (last-first>Math.max(1.8,a.count*.24)) continue;
      const prev=anchors.slice(0,wi).findLast(x=>x.matches.length)?.matches.at(-1);
      const next=anchors.slice(wi+1).find(x=>x.matches.length)?.matches[0];
      const leading=a.matches[0].letterIndex;
      const trailing=a.count-1-a.matches.at(-1).letterIndex;
      lo=Math.max(offset,first-Math.min(.8,Math.max(.24,(leading+1)*.16)),prev?.end ?? offset);
      hi=Math.min(offset+emissions.frameCount*.02,last+Math.min(.8,Math.max(.24,(trailing+1)*.16)),next?.start ?? Infinity);
    } else {
      // A clipped/noisy greedy transcript can miss a correct Book word.
      // Recover only within a short interval bounded by strong neighbouring
      // words, with substantially stronger direct CTC support below.
      if(a.count<2) continue;
      const strong=x=>x.coverage>=.6 && x.count>=3 && x.matches.length>=2;
      const left=anchors.slice(0,wi).findLast(strong)?.matches.at(-1);
      const right=anchors.slice(wi+1).find(strong)?.matches[0];
      if(!left && !right) continue;
      // Two-letter function words need both observed neighbours and evidence
      // for every letter; their short spelling alone is too easy to force.
      if(a.count===2 && (!left || !right)) continue;
      lo=Math.max(offset,w.coarse_start-2,left?.end ?? offset);
      hi=Math.min(offset+emissions.frameCount*.02,w.coarse_end+2,right?.start ?? Infinity);
      if(hi-lo>2.5 || hi<=lo) continue;
    }
    const f0=Math.max(0,Math.floor((lo-offset)/.02));
    const f1=Math.min(emissions.frameCount,Math.ceil((hi-offset)/.02));
    const transcript=wordTranscript(w.text);
    const tokens=transcript.tokens.filter(t=>t.token!=='|');
    if (!tokens.length || f1-f0<tokens.length) continue;
    const logits=canonicalLogits(emissions.logits.subarray(f0*emissions.vocabSize,f1*emissions.vocabSize),emissions.vocabSize);
    let alignment;
    try {alignment=ctcForcedAlign(logits,f1-f0,emissions.vocabSize,tokens);} catch {continue;}
    let support=0;
    for(let k=0;k<tokens.length;k++) {
      const range=alignment.tokenFrames[k]; let best=0;
      for(let t=range.start;t<=range.end;t++) {
        const row=t*emissions.vocabSize; let max=-Infinity;
        for(let v=0;v<emissions.vocabSize;v++) max=Math.max(max,logits[row+v]);
        let sum=0;for(let v=0;v<emissions.vocabSize;v++) sum+=Math.exp(logits[row+v]-max);
        best=Math.max(best,Math.exp(logits[row+tokens[k].id]-max)/sum);
      }
      support+=best >= (anchored ? 0.1 : 0.35) ? 1 : 0;
    }
    support/=tokens.length;
    if(support < (anchored ? 0.5 : a.count===2 ? 1 : 0.75)) continue;
    const start=offset+(f0+alignment.tokenFrames[0].start)*.02;
    const end=offset+(f0+alignment.tokenFrames.at(-1).end+1)*.02;
    if(end<=start || (a.count>1 && end-start<.05) || end-start>Math.max(1.8,a.count*.24)) continue;
    if(!anchored && a.count===2 && end-start>.6) continue;
    accepted.push({...w,start,end,coverage:a.coverage,support,context_recovery:!anchored});
  }
  accepted.push(...recoverBoundedPhrases(words,emissions,offset,accepted,anchors));
  const sequence=orderedWords(accepted).words;
  const supported=sequence.filter((w,i)=>{
    const prev=sequence[i-1], next=sequence[i+1];
    const left=prev?.word_id===w.word_id-1 && w.start-prev.end<=1.2;
    const right=next?.word_id===w.word_id+1 && next.start-w.end<=1.2;
    if(isConjunction(w.text) && !(left && right)) return false;
    const independent=w.coverage>=.5 && w.support>=.75 && wordTranscript(w.text).tokens.filter(t=>t.token!=='|').length>=3;
    if((w.coverage<.8 || w.support<.8) && !(left || right || independent)) return false;
    // Context is real audio too. A word before the core may only become
    // recoverable with the following window's context. Keep complete interior
    // observations; the final weighted chain resolves duplicate windows.
    const recordingEnd=offset+emissions.frameCount*.02;
    return w.start>=offset+(offset>0 ? .08 : 0) && w.end<=recordingEnd-(recordingEnd>coreEnd+.1 ? .08 : 0);
  });
  return {words:supported, recognized:heard.map(h=>h.char).join('')};
}

/** Maximum-support nonoverlapping chain in Book order. One stray observation
 * must not discard a whole run of subsequent, better supported words. */
export function orderedWords(observations) {
  const words=[...observations].sort((a,b)=>a.word_id-b.word_id || a.start-b.start);
  const ends=[...new Set(words.map(w=>w.end))].sort((a,b)=>a-b);
  const tree=new Int32Array(ends.length+1).fill(-1), score=new Float64Array(words.length), previous=new Int32Array(words.length).fill(-1);
  const upper=time=>{let lo=0,hi=ends.length;while(lo<hi){const mid=(lo+hi)>>1;if(ends[mid]<=time)lo=mid+1;else hi=mid;}return lo;};
  const query=position=>{let best=-1;for(let k=position;k>0;k-=k&-k){const i=tree[k];if(i>=0 && (best<0 || score[i]>score[best]))best=i;}return best;};
  const update=(position,i)=>{for(let k=position;k<tree.length;k+=k&-k)if(tree[k]<0 || score[i]>score[tree[k]])tree[k]=i;};
  for(let a=0;a<words.length;) {
    let b=a+1;while(b<words.length && words[b].word_id===words[a].word_id)b++;
    const distances=words.slice(a,b).map(w=>Number.isFinite(w.coarse_start) && Number.isFinite(w.coarse_end)
      ? Math.max(0,w.coarse_start-w.end,w.start-w.coarse_end) : 0);
    const preferNear=b-a>1 && Math.min(...distances)<1;
    for(let i=a;i<b;i++) {
      previous[i]=query(upper(words[i].start+1e-6));
      // Approximate sentence timing is a soft preference between duplicate
      // observations, never a veto on delayed/early acoustic word evidence.
      const evidence=(words[i].coverage+words[i].support)*(preferNear ? Math.exp(-distances[i-a]/4) : 1);
      score[i]=(previous[i]>=0?score[previous[i]]:0)+evidence;
    }
    // Batch alternatives for one word: they may not follow each other.
    for(let i=a;i<b;i++) update(upper(words[i].end),i);
    a=b;
  }
  const selected=[];let i=query(ends.length);
  while(i>=0){selected.push(words[i]);i=previous[i];}
  selected.reverse();
  const ids=new Set(selected.map(w=>w.word_id));
  return {words:selected,rejected:[...new Set(words.filter(w=>!ids.has(w.word_id)).map(w=>w.word_id))]};
}
