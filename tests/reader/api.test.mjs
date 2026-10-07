import test from 'node:test';
import assert from 'node:assert/strict';
import {createApi,blocksText} from '../../ui/mobile/api.mjs';

test('existing quoted-answer receives its owning conversation and exact selected context',async()=>{
 const calls=[];const blocks=[{type:'paragraph',parts:[{text:'برداشت'},{quote:'متن اصلی',source:0}]}];
 const api=createApi({fetchImpl:async(path,options)=>{calls.push({path,...options,body:JSON.parse(options.body)});return{ok:true,json:async()=>path==='/ask'?{chat_id:3,sources:[{reference:'document tarhe-kolli (page 100)',passage:'متن اصلی'}]}:{blocks}};}});
 const result=await api.ask({question:'معنایش چیست؟',book:'tarhe-kolli',selection:{text:'متن دقیق'},sessionId:42});
 assert.equal(calls[1].body.session_id,42);assert.match(calls[0].body.query,/متن دقیق/);assert.equal(calls[1].credentials,'same-origin');assert.equal(result.text,'برداشت متن اصلی');assert.equal(blocksText(blocks),result.text);
});

test('quota rejection becomes a visible assistant restriction',async()=>{
 const api=createApi({fetchImpl:async()=>({ok:false,status:429,json:async()=>({detail:'پرسش‌های این بازه تمام شد'})})});const result=await api.ask({question:'پرسش',book:'tarhe-kolli'});assert.equal(result.limited,true);assert.match(result.text,/تمام شد/);
});

test('deferred SMS and payment never invoke nonexistent providers',async()=>{
 let calls=0;const api=createApi({fetchImpl:async()=>{calls++;}});await assert.rejects(api.requestOtp('09123456789'),/هنوز/);await assert.rejects(api.purchase(),/هنوز/);assert.equal(calls,0);
});
