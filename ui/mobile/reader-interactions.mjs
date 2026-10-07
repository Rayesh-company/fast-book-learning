const clamp=(n,min,max)=>Math.max(min,Math.min(max,n));

export function installReaderGestures({viewport,surface,getZoom,setZoom,turnPage,hasSelection}) {
  const win=viewport.ownerDocument.defaultView, life=new win.AbortController();
  const options={signal:life.signal,passive:false};
  let first=null,pinch=null;
  const distance=touches=>Math.hypot(touches[0].clientX-touches[1].clientX,touches[0].clientY-touches[1].clientY);
  const sync=()=>viewport.style.touchAction=getZoom()>1?'pan-x pan-y':'pan-y';
  function clear(){surface.style.transform='';surface.style.transformOrigin='';first=null;pinch=null;}
  viewport.addEventListener('touchstart',event=>{
    if(event.touches.length===2){
      event.preventDefault();const box=surface.getBoundingClientRect();
      const x=(event.touches[0].clientX+event.touches[1].clientX)/2,y=(event.touches[0].clientY+event.touches[1].clientY)/2;
      pinch={distance:distance(event.touches),zoom:getZoom(),next:getZoom(),x:x-box.left,y:y-box.top,clientX:x,clientY:y};
      surface.style.transformOrigin=`${pinch.x}px ${pinch.y}px`;first=null;
    } else if(event.touches.length===1){const t=event.touches[0];first={x:t.clientX,y:t.clientY,time:Date.now(),selected:hasSelection()};}
  },options);
  viewport.addEventListener('touchmove',event=>{
    if(pinch&&event.touches.length===2){event.preventDefault();pinch.next=clamp(pinch.zoom*distance(event.touches)/Math.max(1,pinch.distance),.75,3);surface.style.transform=`scale(${pinch.next/pinch.zoom})`;return;}
    if(first&&event.touches.length===1&&getZoom()<=1&&!first.selected&&!hasSelection()&&Date.now()-first.time<400){
      const t=event.touches[0],dx=t.clientX-first.x,dy=t.clientY-first.y;
      if(Math.abs(dx)>24&&Math.abs(dx)>Math.abs(dy)*1.6)event.preventDefault();
    }
  },options);
  viewport.addEventListener('touchend',event=>{
    if(pinch){const value=pinch.next,anchor={x:pinch.x,y:pinch.y,clientX:pinch.clientX,clientY:pinch.clientY,oldZoom:pinch.zoom};clear();setZoom(value,anchor);sync();return;}
    if(first&&event.changedTouches.length&&!event.touches.length){
      const t=event.changedTouches[0],dx=t.clientX-first.x,dy=t.clientY-first.y;
      if(getZoom()<=1&&!first.selected&&!hasSelection()&&Date.now()-first.time<600&&Math.abs(dx)>=64&&Math.abs(dx)>Math.abs(dy)*1.6)turnPage(dx>0?1:-1);
      first=null;
    }
  },options);
  viewport.addEventListener('touchcancel',clear,options);
  viewport.addEventListener('keydown',event=>{
    if(event.target!==viewport)return;
    if(['ArrowRight','ArrowLeft'].includes(event.key)&&!hasSelection()){event.preventDefault();turnPage(event.key==='ArrowRight'?1:-1);}
    if(['+','=','-','0'].includes(event.key)){event.preventDefault();setZoom(event.key==='0'?1:clamp(getZoom()+(event.key==='-'?-.25:.25),.75,3));sync();}
  },{signal:life.signal});
  sync();return{dispose(){clear();life.abort();}};
}

