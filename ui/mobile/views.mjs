import {icon,iconButton as ib} from './icons.mjs';
import {blocksText} from './api.mjs';
export const books=[{id:'tarhe-kolli',title:'طرح کلی اندیشۀ اسلامی در قرآن',short:'طرح کلی اندیشه',author:'سیدعلی خامنه‌ای',cover:'طرح کلی\nاندیشۀ اسلامی\nدر قرآن',pages:862},{id:'70143-336',title:'انسان ۲۵۰ ساله',short:'انسان ۲۵۰ ساله',author:'سیدعلی خامنه‌ای',cover:'انسان\n۲۵۰ ساله',pages:390}];
export const bookInfo=id=>books.find(b=>b.id===id)||books[0];
export const activePage=s=>s.positions[s.book]?.page||1;
export const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const digits=n=>String(n).replace(/\d/g,c=>'۰۱۲۳۴۵۶۷۸۹'[c]);
export const number=n=>Number(String(n).replace(/[۰-۹]/g,c=>'۰۱۲۳۴۵۶۷۸۹'.indexOf(c)).replace(/[٠-٩]/g,c=>'٠١٢٣٤٥٦٧٨٩'.indexOf(c)));
export const action=(label,name,extra='',cls='')=>`<button type="button" class="${cls}" data-action="${name}" ${extra}>${label}</button>`;
const primary=(label,name,extra='')=>action(label,name,extra,'primary-action');
const date=s=>s?new Date(s).toLocaleDateString('fa-IR',{year:'numeric',month:'long',day:'numeric'}):'';
export const pageLabel=pages=>pages?.length?pages.length===1?`صفحهٔ ${digits(pages[0])}`:`صفحات ${digits(pages[0])} تا ${digits(pages.at(-1))}`:'';
const formError=s=>`<p class="inline-error" role="alert">${esc(s.error)}</p>`;
export function empty(title,description,actions=''){return `<div class="empty-state">${icon('book')}<h2>${title}</h2><p>${description}</p>${actions}</div>`;}
function topbar(s){return `<header class="topbar">${ib('menu',s.view==='reader'?'منوی کتاب‌خوان':'منوی چت','menu')}<div><h3>${s.view==='reader'?esc(bookInfo(s.book).title):'همراه'}</h3>${s.view==='reader'?'':`<p>${esc(bookInfo(s.book).title)}</p>`}</div></header>`;}
const backbar=(title,extra='')=>`<header class="panel-topbar">${ib('chevron','بازگشت','back')}<h1>${title}</h1>${extra}</header>`;
export const CANONICAL_CITATION_REGEX = /\bdocument\s+([\w.-]+)\s*\((pages?\s+(\d+)(?:-(\d+))?)\)/;

function quotePart(part,p){
 const source=p.citations?.[part.source]||{},reference=part.reference||source.reference||'';
 const locator=reference.match(CANONICAL_CITATION_REGEX);
 const book=locator?.[1]||books.find(b=>b.title===part.book_label)?.id||source.doc||p.book||'';
 const page=Number(locator?.[3]||part.first_page_label?.match(/\d+/)?.[0]||source.page)||0;
 const text=part.quote??part.text;
 return `<button class="cite-sent" data-action="citation" data-book="${esc(book)}" data-page="${page}" data-reference="${esc(reference)}" data-text="${esc(text)}" title="${esc(part.pages_label||pageLabel([page]))}">${esc(text)}</button>`;
}
function renderCitationButton(m, doc, label, first, last, p) {
 const page = Number(first) || 0;
 const book = doc || p?.book || '';
 return `<button type="button" class="cite-sent agent-cite" data-action="citation" data-book="${esc(book)}" data-page="${page}" data-reference="${esc(m)}" data-text="${esc(m)}">${esc(m)}</button>`;
}

export function parseInline(raw, p) {
 if (!raw) return '';
 const codeTokens = [];
 let s = String(raw).replace(/`([^`]+)`/g, (_, code) => {
  const token = `\x00CODE_${codeTokens.length}\x00`;
  const citeRegex = new RegExp(CANONICAL_CITATION_REGEX.source, 'g');
  const processedCode = esc(code).replace(citeRegex, (m, doc, label, first, last) =>
   renderCitationButton(m, doc, label, first, last, p)
  );
  codeTokens.push(`<code>${processedCode}</code>`);
  return token;
 });

 const linkTokens = [];
 s = s.replace(/\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^\s)"'<]+)\)/g, (_, label, url) => {
  const token = `\x00LINK_${linkTokens.length}\x00`;
  linkTokens.push({ label, url });
  return token;
 });

 s = esc(s);

 const citeTokens = [];
 const citeRegex = new RegExp(CANONICAL_CITATION_REGEX.source, 'g');
 s = s.replace(citeRegex, (m, doc, label, first, last) => {
  const token = `\x00CITE_${citeTokens.length}\x00`;
  citeTokens.push(renderCitationButton(m, doc, label, first, last, p));
  return token;
 });

 s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
      .replace(/___([^_]+)___/g, '<strong><em>$1</em></strong>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_]+)__/g, '<strong>$1</strong>')
      .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
      .replace(/(^|[^\w\u0600-\u06FF])_([^_]+)_(?=[^\w\u0600-\u06FF]|$)/g, '$1<em>$2</em>')
      .replace(/~~([^~]+)~~/g, '<del>$1</del>');

 s = s.replace(/\x00CITE_(\d+)\x00/g, (_, i) => citeTokens[Number(i)]);
 s = s.replace(/\x00LINK_(\d+)\x00/g, (_, i) => {
  const item = linkTokens[Number(i)];
  return `<a href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">${parseInline(item.label, p)}</a>`;
 });
 s = s.replace(/\x00CODE_(\d+)\x00/g, (_, i) => codeTokens[Number(i)]);

 return s;
}

