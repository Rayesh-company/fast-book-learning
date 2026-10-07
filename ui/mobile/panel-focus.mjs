/** One keyboard and background contract for host and PDF tool panels. */
export function createPanelFocus(root){
 const doc=root.ownerDocument??root;
 let current=null;
 const available=node=>!node.disabled&&node.tabIndex>=0&&!node.closest('[hidden],[inert],[aria-hidden="true"]');
 const controls=panel=>[...panel.querySelectorAll('button,input,select,textarea,a[href],[tabindex]')].filter(available);
 function first(){const panel=current?.panel;if(panel)(controls(panel)[0]||panel).focus({preventScroll:true});}
 function keydown(event){
  if(!current)return;
  if(event.key==='Escape'){event.preventDefault();event.stopPropagation();current.onClose?.();return;}
  if(event.key!=='Tab')return;
  const nodes=controls(current.panel),at=nodes.indexOf(doc.activeElement);
  if(!nodes.length||at<0||event.shiftKey&&at===0||!event.shiftKey&&at===nodes.length-1){event.preventDefault();((event.shiftKey?nodes.at(-1):nodes[0])||current.panel).focus({preventScroll:true});}
 }
 function focusin(event){if(current&&!current.panel.contains(event.target))first();}
 function close({restore=true}={}){
  if(!current)return;
  const previous=current;current=null;
  doc.removeEventListener('keydown',keydown,true);doc.removeEventListener('focusin',focusin,true);
  for(const [node,inert] of previous.background)node.toggleAttribute('inert',inert);
  if(restore&&previous.trigger?.isConnected&&!previous.trigger.closest('[hidden],[inert]'))previous.trigger.focus({preventScroll:true});
 }
 return{
  open(panel,{trigger=doc.activeElement,initial,onClose}={}){
   if(!panel||current?.panel===panel)return;
   close({restore:false});
   panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','true');panel.tabIndex=-1;
   const boundary=panel.closest('.phone')||root;
   const background=[...boundary.children].filter(node=>!node.contains(panel)).map(node=>[node,node.hasAttribute('inert')]);
   for(const [node] of background)node.setAttribute('inert','');
   current={panel,trigger,onClose,background};
   doc.addEventListener('keydown',keydown,true);doc.addEventListener('focusin',focusin,true);
   const preferred=initial&&panel.querySelector(initial);if(preferred&&available(preferred))preferred.focus({preventScroll:true});else first();
  },close,dispose(){close({restore:false});}
 };
}
