/** The current repository's authenticated API; absent launch services fail visibly. */
export function createApi({fetchImpl=fetch}={}) {
 async function request(path,{method='GET',body,signal}={}){
  const r=await fetchImpl(path,{method,signal,credentials:'same-origin',cache:'no-store',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
  let data;try{data=await r.json();}catch{}
  if(!r.ok){const e=new Error(data?.detail||'ارتباط برقرار نشد. دوباره تلاش کنید.');e.status=r.status;throw e;}
  return data;
 }
 const unavailable=async message=>{throw new Error(message);};
 return {demo:false,pageFiltering:false,
  me:async()=>{try{return await request('/auth/me');}catch(e){if(e.status===401)return null;throw e;}},
  login:({email,password})=>request('/auth/login',{method:'POST',body:{email,password}}),
  logout:()=>request('/auth/logout',{method:'POST'}),
  requestOtp:()=>unavailable('ورود پیامکی هنوز فعال نشده است. اگر حساب قبلی دارید از ورود با ایمیل استفاده کنید.'),
  verifyOtp:()=>unavailable('تأیید پیامکی هنوز فعال نشده است.'),
  joinWaitlist:()=>unavailable('ثبت فهرست انتظار هنوز در دسترس نیست. بعداً دوباره تلاش کنید.'),
  profile:async()=>{await request('/profile/data');return{subscription:null,subscription_available:false,questions_remaining:null};},
  sessions:async()=>(await request('/sessions')).sessions,
  session:id=>request(`/sessions/${Number(id)}`),
  createSession:(book,title)=>request('/sessions',{method:'POST',body:{book,title}}),
  renameSession:()=>unavailable('تغییر نام گفتگو در سرویس فعلی هنوز فعال نشده است.'),
  deleteSession:id=>request(`/sessions/${Number(id)}`,{method:'DELETE'}),
  append:(id,role,payload)=>request(`/sessions/${Number(id)}/messages`,{method:'POST',body:{role,payload}}),
  ask:async(input,{signal,onStatus}={})=>{
   // Transitional retrieval/quoted-answer adapter; does not claim to be the new Mastra agent.
   onStatus?.('در حال جستجو در کتاب');
   try{
    const question=input.selection?.text?`${input.question}\n\nمتن انتخاب‌شده از کتاب:\n${input.selection.text}`:input.question;
    const pool=await request('/ask',{method:'POST',signal,body:{query:question,datasets:[input.book]}});
    if(!pool.sources?.length)return{text:'متن مرتبطی از کتاب پیدا نشد. می‌توانید پرسش را دقیق‌تر کنید یا چند جمله از کتاب را انتخاب کنید.',citations:[]};
    onStatus?.('در حال نوشتن پاسخ');
    const result=await request('/quoted-answer',{method:'POST',signal,body:{question,answer:'',sources:pool.sources,chat_id:pool.chat_id,session_id:input.sessionId}});
    if(!result.blocks?.length)throw new Error('پاسخ آماده نشد. دوباره تلاش کنید.');
    return{blocks:result.blocks,citations:pool.sources,text:blocksText(result.blocks)};
   }catch(e){if([402,429].includes(e.status))return{text:e.message,limited:true,citations:[]};throw e;}
  },
  notes:async()=>(await request('/notes')).notes,
  saveNote:note=>request('/notes',{method:'POST',body:note}),
  updateNote:(id,opinion)=>request(`/notes/${Number(id)}`,{method:'POST',body:{opinion}}),
  deleteNotes:ids=>request('/notes/bulk-delete',{method:'POST',body:{ids}}),
  purchase:()=>unavailable('خرید اشتراک هنوز در دسترس نیست. اتصال درگاه پرداخت تکمیل نشده است.'),
  verifyPayment:()=>unavailable('وضعیت پرداخت هنوز تأیید نشده است. دوباره بررسی کنید.'),
  transcribe:()=>unavailable('تبدیل گفتار به متن هنوز فعال نشده است. می‌توانید پرسش را بنویسید.'),
 };
}
export function blocksText(blocks=[]){return blocks.map(b=>b.text||b.parts?.map(p=>p.quote??p.text??'').join(' ')||b.items?.join('\n')||'').filter(Boolean).join('\n\n');}
