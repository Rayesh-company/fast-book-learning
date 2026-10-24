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

test('the SMS login speaks the wired endpoints and stores the verified token',async()=>{
 const calls=[];let stored=null;
 // localStorage is a getter/setter accessor on Node ≥26 — override by
 // descriptor and restore it, so the token store is real in this test.
 const prev=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
 Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:()=>stored,setItem:(k,v)=>{stored=v;},removeItem:()=>{stored=null;}}});
 const api=createApi({fetchImpl:async(path,options)=>{calls.push({path,body:JSON.parse(options.body)});return{ok:true,json:async()=>path==='/auth/otp/request'?{waitlist:false}:{email:'x@y',role:'operator',token:'tok-1'}};}});
 // requestOtp forks by the server's waitlist flag, no token stored.
 assert.deepEqual(await api.requestOtp('09123456789'),{waitlist:false});
 assert.equal(calls[0].path,'/auth/otp/request');assert.equal(calls[0].body.phone,'09123456789');assert.equal(stored,null);
 // verifyOtp answers the email login's own body and stores its token.
 assert.deepEqual(await api.verifyOtp('09123456789','042021'),{email:'x@y',role:'operator',token:'tok-1'});
 assert.equal(calls[1].path,'/auth/otp/verify');assert.equal(calls[1].body.code,'042021');assert.equal(stored,'tok-1');
 // The waitlist joins through its own door.
 await api.joinWaitlist('09123456789');assert.equal(calls[2].path,'/waitlist');
 // Still-unwired providers keep failing honestly without a call.
 await assert.rejects(api.purchase(),/هنوز/);assert.equal(calls.length,3);
 prev?Object.defineProperty(globalThis,'localStorage',prev):delete globalThis.localStorage;
});
