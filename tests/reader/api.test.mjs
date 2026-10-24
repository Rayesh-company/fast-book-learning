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

test('the SMS login speaks the wired endpoints and stores the verified token',async()=>{
 const calls=[];let stored=null;
 // localStorage is a getter/setter accessor on Node ≥26 — override by
 // descriptor and restore it, so the token store is real in this test.
 const prev=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
 Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:()=>stored,setItem:(k,v)=>{stored=v;},removeItem:()=>{stored=null;}}});
 const api=createApi({fetchImpl:async(path,options)=>{calls.push({path,body:JSON.parse(options.body)});return{ok:true,json:async()=>path==='/auth/otp/request'?{}:{email:'x@y',role:'operator',token:'tok-1'}};}});
 // requestOtp sends and stores nothing; only verify carries a token.
 assert.deepEqual(await api.requestOtp('09123456789'),{});
 assert.equal(calls[0].path,'/auth/otp/request');assert.equal(calls[0].body.phone,'09123456789');assert.equal(stored,null);
 // verifyOtp answers the email login's own body and stores its token.
 assert.deepEqual(await api.verifyOtp('09123456789','042021'),{email:'x@y',role:'operator',token:'tok-1'});
 assert.equal(calls[1].path,'/auth/otp/verify');assert.equal(calls[1].body.code,'042021');assert.equal(stored,'tok-1');
 // Still-unwired providers keep failing honestly without a call.
 await assert.rejects(api.purchase(),/هنوز/);assert.equal(calls.length,2);
 prev?Object.defineProperty(globalThis,'localStorage',prev):delete globalThis.localStorage;
});
