import test from 'node:test';
import assert from 'node:assert/strict';
import {createLectureTrack, sentenceIndexAt, pageForTime, sentenceAtPoint, focusForTime} from '../../ui/book-reader/lecture-sync.mjs';

test('sentence intervals span internal gaps but never join separate runs of the same source sentence',()=>{
  const cue=(id,sentence_id,start,end)=>({id,sentence_id,start,end,words:[{start,end}]});
  const input={word_alignment:{},sentence_focus:[{id:7,text:'اول'},{id:8,text:'دوم'}],
    cues:[cue(0,7,2,3),cue(1,7,6,7),cue(2,8,8,9),cue(3,7,12,13)]};
  const original=JSON.stringify(input),track=createLectureTrack(input);
  assert.equal(track.sentences.length,3);
  for(const t of [2,3,4,5.9,6.9]) {
    const state=sentenceIndexAt(track,t);
    assert.deepEqual(state,{index:0,active:true});
    assert.equal(focusForTime(track.sentences[0],t,state.active).active,true);
  }
  assert.deepEqual(sentenceIndexAt(track,7),{index:-1,active:false});
  assert.deepEqual(sentenceIndexAt(track,8),{index:1,active:true});
  assert.deepEqual(sentenceIndexAt(track,10),{index:-1,active:false});
  assert.deepEqual(sentenceIndexAt(track,12),{index:2,active:true});
  assert.equal(JSON.stringify(input),original); // source cues and word times remain untouched
});

test('refined phrases change at the pause checkpoint and remain quiet until speech resumes', () => {
  const session = {sentences: [{id: 99, start: 0, end: 10}], cues: [
    {id: 0, start: 0, end: 4.7, speech_start: 0, speech_end: 4.5, boxes: [[1, 50, 10, 100, 20]]},
    {id: 1, start: 4.7, end: 10, speech_start: 4.9, speech_end: 10, boxes: [[1, 0, 10, 40, 20]]},
  ]};
  const track = createLectureTrack(session);
  assert.equal(track.sentences.length, 2);
  assert.deepEqual(sentenceIndexAt(track, 4.49), {index: 0, active: true});
  assert.deepEqual(sentenceIndexAt(track, 4.5), {index: 0, active: false});
  assert.deepEqual(sentenceIndexAt(track, 4.7), {index: 1, active: false});
  assert.deepEqual(sentenceIndexAt(track, 4.9), {index: 1, active: true});
  assert.deepEqual(sentenceIndexAt(track, 10), {index: 1, active: false});
  // Seeking backwards uses media time, with no forward-only checkpoint state.
  assert.deepEqual(sentenceIndexAt(track, 1), {index: 0, active: true});
  assert.equal(sentenceAtPoint(track, 1, 20, 15).id, 1);
});

test('only a valid bounded measured onset can precede the first accepted word',()=>{
  const make=onset=>createLectureTrack({word_alignment:{},sentence_focus:[{id:7,text:'جمله'}],cues:[
    {id:0,sentence_id:7,start:5,end:6,words:[{start:5,end:6}],timing:{sentence_onset:onset}},
  ]});
  const valid={start:4.4,pause:[4.1,4.4]};
  const track=make(valid),state=sentenceIndexAt(track,4.41);
  assert.deepEqual(state,{index:0,active:true});
  assert.equal(focusForTime(track.sentences[0],4.41,state.active).active,true);
  assert.deepEqual(sentenceIndexAt(track,4.39),{index:-1,active:false});
  for(const onset of [{start:2,pause:[1,2]},{start:4,pause:[4.1,4.4]},{start:5.5,pause:[5.2,5.5]},{start:4,pause:[4,3]}]) {
    assert.deepEqual(sentenceIndexAt(make(onset),4.41),{index:-1,active:false});
  }
});

test('a page break never uses the number of rectangles as an acoustic timestamp for refined cues', () => {
  const cue = {start: 0, end: 10, page: 1, page_timing: 'checkpoint', boxes: [
    [1, 0, 100, 50, 120], [2, 0, 10, 50, 20],
  ]};
  assert.equal(pageForTime(cue, 9.9), 1);
  assert.equal(pageForTime({...cue, page_timing: undefined}, 9.9), 2);
});

test('legacy sentence timing and half-open intervals still work, zero length cues cannot hide speech', () => {
  const track = createLectureTrack({sentences: [
    {id: 0, start: 1, end: 5}, {id: 1, start: 5, end: 5}, {id: 2, start: 7, end: 10},
  ]});
  assert.deepEqual(sentenceIndexAt(track, 0), {index: -1, active: false});
  assert.deepEqual(sentenceIndexAt(track, 3), {index: 0, active: true});
  assert.deepEqual(sentenceIndexAt(track, 5), {index: 0, active: false});
  assert.deepEqual(sentenceIndexAt(track, 7), {index: 1, active: true});
});
