import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createMobileApp} from '../../ui/mobile/app-ui.mjs';
import {createDemoApi} from '../../ui/mobile/demo-api.mjs';

function fixture({userAgent,standalone}={}){
 const dom=new JSDOM(`<!doctype html><div id="app"></div>`,{url:'https://fahva.test/'});
 if(userAgent)Object.defineProperty(dom.window.navigator,'userAgent',{value:userAgent,configurable:true});
 if(standalone!==undefined){
  dom.window.matchMedia=query=>({matches:query==='(display-mode: standalone)'?standalone:false,addEventListener(){},removeEventListener(){}});
 }
 const root=dom.window.document.querySelector('#app');
 const api=createDemoApi({storage:dom.window.localStorage,delay:0});
 const app=createMobileApp({root,api});
 const click=action=>{
  const el=root.querySelector(`[data-action="${action}"]`);
  assert.ok(el,`element [data-action="${action}"] should exist`);
  el.click();
 };
 const dispatchInstall=userChoice=>{
  let prompted=0;
  const event=new dom.window.Event('beforeinstallprompt',{cancelable:true});
  event.prompt=()=>{prompted++;};
  event.userChoice=userChoice;
  dom.window.dispatchEvent(event);
  return{get prompted(){return prompted;},get defaultPrevented(){return event.defaultPrevented;}};
 };
 return {dom,root,app,click,dispatchInstall,close(){app.dispose();dom.window.close();}};
}

test('install row appears on beforeinstallprompt and the popup drives the native prompt',async()=>{
 const f=fixture();
 await f.app.ready;

 f.click('menu');
 assert.equal(f.root.querySelector('[data-action="install-app"]'),null,'before any install signal the row must not exist');
 f.click('close-menu');

 const probe=f.dispatchInstall(Promise.resolve({outcome:'accepted'}));
 assert.equal(probe.defaultPrevented,true,'the app must suppress the browser\u2019s own banner — the drawer row is the door');

 f.click('menu');
 const row=f.root.querySelector('[data-action="install-app"]');
 assert.ok(row,'the drawer must carry the install row once the prompt exists');
 row.click();
 const sheet=f.root.querySelector('.app-sheet');
 assert.ok(sheet,'the install popup opens');
 assert.match(sheet.getAttribute('aria-label')||'',/نصب برنامه/);
 assert.match(sheet.textContent,/بدون نوار آدرس/);
 const confirm=sheet.querySelector('[data-action="confirm-install"]');
 assert.ok(confirm,'the popup offers the native install');
 confirm.click();
 await f.app.settled();
 assert.equal(probe.prompted,1,'confirm-install must call the native prompt exactly once');
 assert.equal(f.root.querySelector('.app-sheet'),null,'an accepted install closes the popup');
 assert.equal(f.app.state.canInstall,false);
 // The accepted ride stays silent here on purpose: appinstalled owns the
 // celebration (its own test below), so one install never toasts twice.

 f.close();
});

test('an already-standalone app never shows the install row even when the prompt fires',async()=>{
 const f=fixture({standalone:true});
 await f.app.ready;
 f.dispatchInstall(Promise.resolve({outcome:'accepted'}));
 f.click('menu');
 assert.equal(f.root.querySelector('[data-action="install-app"]'),null,'standalone must never ask to install itself');
 f.close();
});

test('iOS shows the share-sheet instructions instead of a native prompt',async()=>{
 const f=fixture({userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'});
 await f.app.ready;
 assert.equal(f.app.state.installKind,'ios','iOS is read straight off the agent, no event needed');

 f.click('menu');
 f.click('install-app');
 const sheet=f.root.querySelector('.app-sheet');
 assert.ok(sheet,'the install popup opens on iOS too');
 assert.match(sheet.textContent,/اشتراک‌گذاری/);
 assert.match(sheet.textContent,/Add to Home Screen/);
 assert.equal(sheet.querySelector('[data-action="confirm-install"]'),null,'iOS has no beforeinstallprompt to drive');
 f.close();
});

test('a dismissed prompt closes the popup with an honest toast and hides the row',async()=>{
 const f=fixture();
 await f.app.ready;
 f.dispatchInstall(Promise.resolve({outcome:'dismissed'}));

 f.click('menu');
 f.click('install-app');
 f.root.querySelector('[data-action="confirm-install"]').click();
 await f.app.settled();
 assert.match(f.root.querySelector('.toast').textContent,/انجام نشد/);
 assert.equal(f.root.querySelector('.app-sheet'),null);
 assert.equal(f.app.state.canInstall,false,'a spent prompt must not keep the row alive');

 f.close();
});

test('appinstalled hides the row and toasts wherever the install came from',async()=>{
 const f=fixture();
 await f.app.ready;
 f.dispatchInstall(Promise.resolve({outcome:'accepted'}));
 f.click('menu');
 assert.ok(f.root.querySelector('[data-action="install-app"]'),'row present before the install lands');
 f.dom.window.dispatchEvent(new f.dom.window.Event('appinstalled'));
 assert.equal(f.root.querySelector('[data-action="install-app"]'),null,'the open drawer re-renders without the row');
 assert.match(f.root.querySelector('.toast').textContent,/برنامه نصب شد/);
 f.close();
});
