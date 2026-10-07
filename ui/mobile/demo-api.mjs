/** Explicitly marked, browser-local fixtures. Never calls login, payment, or AI providers. */
export function createDemoApi({storage,delay=650,quota=30,guest=false,loginRequired=false}={}) {
 const key='book-ui-demo-v1';
 let data;
 try {data=JSON.parse(storage?.getItem(key));}catch{}
 data??={account:guest?null:{phone:'۰۹۱۲۳۴۵۶۷۸۹',email:'',role:'user'},quota,subscription:null,sessions:[],notes:[],sequence:1};
 const save=()=>{try{storage?.setItem(key,JSON.stringify(data));}catch{}};
 const clone=x=>structuredClone(x);
 const stamp=()=>new Date().toISOString();
 const wait=signal=>new Promise((resolve,reject)=>{
  if(signal?.aborted)return reject(new DOMException('Aborted','AbortError'));
  const done=()=>{signal?.removeEventListener('abort',abort);resolve();};
  const timer=setTimeout(done,delay);
  function abort(){clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(new DOMException('Aborted','AbortError'));}
  signal?.addEventListener('abort',abort,{once:true});
 });
 const session=id=>data.sessions.find(s=>s.id===Number(id));
 return {demo:true,loginRequired,
  me:async()=>{if(!loginRequired&&!data.account){data.account={phone:'۰۹۱۲۳۴۵۶۷۸۹',email:'',role:'user'};save();}return clone(data.account);},
  login:async()=>{data.account={phone:'۰۹۱۲۳۴۵۶۷۸۹',role:'user'};save();return clone(data.account);},
  logout:async()=>{data.account=null;save();},
  requestOtp:async phone=>{await wait();return {phone,waitlist:false};},
  verifyOtp:async(phone,code)=>{if(code!=='123456')throw new Error('کد نمونه ۱۲۳۴۵۶ است.');data.account={phone,role:'user'};save();return clone(data.account);},
  joinWaitlist:async phone=>{await wait();return {phone,joined:true};},
  profile:async()=>({subscription:clone(data.subscription),questions_remaining:data.quota,question_limit:30}),
  sessions:async()=>clone([...data.sessions].sort((a,b)=>b.updated_at.localeCompare(a.updated_at))),
  session:async id=>{const s=session(id);if(!s)throw new Error('گفتگو پیدا نشد.');return clone(s);},
  createSession:async(book,title)=>{const s={id:data.sequence++,book,title:title||'گفتگوی تازه',created_at:stamp(),updated_at:stamp(),messages:[]};data.sessions.push(s);save();return clone(s);},
  renameSession:async(id,title)=>{const s=session(id);if(!s)throw new Error('گفتگو پیدا نشد.');s.title=title;save();},
  deleteSession:async id=>{data.sessions=data.sessions.filter(s=>s.id!==Number(id));save();},
  append:async(id,role,payload)=>{const s=session(id);if(!s)throw new Error('گفتگو پیدا نشد.');s.messages.push({id:data.sequence++,role,payload:clone(payload),created_at:stamp()});s.updated_at=stamp();save();},
  ask:async(input,{signal,onStatus}={})=>{
   onStatus?.('در حال جستجو در کتاب');await wait(signal);
   if(data.quota<=0)return {text:'سهمیهٔ پرسش‌های این بازه تمام شده است. مطالعه، یادداشت‌ها و شنیدن کتاب همچنان در دسترس‌اند.',limited:true,citations:[]};
   onStatus?.('در حال نوشتن پاسخ');await wait(signal);data.quota--;save();
   const page=input.pages?.[0]||100;
   return {text:'برای فهم این بخش، ابتدا نکتهٔ اصلی را با زبان خودتان بیان کنید؛ سپس آن را به یک مثال از تجربهٔ خودتان پیوند بدهید. برگشتن به متن و بررسی مثال کمک می‌کند برداشتتان را دقیق‌تر کنید.',
    citations:input.selection?.text?[{doc:input.book,page,text:input.selection.text}]:[],
    study:{doc:input.book,page,text:'این صفحه را دوباره بخوانید و یک نکتهٔ اصلی از آن بنویسید.'},
    outside:/اینترنت|وب/.test(input.question)?[{text:'برای اطلاعات عمومی می‌توانید منبع بیرون از کتاب را بررسی کنید.',url:'https://fa.wikipedia.org/wiki/یادگیری',title:'یادگیری'}]:[]};
  },
  notes:async()=>clone(data.notes),
  saveNote:async note=>{const row={...clone(note),id:data.sequence++,opinion:'',created_at:stamp(),updated_at:stamp()};data.notes.unshift(row);save();return clone(row);},
  updateNote:async(id,opinion)=>{const n=data.notes.find(n=>n.id===Number(id));if(!n)throw new Error('یادداشت پیدا نشد.');n.opinion=opinion;n.updated_at=stamp();save();return clone(n);},
  deleteNotes:async ids=>{data.notes=data.notes.filter(n=>!ids.includes(n.id));save();},
  purchase:async()=>{await wait();return {pending:true,authority:'preview-payment'};},
  verifyPayment:async(authority,outcome='success')=>{await wait();if(outcome==='unknown')return{status:'unknown'};if(outcome!=='success')return{status:outcome};data.subscription={active:true,ends_at:new Date(Date.now()+30*86400000).toISOString()};save();return{status:'success',subscription:clone(data.subscription)};},
  transcribe:async()=>{await wait();return {text:'این قسمت را با یک مثال توضیح بده.'};},
 };
}
