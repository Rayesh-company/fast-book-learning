import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {ALIGNMENT_VOCAB} from '../../ui/narration/aligner.mjs';
import {alignWords,alignWordCandidates,orderedWords} from '../../tools/lecture-word-alignment.mjs';
import {createLectureTrack,sentenceIndexAt,pageForTime,focusForTime} from '../../ui/book-reader/lecture-sync.mjs';

function recording(parts, duration=10) {
  const frameCount=duration*50,vocabSize=67;
  const logits=new Float32Array(frameCount*vocabSize).fill(-18);
  for(let t=0;t<frameCount;t++) logits[t*vocabSize]=8;
  for(const [text,start] of parts) {
    let frame=Math.round(start*50);
    for(const char of text) {
      const id=ALIGNMENT_VOCAB[char];
      for(let n=0;n<3;n++) {logits[(frame+n)*vocabSize]= -18; logits[(frame+n)*vocabSize+id]=12;}
      frame+=5;
    }
  }
  return {logits,frameCount,vocabSize};
}
const source=(texts)=>texts.map((text,word_id)=>({text,word_id,coarse_start:1,coarse_end:9}));

test('real session 3 replay retains the reported missing words at their acoustic times',()=>{
  const folder=new URL('../fixtures/lecture-ctc/',import.meta.url);
  const fixture=JSON.parse(readFileSync(new URL('session-03.json',folder),'utf8'));
  const observations=fixture.windows.flatMap(window=>{
    const bytes=gunzipSync(readFileSync(new URL(window.emissions,folder)));
    const logits=new Float32Array(bytes.buffer,bytes.byteOffset,bytes.byteLength/4);
    return alignWords(window.words,{logits,vocabSize:67,frameCount:window.frames},window.offset,window.core,window.core+12).words;
  });
  const result=orderedWords(observations).words;
  for(const expected of fixture.expected) {
    const word=result.find(w=>w.word_id===expected.word_id);
    assert.ok(word,`reported spoken word disappeared: ${expected.text}`);
    assert.ok(word.start>=expected.range[0] && word.end<=expected.range[1],`incorrect acoustic interval: ${expected.text}`);
  }
});