export function installReaderChrome({phone,getPage,getCount,goToPage,idleMs=5000}) {
  const win=phone.ownerDocument.defaultView,life=new win.AbortController(),signal=life.signal;
  const chrome=phone.querySelector('.reader-chrome'),wheel=phone.querySelector('[data-page-wheel]');
  let timer,scrollTimer,open=false,holding=false,keyboardFocus=false;
  const focused=()=>keyboardFocus&&chrome.contains(phone.ownerDocument.activeElement);
  function schedule(){clearTimeout(timer);if(!open&&!holding&&!focused())timer=setTimeout(()=>{chrome.dataset.hidden='true';chrome.setAttribute('inert','');},idleMs);}
  function show(){chrome.dataset.hidden='false';if(!phone.querySelector('.drawer:not([hidden]),.sheet:not([hidden])'))chrome.removeAttribute('inert');schedule();}
  const pageTouch=()=>{keyboardFocus=false;show();};
  phone.querySelector('.reader-page').addEventListener('pointerdown',pageTouch,{signal});
  phone.querySelector('.reader-page').addEventListener('touchstart',pageTouch,{signal,passive:true});
  chrome.addEventListener('pointerdown',()=>{keyboardFocus=false;holding=true;show();},{signal});
  win.addEventListener('pointerup',()=>{holding=false;schedule();},{signal});
  win.addEventListener('pointercancel',()=>{holding=false;schedule();},{signal});
  chrome.addEventListener('focusin',show,{signal});chrome.addEventListener('focusout',()=>win.setTimeout(schedule,0),{signal});
  phone.addEventListener('keydown',()=>{keyboardFocus=true;show();},{signal});
  function sync(){
    const page=getPage(),count=getCount();
    phone.querySelector('[data-page-number]').textContent=String(page).replace(/\d/g,c=>'۰۱۲۳۴۵۶۷۸۹'[c]);
    phone.querySelector('[data-page-number]').closest('button').setAttribute('aria-label',`رفتن به صفحه؛ صفحهٔ ${page} از ${count}`);
    phone.querySelector('[name="page"]').value=String(page).replace(/\d/g,c=>'۰۱۲۳۴۵۶۷۸۹'[c]);
    wheel.setAttribute('aria-activedescendant',`wheel-page-${page}`);
    for(const item of wheel.children)item.setAttribute('aria-selected',String(Number(item.dataset.page)===page));
  }
  function populate(){
    if(wheel.children.length!==getCount())wheel.innerHTML=Array.from({length:getCount()},(_,i)=>`<div role="option" id="wheel-page-${i+1}" data-page="${i+1}" aria-selected="false">${String(i+1).replace(/\d/g,c=>'۰۱۲۳۴۵۶۷۸۹'[c])}</div>`).join('');
    sync();wheel.scrollTop=(getPage()-1)*44;
  }
  async function select(page){page=clamp(page,1,getCount());if(page!==getPage())await goToPage(page);sync();}
  wheel.addEventListener('scroll',()=>{if(!open)return;clearTimeout(scrollTimer);scrollTimer=setTimeout(()=>select(Math.round(wheel.scrollTop/44)+1),140);},{signal});
  wheel.addEventListener('click',event=>{const item=event.target.closest('[data-page]');if(item){wheel.scrollTop=(Number(item.dataset.page)-1)*44;select(Number(item.dataset.page));}},{signal});
  wheel.addEventListener('keydown',event=>{
    const offset={ArrowUp:-1,ArrowDown:1,PageUp:-10,PageDown:10}[event.key];
    if(offset!==undefined||event.key==='Home'||event.key==='End'){event.preventDefault();const page=clamp(event.key==='Home'?1:event.key==='End'?getCount():getPage()+offset,1,getCount());wheel.scrollTop=(page-1)*44;select(page);}
  },{signal});
  show();return{sync,show,setOpen(value){open=value;if(value)populate();else clearTimeout(scrollTimer);show();},dispose(){clearTimeout(timer);clearTimeout(scrollTimer);life.abort();}};
}

/** The handle has a large hit area; dragging never starts on the textarea. */
export function installQuestionGestures({root,minimise,expand}) {
  const win=root.ownerDocument.defaultView,life=new win.AbortController();let drag,suppressClick=false;
  root.addEventListener('click',event=>{if(suppressClick&&event.target.closest('[data-question-handle]')){event.preventDefault();event.stopImmediatePropagation();suppressClick=false;}},{signal:life.signal,capture:true});
  root.addEventListener('pointerdown',event=>{
    const handle=event.target.closest('[data-question-handle]');
    if(handle){event.preventDefault();suppressClick=false;drag={id:event.pointerId,y:event.clientY,handle,panel:handle.closest('.reader-floating')};handle.setPointerCapture?.(event.pointerId);}
    else if(root.querySelector('.reader-floating:not([hidden]) [name="reader-question"],.reader-floating .loading-label')&&!event.target.closest('.reader-floating,.reader-selection-actions,.reader-tools,.drawer-holder,.overlay-holder'))minimise();
  },{signal:life.signal});
  root.addEventListener('pointermove',event=>{if(drag?.id===event.pointerId)drag.panel.style.transform=`translateY(${clamp(event.clientY-drag.y,-100,100)}px)`;},{signal:life.signal});
  function finish(event){if(drag?.id!==event.pointerId)return;const dy=event.clientY-drag.y;drag.panel.style.transform='';suppressClick=Math.abs(dy)>8;drag=null;if(event.type!=='pointercancel'){if(dy<=-48)expand();else if(dy>=36)minimise();}}
  root.addEventListener('pointerup',finish,{signal:life.signal});root.addEventListener('pointercancel',finish,{signal:life.signal});
  return{dispose(){life.abort();}};
}
