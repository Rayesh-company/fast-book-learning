/** Small, interruptible motion layer. PDF canvases and selection geometry never move. */
export function createInterfaceMotion(root){
 const doc=root.ownerDocument,win=doc.defaultView;
 const preference=win.matchMedia?.('(prefers-reduced-motion: reduce)');
 const active=new Set(),ghosts=new Set(),byNode=new WeakMap();
 const ease='cubic-bezier(0.22, 1, 0.36, 1)';
 let disposed=false;
 const canAnimate=()=>!disposed&&!preference?.matches&&typeof win.Element.prototype.animate==='function';
 const shell=()=>root.querySelector('.product-shell');
 function play(node,frames,duration=200,done){
  if(!node||!canAnimate()){done?.();return;}
  byNode.get(node)?.cancel();
  const animation=node.animate(frames,{duration,easing:ease,fill:'none'});byNode.set(node,animation);
  active.add(animation);
  animation.finished.catch(()=>{}).finally(()=>{active.delete(animation);if(byNode.get(node)===animation)byNode.delete(node);done?.();});
 }
 function cancelAll(){for(const a of active)a.cancel();active.clear();for(const g of ghosts)g.remove();ghosts.clear();}
 function reveal(node,y=8,duration=200){play(node,[{opacity:0,transform:`translateY(${y}px)`},{opacity:1,transform:'translateY(0)'}],duration);}
 function overlaySnapshot(){return [...root.querySelectorAll('.drawer-holder,.overlay-holder')].flatMap(holder=>[...holder.children]);}
 function overlayKey(){return root.querySelector('.drawer-holder .drawer')?.getAttribute('aria-label')||root.querySelector('.overlay-holder .app-sheet')?.getAttribute('aria-label')||'';}
 function leave(nodes){
  if(!nodes.length||!canAnimate()||!shell())return;
  const ghost=doc.createElement('div');ghost.className='motion-overlay-exit';ghost.setAttribute('aria-hidden','true');ghost.setAttribute('inert','');ghosts.add(ghost);shell().append(ghost);
  for(const node of nodes){node.removeAttribute('hidden');ghost.append(node);}
  const panel=ghost.querySelector('.drawer,.sheet,.reader-floating');
  const backdrop=ghost.querySelector('.drawer-scrim,.sheet-scrim');
  const remove=()=>{ghost.remove();ghosts.delete(ghost);};
  if(backdrop)play(backdrop,[{opacity:1},{opacity:0}],150,panel?undefined:remove);
  if(panel)play(panel,[{opacity:1,transform:'translate(0,0)'},{opacity:0,transform:panel.matches('.drawer')?'translateX(36px)':'translateY(16px)'}],160,()=>{ghost.remove();ghosts.delete(ghost);});
  else if(!backdrop)remove();
 }
 function enterOverlays(){
  const drawer=root.querySelector('.drawer-holder .drawer'),sheet=root.querySelector('.overlay-holder .app-sheet');
  if(drawer)play(drawer,[{opacity:.65,transform:'translateX(36px)'},{opacity:1,transform:'translateX(0)'}],240);
  if(sheet)reveal(sheet,24,220);
  const backdrop=root.querySelector('.drawer-holder .drawer-scrim,.overlay-holder .sheet-scrim');
  if(backdrop)play(backdrop,[{opacity:0},{opacity:1}],180);
 }
 function tabSnapshot(){const tabs=root.querySelector('.note-tabs'),selected=tabs?.querySelector('[aria-selected="true"]');if(!selected)return null;const visual=tabs.querySelector('.motion-tab-indicator')||selected;const box=visual.getBoundingClientRect(),parent=tabs.getBoundingClientRect();return{tab:selected.dataset.tab,x:box.left-parent.left,width:box.width};}
 function tabIndicator(previous){
  const current=tabSnapshot(),tabs=root.querySelector('.note-tabs');if(!current||!tabs)return;
  const indicator=doc.createElement('span');indicator.className='motion-tab-indicator';indicator.setAttribute('aria-hidden','true');indicator.style.left=`${current.x}px`;indicator.style.width=`${current.width}px`;tabs.append(indicator);
  if(previous&&previous.tab!==current.tab&&current.width){play(indicator,[{transform:`translateX(${previous.x-current.x}px) scaleX(${previous.width/current.width})`},{transform:'translateX(0) scaleX(1)'}],200);reveal(root.querySelector('.note-list'),4,170);}
 }
 function floatingSnapshot(){const node=root.querySelector('[data-reader-floating] .reader-floating:not([hidden])');return{node,kind:node?.querySelector('.restore-response')?'minimised':node?.dataset.state||''};}
 function beforeRender(){const p=shell(),tab=tabSnapshot();const snapshot={view:p?.dataset.type,book:p?.dataset.book,session:p?.dataset.sessionId,count:root.querySelectorAll('.conversation .user-turn,.conversation .assistant').length,tab,overlays:overlaySnapshot(),recording:!!root.querySelector('.recording')};cancelAll();return snapshot;}
 function afterRender(previous,{back=false}={}){
  if(disposed)return;
  const p=shell();if(!p)return;
  if(previous.view&&previous.view!=='boot'&&previous.view!==p.dataset.type){
   const direction=back?-6:8;
   // Study content stays anchored. Only its surrounding controls transition.
   if(p.dataset.type==='reader'){reveal(root.querySelector('.topbar'),0,170);reveal(root.querySelector('.reader-chrome,.reader-navigation'),4,180);}
   else{for(const node of root.querySelectorAll('.panel-body,.auth-page,.conversation,.note-list'))reveal(node,direction,210);reveal(root.querySelector('.panel-topbar,.topbar'),0,150);if(p.dataset.type==='chat')reveal(root.querySelector('.chat-composer'),6,200);}
  }else if(previous.view==='chat'&&p.dataset.type==='chat'&&previous.book===p.dataset.book&&previous.session===p.dataset.sessionId){
   const turns=[...root.querySelectorAll('.conversation .user-turn,.conversation .assistant')];
   if(turns.length>previous.count)for(const node of turns.slice(previous.count))reveal(node,node.matches('.assistant')?6:4,node.matches('.assistant')?210:150);
  }
  if(previous.recording)reveal(root.querySelector('.chat-composer'),0,130);
  tabIndicator(previous.tab);leave(previous.overlays);
 }
 function beforeOverlay(){return{key:overlayKey(),nodes:overlaySnapshot()};}
 function afterOverlay(previous){if(previous.key===overlayKey())return;leave(previous.nodes);enterOverlays();}
 function afterFloating(previous){
  const current=floatingSnapshot();if(current.kind===previous.kind)return;
  if(previous.node&&(!current.node||current.kind==='minimised'))leave([previous.node]);
  if(!previous.node&&current.node){reveal(current.node,10,210);return;}
  if(current.kind==='response')reveal(current.node?.querySelector('.response-card'),10,220);
  else if(current.kind==='minimised')reveal(current.node?.querySelector('.restore-response'),4,150);
  else reveal(current.node?.querySelector('.floating-bar'),0,150);
 }
 // Native PDF sheets keep their existing controls and lifecycle. Observe only visibility.
 const observer=new win.MutationObserver(records=>{
  const changed=new Map();for(const record of records)if(!changed.has(record.target))changed.set(record.target,record);
  for(const [node,record] of changed){
   if(!node.matches('.reader-tools .sheet,.reader-tools .sheet-scrim')||node.closest('.motion-overlay-exit'))continue;
   if(!node.hidden){if(node.matches('.sheet'))reveal(node,24,220);else play(node,[{opacity:0},{opacity:1}],180);}
   else if(record.oldValue===null&&canAnimate()){const copy=node.cloneNode(true);copy.hidden=false;leave([copy]);}
  }
 });
 observer.observe(root,{subtree:true,attributes:true,attributeFilter:['hidden'],attributeOldValue:true});
 const preferenceChanged=()=>{if(preference.matches)cancelAll();};
 preference?.addEventListener('change',preferenceChanged);
 root.classList.add('motion-enabled');
 return{beforeRender,afterRender,beforeOverlay,afterOverlay,beforeFloating:floatingSnapshot,afterFloating,reveal,
  dismiss(node,done){play(node,[{opacity:1,transform:'translateY(0)'},{opacity:0,transform:'translateY(4px)'}],130,done);},
  dispose(){disposed=true;cancelAll();observer.disconnect();preference?.removeEventListener('change',preferenceChanged);root.classList.remove('motion-enabled');}};
}
