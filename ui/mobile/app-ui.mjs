import {mainView,drawer,sheet,floating,composerAction,books,bookInfo,number,digits,esc,visibleNotes,completeAnswer} from './views.mjs';
import {installQuestionGestures} from './reader-interactions.mjs';
import {icon} from './icons.mjs';
import {createInterfaceMotion} from './motion.mjs';
import {createPanelFocus} from './panel-focus.mjs';
const normalPhone=v=>String(v).replace(/[۰-۹]/g,c=>'۰۱۲۳۴۵۶۷۸۹'.indexOf(c)).replace(/[٠-٩]/g,c=>'٠١٢٣٤٥٦٧٨٩'.indexOf(c)).replace(/[\s()-]/g,'').replace(/^\+98|^0098/,'0');
const normalText=v=>String(v).normalize('NFKC').replace(/[يى]/g,'ی').replace(/ك/g,'ک').replace(/[\u064b-\u065f\u0670\u0640\u200c\s]/g,'').toLowerCase();

/** The product host owns UI, drafts and notebook behavior. PDF/audio remain independent. */
export function createMobileApp({root,api,storage=root.ownerDocument.defaultView.localStorage}={}){
 const doc=root.ownerDocument,win=doc.defaultView;
 const lifecycle=new win.AbortController();
 const motion=createInterfaceMotion(root);
 const panelFocus=createPanelFocus(root);
 let navigationBack=false,toastRevision=0;
 const s={view:'boot',demo:api.demo,loginRequired:api.loginRequired!==false,pageFiltering:api.demo||api.pageFiltering===true,book:'tarhe-kolli',positions:{'tarhe-kolli':{page:100},'70143-336':{page:1}},account:null,
  messages:[],sessions:[],sessionId:null,drafts:{},chatScroll:0,follow:true,pages:[100],theme:'system',profile:null,
  readerQuestion:null,readerGuideSeen:false,stack:[],menu:false,sheet:null,error:'',notes:[],noteTab:'notes',noteBook:'tarhe-kolli',noteSearch:'',selected:new Set(),selecting:false,notesLoading:false};
 let storageKey,disposed=false,job=null,sequence=0,accountRevision=0,recordRevision=0,recordPending=false,otpTimer,pending=new Set(),toastTimer,recorder,timer,media,recordingStarted,recordingPlace,recordDraft;
 const safeRead=key=>{try{return JSON.parse(storage?.getItem(key));}catch{return null;}};
 const persist=()=>{if(!storageKey||disposed)return;try{storage?.setItem(storageKey,JSON.stringify({view:['reader','chat'].includes(s.view)?s.view:s.stack.find(v=>['reader','chat'].includes(v))||'reader',book:s.book,positions:s.positions,drafts:s.drafts,pages:s.pages,sessionId:s.sessionId,chatScroll:s.chatScroll,follow:s.follow,theme:s.theme,readerGuideSeen:s.readerGuideSeen}));}catch{}};
 const run=p=>{const promise=Promise.resolve(p).catch(e=>{if(!disposed&&e.name!=='AbortError'){s.error=e.message;renderOverlay();toast(e.message);}}).finally(()=>pending.delete(promise));pending.add(promise);return promise;};
 const phone=()=>root.querySelector('.phone');
 function capture(){
  const p=phone();if(!p)return;
  const currentBook=p.dataset.book||s.book;
  if(p.dataset.type==='reader')s.positions[currentBook]={page:number(p.dataset.pdfPage)||s.positions[currentBook]?.page||1,zoom:number(p.dataset.pdfZoom)||1,scroll:number(p.querySelector('.reader-page')?.scrollTop)||0};
  const thread=p.querySelector('.conversation');if(thread){s.chatScroll=thread.scrollTop;s.follow=thread.scrollHeight-thread.clientHeight-thread.scrollTop<80;}
  const draft=p.querySelector('[name="question"]');if(draft){s.drafts[currentBook]=draft.value;if(s.readerQuestion?.inChat)s.readerQuestion.draft=draft.value;}
  const rq=p.querySelector('[name="reader-question"]');if(rq&&s.readerQuestion)s.readerQuestion.draft=rq.value;
 }
 function applyTheme(){
  const dark=s.theme==='dark'||s.theme==='system'&&win.matchMedia?.('(prefers-color-scheme: dark)').matches;
  doc.body.classList.toggle('dark',!!dark);doc.documentElement.style.colorScheme=dark?'dark':'light';
 }
 function autosize(input){input.style.height='auto';input.style.height=Math.min(150,Math.max(34,input.scrollHeight))+'px';const c=input.closest('.chat-composer');if(c)phone()?.style.setProperty('--composer-height',`${c.offsetHeight||138}px`);}
 function render(){if(disposed)return;panelFocus.close({restore:false});const previous=motion.beforeRender();
  s.menu=false;s.sheet=null;applyTheme();const pos=s.positions[s.book]||{page:1};
  root.innerHTML=`<div class="phone product-shell" data-type="${s.view}" data-book="${s.book}" data-session-id="${s.sessionId||''}" data-demo="${s.demo}" data-login-required="${s.loginRequired}" data-pdf-page="${pos.page}" data-pdf-zoom="${pos.zoom||1}" data-pdf-scroll="${pos.scroll||0}">${mainView(s)}<div class="drawer-holder"></div><div class="overlay-holder"></div><div class="toast" role="status" hidden></div></div>`;
  phone().readerQuestion=s.readerQuestion;
  const thread=root.querySelector('.conversation');if(thread){thread.scrollTop=s.follow?thread.scrollHeight:s.chatScroll;thread.addEventListener('scroll',()=>{s.chatScroll=thread.scrollTop;s.follow=thread.scrollHeight-thread.clientHeight-thread.scrollTop<80;const b=root.querySelector('.jump-latest');if(b)b.hidden=s.follow;persist();},{signal:lifecycle.signal});const b=root.querySelector('.jump-latest');b.hidden=s.follow;}
  root.querySelectorAll('textarea').forEach(autosize);persist();motion.afterRender(previous,{back:navigationBack});navigationBack=false;
 }
 let focusReturn;
 function renderOverlay(){if(disposed||!phone())return;
  const previous=motion.beforeOverlay(),focused=doc.activeElement,inDrawer=focused?.closest('.drawer');
  const holder=root.querySelector('.drawer-holder'),existing=holder.querySelector('.drawer');
  if(s.menu&&existing){
   // A history refresh must preserve the moving shell and its keyboard focus.
   const template=doc.createElement('template');template.innerHTML=drawer(s);const next=template.content.querySelector('.drawer');
   existing.querySelector('.history').innerHTML=next.querySelector('.history').innerHTML;
   existing.querySelector('.account-button').innerHTML=next.querySelector('.account-button').innerHTML;
  }else holder.innerHTML=s.menu?drawer(s):'';
  root.querySelector('.overlay-holder').innerHTML=sheet(s);
  if(inDrawer&&s.menu&&!focused.isConnected){const replacement=[...holder.querySelectorAll('.drawer [data-action]')].find(n=>n.dataset.action===focused.dataset.action&&n.dataset.id===focused.dataset.id);(replacement||holder.querySelector('.drawer button'))?.focus({preventScroll:true});}
  motion.afterOverlay(previous);
  const panel=root.querySelector('.drawer-holder .drawer,.overlay-holder .app-sheet');
  if(panel)panelFocus.open(panel,{trigger:focusReturn,onClose:closeOverlay});else panelFocus.close();
 }
 function openSheet(type,details={}){if(!doc.activeElement?.closest('.app-sheet,.drawer'))focusReturn=doc.activeElement;s.menu=false;s.error='';s.sheet={type,...details};renderOverlay();root.querySelector('.app-sheet input,.app-sheet button')?.focus({preventScroll:true});}
 function closeOverlay(){s.menu=false;s.sheet=null;s.error='';renderOverlay();focusReturn?.isConnected&&focusReturn.focus({preventScroll:true});}
 function renderFloating(){const holder=root.querySelector('[data-reader-floating]');if(holder){const previous=motion.beforeFloating();holder.innerHTML=floating(s);phone().readerQuestion=s.readerQuestion;holder.querySelectorAll('textarea').forEach(autosize);motion.afterFloating(previous);}}
 function minimiseQuestion(){if(s.view!=='reader'||!s.readerQuestion||s.readerQuestion.minimised)return;capture();stopRecording();s.readerQuestion.minimised=true;renderFloating();root.querySelector('[data-action="restore"]')?.focus({preventScroll:true});}
 function expandQuestion(){if(!s.readerQuestion)return;capture();if(!s.readerQuestion.inChat)s.readerQuestion.chatDraft=s.drafts[s.book]||'';s.readerQuestion.inChat=true;s.drafts[s.book]=s.readerQuestion.draft||'';s.pages=s.readerQuestion.selection.pages.map(p=>p.page);navigate('chat',{captured:true});root.querySelector('[name="question"]')?.focus({preventScroll:true});}
 function syncComposer(input){const group=input.closest('form')?.querySelector('.send-group');if(group)group.innerHTML=composerAction(input.value,s.busy,input.name==='reader-question'?'reader':'chat');}
 const questionGestures=installQuestionGestures({root,minimise:minimiseQuestion,expand:expandQuestion});
 lifecycle.signal.addEventListener('abort',()=>questionGestures.dispose(),{once:true});
 function dismissReaderGuide(){s.readerGuideSeen=true;root.querySelector('.reader-guide')?.remove();persist();}
 function toast(text){const el=root.querySelector('.toast');if(!el)return;const revision=++toastRevision;el.textContent=text;el.hidden=false;motion.reveal(el,5,150);clearTimeout(toastTimer);toastTimer=setTimeout(()=>{if(el.isConnected&&revision===toastRevision)motion.dismiss(el,()=>{if(revision===toastRevision)el.hidden=true;});},4000);}
 function navigate(view,{back=false,captured=false}={}){if(!captured)capture();stopRecording();if(!back&&!['reader','chat'].includes(view)&&s.view!==view)s.stack.push(s.view);s.view=view;s.error='';navigationBack=back;render();}
 async function refresh(){const rev=accountRevision;const [sessions,profile]=await Promise.allSettled([api.sessions(),api.profile()]);if(disposed||rev!==accountRevision)return;if(sessions.status==='fulfilled')s.sessions=sessions.value||[];if(profile.status==='fulfilled')s.profile=profile.value;}
 async function openSession(id){capture();abortJob();stopRecording();const rev=++sequence;const row=await api.session(Number(id));if(disposed||rev!==sequence)return;capture();s.book=books.some(b=>b.id===row.book)?row.book:s.book;s.sessionId=row.id;s.messages=row.messages||[];restoreUnanswered();s.follow=true;s.chatScroll=0;s.readerQuestion=null;navigate('chat',{captured:true});}
 async function selectBook(id){if(!books.some(b=>b.id===id))return;capture();abortJob();s.readerQuestion=null;s.book=id;s.messages=[];s.sessionId=null;s.pages=[s.positions[id]?.page||1];await refresh();const latest=s.sessions.find(r=>r.book===id);if(latest)await openSession(latest.id);else navigate('chat',{captured:true});}
 function abortJob(){job?.abort();job=null;s.busy=false;if(s.readerQuestion)s.readerQuestion.busy=false;}
 async function send(place='chat',retryIndex=null){
  if(s.busy)return;
  const rq=place==='reader'||s.readerQuestion?.inChat?s.readerQuestion:null;
  const question=retryIndex!==null?s.messages[retryIndex]?.payload.text:place==='reader'?root.querySelector('[name="reader-question"]')?.value:s.drafts[s.book]||root.querySelector('[name="question"]')?.value;
  if(!question?.trim())return;
  const context=retryIndex!==null?s.messages[retryIndex].payload:{text:question.trim(),book:s.book,pages:[...(rq?rq.selection.pages.map(p=>p.page):s.pages||[])],selection:rq?.selection};
  const book=context.book||s.book;
  const controller=new win.AbortController();job=controller;s.busy=true;s.error='';s.status='در حال جستجو در کتاب';
  const at=retryIndex??s.messages.length;
  if(retryIndex===null)s.messages.push({role:'user',payload:{...context,pending_store:true}});
  const turn=s.messages[at];delete turn.payload.failed;delete turn.payload.failure;
  if(!rq||s.view==='chat'){s.drafts[book]='';s.follow=true;render();}
  try{
   if(!s.sessionId){const row=await api.createSession(book,question.slice(0,42));if(controller.signal.aborted)return;s.sessionId=row.id;}
   const id=s.sessionId;
   if(turn.payload.pending_store){await api.append(id,'user',{...context,failed:undefined,failure:undefined,pending_store:undefined});if(controller.signal.aborted)return;delete turn.payload.pending_store;}
   if(rq){rq.lastDraft=question;rq.draft='';rq.busy=true;rq.error='';if(rq.inChat)s.drafts[book]='';renderFloating();}else{s.drafts[book]='';s.follow=true;render();}
   const response=await api.ask({question:context.text,book,pages:context.pages,selection:context.selection,sessionId:id},{signal:controller.signal,onStatus:status=>{if(disposed||controller.signal.aborted)return;s.status=status;const el=root.querySelector('.operation-status span:nth-child(2),.loading-label');if(el)el.textContent=status;}});
   if(disposed||controller.signal.aborted)return;
   await api.append(id,'assistant',{...response,book,origin_session_id:id});
   if(disposed||controller.signal.aborted||job!==controller||id!==s.sessionId)return;
   response.book=book;response.origin_session_id=id;
   s.messages.push({role:'assistant',payload:response});
   if(rq){rq.answer=response;rq.busy=false;renderFloating();}
   await refresh();
  }catch(e){
   if(disposed||job!==controller)return;
   const stopped=e.name==='AbortError'||controller.signal.aborted;
   if(rq){rq.busy=false;rq.draft=question;rq.error=stopped?'پاسخ متوقف شد. می‌توانید پرسش را دوباره بفرستید.':e.message;if(rq.inChat){s.drafts[book]=question;turn.payload.failed=!stopped;turn.payload.failure=rq.error;}renderFloating();}
   else{turn.payload.failed=!stopped;turn.payload.failure=stopped?'':e.message;if(stopped)s.messages.push({role:'assistant',payload:{text:'پاسخ متوقف شد.',stopped:true}});}
  }finally{
   if(job===controller){job=null;s.busy=false;if(s.view==='chat')render();else if(rq)renderFloating();persist();}
  }
 }
 async function saveAnswer(index){const p=index==='reader'?s.readerQuestion?.answer:s.messages[Number(index)]?.payload;if(!p||p.saved)return;
  const text=completeAnswer(p);if(!text)return;const rev=accountRevision;const origin=p.origin_session_id||s.sessionId;const session=s.sessions.find(x=>x.id===origin);
  const note=await api.saveNote({text,doc:null,pages:[],refs:[],source:{kind:'session',session_id:origin,title:session?.title||'',book:p.book||session?.book||s.book}});
  if(disposed||rev!==accountRevision)return;s.notes.unshift(note);p.saved=true;if(s.view==='chat')render();else renderFloating();toast('ذخیره شد');
 }
 async function loadNotes(){const rev=accountRevision;s.noteBook=s.book;s.notesLoading=true;navigate('notebook');try{const notes=await api.notes();if(rev===accountRevision&&!disposed)s.notes=notes;}finally{if(rev!==accountRevision)return;s.notesLoading=false;if(s.view==='notebook')render();}}
 async function highlightSelection(selected){if(!selected)return;const rev=accountRevision,book=s.book;const note=await api.saveNote({text:selected.text,doc:book,pages:selected.pages.map(p=>p.page),refs:[],source:{kind:'book',capture:'highlight',book,selection:selected}});if(disposed||rev!==accountRevision)return;s.notes.unshift(note);doc.getSelection()?.removeAllRanges();toast('هایلایت در دفتر ذخیره شد');if(book===s.book)for(const p of selected.pages)phone()?.bookReader?.highlight(p);}
 function sourcePage(book,page,text,selection){capture();abortJob();if(book!==s.book){s.sessionId=null;s.messages=[];}s.readerQuestion=null;s.book=books.some(b=>b.id===book)?book:s.book;s.positions[s.book]={...s.positions[s.book],page:Number(page)||1,scroll:0};s.pendingSource={text,selection};navigate('reader',{captured:true});}
 async function citation(target){let book=target.dataset.book||s.book,page=number(target.dataset.page),text=target.dataset.text||'';const match=target.dataset.reference?.match(/document\s+([\w-]+)\s*\(pages?\s+(\d+)/);if(match){book=match[1];page=Number(match[2]);}if(!page){toast('این ارجاع شمارهٔ صفحه ندارد.');return;}
  if(text&&target.dataset.reference){try{const response=await win.fetch(`/books/${book}.pages.json`);if(response.ok){const data=await response.json(),pages=Array.isArray(data)?data:data.pages||data;const needle=normalText(text);for(let n=page;n<=page+10;n++){const raw=pages[String(n)]??pages[n-1];const value=typeof raw==='string'?raw:raw?.text;if(value&&normalText(value).includes(needle)){page=n;break;}}}}catch{}}
  sourcePage(book,page,text);
 }
 async function searchBook(query){s.bookSearch=query;s.searching=true;s.error='';renderOverlay();try{const response=await win.fetch(`/books/${s.book}.pages.json`);if(!response.ok)throw new Error('جستجو در کتاب در دسترس نیست.');const data=await response.json(),pages=data.pages||data;const entries=Array.isArray(pages)?pages.map((p,i)=>[i+1,p]):Object.entries(pages);const needle=normalText(query);s.searchResults=entries.map(([page,p])=>({page:Number(page),text:typeof p==='string'?p:p?.text||''})).filter(p=>normalText(p.text).includes(needle)).slice(0,40).map(p=>({...p,text:p.text.slice(0,260)}));}catch(e){s.error=e.message;}finally{s.searching=false;renderOverlay();}}
 function copy(text){if(!text)return;
  const fallback=()=>{const focused=doc.activeElement;const input=doc.createElement('textarea');input.dataset.clipboardFallback='';input.value=text;input.style.cssText='position:fixed;left:-9999px;top:0';doc.body.append(input);input.focus();input.select();let copied=false;try{copied=doc.execCommand?.('copy')===true;}catch{}finally{input.remove();focused?.isConnected&&focused.focus({preventScroll:true});}toast(copied?'کپی شد':'کپی در این مرورگر در دسترس نیست.');};
  if(win.navigator.clipboard?.writeText)return win.navigator.clipboard.writeText(text).then(()=>toast('کپی شد')).catch(fallback);
  fallback();
 }
 function stopRecording(){recordRevision++;recordPending=false;clearInterval(timer);timer=null;if(recorder?.state==='recording')recorder.stop();media?.getTracks().forEach(t=>t.stop());media=null;recorder=null;}
 async function startRecording(place){if(timer||recordPending||s.busy)return;const rev=++recordRevision;recordPending=true;recordingPlace=place;recordDraft=place==='reader'?s.readerQuestion?.draft||'':s.drafts[s.book]||'';
  if(!s.demo){try{const stream=await win.navigator.mediaDevices.getUserMedia({audio:true});if(disposed||rev!==recordRevision){stream.getTracks().forEach(t=>t.stop());return;}media=stream;recorder=new win.MediaRecorder(media);recorder._chunks=[];recorder.ondataavailable=e=>recorder._chunks.push(e.data);recorder.start();}catch(e){if(disposed||rev!==recordRevision)return;recordPending=false;toast('ضبط شروع نشد. اجازهٔ میکروفون را بررسی کنید.');return;}}
  recordPending=false;recordingStarted=Date.now();const el=root.querySelector(place==='reader'?'.floating-bar':'.chat-composer');if(!el){stopRecording();return;}
  el.innerHTML=`<div class="recording"><span class="record-dot"></span><span>${s.demo?'ضبط نمونه':'در حال ضبط'}</span><span data-recording-time>۰۰:۰۰</span><button type="button" data-action="finish-record">پایان</button><button type="button" data-action="cancel-record">لغو</button></div>`;
  motion.reveal(el.querySelector('.recording'),0,130);
  timer=setInterval(()=>{const seconds=Math.floor((Date.now()-recordingStarted)/1000);const t=root.querySelector('[data-recording-time]');if(t)t.textContent=digits(`${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`);},1000);
 }
 async function finishRecording(cancel=false){const rev=recordRevision;clearInterval(timer);timer=null;let blob;
  if(recorder?.state==='recording'){blob=await new Promise(resolve=>{recorder.onstop=()=>resolve(new win.Blob(recorder._chunks,{type:recorder.mimeType}));recorder.stop();});}media?.getTracks().forEach(t=>t.stop());media=null;recorder=null;
  if(disposed||rev!==recordRevision)return;
  if(cancel){if(recordingPlace==='reader'){s.readerQuestion.draft=recordDraft;renderFloating();}else{s.drafts[s.book]=recordDraft;render();}return;}
  try{toast('در حال تبدیل گفتار به متن…');const result=await api.transcribe(blob);if(disposed||rev!==recordRevision)return;if(recordingPlace==='reader'){s.readerQuestion.draft=result.text;renderFloating();}else{s.drafts[s.book]=result.text;render();}}
  catch(e){if(disposed||rev!==recordRevision)return;if(recordingPlace==='reader')renderFloating();else render();toast(e.message);}
 }
 const listenerOptions={signal:lifecycle.signal};
 root.addEventListener('book-selection',e=>{if(e.detail?.text)dismissReaderGuide();},{...listenerOptions,capture:true});
 root.addEventListener('reader-question',e=>{dismissReaderGuide();s.readerQuestion={selection:structuredClone(e.detail),draft:''};renderFloating();root.querySelector('[name="reader-question"]')?.focus({preventScroll:true});},listenerOptions);
 root.addEventListener('reader-question-reset',()=>{if(s.readerQuestion){s.readerQuestion.minimised=true;renderFloating();}},listenerOptions);
 root.addEventListener('reader-selection-action',e=>{if(e.detail.action==='highlight')run(highlightSelection(e.detail.selection));else if(e.detail.action==='copy-selection')copy(e.detail.selection.text);},listenerOptions);
 root.addEventListener('book-page-ready',e=>{s.positions[s.book]={...s.positions[s.book],page:e.detail.page};s.outline=e.detail.outline||[];persist();const pendingSource=s.pendingSource;if(!pendingSource)return;s.pendingSource=null;
  let range=pendingSource.selection?.pages.find(p=>p.page===e.detail.page);
  if(!range&&pendingSource.text){const index=phone()?.bookReader?.getPageIndex(e.detail.page);if(index){const text=index.text,map=[];let normalized='';for(let i=0;i<text.length;i++){for(const c of normalText(text[i])){normalized+=c;map.push(i);}}const needle=normalText(pendingSource.text),at=normalized.indexOf(needle);if(needle.length>=8&&at>=0&&normalized.indexOf(needle,at+1)<0){const start=map[at],end=map[at+needle.length-1]+1;range={page:e.detail.page,start,end,text:text.slice(start,end)};}}}
  if(range)phone().bookReader.highlight(range);else if(pendingSource.text)toast('صفحهٔ منبع باز شد؛ متن دقیق در این صفحه پیدا نشد.');
 },listenerOptions);
 root.addEventListener('input',e=>{if(e.target.name==='question'){s.drafts[s.book]=e.target.value;if(s.readerQuestion?.inChat)s.readerQuestion.draft=e.target.value;autosize(e.target);syncComposer(e.target);persist();}if(e.target.name==='reader-question'&&s.readerQuestion){s.readerQuestion.draft=e.target.value;autosize(e.target);syncComposer(e.target);}if(e.target.name==='note-search'){s.noteSearch=e.target.value;const pos=e.target.selectionStart;render();const input=root.querySelector('[name="note-search"]');input.focus();input.setSelectionRange(pos,pos);}},listenerOptions);
 root.addEventListener('change',e=>{if(e.target.name==='range')e.target.closest('form').querySelector('.range-inputs').hidden=!e.target.checked;if(e.target.name==='note-book'){s.noteBook=e.target.value;render();}if(e.target.name==='selected-note'){const id=Number(e.target.value);e.target.checked?s.selected.add(id):s.selected.delete(id);render();}},listenerOptions);
 root.addEventListener('keydown',e=>{
  if(e.key==='Escape'&&s.view==='reader'&&s.readerQuestion&&!e.target.closest('.sheet,.drawer'))minimiseQuestion();
  if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)&&e.target.matches('.note-tabs [role="tab"]')){e.preventDefault();const tabs=['notes','highlights'],at=tabs.indexOf(s.noteTab);s.noteTab=tabs[e.key==='Home'?0:e.key==='End'?1:(at+1)%2];s.selected.clear();render();root.querySelector('.note-tabs [aria-selected="true"]')?.focus();}
  if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing&&['question','reader-question'].includes(e.target.name)){e.preventDefault();run(send(e.target.name==='question'?'chat':'reader'));}
 },listenerOptions);
 root.addEventListener('submit',e=>{
  const form=e.target;
  if(form.matches('[data-pdf-page-form]'))return;
  e.preventDefault();
  if(form.matches('[data-chat-form],[data-reader-form]'))return run(send(form.hasAttribute('data-reader-form')?'reader':'chat'));
  if(form.matches('[data-pages-form]')){const range=form.elements.range.checked,start=number(form.elements[range?'from':'single'].value),end=range?number(form.elements.to.value):start;const count=number(phone()?.querySelector('[data-pdf-page-count]')?.textContent?.replace(/[^۰-۹0-9]/g,''))||bookInfo(s.book).pages;if(!Number.isInteger(start)||!Number.isInteger(end)||start<1||end<start||end>count){s.error='شمارهٔ صفحه و ترتیب بازه را بررسی کنید.';renderOverlay();return;}s.pages=Array.from({length:end-start+1},(_,i)=>start+i);closeOverlay();render();}
  if(form.matches('[data-rename-form]'))run((async()=>{const title=form.elements.title.value.trim();if(!title)return;await api.renameSession(s.sheet.id,title);await refresh();closeOverlay();})());
  if(form.matches('[data-book-search]'))run(searchBook(form.elements.search.value));
  if(form.matches('[data-auth-form]'))run((async()=>{s.error='';try{if(s.view==='email-login'){s.account=await api.login({email:form.elements.email.value,password:form.elements.password.value});await initialize();}else if(s.view==='otp'){const code=String(number(form.elements.code.value)).padStart(6,'0');s.account=await api.verifyOtp(s.phone,code);await initialize();}else{const phone=normalPhone(form.elements.phone.value);if(!/^09\d{9}$/.test(phone))throw new Error('شمارهٔ موبایل ایرانی را با ۱۱ رقم وارد کنید.');s.phone=phone;if(s.view==='waitlist'){await api.joinWaitlist(phone);s.waitlisted=true;render();}else{const result=await api.requestOtp(phone);startOtpCooldown();navigate(result.waitlist?'waitlist':'otp');}}}catch(e){s.error=e.message;render();}})());
 },listenerOptions);
 root.addEventListener('click',e=>{
  const t=e.target.closest('[data-action]');if(!t)return;const a=t.dataset.action;
  if(a==='menu'){capture();focusReturn=t;s.menu=true;renderOverlay();root.querySelector('.drawer button')?.focus({preventScroll:true});run(refresh().then(()=>{if(s.menu)renderOverlay();}));}
  if(a==='close-menu'||a==='close-sheet')closeOverlay();
  if(a==='open-chat'){capture();s.pages=[s.positions[s.book]?.page||1];navigate('chat');}
  if(a==='open-reader'){capture();if(s.readerQuestion?.inChat){s.drafts[s.book]=s.readerQuestion.chatDraft||'';s.readerQuestion.inChat=false;}navigate('reader',{captured:true});}
  if(a==='expand-question')expandQuestion();
  if(a==='dismiss-reader-guide'){dismissReaderGuide();root.querySelector('.reader-page')?.focus({preventScroll:true});}
  if(a==='new-chat'){abortJob();s.sessionId=null;s.messages=[];s.readerQuestion=null;s.chatScroll=0;s.follow=true;navigate('chat');}
  if(a==='suggest-question'||a==='suggest-plan'){s.drafts[s.book]=a==='suggest-question'?'این بخش از کتاب را توضیح بده.':'برای مطالعهٔ این کتاب یک برنامه پیشنهاد بده.';render();root.querySelector('[name="question"]').focus();}
  if(a==='back'){const view=s.stack.pop()||'reader';navigate(view,{back:true});}
  if(a==='account')navigate('account');
  if(a==='subscription')navigate('subscription');
  if(a==='theme'){s.theme=t.dataset.theme;render();}
  if(a==='books'||a==='pages'||a==='reading-settings'||a==='book-search')openSheet(a);
  if(a==='select-book')run(selectBook(t.dataset.book));
  if(a==='open-session')run(openSession(t.dataset.id));
  if(a==='session-more')openSheet('session-more',{id:Number(t.dataset.id)});
  if(a==='rename-session'){const row=s.sessions.find(r=>r.id===s.sheet.id);openSheet('rename',{id:row.id,title:row.title});}
  if(a==='confirm-delete-session'){const row=s.sessions.find(r=>r.id===s.sheet.id);openSheet('delete-session',{id:row.id,title:row.title});}
  if(a==='delete-session')run((async()=>{const id=s.sheet.id;await api.deleteSession(id);await refresh();closeOverlay();if(s.sessionId===id){s.sessionId=null;s.messages=[];navigate('chat');}})());
  if(a==='clear-pages'){s.pages=[];closeOverlay();render();}
  if(a==='send-chat')run(send());
  if(a==='send-reader')run(send('reader'));
  if(a==='retry')run(send('chat',Number(t.dataset.index)));
  if(a==='stop'){const turn=s.messages.at(-1);if(turn?.role==='user'){turn.payload.failed=true;turn.payload.failure='پاسخ متوقف شد.';}abortJob();if(s.readerQuestion){s.readerQuestion.draft=s.readerQuestion.lastDraft||s.readerQuestion.draft;s.readerQuestion.error='پاسخ متوقف شد.';renderFloating();}else render();}
  if(a==='close-question'){abortJob();s.readerQuestion=null;renderFloating();}
  if(a==='minimise')minimiseQuestion();
  if(a==='restore'){s.readerQuestion.minimised=false;renderFloating();root.querySelector('[name="reader-question"]')?.focus({preventScroll:true});}
  if(a==='latest'){const el=root.querySelector('.conversation');el.scrollTop=el.scrollHeight;s.follow=true;t.hidden=true;}
  if(a==='save-answer')run(saveAnswer(t.dataset.index));
  if(a==='copy-answer')copy(completeAnswer(t.dataset.index==='reader'?s.readerQuestion.answer:s.messages[Number(t.dataset.index)].payload));
  if(a==='answer-more')openSheet('answer-more',{index:t.dataset.index});
  if(a==='ask-again'){const q=s.sheet.index==='reader'?s.readerQuestion?.selection.text:s.messages[Number(s.sheet.index)-1]?.payload.text;closeOverlay();if(s.view==='reader'){s.readerQuestion.draft='این متن را بیشتر توضیح بده.';renderFloating();}else{s.drafts[s.book]=q||'';render();}}
  if(a==='answer-sources'){const p=s.sheet.index==='reader'?s.readerQuestion.answer:s.messages[Number(s.sheet.index)].payload;openSheet('sources',{sources:p.citations});}
  if(a==='citation')run(citation(t));
  if(a==='study')sourcePage(t.dataset.book,t.dataset.page);
  if(a==='notebook')run(loadNotes());
  if(a==='note-tab'){s.noteTab=t.dataset.tab;s.selected.clear();render();root.querySelector('.note-tabs [aria-selected="true"]')?.focus();}
  if(a==='clear-note-search'){s.noteSearch='';render();root.querySelector('[name="note-search"]')?.focus();}
  if(a==='note-open'){s.noteId=Number(t.dataset.id);s.editOpinion=false;navigate('note');}
  if(a==='edit-opinion'){s.editOpinion=true;render();root.querySelector('[name="opinion"]')?.focus();}
  if(a==='cancel-opinion'){s.editOpinion=false;render();}
  if(a==='save-opinion')run((async()=>{const value=root.querySelector('[name="opinion"]').value;const n=await api.updateNote(s.noteId,value);s.notes=s.notes.map(x=>x.id===n.id?n:x);s.editOpinion=false;render();})());
  if(a==='note-source'){const n=s.notes.find(n=>n.id===s.noteId);if(n.doc&&n.pages?.length)sourcePage(n.doc,n.pages[0],n.text,n.source?.selection);else if(n.source?.session_id)run(openSession(n.source.session_id));}
  if(a==='select-notes'){s.selecting=!s.selecting;s.selected.clear();render();}
  if(a==='copy-notes')copy(s.notes.filter(n=>s.selected.has(n.id)).map(n=>n.text+(n.opinion?'\nنظر من: '+n.opinion:'')).join('\n\n'));
  if(a==='delete-notes')openSheet('delete-notes',{ids:[...s.selected]});
  if(a==='notebook-more')openSheet('notebook-more');
  if(a==='note-more')openSheet('note-more');
  if(a==='delete-note')openSheet('delete-notes',{ids:[s.noteId]});
  if(a==='confirm-delete-notes')run((async()=>{const ids=s.sheet.ids;await api.deleteNotes(ids);s.notes=s.notes.filter(n=>!ids.includes(n.id));s.selected.clear();closeOverlay();if(s.view==='note')s.stack.pop();s.view='notebook';render();})());
  if(a==='export-notes'){const notes=visibleNotes(s);if(!notes.length){toast('یادداشتی برای خروجی وجود ندارد.');return;}const print=doc.createElement('section');print.className='note-print';print.innerHTML=`<h1>دفتر یادداشت</h1>${notes.map(n=>`<article><h2>${esc(n.doc?bookInfo(n.doc).title:'یادداشت گفتگو')}</h2><p>${esc(n.text)}</p>${n.opinion?`<h3>نظر من</h3><p>${esc(n.opinion)}</p>`:''}</article>`).join('')}`;doc.body.append(print);win.print();print.remove();}
  if(a==='contents')run((async()=>{const state=phone()?.bookReader;if(!state){toast('ابتدا صبر کنید کتاب باز شود.');return;}openSheet('contents');})());
  if(a==='outline-page'){const page=s.outline[Number(t.dataset.index)]?.page;if(page)sourcePage(s.book,page);else toast('مقصد این عنوان مشخص نیست.');}
  if(a==='search-page')sourcePage(s.book,t.dataset.page,t.dataset.text);
  if(['pdf-pages','pdf-audio','pdf-zoom'].includes(a)){const trigger=s.menu||s.sheet?focusReturn:t;closeOverlay();phone()?.dispatchEvent(new win.CustomEvent('reader-tools-open',{bubbles:true,detail:{type:a,trigger}}));}
  if(a==='buy')run((async()=>{s.payment=await api.purchase();navigate('payment');})());
  if(a==='verify-payment')run((async()=>{const result=await api.verifyPayment(s.payment?.authority,s.paymentOutcome||'success');s.payment={...s.payment,...result};if(result.subscription)s.profile.subscription=result.subscription;render();})());
  if(a==='payment-outcome'){s.paymentOutcome=t.dataset.outcome;run((async()=>{const result=await api.verifyPayment(s.payment?.authority,s.paymentOutcome);s.payment={...s.payment,...result};render();})());}
  if(a==='return-activity'){s.stack=[];navigate('chat');}
  if(a==='record'||a==='reader-record')run(startRecording(a==='record'?'chat':'reader'));
  if(a==='finish-record'||a==='cancel-record')run(finishRecording(a==='cancel-record'));
  if(a==='logout')run((async()=>{capture();persist();abortJob();stopRecording();await api.logout();resetAccountState();s.account=null;storageKey=null;navigate('login',{captured:true});})());
  if(a==='email-login')navigate('email-login');
  if(a==='login-back')navigate('login');
  if(a==='waitlist')navigate('waitlist');
  if(a==='resend-otp')run((async()=>{await api.requestOtp(s.phone);startOtpCooldown();render();toast('کد ورود دوباره درخواست شد.');})());
 },listenerOptions);
 function restoreUnanswered(){const turn=s.messages.at(-1);if(turn?.role==='user'){turn.payload.failed=true;turn.payload.failure='پاسخ این پرسش کامل نشده است. می‌توانید دوباره تلاش کنید.';}}
 function resetAccountState(){accountRevision++;sequence++;clearTimeout(otpTimer);Object.assign(s,{book:'tarhe-kolli',positions:{'tarhe-kolli':{page:100},'70143-336':{page:1}},messages:[],sessions:[],sessionId:null,drafts:{},chatScroll:0,follow:true,pages:[100],profile:null,readerQuestion:null,readerGuideSeen:false,stack:[],menu:false,sheet:null,error:'',notes:[],noteTab:'notes',noteBook:'tarhe-kolli',noteSearch:'',selected:new Set(),selecting:false,notesLoading:false,pendingSource:null,outline:[],payment:null,phone:'',waitlisted:false});}
 function startOtpCooldown(){s.resendAt=Date.now()+60000;clearTimeout(otpTimer);otpTimer=setTimeout(()=>{if(!disposed&&s.view==='otp'){const button=root.querySelector('[data-action="resend-otp"]');if(button)button.disabled=false;}},60010);}
 async function initialize(){if(disposed)return;resetAccountState();storageKey=`book-ui:${s.demo?'demo:':''}${s.account.email||normalPhone(s.account.phone)}`;const saved=safeRead(storageKey);if(saved){for(const key of ['book','positions','drafts','pages','sessionId','chatScroll','follow','theme','readerGuideSeen'])if(saved[key]!=null)s[key]=saved[key];s.view=['reader','chat'].includes(saved.view)?saved.view:'reader';}else s.view='reader';await refresh();if(s.sessionId){try{const row=await api.session(s.sessionId);s.messages=row.messages||[];restoreUnanswered();}catch{s.sessionId=null;s.messages=[];}}render();}
 const mediaQuery=win.matchMedia?.('(prefers-color-scheme: dark)');mediaQuery?.addEventListener('change',applyTheme,{signal:lifecycle.signal});
 const viewport=win.visualViewport;
 function keyboard(){if(viewport)doc.documentElement.style.setProperty('--app-height',`${viewport.height}px`);}
 viewport?.addEventListener('resize',keyboard,{signal:lifecycle.signal});keyboard();
 render();
 const ready=(async()=>{try{s.account=await api.me();if(disposed)return;if(s.account)await initialize();else navigate('login');}catch(e){s.error=e.message;navigate('login');}})();
 return{state:s,ready,settled:async()=>{while(pending.size)await Promise.allSettled([...pending]);},dispose(){capture();persist();disposed=true;abortJob();lifecycle.abort();panelFocus.dispose();motion.dispose();clearTimeout(toastTimer);clearTimeout(otpTimer);stopRecording();}};
}
