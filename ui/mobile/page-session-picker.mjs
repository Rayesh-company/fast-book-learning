import { sessionForPage } from '../book-reader/lecture-sync.mjs';

export function pageSessionPickerMarkup({inputName='page',page=1}={}) {
  const value=String(page).replace(/\d/g,d=>'۰۱۲۳۴۵۶۷۸۹'[d]);
  return `<div class="page-session-picker" data-page-session-picker><div class="picker-columns"><div class="picker-column"><p>جلسه</p><div class="wheel-frame"><div class="page-wheel" data-session-wheel role="listbox" tabindex="0" aria-label="شمارهٔ جلسه"></div></div></div><div class="picker-column"><p>صفحه</p><div class="wheel-frame"><div class="page-wheel" data-page-wheel role="listbox" tabindex="0" aria-label="شمارهٔ صفحه"></div></div></div></div><label class="picker-direct">شمارهٔ صفحه<input name="${inputName}" inputmode="numeric" value="${value}" aria-label="ورود مستقیم شمارهٔ صفحه"></label><p class="picker-status" data-picker-status role="status"></p></div>`;
}

const digits=value=>String(value).replace(/\d/g,d=>'۰۱۲۳۴۵۶۷۸۹'[d]);
const number=value=>Number(String(value).replace(/[۰-۹]/g,d=>'۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/[٠-٩]/g,d=>'٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
let pickerSequence=0;

export function pagesForSession(sessions,session,count) {
  if (!sessions.length) return Array.from({length:count},(_,i)=>i+1);
  if (session===null) return Array.from({length:count},(_,i)=>i+1).filter(page=>!sessionForPage(sessions,page));
  const selected=sessions.find(s=>s.session===session);
  if (!selected?.book_pages) return [];
  const first=Math.max(1,selected.cover_page??selected.book_pages[0]),last=Math.min(count,selected.book_pages[1]);
  return Array.from({length:Math.max(0,last-first+1)},(_,i)=>first+i);
}

/** Both hosts edit a draft here; only their form's submit commits navigation/context. */
export function installPageSessionPicker({root,page,count,sessions=[],onChange=()=>{}}) {
  const win=root.ownerDocument.defaultView,life=new win.AbortController(),signal=life.signal;
  const id=++pickerSequence,input=root.querySelector('input'),status=root.querySelector('[data-picker-status]');
  const pageWheel=root.querySelector('[data-page-wheel]'),sessionWheel=root.querySelector('[data-session-wheel]');
  let selectedPage=Math.max(1,Math.min(count,page)),selectedSession=sessionForPage(sessions,selectedPage)?.session??null;
  let pageValues=[],sessionValues=[],scrollTimers=new Map(),disposed=false;
  function options(wheel,values,label,current) {
    wheel.replaceChildren(...values.map((value,i)=>{
      const node=root.ownerDocument.createElement('div');node.setAttribute('role','option');node.id=`picker-${id}-${wheel===pageWheel?'page':'session'}-${i}`;
      node.dataset.value=value===null?'none':String(value);node.textContent=label(value);node.setAttribute('aria-selected',String(value===current));return node;
    }));
    wheel.scrollTop=Math.max(0,values.indexOf(current))*44;
    mark(wheel,values,current);
  }
  function mark(wheel,values,value) {
    const at=values.indexOf(value);
    for (const [i,node] of [...wheel.children].entries()) node.setAttribute('aria-selected',String(i===at));
    if (at>=0) wheel.setAttribute('aria-activedescendant',wheel.children[at].id);else wheel.removeAttribute('aria-activedescendant');
  }
  function populatePages() {
    pageValues=pagesForSession(sessions,selectedSession,count);
    if (!pageValues.includes(selectedPage)) selectedPage=pageValues[0]??1;
    options(pageWheel,pageValues,digits,selectedPage);
    input.value=digits(selectedPage);input.max=String(count);
  }
  function changed(){onChange({page:selectedPage,session:selectedSession});}
  function select(wheel,value,{scroll=false}={}) {
    if(disposed)return;
    if(wheel===sessionWheel){if(value===selectedSession)return;selectedSession=value;populatePages();}
    else {if(!pageValues.includes(value))return;selectedPage=value;input.value=digits(value);}
    const values=wheel===sessionWheel?sessionValues:pageValues,current=wheel===sessionWheel?selectedSession:selectedPage;
    mark(wheel,values,current);if(scroll)wheel.scrollTop=Math.max(0,values.indexOf(current))*44;
    changed();
  }
  for (const wheel of [sessionWheel,pageWheel]) {
    wheel.addEventListener('scroll',()=>{
      clearTimeout(scrollTimers.get(wheel));scrollTimers.set(wheel,setTimeout(()=>{
        const values=wheel===sessionWheel?sessionValues:pageValues,index=Math.max(0,Math.min(values.length-1,Math.round(wheel.scrollTop/44)));
        if(values.length)select(wheel,values[index]);
      },140));
    },{signal});
    wheel.addEventListener('click',event=>{const node=event.target.closest('[role="option"]');if(node)select(wheel,node.dataset.value==='none'?null:Number(node.dataset.value),{scroll:true});},{signal});
    wheel.addEventListener('keydown',event=>{
      const offset={ArrowUp:-1,ArrowDown:1,PageUp:-10,PageDown:10}[event.key];
      if(offset===undefined&&!['Home','End'].includes(event.key))return;
      event.preventDefault();const values=wheel===sessionWheel?sessionValues:pageValues,value=wheel===sessionWheel?selectedSession:selectedPage;
      const at=event.key==='Home'?0:event.key==='End'?values.length-1:Math.max(0,Math.min(values.length-1,values.indexOf(value)+offset));
      if(values.length)select(wheel,values[at],{scroll:true});
    },{signal});
  }
  input.addEventListener('input',()=>{
    const value=number(input.value);if(!Number.isInteger(value)||value<1||value>count)return;
    selectedSession=sessionForPage(sessions,value)?.session??null;selectedPage=value;populatePages();
    mark(sessionWheel,sessionValues,selectedSession);sessionWheel.scrollTop=Math.max(0,sessionValues.indexOf(selectedSession))*44;changed();
  },{signal});
  function setSessions(next){
    for(const timer of scrollTimers.values())clearTimeout(timer);
    sessions=next;selectedSession=sessionForPage(sessions,selectedPage)?.session??null;
    sessionValues=sessions.filter(s=>s.book_pages).map(s=>s.session);
    if(pagesForSession(sessions,null,count).length||!sessionValues.length)sessionValues.push(null);
    options(sessionWheel,sessionValues,value=>value===null?'بدون جلسه':`جلسهٔ ${digits(value)}`,selectedSession);
    sessionWheel.setAttribute('aria-disabled',String(!sessions.length));sessionWheel.tabIndex=sessions.length?0:-1;
    populatePages();status.textContent='';
  }
  setSessions(sessions);
  return {setSessions,get value(){return {page:selectedPage,session:selectedSession};},
    dispose(){disposed=true;life.abort();for(const timer of scrollTimers.values())clearTimeout(timer);}};
}

export async function fetchLectureSessions(book,fetchImpl,{signal}={}) {
  if(!fetchImpl)return [];
  const response=await fetchImpl(`/books/${encodeURIComponent(book)}/lectures`,{signal});
  if(response.status===404)return [];
  if(!response.ok)throw new Error('دریافت جلسات ممکن نشد؛ دوباره انتخابگر را باز کنید.');
  const body=await response.json();return body.sessions??[];
}
