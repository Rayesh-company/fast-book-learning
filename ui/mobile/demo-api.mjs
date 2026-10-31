/** Explicitly marked, browser-local fixtures. Never calls login, payment, or AI providers. */
export function createDemoApi({storage,delay=650,quota=30,guest=false,loginRequired=false}={}) {
 const key='book-ui-demo-v1';
 const stamp=()=>new Date().toISOString();
 const clone=x=>structuredClone(x);
 let data;
 try {data=JSON.parse(storage?.getItem(key));}catch{}
 const searchParams=typeof location!=='undefined'?new URLSearchParams(location.search):null;
 const asAdmin=Boolean(searchParams&&(searchParams.get('admin')==='1'||searchParams.has('admin')||searchParams.get('view')==='admin'));
 data??={account:guest?null:{phone:'۰۹۱۲۳۴۵۶۷۸۹',email:asAdmin?'admin@rayesh.ir':'',role:asAdmin?'admin':'user'},quota,subscription:null,sessions:[],notes:[],sequence:1,accounts:[
  {email:'admin@rayesh.ir',role:'admin',phone:'09121112233',balance_toman:1500000,today_spend_toman:0,created_at:stamp()},
  {email:'operator1@example.com',role:'operator',phone:'09123456789',balance_toman:450000,today_spend_toman:12000,created_at:stamp()},
  {email:'student@example.com',role:'operator',phone:'09998887766',balance_toman:50000,today_spend_toman:6000,created_at:stamp()}
]};
if(!data.accounts)data.accounts=[
  {email:'admin@rayesh.ir',role:'admin',phone:'09121112233',balance_toman:1500000,today_spend_toman:0,created_at:stamp()},
  {email:'operator1@example.com',role:'operator',phone:'09123456789',balance_toman:450000,today_spend_toman:12000,created_at:stamp()},
  {email:'student@example.com',role:'operator',phone:'09998887766',balance_toman:50000,today_spend_toman:6000,created_at:stamp()}
];
 if(asAdmin&&data?.account){data.account.role='admin';data.account.email='admin@rayesh.ir';}
 const save=()=>{try{storage?.setItem(key,JSON.stringify(data));}catch{}};
 const wait=signal=>new Promise((resolve,reject)=>{
  if(signal?.aborted)return reject(new DOMException('Aborted','AbortError'));
  const done=()=>{signal?.removeEventListener('abort',abort);resolve();};
  const timer=setTimeout(done,delay);
  function abort(){clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(new DOMException('Aborted','AbortError'));}
  signal?.addEventListener('abort',abort,{once:true});
 });
 const session=id=>data.sessions.find(s=>s.id===Number(id));
 return {demo:true,loginRequired,
  get lastAsk(){return data.lastAsk;},
  me:async()=>{if(!loginRequired&&!data.account){data.account={phone:'۰۹۱۲۳۴۵۶۷۸۹',email:'',role:'user'};save();}return clone(data.account);},
  login:async()=>{data.account={phone:'۰۹۱۲۳۴۵۶۷۸۹',role:'user'};save();return clone(data.account);},
  logout:async()=>{data.account=null;save();},
  requestOtp:async phone=>{await wait();return {phone};},
  verifyOtp:async(phone,code)=>{if(code!=='123456')throw new Error('کد نمونه ۱۲۳۴۵۶ است.');data.account={phone,role:'user'};save();return clone(data.account);},
  profile:async()=>({subscription:clone(data.subscription),questions_remaining:data.quota,question_limit:30}),
  getProfile:async()=>({profile:clone(data.account?.profile||null),profile_completed:Boolean(data.account?.profile_completed)}),
  saveProfile:async profile=>{
   if(!data.account)data.account={phone:'۰۹۱۲۳۴۵۶۷۸۹',email:'',role:'user'};
   data.account.profile=clone(profile);
   data.account.profile_completed=Boolean(profile?.assistant_tone||profile?.tone||profile?.usage_purpose||profile?.knowledge_level);
   save();
   return {profile:clone(data.account.profile),profile_completed:data.account.profile_completed};
  },
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
   const page=(input.page??input.pages?.[0])||100;
   const scope=input.scope||'all';
   data.lastAsk={book:input.book,page,scope,selection:input.selection,question:input.question};
   const md = `### راهنمای مطالعه\nبرای فهم این بخش، ابتدا **نکتهٔ اصلی** را با زبان خودتان بیان کنید:\n- یک مثال از *تجربهٔ خودتان* بیاورید.\n- طبق document ${input.book} (page ${page}) تطبیق با متن را بررسی کنید.\n\n> برگشتن به متن و بررسی مثال کمک می‌کند برداشتتان را دقیق‌تر کنید.`;
    return {text:md,
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
  adminAccounts:async()=>clone(data.accounts),
  adminCreateAccount:async({email,password,phone,role='operator',initial_credit=0})=>{
    await wait();
    if(data.accounts.some(a=>a.email===email))throw new Error('این ایمیل پیش‌تر حساب گرفته است.');
    const account={email,role,phone:phone||null,balance_toman:Number(initial_credit)||0,today_spend_toman:0,created_at:stamp()};
    data.accounts.unshift(account);
    save();
    return clone(account);
  },
  adminTopup:async({email,amount})=>{
    await wait();
    const target=data.accounts.find(a=>a.email===email);
    if(!target)throw new Error('حسابی با این ایمیل یافت نشد.');
    target.balance_toman+=Number(amount);
    save();
    return {email,amount_toman:Number(amount),new_balance_toman:target.balance_toman};
  },
  adminTokens: async (limit = 50) => {
    await wait();
    return {
      summary: {
        total_chats: 24,
        avg_mastra_prompt: 2101,
        avg_mastra_completion: 224,
        avg_cognee_embedding: 25,
        avg_cognee_llm: 0,
        avg_total_tokens: 2350,
        search_turns: 14,
        web_turns: 4,
        direct_turns: 6,
        avg_web_prompt: 3420,
        avg_web_completion: 390,
        avg_web_total: 3810,
        avg_cost_toman: 6.2,
        session_growth: [
          {turn: 1, history_messages: 0, history_tokens: 0, direct_input: 1230, search_input: 2850, web_input: 3250},
          {turn: 2, history_messages: 2, history_tokens: 260, direct_input: 1490, search_input: 3110, web_input: 3510},
          {turn: 3, history_messages: 4, history_tokens: 540, direct_input: 1770, search_input: 3390, web_input: 3790},
          {turn: 5, history_messages: 8, history_tokens: 1180, direct_input: 2410, search_input: 4030, web_input: 4430},
          {turn: 8, history_messages: 10, history_tokens: 1680, direct_input: 2910, search_input: 4530, web_input: 4930},
          {turn: 12, history_messages: 10, history_tokens: 1680, direct_input: 2910, search_input: 4530, web_input: 4930},
        ],
        memory_config: {
          last_messages: 10,
          max_tokens_leash: 8000,
          at_max_remove_tokens: 2000,
          working_memory_enabled: true,
          working_memory_scope: 'resource',
          tool_call_filter_active: true,
          tool_call_filter_excluded: ['searchBooksTool', 'webSearchTool'],
          tool_call_filter_savings_per_past_search: '~1,500 - 2,500 tokens'
        },
        avalai_credit: {
          remaining_irt: 2965541.58,
          formatted_irt: '۲,۹۶۵,۵۴۱',
          exchange_rate: 271700,
          account_tier: 2,
          connected: true,
          updated_at: '2026-10-30T10:40:00Z'
        }
      },
      records: [
        {
          request_id: '5f8b06f5e4b5a9e6',
          start_time: '2026-10-30T10:15:20Z',
          phone: '09121112233',
          question: 'نقد های بزرگان دین در مورد این کتاب چیست ؟',
          turn_type: 'web',
          path: 'agent',
          mastra_prompt_tokens: 3420,
          mastra_completion_tokens: 390,
          cognee_embedding_tokens: 0,
          cognee_llm_tokens: 0,
          cognee_calls: 0,
          cognee_passages: 0,
          cognee_latency_ms: 0,
          total_tokens: 3810,
          cost_toman: 10,
        },
        {
          request_id: '300a374b6d0c6456b3ba0dbda8d215f6',
          start_time: '2026-10-30T09:42:10Z',
          phone: '09121112233',
          question: 'مفهوم نبوت در قرآن و کتاب طرح کلی چیست؟',
          turn_type: 'search',
          path: 'agent',
          mastra_prompt_tokens: 2534,
          mastra_completion_tokens: 225,
          cognee_embedding_tokens: 25,
          cognee_llm_tokens: 0,
          cognee_calls: 1,
          cognee_passages: 4,
          cognee_latency_ms: 3.2,
          total_tokens: 2784,
          cost_toman: 7,
        },
        {
          request_id: '7230291fd34f6c034e0aa1082c61cf71',
          start_time: '2026-10-30T09:40:02Z',
          phone: '09123456789',
          question: 'آیا این مفهوم با توحید پیوند مستقیم دارد؟',
          turn_type: 'direct',
          path: 'agent',
          mastra_prompt_tokens: 928,
          mastra_completion_tokens: 180,
          cognee_embedding_tokens: 0,
          cognee_llm_tokens: 0,
          cognee_calls: 0,
          cognee_passages: 0,
          cognee_latency_ms: 0.0,
          total_tokens: 1108,
          cost_toman: 3,
        },
        {
          request_id: '484ae18c859dd9f892d48646c5c9751e',
          start_time: '2026-10-30T09:35:18Z',
          phone: '09998887766',
          question: 'سیره مبارزاتی ائمه اطهار در انسان ۲۵۰ ساله چگونه تحلیل شده است؟',
          turn_type: 'search',
          path: 'agent',
          mastra_prompt_tokens: 2943,
          mastra_completion_tokens: 240,
          cognee_embedding_tokens: 30,
          cognee_llm_tokens: 0,
          cognee_calls: 1,
          cognee_passages: 4,
          cognee_latency_ms: 2.8,
          total_tokens: 3213,
          cost_toman: 8,
        }
      ]
    };  },
 };
}
