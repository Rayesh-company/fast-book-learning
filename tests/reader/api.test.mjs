import test from 'node:test';
import assert from 'node:assert/strict';
import {createApi,blocksText} from '../../ui/mobile/api.mjs';

test('existing quoted-answer receives its owning conversation and exact selected context',async()=>{
 const calls=[];
 const api=createApi({fetchImpl:async(path,options)=>{calls.push({path,...options,body:JSON.parse(options.body)});return{ok:true,json:async()=>({text:'برداشت متن اصلی'})};}});
 const result=await api.ask({question:'معنایش چیست؟',book:'tarhe-kolli',selection:{text:'متن دقیق'},sessionId:42});
 assert.equal(calls[0].path,'/agent/chat');assert.equal(calls[0].body.selection.text,'متن دقیق');assert.equal(calls[0].credentials,'same-origin');assert.equal(result.text,'برداشت متن اصلی');
});

test('quota rejection becomes a visible assistant restriction',async()=>{
 const api=createApi({fetchImpl:async()=>({ok:false,status:429,json:async()=>({detail:'پرسش‌های این بازه تمام شد'})})});const result=await api.ask({question:'پرسش',book:'tarhe-kolli'});assert.equal(result.limited,true);assert.match(result.text,/تمام شد/);
});

test('deferred SMS and payment never invoke nonexistent providers',async()=>{
 let calls=0;const api=createApi({fetchImpl:async()=>{calls++;}});await assert.rejects(api.requestOtp('09123456789'),/هنوز/);await assert.rejects(api.purchase(),/هنوز/);assert.equal(calls,0);
});
