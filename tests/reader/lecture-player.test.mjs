import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {installLecturePlayer} from '../../ui/mobile/lecture-player.mjs';

const INDEX = {
  format: 1,
  book: 'tarhe-kolli',
  sessions: [
    {session: 1, audio: 'session_01.mp3', duration: 2484.2, lecture_start: 20.0, lecture_end: 2472.22, book_pages: [41, 84]},
    {session: 2, audio: 'session_02.mp3', duration: 2600.5, lecture_start: 15.5, lecture_end: 2590.0, book_pages: [85, 120]},
  ],
};

const tick = () => new Promise((resolve) => setImmediate(resolve));

function fixture({index = INDEX, failIndex = false} = {}) {
  const dom = new JSDOM('<!doctype html><html lang="fa" dir="rtl"><body></body></html>');
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (failIndex) return {ok: false, status: 404, json: async () => ({})};
    return {ok: true, status: 200, json: async () => index};
  };
  return {dom, calls, fetchImpl};
}

test('the player lists the sessions and points the audio at the served route', async () => {
  const f = fixture();
  const bar = await installLecturePlayer({root: f.dom.window.document, fetchImpl: f.fetchImpl});
  const options = bar.querySelectorAll('select[aria-label="انتخاب جلسه"] option');
  assert.equal(options.length, 2);
  assert.equal(options[0].value, 'session_01.mp3');
  assert.match(options[0].textContent, /جلسۀ ۱/);
  const audio = bar.parentElement.querySelector('audio');
  assert.equal(audio.getAttribute('src'), '/books/tarhe-kolli/lectures/session_01.mp3');
  assert.equal(audio.preload, 'metadata');
  // The «بدون مقدمه» boundary stays off until the operator asks.
  assert.equal(audio.currentTime, 0);
  f.dom.window.close();
});

test('play, speed, and skip-intro drive the audio element without touching files', async () => {
  const f = fixture();
  const doc = f.dom.window.document;
  const bar = await installLecturePlayer({root: doc, fetchImpl: f.fetchImpl});
  const audio = bar.parentElement.querySelector('audio');
  let played = 0;
  audio.play = async () => { played += 1; };
  const play = bar.querySelector('button[aria-label="پخش"]');
  play.click();
  await tick();
  assert.equal(played, 1);
  const speed = bar.querySelector('select[aria-label="سرعت پخش"]');
  speed.value = '1.5';
  speed.dispatchEvent(new f.dom.window.Event('change'));
  assert.equal(audio.playbackRate, 1.5);
  // «بدون مقدمه»: the jump rides the index's measured lecture_start.
  const skip = bar.querySelector('button[aria-label="پرش از مقدمه"]');
  skip.click();
  assert.equal(skip.getAttribute('data-lp-skip'), 'on');
  assert.equal(audio.currentTime, 20.0);
  // Switching sessions keeps the skip applied from the new boundary.
  const picker = bar.querySelector('select[aria-label="انتخاب جلسه"]');
  picker.value = 'session_02.mp3';
  picker.dispatchEvent(new f.dom.window.Event('change'));
  assert.equal(audio.getAttribute('src'), '/books/tarhe-kolli/lectures/session_02.mp3');
  assert.equal(audio.currentTime, 15.5);
  f.dom.window.close();
});

test('time updates and the next session chain off the index', async () => {
  const f = fixture();
  const doc = f.dom.window.document;
  const bar = await installLecturePlayer({root: doc, fetchImpl: f.fetchImpl});
  const audio = bar.parentElement.querySelector('audio');
  let played = 0;
  audio.play = async () => { played += 1; };
  const play = bar.querySelector('button[aria-label="پخش"]');
  play.click();
  await tick();
  audio.dispatchEvent(new f.dom.window.Event('timeupdate'));
  const time = bar.querySelector('.lp-time').textContent;
  assert.match(time, /۴۱:۲۴/); // 2484.2s as a clock, Persian digits
  audio.dispatchEvent(new f.dom.window.Event('ended'));
  await tick();
  assert.equal(played, 2); // the next session auto-loads and plays
  const picker = bar.querySelector('select[aria-label="انتخاب جلسه"]');
  assert.equal(picker.value, 'session_02.mp3');
  f.dom.window.close();
});

test('a missing package degrades to one honest line', async () => {
  const f = fixture({failIndex: true});
  const bar = await installLecturePlayer({root: f.dom.window.document, fetchImpl: f.fetchImpl});
  assert.match(bar.querySelector('.lp-status').textContent, /در دسترس نیست/);
  assert.equal(bar.querySelectorAll('audio').length, 0);
  f.dom.window.close();
});