test('acoustic word times follow nonuniform speech, not letter length ratios',()=>{
  const r=alignWords(source(['سلام','کتاب']),recording([['سلام',1.2],['کتاب',7.3]]),0,0,10);
  assert.deepEqual(r.words.map(w=>[w.text,w.start,w.end]),[['سلام',1.2,1.56],['کتاب',7.3,7.66]]);
});
test('omitted Book words have no acoustic cue; commentary is allowed between matches',()=>{
  const r=alignWords(source(['سلام','ناموجود','کتاب']),recording([['سلام',1],['توضیح',3],['کتاب',7]]),0,0,10);
  assert.deepEqual(r.words.map(w=>w.text),['سلام','کتاب']);
  assert.equal(r.words[1].start,7);
});
test('a short unrelated utterance cannot be forced into an omitted Book word',()=>{
  const r=alignWords(source(['سلام','ناموجود','کتاب']),recording([['سلام',1],['توضیح',2],['کتاب',3]]),0,0,10);
  assert.deepEqual(r.words.map(w=>w.text),['سلام','کتاب']);
});
test('phrase recovery cannot manufacture multiple Book words out of a silent gap',()=>{
  const r=alignWords(source(['کتاب','سلام','به','جهان','مطلب']),recording([['کتاب',1],['مطلب',4]]),0,0,10);
  assert.deepEqual(r.words.map(w=>w.text),['کتاب','مطلب']);
});
test('diffuse low-confidence emissions do not authorize a guessed phrase',()=>{
  const emissions=recording([['کتاب',1],['مطلب',4]]);
  emissions.logits.fill(0,100*67,180*67);
  const r=alignWords(source(['کتاب','سلام','جهان','مطلب']),emissions,0,0,10);
  assert.deepEqual(r.words.map(w=>w.text),['کتاب','مطلب']);
});
test('strong local CTC evidence can recover a word missed by greedy decoding',()=>{
  const emissions=recording([['کتاب',1],['سلام',2],['مطلب',3]]);
  for(const [i,alternative] of ['ظ','ق','ح'].entries()) {
    const frame=100+i*5;
    for(let n=0;n<3;n++) {
      emissions.logits[(frame+n)*67+ALIGNMENT_VOCAB['سلام'[i]]]=8;
      emissions.logits[(frame+n)*67+ALIGNMENT_VOCAB[alternative]]=8.2;
    }
  }
  const r=alignWords(source(['کتاب','سلام','مطلب']),emissions,0,0,10);
  const word=r.words.find(w=>w.text==='سلام');
  assert.ok(word?.context_recovery);assert.equal(word.start,2);assert.equal(word.end,2.36);
});
test('a short function word with strong acoustic evidence survives greedy misrecognition',()=>{
  const emissions=recording([['کتاب',1],['به',2],['سلام',3]]);
  for(const [i,alternative] of ['ظ','ق'].entries()) {
    for(let n=0;n<3;n++) {
      const frame=100+i*5+n;
      emissions.logits[frame*67+ALIGNMENT_VOCAB['به'[i]]]=8;
      emissions.logits[frame*67+ALIGNMENT_VOCAB[alternative]]=8.2;
    }
  }
  const r=alignWords(source(['کتاب','به','سلام']),emissions,0,0,10);
  const word=r.words.find(w=>w.text==='به');
  assert.ok(word,'the spoken short word must not disappear');
  assert.equal(word.start,2);assert.equal(word.end,2.16);
});
test('a written conjunction keeps its diacritic while receiving the same acoustic timing',()=>{
  const r=alignWords(source(['کتاب','وَ','سلام']),recording([['کتاب',1],['و',2],['سلام',3]]),0,0,10);
  assert.deepEqual(r.words.map(w=>w.text),['کتاب','وَ','سلام']);
  assert.equal(r.words[1].start,2);
});
test('short-word recovery still rejects missing speech and requires both neighbours',()=>{
  const absent=alignWords(source(['کتاب','به','سلام']),recording([['کتاب',1],['ظق',2],['سلام',3]]),0,0,10);
  assert.deepEqual(absent.words.map(w=>w.text),['کتاب','سلام']);
  const emissions=recording([['کتاب',1],['به',2]]);
  for(const [i,alternative] of ['ظ','ق'].entries()) for(let n=0;n<3;n++) {
    const frame=100+i*5+n;
    emissions.logits[frame*67+ALIGNMENT_VOCAB['به'[i]]]=8;
    emissions.logits[frame*67+ALIGNMENT_VOCAB[alternative]]=8.2;
  }
  assert.deepEqual(alignWords(source(['کتاب','به']),emissions,0,0,10).words.map(w=>w.text),['کتاب']);
  const conjunction=alignWords(source(['وَ','سلام']),recording([['و',2],['سلام',3]]),0,0,10);
  assert.deepEqual(conjunction.words.map(w=>w.text),['سلام']);
});
test('word alignment retains its absolute audio offset',()=>{
  const words=source(['سلام']).map(w=>({...w,coarse_start:100,coarse_end:110}));
  const r=alignWords(words,recording([['سلام',2]]),100,100,110);
  assert.equal(r.words[0].start,102);
});
test('a sentence clipped by an inference window can retain its heard prefix',()=>{
  const r=alignWords(source(['سلام','کتاب','بلند','یادگیری','مطلب','حقیقت']),recording([['سلام',1],['کتاب',2]]),0,0,10);
  assert.deepEqual(r.words.map(w=>w.text),['سلام','کتاب']);
});
test('approximate sentence times do not veto clearly observed delayed speech',()=>{
  const words=source(['سلام','کتاب']).map(w=>({...w,coarse_start:0,coarse_end:1}));
  const r=alignWords(words,recording([['سلام',7],['کتاب',8]]),0,0,10);
  assert.deepEqual(r.words.map(w=>[w.text,w.start]),[['سلام',7],['کتاب',8]]);
});
test('a context window retains complete words just before its core',()=>{
  const words=source(['سلام','کتاب']).map(w=>({...w,coarse_start:10,coarse_end:20}));
  const r=alignWords(words,recording([['سلام',1],['کتاب',3]]),10,12,20);
  assert.equal(r.words[0].start,11);
  assert.equal(orderedWords([...r.words,...r.words]).words.length,2);
});
test('a strongly supported isolated word is retained across the speaker\'s pauses',()=>{
  const emissions=recording([['سلام',4]]);
  for(const [i,alternative] of ['ظ','ق'].entries()) for(let n=0;n<3;n++) {
    const frame=200+i*5+n;
    emissions.logits[frame*67+ALIGNMENT_VOCAB['سلام'[i]]]=8;
    emissions.logits[frame*67+ALIGNMENT_VOCAB[alternative]]=8.2;
  }
  const r=alignWords(source(['سلام']),emissions,0,0,10);
  assert.equal(r.words[0]?.start,4);
});
test('Arabic and Persian spelling variants share acoustic support without changing Book text',()=>{
  const r=alignWords(source(['کیکی','نکتۀ']),recording([['كيكي',1],['نکته',3]]),0,0,10);
  assert.deepEqual(r.words.map(w=>w.text),['کیکی','نکتۀ']);
  assert.equal(r.words[0].start,1);assert.equal(r.words[0].support,1);
  assert.equal(r.words[1].end,3.36);
});
test('verified gaps clear the previous highlight instead of holding an unrelated passage',()=>{
  const track=createLectureTrack({word_alignment:{method:'local_ctc'},cues:[{id:0,start:1,end:2},{id:1,start:5,end:6}]});
  assert.deepEqual(sentenceIndexAt(track,3),{index:-1,active:false});
  assert.deepEqual(sentenceIndexAt(track,5.2),{index:1,active:true});
  assert.deepEqual(sentenceIndexAt(track,1.2),{index:0,active:true});
});
test('page changes use the observed word time even when PDF rectangle counts differ',()=>{
  const s={start:0,end:20,page_timing:'word_alignment',boxes:[[1,0,0,10,10],[2,0,0,10,10]],
    words:[{start:1,end:17,boxes:[[1,0,0,10,10]]},{start:18,end:19,boxes:[[2,0,0,10,10]]}]};
  assert.equal(pageForTime(s,17),1);assert.equal(pageForTime(s,18),2);
});
test('the entire phrase stays stable through words and small gaps until its pause',()=>{
  const phrase={id:2,start:.8,end:3,text:'سلام کتاب',boxes:[[1,10,0,20,10],[1,0,0,10,10]],
    words:[{text:'سلام',start:1,end:2,boxes:[[1,10,0,20,10]]},{text:'کتاب',start:2.1,end:2.8,boxes:[[1,0,0,10,10]]}]};
  for(const time of [1.5,2.05,2.5]) {
    const focus=focusForTime(phrase,time);
    assert.equal(focus.sentence,phrase);assert.equal(focus.active,true);
  }
  assert.equal(focusForTime(phrase,.9).active,false);
  assert.equal(focusForTime(phrase,2.9).active,false);
  assert.equal(focusForTime(phrase,1.5,false).active,false);
});
test('one conflicting late observation cannot hide better supported words that follow it',()=>{
  const observation=(word_id,start,end,coverage=1)=>({word_id,start,end,coverage,support:coverage});
  const result=orderedWords([observation(0,9,10,.5),observation(1,2,3),observation(2,4,5)]);
  assert.deepEqual(result.words.map(w=>w.word_id),[1,2]);assert.deepEqual(result.rejected,[0]);
  // Alternate context windows for a word must neither duplicate it nor
  // discard the observation that fits the neighbouring acoustic words.
  const alternatives=orderedWords([observation(0,1,2,.8),observation(0,8,9),observation(1,3,4)]);
  assert.deepEqual(alternatives.words.map(w=>[w.word_id,w.start]),[[0,1],[1,3]]);
  const intro=orderedWords([
    {...observation(0,10,10.2),coarse_start:22,coarse_end:32},
    {...observation(0,23,23.2,.5),coarse_start:22,coarse_end:32},
    {...observation(1,24,24.5),coarse_start:22,coarse_end:32},
  ]);
  assert.equal(intro.words[0].start,23);
});

