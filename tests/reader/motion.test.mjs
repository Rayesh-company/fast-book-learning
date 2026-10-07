import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createMobileApp} from '../../ui/mobile/app-ui.mjs';
import {createDemoApi} from '../../ui/mobile/demo-api.mjs';
import {createInterfaceMotion} from '../../ui/mobile/motion.mjs';

function environment(reduced=false){
 const dom=new JSDOM('<main id="app"></main>',{url:'http://localhost/mobile/?demo=1',pretendToBeVisual:true});
 const root=dom.window.document.querySelector('#app'),listeners=new Set(),animations=[];
 const preference={matches:reduced,addEventListener:(type,fn)=>listeners.add(fn),removeEventListener:(type,fn)=>listeners.delete(fn)};
 dom.window.matchMedia=query=>query.includes('reduced-motion')?preference:{matches:false,addEventListener(){},removeEventListener(){}};
 dom.window.Element.prototype.animate=function(){let finish;const a={target:this,finished:new Promise(resolve=>finish=resolve),cancelled:false,cancel(){this.cancelled=true;finish();},finish};animations.push(a);return a;};
 return{dom,root,animations,preference,reduce(){preference.matches=true;for(const fn of listeners)fn();}};
}
async function fixture(reduced=false){const f=environment(reduced);f.app=createMobileApp({root:f.root,api:createDemoApi({storage:f.dom.window.localStorage,delay:0})});await f.app.ready;f.close=()=>{f.app.dispose();f.dom.window.close();};return f;}
const click=(f,a)=>f.root.querySelector(`[data-action="${a}"]`).click();
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('drawer dismissal preserves focus and rapid reopening cannot remove the new drawer',async()=>{
 const f=await fixture();const opener=f.root.querySelector('[data-action="menu"]');opener.focus();click(f,'menu');await f.app.settled();const drawer=f.root.querySelector('.drawer-holder .drawer');assert.ok(f.dom.window.document.activeElement.closest('.drawer'));
 const enter=f.animations.find(a=>a.target===drawer);assert.ok(enter);assert.equal(enter.cancelled,false); // history refresh retains its moving shell
 click(f,'close-menu');const ghost=f.root.querySelector('.motion-overlay-exit');assert.ok(ghost);assert.equal(ghost.getAttribute('aria-hidden'),'true');assert.ok(ghost.hasAttribute('inert'));assert.equal(f.dom.window.document.activeElement,opener);
 click(f,'menu');const reopened=f.root.querySelector('.drawer-holder .drawer');assert.notEqual(reopened,drawer);for(const a of [...f.animations])a.finish();await tick();assert.equal(reopened.isConnected,true);assert.equal(f.root.querySelector('.motion-overlay-exit'),null);f.close();
});

test('reduced motion is immediate and preference changes clear unfinished exits',async()=>{
 const f=await fixture(true);click(f,'menu');click(f,'open-chat');click(f,'menu');click(f,'close-menu');assert.equal(f.animations.length,0);assert.equal(f.root.querySelector('.motion-overlay-exit'),null);f.close();
 const moving=await fixture();click(moving,'menu');click(moving,'close-menu');assert.ok(moving.root.querySelector('.motion-overlay-exit'));moving.reduce();assert.equal(moving.root.querySelector('.motion-overlay-exit'),null);assert.ok(moving.animations.every(a=>a.cancelled));moving.close();
});

test('motion never targets PDF geometry or consumes the selected reader question',async()=>{
 const f=await fixture();const surface=f.root.querySelector('.pdf-surface');surface.innerHTML='<canvas></canvas>';const canvas=surface.firstChild;
 const selection={text:'عبارت دقیق',pages:[{page:100,start:4,end:13,text:'عبارت دقیق'}]};f.root.querySelector('.phone').dispatchEvent(new f.dom.window.CustomEvent('reader-question',{bubbles:true,detail:selection}));
 const input=f.root.querySelector('[name="reader-question"]');input.value='پیش‌نویس';input.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));click(f,'menu');click(f,'close-menu');assert.equal(f.root.querySelector('canvas'),canvas);assert.equal(f.root.querySelector('[name="reader-question"]').value,'پیش‌نویس');assert.equal(f.root.querySelector('.question-context').textContent,'عبارت دقیق');
 assert.ok(f.animations.every(a=>!a.target.matches('.reader-page,.pdf-surface,canvas,.textLayer')));f.close();
});

test('native PDF sheets animate without replacing their PDF canvas, then clean up on disposal',async()=>{
 const f=environment();f.root.innerHTML='<div class="phone product-shell"><canvas></canvas><div class="reader-tools"><section class="sheet" hidden>Controls</section></div></div>';
 const motion=createInterfaceMotion(f.root),canvas=f.root.querySelector('canvas'),sheet=f.root.querySelector('.sheet');sheet.hidden=false;await tick();assert.ok(f.animations.find(a=>a.target===sheet));sheet.hidden=true;await tick();assert.ok(f.root.querySelector('.motion-overlay-exit'));assert.equal(f.root.querySelector('canvas'),canvas);motion.dispose();assert.equal(f.root.querySelector('.motion-overlay-exit'),null);f.dom.window.close();
});