export function formatAgentMarkdown(text, p = {}) {
 const raw = String(text ?? '').replace(/\r\n?/g, '\n').trim();
 if (!raw) return `<p>${esc(text)}</p>`;

 const lines = raw.split('\n');
 const out = [];
 let i = 0;

 while (i < lines.length) {
  const line = lines[i];

  if (!line.trim()) {
   i++;
   continue;
  }

  const codeFenceMatch = line.match(/^```(\w*)/);
  if (codeFenceMatch) {
   const lang = codeFenceMatch[1] || '';
   i++;
   const codeLines = [];
   while (i < lines.length && !lines[i].startsWith('```')) {
    codeLines.push(lines[i]);
    i++;
   }
   if (i < lines.length && lines[i].startsWith('```')) {
    i++;
   }
   out.push(`<pre><code${lang ? ` class="language-${esc(lang)}"` : ''}>${esc(codeLines.join('\n'))}</code></pre>`);
   continue;
  }

  const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
  if (headingMatch) {
   const level = Math.min(headingMatch[1].length + 1, 6);
   out.push(`<h${level}>${parseInline(headingMatch[2], p)}</h${level}>`);
   i++;
   continue;
  }

  if (/^\s*([-*_]\s*){3,}\s*$/.test(line)) {
   out.push('<hr>');
   i++;
   continue;
  }

  if (/^>\s?(.*)$/.test(line)) {
   const quoteLines = [];
   while (i < lines.length && /^>\s?(.*)$/.test(lines[i])) {
    const m = lines[i].match(/^>\s?(.*)$/);
    quoteLines.push(m ? m[1] : '');
    i++;
   }
   out.push(`<blockquote>${formatAgentMarkdown(quoteLines.join('\n'), p)}</blockquote>`);
   continue;
  }

  const isTableSeparator = s => /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(s);
  const isTableRow = s => Boolean(s && s.includes('|') && !s.startsWith('#') && !s.startsWith('```'));
  if (isTableRow(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
   const tableRows = [];
   while (i < lines.length && isTableRow(lines[i])) {
    tableRows.push(lines[i]);
    i++;
   }
   if (tableRows.length >= 2) {
    const parseRow = row => row.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
    const headerCells = parseRow(tableRows[0]);
    const bodyRows = tableRows.slice(2).map(parseRow);
    const thead = `<thead><tr>${headerCells.map(c => `<th>${parseInline(c, p)}</th>`).join('')}</tr></thead>`;
    const tbody = bodyRows.length ? `<tbody>${bodyRows.map(r => `<tr>${r.map(c => `<td>${parseInline(c, p)}</td>`).join('')}</tr>`).join('')}</tbody>` : '';
    out.push(`<div class="table-wrap"><table>${thead}${tbody}</table></div>`);
    continue;
   }
  }

  const formatTaskItem = it => {
   let taskPrefix = '';
   const taskMatch = it.match(/^\[([ xX])\]\s+(.*)$/);
   if (taskMatch) {
    const checked = taskMatch[1].toLowerCase() === 'x' ? ' checked' : '';
    taskPrefix = `<input type="checkbox" disabled${checked}> `;
    it = taskMatch[2];
   }
   return taskPrefix + it.split('\n').map(l => parseInline(l, p)).join('<br>');
  };

  if (/^\s*[-*+]\s+(.*)$/.test(line)) {
   const items = [];
   while (i < lines.length) {
    const m = lines[i].match(/^\s*[-*+]\s+(.*)$/);
    if (m) {
     items.push(m[1]);
     i++;
    } else if (items.length && /^\s{2,}(.*)$/.test(lines[i])) {
     items[items.length - 1] += '\n' + lines[i].trim();
     i++;
    } else if (items.length && !lines[i].trim() && i + 1 < lines.length && /^\s*[-*+]\s+/.test(lines[i + 1])) {
     i++;
    } else {
     break;
    }
   }
   out.push(`<ul>${items.map(it => `<li>${formatTaskItem(it)}</li>`).join('')}</ul>`);
   continue;
  }

  if (/^\s*([0-9]+|[۰-۹]+)[.)]\s+(.*)$/.test(line)) {
   const items = [];
   while (i < lines.length) {
    const m = lines[i].match(/^\s*([0-9]+|[۰-۹]+)[.)]\s+(.*)$/);
    if (m) {
     items.push(m[2]);
     i++;
    } else if (items.length && /^\s{2,}(.*)$/.test(lines[i])) {
     items[items.length - 1] += '\n' + lines[i].trim();
     i++;
    } else if (items.length && !lines[i].trim() && i + 1 < lines.length && /^\s*([0-9]+|[۰-۹]+)[.)]\s+/.test(lines[i + 1])) {
     const nextNum = lines[i + 1].match(/^\s*([0-9]+|[۰-۹]+)[.)]\s+/)?.[1];
     if (nextNum === '1' || nextNum === '۱') break;
     i++;
    } else {
     break;
    }
   }
   out.push(`<ol>${items.map(it => `<li>${formatTaskItem(it)}</li>`).join('')}</ol>`);
   continue;
  }

  const pLines = [];
  while (i < lines.length) {
   const cur = lines[i];
   if (!cur.trim()) break;
   if (
    /^```/.test(cur) ||
    /^(#{1,6})\s+/.test(cur) ||
    /^\s*([-*_]\s*){3,}\s*$/.test(cur) ||
    /^>\s?/.test(cur) ||
    /^\s*[-*+]\s+/.test(cur) ||
    /^\s*([0-9]+|[۰-۹]+)[.)]\s+/.test(cur) ||
    (isTableRow(cur) && i + 1 < lines.length && isTableSeparator(lines[i + 1]))
   ) {
    break;
   }
   pLines.push(cur);
   i++;
  }
  if (pLines.length) {
   out.push(`<p>${pLines.map(l => parseInline(l, p)).join('<br>')}</p>`);
  }
 }

 return out.join('');
}

export const formatAgentParagraph = formatAgentMarkdown;

function answerBody(p){
 if(p.blocks?.length)return p.blocks.map(b=>b.type==='heading'?`<h3>${esc(b.text)}</h3>`:b.type==='references'?`<h3>منابع</h3>${(b.items||[]).map(x=>`<p>${esc(x)}</p>`).join('')}`:`<p>${b.parts?.length?b.parts.map(part=>part.quote!=null||part.type==='quote'?quotePart(part,p):esc(part.text)).join(' '):esc(b.text)}</p>`).join('');
 return formatAgentMarkdown(p.text, p);
}
export function answer(p,index){return `<article class="assistant" data-message="${index}">${answerBody(p)}${(p.citations||[]).filter(c=>c.doc&&c.page).map(c=>`<p><button class="cite-sent" data-action="citation" data-book="${esc(c.doc)}" data-page="${c.page}" data-text="${esc(c.text)}">${esc(c.text)}</button><button class="cite-pages" data-action="citation" data-book="${esc(c.doc)}" data-page="${c.page}" data-text="${esc(c.text)}">${esc(bookInfo(c.doc).title)} · ${pageLabel([c.page])}</button></p>`).join('')}${p.outside?.length?`<section class="outside-book"><h4>بیرون از کتاب</h4>${p.outside.map(x=>`<p>${esc(x.text)}</p>${/^https?:\/\//.test(x.url||'')?`<a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">${esc(x.title||'منبع وب')} ↗</a>`:''}`).join('')}</section>`:''}<div class="answer-actions">${ib('copy','کپی پاسخ','copy-answer',`data-index="${index}"`)}${ib('save',p.saved?'ذخیره شد':'ذخیره در یادداشت','save-answer',`data-index="${index}" ${p.saved?'disabled':''}`)}${ib('more','بیشتر','answer-more',`data-index="${index}"`)}</div>${p.study?`<div class="study-card"><div class="study-head">${icon('book')}<span>${esc(bookInfo(p.study.doc).title)} · ${pageLabel([p.study.page])}</span></div><p>${esc(p.study.text)}</p>${action('بازکردن کتاب '+icon('book'),'study',`data-book="${esc(p.study.doc)}" data-page="${p.study.page}"`)}</div>`:''}</article>`;}
function message(m,i){const p=m.payload||{};return m.role==='user'?`<div class="user-turn"><div class="user-message">${esc(p.text)}</div><p class="message-context">${esc(bookInfo(p.book).title)}${p.scope!=='all'&&p.pages?.length?' · '+pageLabel(p.pages):''}</p>${p.selection?.text?`<details class="sent-selection"><summary>متن انتخاب‌شده</summary><p>${esc(p.selection.text)}</p></details>`:''}${p.failure?`<p class="inline-error" role="alert">${esc(p.failure)}</p>`:''}${p.failed?`<button class="send-failure" data-action="retry" data-index="${i}">ارسال نشد · تلاش دوباره</button>`:''}</div>`:answer(p,i);}
export const selectionExcerpt=text=>{const words=text.trim().split(/\s+/u);return words.length<=6?text.trim():`${words.slice(0,3).join(' ')} … ${words.slice(-3).join(' ')}`;};
export function composerAction(text,busy,place='chat'){
 const typed=!!text?.trim(),reader=place==='reader';
 return busy?ib('stop','توقف پاسخ','stop','class="composer-action stop-button"'):typed?ib('send','ارسال پیام',reader?'send-reader':'send-chat','class="composer-action send-button"'):ib('mic','شروع ضبط گفتار',reader?'reader-record':'record','class="composer-action mic-button"');
}
function composer(s){const isPage=(s.scope||'page')==='page';const curPage=activePage(s);const label=isPage?(!s.pages?.length||(s.pages.length===1&&s.pages[0]===curPage)?'صفحه فعلی':pageLabel(s.pages)):'کل کتاب';const cls=isPage?'scope-active':'scope-outline';return `<form class="chat-composer" data-chat-form>${s.readerQuestion?.inChat?`<blockquote class="chat-selection-context">${esc(selectionExcerpt(s.readerQuestion.selection.text))}</blockquote>`:''}<textarea name="question" rows="1" aria-label="پیام به همراه" placeholder="از همراه بپرسید…">${esc(s.drafts[s.book]||'')}</textarea><div class="composer-tools"><div class="pages-pill-group"><button type="button" class="pages-button ${cls}" data-action="toggle-scope" aria-label="تغییر دامنهٔ صفحه: ${esc(label)}">${icon('book')}<span>${esc(label)}</span></button><button type="button" class="pages-options-button ${cls}" data-action="pages" aria-label="انتخاب دامنهٔ صفحه">${icon('chevron')}</button></div><div class="send-group">${composerAction(s.drafts[s.book],s.busy)}</div></div></form>`;}
export function floating(s){
 const q=s.readerQuestion;if(!q)return '<div class="reader-floating" hidden></div>';
 if(q.minimised)return `<div class="reader-floating" data-state="minimised">${action(icon('chat')+'بازکردن پرسش','restore','','restore-response')}</div>`;
 return `<div class="reader-floating" data-state="${q.busy?'loading':q.answer?'response':'ready'}"><div class="question-selection"><blockquote class="question-context">${esc(selectionExcerpt(q.selection.text))}</blockquote></div>${q.answer?`<button class="minimise" data-action="minimise">${icon('min')}کوچک‌کردن</button><div class="response-card">${answer(q.answer,'reader')}</div>`:''}<button type="button" class="question-handle" data-question-handle data-action="expand-question" aria-label="بازکردن پرسش در چت؛ برای کوچک‌کردن به پایین بکشید"><span></span></button>${q.busy?`<div class="floating-bar"><div class="send-group">${composerAction('',true,'reader')}</div><p role="status" class="loading-label"><span class="loading-dot"></span>${esc(s.status||'در حال آماده‌کردن پاسخ…')}</p></div>`:`<form class="floating-bar" data-reader-form><div class="send-group">${composerAction(q.draft,false,'reader')}</div><textarea name="reader-question" rows="1" aria-label="پرسش از متن انتخاب‌شده" placeholder="دربارهٔ این متن بپرسید…">${esc(q.draft||'')}</textarea></form>`}${q.error?`<p class="inline-error" role="alert">${esc(q.error)} ${action('تلاش دوباره','send-reader')}</p>`:''}</div>`;
}
function reader(s){return `${topbar(s)}<div class="reader-page" tabindex="0" aria-label="صفحهٔ اصلی PDF"><div class="pdf-surface"><p class="pdf-placeholder" role="status">در حال بازکردن کتاب…</p></div></div><div class="reader-selection-actions" hidden>${action('هایلایت','highlight')}${action('پرسش از همراه','ask-agent')}${action('کپی','copy-selection')}</div>${!s.readerGuideSeen&&!s.readerQuestion?`<aside class="reader-guide" aria-label="راهنمای پرسش از کتاب"><p>بخشی از متن را انتخاب کنید تا از همراه بپرسید یا هایلایت کنید.</p>${ib('close','بستن راهنمای انتخاب متن','dismiss-reader-guide')}</aside>`:''}<div data-reader-floating>${floating(s)}</div><div class="reader-chrome">${lectureBar()}<div class="audio-widget" role="group" aria-label="شنیدن کتاب"><button type="button" class="icon-button" data-audio-previous aria-label="پاراگراف قبلی">${icon('chevron')}</button><button type="button" class="icon-button audio-play" data-audio-play aria-label="پخش کتاب"><svg class="play-symbol" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 11 7-11 7Z"/></svg><svg class="pause-symbol" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14M16 5v14"/></svg></button><button type="button" class="icon-button" data-audio-next aria-label="پاراگراف بعدی">${icon('chevron')}</button></div><button type="button" class="reader-page-badge" data-action="pdf-pages" aria-label="رفتن به صفحه"><span data-page-number>${digits(s.positions[s.book]?.page||100)}</span></button><button type="button" class="lecture-toggle" data-lecture-toggle aria-expanded="false" aria-label="درس‌گفتار جلسه" title="درس‌گفتار جلسه" hidden>${icon('headphones')}</button><p data-reader-audio-status role="status"></p></div><div class="reader-tools" hidden>${readerTools()}</div>`;}
/** Lecture read-along (book-reader/lecture-player.mjs): recorded session audio, sentence highlight on the page. */
function lectureBar(){return `<section class="lecture-bar" data-lecture-bar hidden aria-label="درس‌گفتار جلسه"><div class="lecture-row"><select data-lecture-session aria-label="انتخاب جلسه"></select><button type="button" class="icon-button" data-lecture-back aria-label="ده ثانیه عقب">−۱۰</button><button type="button" class="icon-button audio-play" data-lecture-play aria-label="پخش درس‌گفتار" disabled><svg class="play-symbol" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 11 7-11 7Z"/></svg><svg class="pause-symbol" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14M16 5v14"/></svg></button><button type="button" class="icon-button" data-lecture-forward aria-label="ده ثانیه جلو">+۱۰</button><label class="lecture-skip"><input type="checkbox" data-lecture-skip-intro checked>بدون مقدمه</label></div><div class="lecture-row lecture-timeline"><span data-lecture-time>۰:۰۰</span><input type="range" data-lecture-seek min="0" max="0" step="1" value="0" aria-label="موقعیت صوت"><span data-lecture-duration>۰:۰۰</span></div><p class="lecture-caption" data-lecture-caption></p><p class="lecture-status" data-lecture-status role="status"></p></section>`;}
function readerTools(){return `<button class="sheet-scrim" data-pdf-dismiss hidden aria-label="بستن انتخابگر صفحه"></button><section class="sheet pdf-page-sheet" role="dialog" aria-modal="true" tabindex="-1" hidden aria-label="رفتن به صفحهٔ کتاب"><div class="sheet-title"><h3>صفحهٔ کتاب</h3><button class="icon-button" data-pdf-dismiss aria-label="بستن">${icon('close')}</button></div><div class="wheel-frame"><div class="page-wheel" data-page-wheel role="listbox" tabindex="0" aria-label="شمارهٔ صفحه"></div></div><form data-pdf-page-form><label>شمارهٔ صفحه<input name="page" inputmode="numeric" value="۱۰۰" aria-label="ورود مستقیم شمارهٔ صفحه"></label><p data-pdf-page-count></p><p data-pdf-error role="alert"></p></form></section>`;}

export const USAGE_PURPOSES=[{id:'academic',label:'اکادمیک'},{id:'leisure',label:'مطالعه آزاد'},{id:'learning',label:'یادگیری'},{id:'discussion',label:'مباحثه'},{id:'teaching',label:'آموزش'},{id:'presentation',label:'ارائه'}];
export const FAMILIARITY_LEVELS=[{id:'high',label:'زیاد'},{id:'medium',label:'متوسط'},{id:'low',label:'کم'},{id:'none',label:'آشنایی ندارم'}];
export const ASSISTANT_TONES=[{id:'professional',label:'حرفه‌ای'},{id:'educational',label:'آموزشی'},{id:'kids',label:'برای نوجوان و کودک'},{id:'simple',label:'ساده و روان'}];

function profileSummary(s){
 const prof=s.account?.profile||{};
 const purpose=USAGE_PURPOSES.find(x=>x.id===prof.usage_purpose)?.label;
 const tone=ASSISTANT_TONES.find(x=>x.id===prof.assistant_tone)?.label;
 const martyr=FAMILIARITY_LEVELS.find(x=>x.id===prof.martyr_works_familiarity)?.label;
 const pol=FAMILIARITY_LEVELS.find(x=>x.id===prof.political_familiarity)?.label;
 const rel=FAMILIARITY_LEVELS.find(x=>x.id===prof.religious_familiarity)?.label;
 if(!s.account?.profile_completed&&!purpose)return '<div class="profile-summary"><p class="field-label">مشخصات هنوز ثبت نشده است.</p></div>';
 return `<div class="profile-summary"><div class="profile-row"><span>هدف استفاده</span><strong>${esc(purpose||'ثبت‌نشده')}</strong></div>${tone?`<div class="profile-row"><span>لحن دستیار</span><strong>${esc(tone)}</strong></div>`:''}${martyr?`<div class="profile-row"><span>آشنایی با آثار رهبر شهید</span><strong>${esc(martyr)}</strong></div>`:''}${prof.age?`<div class="profile-row"><span>سن</span><strong>${digits(prof.age)}</strong></div>`:''}${prof.occupation?`<div class="profile-row"><span>شغل</span><strong>${esc(prof.occupation)}</strong></div>`:''}${pol?`<div class="profile-row"><span>آشنایی با سیاست</span><strong>${esc(pol)}</strong></div>`:''}${rel?`<div class="profile-row"><span>آشنایی با مباحث دینی</span><strong>${esc(rel)}</strong></div>`:''}</div>`;
}

export function profileForm(s,{isEdit=false}={}){
 const p=s.account?.profile||{};
 return `<form class="profile-form" ${isEdit?'data-profile-form':'data-onboarding-form'}><div class="question-card"><div class="question-header"><label class="question-title">چه استفاده‌ای می‌خواهید بکنید؟</label><span class="badge-req">اجباری</span></div><p class="question-desc">هدف اصلی خود را از مطالعه و پرسش از همراه انتخاب کنید.</p><div class="options-grid">${USAGE_PURPOSES.map(opt=>`<label class="choice-option"><input type="radio" name="usage_purpose" value="${opt.id}" ${p.usage_purpose===opt.id?'checked':''} required><span>${esc(opt.label)}</span></label>`).join('')}</div></div><div class="question-card"><div class="question-header"><label class="question-title">چقدر با آثار رهبر شهید آشنا هستید؟</label><span class="badge-opt">اختیاری</span></div><div class="options-grid"><label class="choice-option"><input type="radio" name="martyr_works_familiarity" value="" ${!p.martyr_works_familiarity?'checked':''}><span>بدون پاسخ</span></label>${FAMILIARITY_LEVELS.map(opt=>`<label class="choice-option"><input type="radio" name="martyr_works_familiarity" value="${opt.id}" ${p.martyr_works_familiarity===opt.id?'checked':''}><span>${esc(opt.label)}</span></label>`).join('')}</div></div><div class="question-card"><div class="question-header"><label class="question-title" for="profile-age">سن</label><span class="badge-opt">اختیاری</span></div><input type="number" id="profile-age" name="age" min="5" max="120" inputmode="numeric" placeholder="مثلاً: ۲۵" value="${p.age!=null?p.age:''}"></div><div class="question-card"><div class="question-header"><label class="question-title">چقدر با سیاست آشنا هستید؟</label><span class="badge-opt">اختیاری</span></div><div class="options-grid"><label class="choice-option"><input type="radio" name="political_familiarity" value="" ${!p.political_familiarity?'checked':''}><span>بدون پاسخ</span></label>${FAMILIARITY_LEVELS.map(opt=>`<label class="choice-option"><input type="radio" name="political_familiarity" value="${opt.id}" ${p.political_familiarity===opt.id?'checked':''}><span>${esc(opt.label)}</span></label>`).join('')}</div></div><div class="question-card"><div class="question-header"><label class="question-title">چقدر با مباحث دینی آشنا هستید؟</label><span class="badge-opt">اختیاری</span></div><div class="options-grid"><label class="choice-option"><input type="radio" name="religious_familiarity" value="" ${!p.religious_familiarity?'checked':''}><span>بدون پاسخ</span></label>${FAMILIARITY_LEVELS.map(opt=>`<label class="choice-option"><input type="radio" name="religious_familiarity" value="${opt.id}" ${p.religious_familiarity===opt.id?'checked':''}><span>${esc(opt.label)}</span></label>`).join('')}</div></div><div class="question-card"><div class="question-header"><label class="question-title" for="profile-occupation">شغل</label><span class="badge-opt">اختیاری</span></div><input type="text" id="profile-occupation" name="occupation" placeholder="مثلاً: دانشجو، معلم، پژوهشگر…" value="${esc(p.occupation||'')}"></div><div class="question-card"><div class="question-header"><label class="question-title">لحن دستیار چی باشد؟</label><span class="badge-opt">اختیاری</span></div><div class="options-grid"><label class="choice-option"><input type="radio" name="assistant_tone" value="" ${!p.assistant_tone?'checked':''}><span>پیش‌فرض</span></label>${ASSISTANT_TONES.map(opt=>`<label class="choice-option"><input type="radio" name="assistant_tone" value="${opt.id}" ${p.assistant_tone===opt.id?'checked':''}><span>${esc(opt.label)}</span></label>`).join('')}</div></div>${formError(s)}<button type="submit" class="primary-action">${isEdit?'ذخیرهٔ مشخصات':'ثبت و ورود به برنامه'}</button></form>`;
}

function onboardingView(s){
 return `<div class="auth-page onboarding-page"><div class="auth-brand">${icon('book')}<span>شخصی‌سازی همراه مطالعه</span></div><h1>سبک یادگیری و علایق شما</h1><p>پاسخ‌های شما لحن، سطح تحلیل و شیوهٔ پاسخ‌دهی همراه هوشمند را هماهنگ می‌کند. اولین پرسش اجباری است و باقی موارد اختیاری هستند.</p>${profileForm(s,{isEdit:false})}</div>`;
}

export function mainView(s){
 if(s.view==='reader')return reader(s);
 if(s.view==='chat')return `${topbar(s)}<div class="conversation" tabindex="0" aria-label="گفتگو">${s.messages.length?`<p class="date-label">${date(s.messages[0].ts||s.messages[0].created_at||new Date().toISOString())}</p>${s.messages.map(message).join('')}`:empty('از کجای کتاب شروع کنیم؟','اینجا دربارهٔ کتاب بپرسید، برای مطالعه برنامه بگیرید، یا به خواندن ادامه بدهید.',action('پرسیدن از کتاب','suggest-question','','starter')+action('برنامهٔ مطالعه','suggest-plan','','starter')+action('بازگشت به مطالعه','open-reader','','starter'))}${s.busy?`<div class="operation-status" role="status"><span class="loading-dot"></span><span>${esc(s.status)}</span>${action('توقف','stop')}</div>`:''}</div>${action('رفتن به آخر گفتگو '+icon('chevron'),'latest','','jump-latest')}<div data-composer>${composer(s)}</div>`;
 if(s.view==='account')return `${backbar('حساب من')}<div class="panel-body">${s.loginRequired?`<section class="account-section"><h2>حساب</h2><p class="field-label">شمارهٔ موبایل</p><p class="account-phone">${esc(s.account?.phone||'شمارهٔ موبایل ثبت نشده است')}</p>${s.account?.email?`<p class="account-email">${esc(s.account.email)}</p>`:''}${action('خروج از حساب','logout','','text-action')}</section>`:''}<section class="account-section"><h2>مشخصات و سبک یادگیری</h2>${profileSummary(s)}${action('ویرایش مشخصات و نحوهٔ پاسخ‌دهی','edit-profile','','text-action')}</section><section class="account-section"><h2>اشتراک</h2>${subscription(s)}${action('جزئیات اشتراک','subscription','','text-action')}</section><section class="account-section"><h2>تنظیمات</h2><p>نمای برنامه</p><div class="theme-options" role="group" aria-label="نمای برنامه">${['system','light','dark'].map((v,i)=>action(['مطابق دستگاه','روشن','تیره'][i],'theme',`data-theme="${v}" aria-pressed="${s.theme===v}"`)).join('')}</div></section></div>`;
 if(s.view==='profile')return `${backbar('مشخصات و سبک یادگیری')}<div class="panel-body">${profileForm(s,{isEdit:true})}</div>`;
 if(s.view==='onboarding')return onboardingView(s);
 if(s.view==='subscription')return `${backbar('اشتراک')}<div class="panel-body">${subscription(s)}<div class="subscription-offer"><h2>یک ماه، همراه کتاب</h2><p>مطالعهٔ کتاب، یادداشت‌ها و شنیدن صوت؛ همراه با ۳۰ پرسش در هر ۵ ساعت.</p><p class="price">۴۹۰٬۰۰۰ <small>تومان / ماه</small></p>${primary('خرید اشتراک','buy')}<p class="field-label">پرداخت امن از طریق زرین‌پال</p></div>${formError(s)}</div>`;
 if(s.view==='payment')return `${backbar('نتیجهٔ پرداخت')}<div class="panel-body payment-result">${empty(s.payment?.status==='success'?'اشتراک شما فعال شد':s.payment?.status==='failed'?'پرداخت انجام نشد':s.payment?.status==='cancelled'?'پرداخت لغو شد':'در حال بررسی پرداخت',s.payment?.status==='success'?`تا ${date(s.payment.subscription?.ends_at)} همراه کتاب هستید.`:s.payment?.status==='unknown'?'هنوز نتیجهٔ پرداخت مشخص نیست. تأیید نشدن را به معنی شکست پرداخت نمی‌گیریم.':'برای نتیجهٔ قطعی، وضعیت پرداخت باید تأیید شود.',s.payment?.status==='success'?primary('بازگشت به گفتگو','return-activity'):primary(s.payment?.status==='failed'||s.payment?.status==='cancelled'?'تلاش دوباره':'بررسی وضعیت پرداخت',s.payment?.status==='failed'||s.payment?.status==='cancelled'?'buy':'verify-payment')+action('بازگشت','back','','text-action'))}${formError(s)}${s.demo?`<details class="preview-scenarios"><summary>آزمودن نتیجه در پیش‌نمایش</summary>${['success','failed','cancelled','unknown'].map((x,i)=>action(['موفق','ناموفق','انصراف','نامشخص'][i],'payment-outcome',`data-outcome="${x}"`)).join('')}</details>`:''}</div>`;
 if(s.view==='notebook')return notebook(s);
 if(s.view==='note')return noteDetail(s);
 if(['login','otp','waitlist','email-login'].includes(s.view))return auth(s);
 return `<div class="boot-state" role="status">${icon('book')}<p>در حال بازکردن کتاب…</p></div>`;
}
function subscription(s){const p=s.profile||{};return `<div class="subscription-state"><h3>${p.subscription_available===false?'وضعیت اشتراک در دسترس نیست':p.subscription?.active?'اشتراک فعال':'بدون اشتراک فعال'}</h3>${p.subscription?.ends_at?`<p>تاریخ پایان · ${date(p.subscription.ends_at)}</p>`:''}<div class="quota-line"><span>پرسش‌های باقی‌مانده</span><strong>${p.questions_remaining==null?'وضعیت در دسترس نیست':digits(p.questions_remaining)}</strong></div>${p.resets_at?`<p class="field-label">بازهٔ بعد · ${new Date(p.resets_at).toLocaleString('fa-IR')}</p>`:''}</div>`;}
function auth(s){return `<div class="auth-page">${s.view!=='login'?ib('chevron','بازگشت','login-back'):''}<div class="auth-brand">${icon('book')}<span>کتاب و همراه</span></div><h1>${s.view==='otp'?'کد ورود را بنویسید':s.view==='waitlist'?'به فهرست انتظار بپیوندید':s.view==='email-login'?'ورود به حساب قبلی':'از خواندن شروع کنید'}</h1><p>${s.view==='otp'?`کد پیامکی برای ${esc(s.phone)} فرستاده می‌شود.`:s.view==='waitlist'?'ظرفیت ثبت‌نام این دور تکمیل است. با بازشدن ظرفیت، امکان ورود با پذیرش مدیر فراهم می‌شود.':'کتاب را بخوانید، از همراه بپرسید و نکته‌های خودتان را نگه دارید.'}</p><form data-auth-form>${s.view==='email-login'?'<label>ایمیل<input type="email" name="email" autocomplete="username" required></label><label>گذرواژه<input type="password" name="password" autocomplete="current-password" required></label>':s.view==='otp'?'<label>کد شش‌رقمی<input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" dir="ltr" required></label>':`<label>شمارهٔ موبایل<input name="phone" inputmode="tel" autocomplete="tel" dir="ltr" placeholder="0912 345 6789" value="${esc(s.phone||'')}" required></label>`}${formError(s)}<button type="submit" class="primary-action">${s.view==='otp'?'تأیید و ورود':s.view==='waitlist'?'ثبت در فهرست انتظار':s.view==='email-login'?'ورود':'دریافت کد ورود'}</button></form>${s.view==='otp'?action('ارسال دوبارهٔ کد','resend-otp',s.resendAt>Date.now()?'disabled':'','text-action'):s.view==='login'?action('ورود با ایمیل','email-login','','text-action'):''}${s.demo?`<p class="preview-hint">پیش‌نمایش است؛ پیامک فرستاده نمی‌شود. کد نمونه: ۱۲۳۴۵۶</p>${action('دیدن فهرست انتظار','waitlist','','text-action')}`:''}${s.waitlisted?'<p role="status" class="success-message">در فهرست انتظار ثبت شدید.</p>':''}</div>`;}
export function visibleNotes(s){return s.notes.filter(n=>(s.noteBook==='all'||n.doc===s.noteBook||(n.source?.book===s.noteBook))&&(s.noteTab==='highlights'?n.source?.capture==='highlight':n.source?.capture!=='highlight')&&(!s.noteSearch||`${n.text} ${n.opinion}`.includes(s.noteSearch))).sort((a,b)=>s.noteTab==='highlights'?(a.pages?.[0]||0)-(b.pages?.[0]||0):String(b.created_at).localeCompare(String(a.created_at)));}
function notebook(s){const notes=visibleNotes(s);return `${backbar('دفتر یادداشت',ib('more','بیشتر در دفتر','notebook-more'))}<div class="notebook-toolbar"><div class="note-tabs" role="tablist" aria-label="بخش دفتر">${['notes','highlights'].map((x,i)=>`<button role="tab" id="note-tab-${x}" aria-controls="note-panel" tabindex="${s.noteTab===x?0:-1}" aria-selected="${s.noteTab===x}" data-action="note-tab" data-tab="${x}">${['یادداشت‌ها','هایلایت‌ها'][i]}</button>`).join('')}</div><div class="notebook-filters"><label class="sr-only" for="note-book">کتاب یادداشت</label><select id="note-book" name="note-book"><option value="all" ${s.noteBook==='all'?'selected':''}>همهٔ کتاب‌ها</option>${books.map(b=>`<option value="${b.id}" ${s.noteBook===b.id?'selected':''}>${b.title}</option>`).join('')}</select>${action(s.selecting?'انصراف':'انتخاب','select-notes','','text-action')}</div><label class="note-search">${icon('search')}<input name="note-search" value="${esc(s.noteSearch)}" aria-label="جستجو در یادداشت‌ها" placeholder="جستجو در متن و نظر من">${s.noteSearch?ib('close','پاک‌کردن جستجوی یادداشت‌ها','clear-note-search'):''}</label></div><div class="note-list" id="note-panel" role="tabpanel" aria-labelledby="note-tab-${s.noteTab}" tabindex="0">${s.notesLoading?'<p class="skeleton" role="status">در حال دریافت یادداشت‌ها…</p>':notes.length?notes.map(n=>`<div class="note-row">${s.selecting?`<input type="checkbox" name="selected-note" value="${n.id}" ${s.selected.has(n.id)?'checked':''} aria-label="انتخاب یادداشت">`:''}<button data-action="note-open" data-id="${n.id}"><p>${esc(n.text)}</p><small>${n.doc?esc(bookInfo(n.doc).title):'از گفتگوی همراه'}${n.pages?.length?' · '+pageLabel(n.pages):''}</small></button></div>`).join(''):empty(s.noteSearch?'موردی پیدا نشد':'هنوز یادداشتی برای این کتاب ذخیره نکرده‌اید',s.noteSearch?'عبارت کوتاه‌تری را جستجو کنید.':'از پاسخ همراه یک یادداشت ذخیره کنید یا متن کتاب را هایلایت کنید.',s.noteSearch?'':action(s.stack.at(-1)==='chat'?'بازگشت به گفتگو':'بازگشت به کتاب','back','','starter'))}</div>${s.selecting?`<div class="bulk-bar"><span>${digits(s.selected.size)} انتخاب</span>${action('کپی','copy-notes',s.selected.size?'':'disabled')}${action('حذف','delete-notes',s.selected.size?'':'disabled','danger-action')}</div>`:''}${formError(s)}`;}
function noteDetail(s){const n=s.notes.find(n=>n.id===s.noteId);if(!n)return backbar('یادداشت')+empty('یادداشت پیدا نشد','ممکن است از دستگاه دیگری حذف شده باشد.');return `${backbar('یادداشت',ib('more','اقدام‌های یادداشت','note-more'))}<div class="panel-body note-detail"><p class="note-source">${n.doc?esc(bookInfo(n.doc).title):'از گفتگوی همراه'}${n.pages?.length?' · '+pageLabel(n.pages):''}</p><div class="saved-text">${esc(n.text)}</div><section class="opinion"><h2>نظر من</h2>${s.editOpinion?`<label class="sr-only" for="opinion">نظر من</label><textarea id="opinion" name="opinion" maxlength="2000">${esc(n.opinion)}</textarea>${primary('ذخیرهٔ نظر','save-opinion')}${action('انصراف','cancel-opinion','','text-action')}`:`<p>${esc(n.opinion||'می‌توانید برداشت خودتان را اینجا بنویسید.')}</p>${action('ویرایش','edit-opinion','','text-action')}`}</section>${n.doc&&n.pages?.length||n.source?.session_id?action('رفتن به منبع '+icon('book'),'note-source','','source-action'):''}${formError(s)}</div>`;}
export function drawer(s){const nav=(n,text,a)=>`<button class="nav-item" data-action="${a}">${icon(n)}<span>${text}</span></button>`;const groups=[['امروز',0,1],['۷ روز گذشته',1,7],['قدیمی‌تر',7,Infinity]];const today=new Date();today.setHours(0,0,0,0);return `<button class="drawer-scrim" data-action="close-menu" aria-label="بستن منو"></button><aside class="drawer" role="dialog" aria-modal="true" aria-label="${s.view==='reader'?'منوی کتاب‌خوان':'منوی چت'}"><div class="drawer-title"><span>${s.view==='reader'?'کتاب‌خوان':'گفتگوهای شما'}</span>${ib('close','بستن منو','close-menu')}</div><nav class="drawer-nav">${s.view==='reader'?`<div class="reader-nav-group" role="group" aria-label="در کتاب"><p class="reader-nav-label">در کتاب</p>${nav('list','فهرست کتاب','contents')}${nav('search','جستجو در کتاب','book-search')}${nav('book','رفتن به شمارهٔ صفحه','pdf-pages')}</div><div class="reader-nav-group" role="group" aria-label="گفتگو و یادداشت">${nav('notes','دفتر یادداشت','notebook')}${nav('chat','رفتن به چت','open-chat')}</div>`:nav('new','گفتگوی تازه','new-chat')+nav('book','کتاب‌خوان','open-reader')+nav('library','انتخاب کتاب','books')+nav('notes','دفتر یادداشت','notebook')}</nav><div class="history">${s.view==='chat'?s.sessions.length?groups.map(([label,min,max])=>{const rows=s.sessions.filter(r=>{const age=Math.max(0,Math.floor((today-new Date(r.updated_at))/86400000)+1);return age>=min&&age<max;});return rows.length?`<p class="history-label">${label}</p>${rows.map(r=>`<div class="history-item ${s.sessionId===r.id?'current':''}"><button class="history-name" data-action="open-session" data-id="${r.id}">${esc(r.title||'گفتگوی تازه')}<small>${esc(bookInfo(r.book).title)}</small></button>${ib('more','اقدام‌های گفتگو: '+esc(r.title),'session-more',`data-id="${r.id}"`)}</div>`).join('')}`:'';}).join(''):'<p class="history-empty">گفتگوهای شما پس از اولین پرسش اینجا می‌آیند.</p>':''}</div><button class="account-button" data-action="account"><span class="account-icon">${icon('user')}</span><span>${s.loginRequired?'حساب من':'اشتراک و تنظیمات'}<small>${s.profile?.subscription?.active?'اشتراک فعال':s.loginRequired?'مشاهدهٔ اشتراک و تنظیمات':'نمای روشن، تیره یا دستگاه'}</small></span></button></aside>`;}
export function sheet(s){const sh=s.sheet;if(!sh)return '';let body='',title='';
 if(sh.type==='books'){title='انتخاب کتاب';body=books.map(b=>`<button class="book-choice" data-action="select-book" data-book="${b.id}"><span class="book-cover cover-${b.id}">${esc(b.cover)}</span><span><strong>${esc(b.title)}</strong><small>${b.author}</small></span>${s.book===b.id?icon('check'):''}</button>`).join('');}
  if(sh.type==='pages'){title='صفحات زمینهٔ پرسش';body=`<form data-pages-form><p>${esc(bookInfo(s.book).title)}</p>${!s.pageFiltering?'<p class="field-label">صفحات برای مشخص‌کردن بخش مطالعه ثبت می‌شوند؛ جستجوی پاسخ فعلاً در کل کتاب است.</p>':''}<label>شمارهٔ صفحه<input name="single" inputmode="numeric" value="${digits(s.pages?.[0]||activePage(s))}"></label><label class="range-check"><input type="checkbox" name="range" ${s.pages?.length>1?'checked':''}>انتخاب بازه</label><div class="range-inputs" ${s.pages?.length>1?'':'hidden'}><label>از صفحه<input name="from" inputmode="numeric" value="${digits(s.pages?.[0]||1)}"></label><label>تا صفحه<input name="to" inputmode="numeric" value="${digits(s.pages?.at(-1)||1)}"></label></div>${formError(s)}<button class="primary-action" type="submit">تأیید</button>${action('حذف انتخاب صفحات','clear-pages','','clear-pages')}</form>`;}
 if(sh.type==='session-more'){title='گفتگو';body=action('تغییر نام','rename-session')+action('حذف گفتگو','confirm-delete-session','','danger-action');}
 if(sh.type==='rename'){title='تغییر نام گفتگو';body=`<form data-rename-form><label>عنوان گفتگو<input name="title" maxlength="120" value="${esc(sh.title)}" required></label>${formError(s)}<button class="primary-action" type="submit">ذخیره</button></form>`;}
 if(sh.type==='delete-session'){title='حذف گفتگو؟';body=`<p>«${esc(sh.title)}» حذف می‌شود. یادداشت‌های ذخیره‌شده باقی می‌مانند.</p>${primary('حذف','delete-session')}${action('انصراف','close-sheet','','clear-pages')}`;}
 if(sh.type==='delete-notes'){title='حذف یادداشت‌ها؟';body=`<p>${digits(sh.ids.length)} یادداشت حذف می‌شود.</p>${primary('حذف','confirm-delete-notes')}${action('انصراف','close-sheet','','clear-pages')}`;}
 if(sh.type==='note-more'){title='یادداشت';body=action('حذف یادداشت','delete-note','','danger-action');}
 if(sh.type==='notebook-more'){title='دفتر یادداشت';body=action('خروجی PDF از همین فهرست','export-notes');}
 if(sh.type==='answer-more'){title='پاسخ همراه';body=action('پرسیدن دوباره','ask-again')+action('دیدن منابع','answer-sources');}
 if(sh.type==='sources'){title='منابع پاسخ';body=(sh.sources||[]).map(c=>`<p>${esc(c.reference||bookInfo(c.doc).title)}</p><p>${esc(c.passage||c.text)}</p>`).join('')||'<p>این پاسخ منبع صفحه‌دار ندارد.</p>';}
 if(sh.type==='contents'){title='فهرست کتاب';body=s.outline?.length?s.outline.map((x,i)=>action(esc(x.title),'outline-page',`data-index="${i}"`)).join(''):'<p>فهرست قابل‌دسترسی داخل این PDF موجود نیست. از شمارهٔ صفحه یا جستجوی متن استفاده کنید.</p>';}
 if(sh.type==='book-search'){title='جستجو در کتاب';body=`<form data-book-search><label>عبارت جستجو<input name="search" value="${esc(s.bookSearch||'')}" required></label><button class="primary-action" type="submit">جستجو</button></form>${s.searching?'<p role="status">در حال جستجو…</p>':s.searchResults?.map(r=>`<button class="search-result" data-action="search-page" data-page="${r.page}" data-text="${esc(r.text)}"><strong>${pageLabel([r.page])}</strong><p>${esc(r.text)}</p></button>`).join('')||''}${s.searchResults?.length===0?'<p>عبارت در نمایهٔ این کتاب پیدا نشد.</p>':''}${formError(s)}`;}
 if(sh.type==='reading-settings'){title='تنظیمات مطالعه';body='<p>صفحه‌آرایی و قلم کتاب از PDF اصلی حفظ می‌شود.</p>'+action('شمارهٔ صفحه','pdf-pages');}
 if(sh.type==='edit-profile'){title='مشخصات و سبک یادگیری';body=profileForm(s,{isEdit:true});}
 return `<button class="sheet-scrim" data-action="close-sheet" aria-label="بستن پنل"></button><section class="sheet app-sheet" role="dialog" aria-modal="true" aria-label="${title}"><div class="sheet-title"><h3>${title}</h3>${ib('close','بستن پنل','close-sheet')}</div>${body}${!['pages','rename','book-search','edit-profile'].includes(sh.type)?formError(s):''}</section>`;
}
export const completeAnswer=p=>[p.text||blocksText(p.blocks),...(p.outside||[]).map(x=>`بیرون از کتاب\n${x.text}\n${x.title||'منبع وب'}: ${x.url||''}`)].filter(Boolean).join('\n\n');
