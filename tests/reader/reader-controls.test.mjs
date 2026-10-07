import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {pdfParagraphs} from '../../ui/book-reader/paragraphs.mjs';
import {installContinuousAudio} from '../../ui/book-reader/continuous-audio.mjs';
import {installReaderChrome} from '../../ui/mobile/reader-interactions.mjs';
const tick=()=>new Promise(r=>setImmediate(r));

test('paragraph geometry splits indented lines without modifying canonical offsets',()=>{
 const text='one line\nwrapped line\nnext paragraph';
 const index={text,items:[{textItemIndex:0,start:0,end:8},{textItemIndex:1,start:9,end:21},{textItemIndex:2,start:22,end:36}]};
 const items=[{str:'one line',height:12,width:80,transform:[1,0,0,1,10,100]},{str:'wrapped line',height:12,width:80,transform:[1,0,0,1,10,80]},{str:'next paragraph',height:12,width:80,transform:[1,0,0,1,24,60]}];
 const paragraphs=pdfParagraphs(index,items,7);assert.equal(paragraphs.length,2);assert.equal(paragraphs[0].text,'one line\nwrapped line');assert.equal(paragraphs[1].start,22);for(const p of paragraphs)assert.equal(p.text,text.slice(p.start,p.end));
});
function audioFixture(fetchImpl){
 const dom=new JSDOM('<main><button data-audio-play></button><button data-audio-previous></button><button data-audio-next></button><p data-reader-audio-status></p></main>');const element=dom.window.document.querySelector('main');
 let page=1,players=[],pages=[],calls=[];
 const data=n=>({index:{text:'alpha beta'},paragraphs:[{page:n,start:0,end:5,text:'alpha'},{page:n,start:6,end:10,text:'beta'}]});
 const audio=installContinuousAudio({element,getContext:()=>({doc:'book',page,numPages:2}),getPageData:async n=>data(n),showPage:async n=>{page=n;pages.push(n);},
  fetchImpl:async(url,options)=>{calls.push(JSON.parse(options.body));if(fetchImpl)return fetchImpl(url,options);return {ok:true,json:async()=>({audioBase64:btoa('bytes'),mimeType:'audio/wav',cues:[],alignment:{status:'unavailable'}})};},
  reader:{loadAudio(input){const player={state:'ready',dispose(){this.disposed=true;},pause(){this.state='paused';},async play(){this.state='playing';input.onState('playing');},end(){this.state='ended';input.onState('ended');}};players.push(player);return player;}}});
 return {dom,element,audio,players,pages,calls,close(){audio.dispose();dom.window.close();}};
}
test('continuous audio prepares only one paragraph ahead and advances into the next page',async()=>{
 const f=audioFixture();f.element.querySelector('[data-audio-play]').click();for(let i=0;i<6;i++)await tick();assert.equal(f.calls.length,2);assert.deepEqual(f.calls.map(p=>[p.page,p.start]),[[1,0],[1,6]]);
 f.players.at(-1).end();for(let i=0;i<6;i++)await tick();assert.equal(f.calls.length,3);assert.equal(f.audio.cursor.paragraph,1);
 f.players.at(-1).end();for(let i=0;i<6;i++)await tick();assert.equal(f.audio.cursor.page,2);assert.deepEqual(f.pages,[1,1,2]);assert.equal(f.calls.length,4);f.close();
});
test('manual reset prevents late generation from autoplaying or loading the old page',async()=>{
 let resolve;const f=audioFixture(()=>new Promise(r=>resolve=r));f.element.querySelector('[data-audio-play]').click();await tick();f.audio.reset();resolve({ok:true,json:async()=>({audioBase64:btoa('bytes'),cues:[]})});await tick();await tick();assert.equal(f.players.length,0);assert.equal(f.pages.length,0);assert.equal(f.audio.cursor,null);f.close();
});
test('paragraph next/previous preserves pause and generation errors expose a retry state',async()=>{
 const f=audioFixture();f.element.querySelector('[data-audio-next]').click();for(let i=0;i<6;i++)await tick();assert.equal(f.audio.cursor.paragraph,1);assert.equal(f.players.at(-1).state,'ready');
 f.element.querySelector('[data-audio-previous]').click();for(let i=0;i<6;i++)await tick();assert.equal(f.audio.cursor.paragraph,0);assert.equal(f.players.at(-1).state,'ready');f.close();
 const failed=audioFixture(async()=>({ok:false,json:async()=>({detail:'تولید ناموفق'})}));failed.element.querySelector('[data-audio-play]').click();for(let i=0;i<4;i++)await tick();assert.equal(failed.element.querySelector('[data-reader-audio-status]').textContent,'تولید ناموفق');assert.equal(failed.element.querySelector('[data-audio-play]').dataset.state,'paused');failed.close();
});
test('reading controls fade, reveal on touch, and stay visible while the wheel is open',async()=>{
 const dom=new JSDOM('<main><div class="reader-page"></div><div class="reader-chrome"><button><span data-page-number></span></button></div><input name="page"><div data-page-wheel></div></main>');const phone=dom.window.document.querySelector('main');
 const chrome=installReaderChrome({phone,getPage:()=>2,getCount:()=>4,goToPage:async()=>{},idleMs:15});await new Promise(r=>setTimeout(r,25));assert.equal(phone.querySelector('.reader-chrome').dataset.hidden,'true');
 phone.querySelector('.reader-page').dispatchEvent(new dom.window.Event('pointerdown'));assert.equal(phone.querySelector('.reader-chrome').dataset.hidden,'false');chrome.setOpen(true);await new Promise(r=>setTimeout(r,25));assert.equal(phone.querySelector('.reader-chrome').dataset.hidden,'false');assert.equal(phone.querySelector('[data-page-wheel]').children.length,4);chrome.setOpen(false);await new Promise(r=>setTimeout(r,25));assert.equal(phone.querySelector('.reader-chrome').dataset.hidden,'true');chrome.dispose();dom.window.close();
});