test('adding collapsed-timing sentences cannot hide existing session 4 acoustic anchors',async()=>{
  const folder=new URL('../fixtures/lecture-ctc/',import.meta.url);
  const fixture=JSON.parse(readFileSync(new URL('session-04-candidates.json',folder),'utf8'));
  const observations=fixture.windows.flatMap(window=>{
    const bytes=gunzipSync(readFileSync(new URL(window.emissions,folder)));
    const logits=new Float32Array(bytes.buffer,bytes.byteOffset,bytes.byteLength/4);
    return alignWordCandidates(window.words,{logits,vocabSize:67,frameCount:window.frames},window.offset,window.core,window.core+12).words;
  });
  const sentence=orderedWords(observations).words.filter(w=>w.sentence_id===11);
  assert.deepEqual(sentence.map(w=>[w.text,w.start,w.end]),[
    ['این',174.16,174.3],['ایمان',174.36,174.74],['در',174.98,175.08],['همان',175.18,175.48],
  ]);
});

test('collapsed coarse timing is an alternative context, not a veto or a guessed timestamp',()=>{
  const words=source(['کتاب','سلام','مطلب']).map((w,i)=>({...w,coarse_timing_plausible:i!==1}));
  const heard=orderedWords(alignWordCandidates(words,recording([['کتاب',1],['سلام',2],['مطلب',4]]),0,0,10).words).words;
  assert.deepEqual(heard.map(w=>w.text),['کتاب','سلام','مطلب']);
  assert.equal(heard[1].start,2);
  const omitted=orderedWords(alignWordCandidates(words,recording([['کتاب',1],['مطلب',4]]),0,0,10).words).words;
  assert.deepEqual(omitted.map(w=>w.text),['کتاب','مطلب']);
});

test('a noisy sentence prefix is recovered even with other sentences in the search window',()=>{
  const words=source(['ناموجود','سلام','دنیا','مطلب','ناخوانده']).map((w,i)=>({...w,sentence_id:i===0 ? 0 : i===4 ? 2 : 1}));
  const emissions=recording([['سلام',2],['دنیا',2.7],['مطلب',4]]);
  for(const [text,start] of [['سلام',2],['دنیا',2.7]]) for(let i=0;i<text.length;i++) {
    for(let n=0;n<3;n++) {
      const row=(Math.round(start*50)+i*5+n)*67;
      emissions.logits[row+ALIGNMENT_VOCAB[text[i]]]=8;
      emissions.logits[row+ALIGNMENT_VOCAB['ظ']]=8.2;
    }
  }
  const result=alignWords(words,emissions,0,0,10).words;
  assert.deepEqual(result.map(w=>w.text),['سلام','دنیا','مطلب']);
  assert.equal(result[0].start,2);
});

test('real session 1 prefix starts the sentence before the old late anchor',()=>{
  const folder=new URL('../fixtures/lecture-ctc/',import.meta.url);
  const fixture=JSON.parse(readFileSync(new URL('session-01-prefix.json',folder),'utf8'));
  const observations=fixture.windows.flatMap(window=>{
    const bytes=gunzipSync(readFileSync(new URL(window.emissions,folder)));
    const logits=new Float32Array(bytes.buffer,bytes.byteOffset,bytes.byteLength/4);
    return alignWordCandidates(window.words,{logits,vocabSize:67,frameCount:window.frames},window.offset,window.core,window.core+12).words;
  });
  const words=orderedWords(observations).words.filter(w=>w.sentence_id===58);
  assert.equal(words[0].text,'اگر');
  assert.equal(words[0].start,494.6);
  assert.ok(words.some(w=>w.text==='گناهکاریم،' && w.start===494.96));
  const focus={id:58,text:'ما می‌گوییم که اگر گناهکاریم، اگر نافرمانی خدا کردیم،',boxes:words.flatMap(w=>w.boxes)};
  const track=createLectureTrack({word_alignment:{},sentence_focus:[focus],cues:words.map((w,id)=>({
    id,sentence_id:58,start:w.start,end:w.end,words:[w],boxes:w.boxes,page_timing:'word_alignment',
  }))});
  const state=sentenceIndexAt(track,495);
  assert.ok(state.active);
  assert.equal(focusForTime(track.sentences[state.index],495,state.active).sentence.text,focus.text);
});

test('open-edge recovery does not invent a prefix or suffix during silence',()=>{
  const words=source(['ناموجود','سلام','مطلب','دنیا','ناخوانده']).map((w,i)=>({...w,sentence_id:i===0 ? 0 : i===4 ? 2 : 1}));
  assert.deepEqual(alignWords(words,recording([['مطلب',4]]),0,0,10).words.map(w=>w.text),['مطلب']);
});
