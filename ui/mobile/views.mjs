import {icon,iconButton as ib} from './icons.mjs';
import {blocksText} from './api.mjs';
import {pageSessionPickerMarkup} from './page-session-picker.mjs';
import {resolveBookToc,renderTocBodyMarkup} from './book-toc.mjs';
export const books=[{id:'tarhe-kolli',title:'طرح کلی اندیشۀ اسلامی در قرآن',short:'طرح کلی اندیشه',author:'سیدعلی خامنه‌ای',cover:'طرح کلی\nاندیشۀ اسلامی\nدر قرآن',coverImage:'/assets/books/tarhe-kolli.png',pages:862,available:true},{id:'70143-336',title:'انسان ۲۵۰ ساله',short:'انسان ۲۵۰ ساله',author:'سیدعلی خامنه‌ای',cover:'انسان\n۲۵۰ ساله',coverImage:'/assets/books/ensan-250-saleh.png',pages:390,available:false,badge:'به زودی...'}];
export const bookInfo=id=>books.find(b=>b.id===id)||books[0];
export const activePage=s=>s.positions[s.book]?.page||1;
export const isPageBookmarked=(s,page=activePage(s),book=s.book)=>
 (s.notes||[]).some(n=>(n.doc===book||n.source?.book===book)&&n.source?.capture==='bookmark'&&n.pages?.includes(page));
export const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const digits=n=>String(n).replace(/\d/g,c=>'۰۱۲۳۴۵۶۷۸۹'[c]);
export const number=n=>Number(String(n).replace(/[۰-۹]/g,c=>'۰۱۲۳۴۵۶۷۸۹'.indexOf(c)).replace(/[٠-٩]/g,c=>'٠١٢٣٤٥٦٧٨٩'.indexOf(c)));
export const action=(label,name,extra='',cls='')=>`<button type="button" class="${cls}" data-action="${name}" ${extra}>${label}</button>`;
const primary=(label,name,extra='')=>action(label,name,extra,'primary-action');
const date=s=>s?new Date(s).toLocaleDateString('fa-IR',{year:'numeric',month:'long',day:'numeric'}):'';
export const pageLabel=pages=>pages?.length?pages.length===1?`صفحهٔ ${digits(pages[0])}`:`صفحات ${digits(pages[0])} تا ${digits(pages.at(-1))}`:'';
const formError=s=>`<p class="inline-error" role="alert">${esc(s.error)}</p>`;
export function empty(title,description,actions=''){return `<div class="empty-state">${icon('book')}<h2>${title}</h2><p>${description}</p>${actions}</div>`;}
function topbar(s){
 const readerTitle=`<button type="button" class="topbar-toc-trigger" data-action="contents" aria-haspopup="dialog" aria-label="فهرست کتاب: ${esc(bookInfo(s.book).title)}"><h3>${esc(bookInfo(s.book).title)}</h3><span class="topbar-toc-chevron" aria-hidden="true">${icon('chevron')}</span></button>`;
 const bookmarked=isPageBookmarked(s);
 const bookmarkBtn=ib(bookmarked?'bookmarkFilled':'bookmark',bookmarked?'حذف نشان این صفحه':'نشان‌کردن این صفحه','toggle-bookmark',`class="reader-bookmark-btn ${bookmarked?'active':''}" aria-pressed="${bookmarked}"`);
 return `<header class="topbar">${ib('menu',s.view==='reader'?'منوی کتاب‌خوان':'منوی چت','menu')}<div>${s.view==='reader'?readerTitle:`<h3>همراه</h3><p>${esc(bookInfo(s.book).title)}</p>`}</div>${s.view==='chat'?ib('book','بازگشت به آخرین محل مطالعه','open-reader','class="reader-return"'):bookmarkBtn}</header>`;
}
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
function message(m,i){const p=m.payload||{};const ctxLabel=p.sessionContext?(p.sessionContext==='eshareh'?'اشاره':p.sessionContext==='preface'?'مقدمه مؤلف':`جلسه ${digits(p.sessionContext)}`):(p.pages?.length?pageLabel(p.pages):'');return m.role==='user'?`<div class="user-turn"><div class="user-message">${esc(p.text)}</div><p class="message-context">${esc(bookInfo(p.book).title)}${p.scope!=='all'&&ctxLabel?' · '+ctxLabel:''}</p>${p.selection?.text?`<details class="sent-selection"><summary>متن انتخاب‌شده</summary><p>${esc(p.selection.text)}</p></details>`:''}${p.failure?`<p class="inline-error" role="alert">${esc(p.failure)}</p>`:''}${p.failed?`<button class="send-failure" data-action="retry" data-index="${i}">ارسال نشد · تلاش دوباره</button>`:''}</div>`:answer(p,i);}
export const selectionExcerpt=text=>{const words=text.trim().split(/\s+/u);return words.length<=6?text.trim():`${words.slice(0,3).join(' ')} … ${words.slice(-3).join(' ')}`;};
export function composerAction(text,busy,place='chat'){
 const typed=!!text?.trim(),reader=place==='reader';
 return busy?ib('stop','توقف پاسخ','stop','class="composer-action stop-button"'):typed?ib('send','ارسال پیام',reader?'send-reader':'send-chat','class="composer-action send-button"'):ib('mic','شروع ضبط گفتار',reader?'reader-record':'record','class="composer-action mic-button"');
}
function composer(s){const isPage=(s.scope||'page')==='page'||s.scope==='session';const curPage=activePage(s);let label='کل کتاب';if(isPage){if(s.sessionContext!=null){if(s.sessionContext==='eshareh')label='اشاره';else if(s.sessionContext==='preface')label='مقدمه مؤلف';else label=`جلسه ${digits(s.sessionContext)}`;}else{label=(!s.pages?.length||(s.pages.length===1&&s.pages[0]===curPage))?'صفحه فعلی':pageLabel(s.pages);}}const cls='scope-neutral';return `<form class="chat-composer" data-chat-form>${s.readerQuestion?.inChat?`<blockquote class="chat-selection-context">${esc(selectionExcerpt(s.readerQuestion.selection.text))}</blockquote>`:''}<textarea name="question" rows="1" aria-label="پیام به همراه" placeholder="از همراه بپرسید…">${esc(s.drafts[s.book]||'')}</textarea><div class="composer-tools"><div class="pages-pill-group"><button type="button" class="pages-button ${cls}" data-action="toggle-scope" aria-pressed="${isPage}" aria-label="تغییر دامنهٔ صفحه: ${esc(label)}">${icon('book')}<span>${esc(label)}</span></button><button type="button" class="pages-options-button ${cls}" data-action="pages" aria-label="انتخاب دامنهٔ صفحه">${icon('chevron')}</button></div><div class="send-group">${composerAction(s.drafts[s.book],s.busy)}</div></div></form>`;}
export function floating(s){
 const q=s.readerQuestion;if(!q)return '<div class="reader-floating" hidden></div>';
 if(q.minimised)return '<div class="reader-floating" data-state="minimised" hidden></div>';
 return `<div class="reader-floating" data-state="${q.busy?'loading':q.answer?'response':'ready'}"><div class="question-selection"><blockquote class="question-context">${esc(selectionExcerpt(q.selection.text))}</blockquote></div>${q.answer?`<button class="minimise" data-action="minimise">${icon('min')}کوچک‌کردن</button><div class="response-card">${answer(q.answer,'reader')}</div>`:''}<button type="button" class="question-handle" data-question-handle data-action="expand-question" aria-label="بازکردن پرسش در چت؛ برای کوچک‌کردن به پایین بکشید"><span></span></button>${q.busy?`<div class="floating-bar"><div class="send-group">${composerAction('',true,'reader')}</div><p role="status" class="loading-label"><span class="loading-dot"></span>${esc(s.status||'در حال آماده‌کردن پاسخ…')}</p></div>`:`<form class="floating-bar" data-reader-form><div class="send-group">${composerAction(q.draft,false,'reader')}</div><textarea name="reader-question" rows="1" aria-label="پرسش از متن انتخاب‌شده" placeholder="دربارهٔ این متن بپرسید…">${esc(q.draft||'')}</textarea></form>`}${q.error?`<p class="inline-error" role="alert">${esc(q.error)} ${action('تلاش دوباره','send-reader')}</p>`:''}</div>`;
}
function reader(s){return `${topbar(s)}<div class="reader-page" tabindex="0" aria-label="صفحهٔ اصلی PDF"><div class="pdf-surface"><p class="pdf-placeholder" role="status">در حال بازکردن کتاب…</p></div></div><button type="button" class="reader-edge-tap reader-edge-next" data-action="reader-next-page" aria-label="صفحهٔ بعد" tabindex="-1"></button><button type="button" class="reader-edge-tap reader-edge-prev" data-action="reader-prev-page" aria-label="صفحهٔ قبل" tabindex="-1"></button><div class="reader-selection-actions" hidden>${action('هایلایت','highlight')}${action('پرسش از همراه','ask-agent')}${action('کپی','copy-selection')}</div>${!s.readerGuideSeen&&!s.readerQuestion?`<aside class="reader-guide" aria-label="راهنمای پرسش از کتاب"><p>بخشی از متن را انتخاب کنید تا از همراه بپرسید یا هایلایت کنید.</p>${ib('close','بستن راهنمای انتخاب متن','dismiss-reader-guide')}</aside>`:''}<div data-reader-floating>${floating(s)}</div><button type="button" class="lecture-scrim" data-player-scrim aria-label="بستن پنل صوتی" hidden></button><div class="reader-chrome" data-question-open="${Boolean(s.readerQuestion && !s.readerQuestion.minimised)}"><section class="lecture-player" data-lecture-player aria-label="پخش صوت جلسه"><div class="player-mini-progress" data-lecture-mini-progress style="width:0%"></div>${lectureBar()}<div class="audio-widget" role="group" aria-label="شنیدن جلسه"><button type="button" class="player-expand" data-player-expand aria-expanded="false" aria-controls="lecture-details" aria-label="بازکردن امکانات پلیر"><span class="expand-handle-pill" aria-hidden="true"></span><div class="mini-session-meta"><span class="mini-session-badge" data-mini-session>جلسه</span><span class="mini-chevron" aria-hidden="true">${icon('chevron')}</span></div></button><div class="audio-transport"><button type="button" class="icon-button transport-step transport-paragraph" data-audio-next aria-label="پاراگراف بعدی" title="پاراگراف بعدی" disabled><svg class="step-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6h2.5v12H6V6zm3.5 6 9.5 6.5V5.5L9.5 12z"/></svg><span class="step-text">پاراگراف بعد</span></button><button type="button" class="icon-button transport-step transport-seconds" data-lecture-back aria-label="ده ثانیه عقب" title="ده ثانیه عقب" disabled><svg class="step-icon seek-10-svg back-10-icon" viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7.5 8.7A9.2 9.2 0 1 0 13 6.05"/><path d="M15.8 3.5 13 6.05l2.8 2.55"/></svg><span class="step-text" aria-hidden="true">۱۰ ثانیه</span></button><button type="button" class="icon-button audio-play" data-audio-play aria-label="پخش درس‌گفتار" disabled><svg class="play-symbol" viewBox="0 0 24 24" aria-hidden="true"><path d="M8.6 5.6c0-.78.85-1.26 1.52-.85l10.05 6.4c.64.41.64 1.29 0 1.7l-10.05 6.4c-.67.41-1.52-.07-1.52-.85V5.6Z"/></svg><svg class="pause-symbol" viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="5.5" width="3.6" height="13" rx="1.3"/><rect x="13.4" y="5.5" width="3.6" height="13" rx="1.3"/></svg></button><button type="button" class="icon-button transport-step transport-seconds" data-lecture-forward aria-label="ده ثانیه جلو" title="ده ثانیه جلو" disabled><svg class="step-icon seek-10-svg forward-10-icon" viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.5 8.7A9.2 9.2 0 1 1 15 6.05"/><path d="M12.2 3.5 15 6.05l-2.8 2.55"/></svg><span class="step-text" aria-hidden="true">۱۰ ثانیه</span></button><button type="button" class="icon-button transport-step transport-paragraph" data-audio-previous aria-label="پاراگراف قبلی" title="پاراگراف قبلی" disabled><span class="step-text">پاراگراف قبل</span><svg class="step-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 18.5 9.5-6.5L5 5.5v13zM15.5 6H18v12h-2.5V6z"/></svg></button></div></div><p class="lecture-status" data-lecture-status role="status"></p></section><button type="button" class="reader-page-badge" data-action="pdf-pages" aria-label="رفتن به صفحه"><span data-page-number>${digits(s.positions[s.book]?.page||100)}</span></button><button type="button" class="reader-chat-badge" data-action="restore" aria-label="پرسش از همراه"><span>${icon('chat')}</span></button></div><div class="reader-tools" hidden>${readerTools(s)}</div>`;}
function lectureBar(){const rates=[0.75,1,1.25,1.5,2];return `<div id="lecture-details" class="lecture-details" data-lecture-bar hidden><div class="lecture-sheet-handle" data-lecture-handle aria-label="بستن پلیر با کشیدن به پایین"><span></span></div><div class="lecture-heading"><span class="lecture-historical-tag">درس‌گفتار مسجد امام حسن مجتبی (ع) · مشهد ۱۳۵۳</span><button type="button" class="icon-button collapse-button" data-player-collapse aria-label="کوچک‌کردن پلیر">${icon('close')}</button></div><p class="lecture-caption sr-only" data-lecture-caption hidden aria-hidden="true"></p><div class="lecture-controls-row lecture-footer-row"><label class="lecture-session-picker-wrap"><select data-lecture-session aria-label="انتخاب جلسه" disabled></select><span class="session-select-chevron" aria-hidden="true">${icon('chevron')}</span></label><div class="lecture-rate-wrap" data-lecture-rate-wrap><button type="button" class="lecture-rate-chip" data-lecture-rate data-rate="1" aria-expanded="false" aria-controls="lecture-rate-panel" aria-label="سرعت پخش ۱ برابر" disabled><span class="rate-label">سرعت</span><span class="rate-value" data-rate-value dir="ltr">۱×</span></button><div id="lecture-rate-panel" class="lecture-rate-popover" data-lecture-rate-panel role="group" aria-label="انتخاب سرعت پخش" hidden>${rates.map(r=>`<button type="button" class="rate-option" data-rate-option="${r}" aria-pressed="${r===1}"><span class="rate-option-text" dir="ltr">${digits(r)}×</span>${icon('check')}</button>`).join('')}</div></div><label class="lecture-skip-toggle"><input type="checkbox" data-lecture-skip-intro checked><span class="toggle-track" aria-hidden="true"><span class="toggle-thumb"></span></span><span class="toggle-label">بدون مقدمه</span></label></div><div class="lecture-timeline-wrap"><div class="lecture-timeline-capsule"><span class="timeline-time time-current" data-lecture-time>۰:۰۰</span><div class="scrubber-track-wrap"><input type="range" data-lecture-seek min="0" max="0" step="1" value="0" aria-label="موقعیت صوت" disabled></div><span class="timeline-time time-duration" data-lecture-duration>۰:۰۰</span></div></div></div>`;}
function readerTools(s){return `<button class="sheet-scrim" data-pdf-dismiss hidden aria-label="بستن ابزار مطالعه"></button><section class="sheet pdf-page-sheet" role="dialog" aria-modal="true" tabindex="-1" hidden aria-label="رفتن به صفحهٔ کتاب"><div class="sheet-title"><h3>صفحه و جلسهٔ کتاب</h3><button class="icon-button" data-pdf-dismiss aria-label="بستن">${icon('close')}</button></div><form data-pdf-page-form>${pageSessionPickerMarkup({page:activePage(s)})}<p data-pdf-page-count></p><p data-pdf-error role="alert"></p><button type="submit" class="primary-action">تأیید</button></form></section>`;}

export const USAGE_PURPOSES=[{id:'academic',label:'اکادمیک'},{id:'leisure',label:'مطالعه آزاد'},{id:'learning',label:'یادگیری'},{id:'discussion',label:'مباحثه'},{id:'teaching',label:'آموزش'},{id:'presentation',label:'ارائه'}];
export const FAMILIARITY_LEVELS=[{id:'high',label:'زیاد'},{id:'medium',label:'متوسط'},{id:'low',label:'کم'},{id:'none',label:'آشنایی ندارم'}];
export const ASSISTANT_TONES=[{id:'professional',label:'حرفه‌ای'},{id:'educational',label:'آموزشی'},{id:'kids',label:'برای نوجوان و کودک'},{id:'simple',label:'ساده و روان'}];

function profileSummary(s){
 const prof=s.account?.profile||{};
 const tone=ASSISTANT_TONES.find(x=>x.id===(prof.assistant_tone||prof.tone))?.label;
 const knowledge=FAMILIARITY_LEVELS.find(x=>x.id===(prof.knowledge_level||prof.martyr_works_familiarity||prof.martyr_leader_familiarity))?.label;
 const purpose=USAGE_PURPOSES.find(x=>x.id===prof.usage_purpose)?.label;
 if(!s.account?.profile_completed&&!tone)return '<div class="profile-summary"><p class="field-label">مشخصات هنوز ثبت نشده است.</p></div>';
 return `<div class="profile-summary">${tone?`<div class="profile-row"><span>لحن همراه</span><strong>${esc(tone)}</strong></div>`:''}${knowledge?`<div class="profile-row"><span>میزان آشنایی</span><strong>${esc(knowledge)}</strong></div>`:''}${prof.age?`<div class="profile-row"><span>سن</span><strong>${digits(prof.age)}</strong></div>`:''}${purpose?`<div class="profile-row"><span>هدف استفاده</span><strong>${esc(purpose)}</strong></div>`:''}</div>`;
}

export function profileForm(s,{isEdit=false}={}){
 const p=s.account?.profile||{};
 const selectedTone=p.assistant_tone||p.tone||'';
 const selectedKnowledge=p.knowledge_level||p.martyr_works_familiarity||p.martyr_leader_familiarity||'';
 return `<form class="profile-form" ${isEdit?'data-profile-form':'data-onboarding-form'}><div class="question-card"><div class="question-header"><label class="question-title">لحن همراه هوشمند چی باشد؟</label><span class="badge-req">اجباری</span></div><p class="question-desc">لحن و شیوهٔ گفتگوی همراه را بر اساس سلیقه و نیاز خود انتخاب کنید.</p><div class="options-grid">${ASSISTANT_TONES.map(opt=>`<label class="choice-option"><input type="radio" name="assistant_tone" value="${opt.id}" ${selectedTone===opt.id?'checked':''} required><span>${esc(opt.label)}</span></label>`).join('')}</div></div><div class="question-card"><div class="question-header"><label class="question-title" for="profile-age">سن شما</label><span class="badge-opt">اختیاری</span></div><input type="number" id="profile-age" name="age" min="5" max="120" inputmode="numeric" placeholder="مثلاً: ۲۵" value="${p.age!=null?p.age:''}"></div><div class="question-card"><div class="question-header"><label class="question-title">میزان آشنایی و دانش شما با مباحث کتاب‌ها چقدر است؟</label><span class="badge-opt">اختیاری</span></div><div class="options-grid"><label class="choice-option"><input type="radio" name="knowledge_level" value="" ${!selectedKnowledge?'checked':''}><span>بدون پاسخ</span></label>${FAMILIARITY_LEVELS.map(opt=>`<label class="choice-option"><input type="radio" name="knowledge_level" value="${opt.id}" ${selectedKnowledge===opt.id?'checked':''}><span>${esc(opt.label)}</span></label>`).join('')}</div></div>${formError(s)}<button type="submit" class="primary-action">${isEdit?'ذخیرهٔ مشخصات':'ثبت و ورود به برنامه'}</button></form>`;
}

function onboardingView(s){
 return `<div class="auth-page onboarding-page"><div class="auth-brand">${icon('book')}<span>شخصی‌سازی همراه مطالعه</span></div><h1>سبک یادگیری و شخصی‌سازی همراه</h1><p>برای تنظیم دقیق‌تر پاسخ‌ها و لحن همراه هوشمند، این ۳ پرسش کوتاه را پاسخ دهید. انتخاب لحن همراه اجباری است و باقی موارد اختیاری هستند.</p>${profileForm(s,{isEdit:false})}</div>`;
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
export function visibleNotes(s){return s.notes.filter(n=>(s.noteBook==='all'||n.doc===s.noteBook||(n.source?.book===s.noteBook))&&(s.noteTab==='highlights'?n.source?.capture==='highlight':s.noteTab==='bookmarks'?n.source?.capture==='bookmark':(n.source?.capture!=='highlight'&&n.source?.capture!=='bookmark'))&&(!s.noteSearch||`${n.text} ${n.opinion}`.includes(s.noteSearch))).sort((a,b)=>(s.noteTab==='highlights'||s.noteTab==='bookmarks')?(a.pages?.[0]||0)-(b.pages?.[0]||0):String(b.created_at).localeCompare(String(a.created_at)));}
function notebook(s){const notes=visibleNotes(s);const tabs=[{id:'notes',label:'یادداشت‌ها'},{id:'highlights',label:'هایلایت‌ها'},{id:'bookmarks',label:'بوک‌مارک‌ها'}];return `${backbar('دفتر یادداشت',ib('more','بیشتر در دفتر','notebook-more'))}<div class="notebook-toolbar"><div class="note-tabs" role="tablist" aria-label="بخش دفتر">${tabs.map(t=>`<button role="tab" id="note-tab-${t.id}" aria-controls="note-panel" tabindex="${s.noteTab===t.id?0:-1}" aria-selected="${s.noteTab===t.id}" data-action="note-tab" data-tab="${t.id}">${t.label}</button>`).join('')}</div><div class="notebook-filters"><label class="sr-only" for="note-book">کتاب یادداشت</label><select id="note-book" name="note-book"><option value="all" ${s.noteBook==='all'?'selected':''}>همهٔ کتاب‌ها</option>${books.map(b=>`<option value="${b.id}" ${s.noteBook===b.id?'selected':''}>${b.title}</option>`).join('')}</select>${action(s.selecting?'انصراف':'انتخاب','select-notes','','text-action')}</div><label class="note-search">${icon('search')}<input name="note-search" value="${esc(s.noteSearch)}" aria-label="جستجو در یادداشت‌ها" placeholder="جستجو در متن و نظر من">${s.noteSearch?ib('close','پاک‌کردن جستجوی یادداشت‌ها','clear-note-search'):''}</label></div><div class="note-list" id="note-panel" role="tabpanel" aria-labelledby="note-tab-${s.noteTab}" tabindex="0">${s.notesLoading?'<p class="skeleton" role="status">در حال دریافت یادداشت‌ها…</p>':notes.length?notes.map(n=>`<div class="note-row">${s.selecting?`<input type="checkbox" name="selected-note" value="${n.id}" ${s.selected.has(n.id)?'checked':''} aria-label="انتخاب یادداشت">`:''}<button data-action="note-open" data-id="${n.id}"><p>${esc(n.text)}</p><small>${n.source?.capture==='bookmark'?'نشان‌شده · ':''}${n.doc?esc(bookInfo(n.doc).title):'از گفتگوی همراه'}${n.pages?.length?' · '+pageLabel(n.pages):''}</small></button></div>`).join(''):empty(s.noteSearch?'موردی پیدا نشد':s.noteTab==='bookmarks'?'هنوز صفحه‌ای را در این کتاب نشان نکرده‌اید':s.noteTab==='highlights'?'هنوز هایلایتی برای این کتاب ذخیره نکرده‌اید':'هنوز یادداشتی برای این کتاب ذخیره نکرده‌اید',s.noteSearch?'عبارت کوتاه‌تری را جستجو کنید.':s.noteTab==='bookmarks'?'در صفحهٔ کتابخوان دکمهٔ نشان را لمس کنید تا صفحات منتخب اینجا ذخیره شوند.':s.noteTab==='highlights'?'بخشی از متن کتاب را انتخاب کرده و هایلایت کنید.':'از پاسخ همراه یک یادداشت ذخیره کنید یا متن کتاب را هایلایت کنید.',s.noteSearch?'':action(s.stack.at(-1)==='chat'?'بازگشت به گفتگو':'بازگشت به کتاب','back','','starter'))}</div>${s.selecting?`<div class="bulk-bar"><span>${digits(s.selected.size)} انتخاب</span>${action('کپی','copy-notes',s.selected.size?'':'disabled')}${action('حذف','delete-notes',s.selected.size?'':'disabled','danger-action')}</div>`:''}${formError(s)}`;}
function noteDetail(s){const n=s.notes.find(n=>n.id===s.noteId);if(!n)return backbar('یادداشت')+empty('یادداشت پیدا نشد','ممکن است از دستگاه دیگری حذف شده باشد.');return `${backbar('یادداشت',ib('more','اقدام‌های یادداشت','note-more'))}<div class="panel-body note-detail"><p class="note-source">${n.doc?esc(bookInfo(n.doc).title):'از گفتگوی همراه'}${n.pages?.length?' · '+pageLabel(n.pages):''}</p><div class="saved-text">${esc(n.text)}</div><section class="opinion"><h2>نظر من</h2>${s.editOpinion?`<label class="sr-only" for="opinion">نظر من</label><textarea id="opinion" name="opinion" maxlength="2000">${esc(n.opinion)}</textarea>${primary('ذخیرهٔ نظر','save-opinion')}${action('انصراف','cancel-opinion','','text-action')}`:`<p>${esc(n.opinion||'می‌توانید برداشت خودتان را اینجا بنویسید.')}</p>${action('ویرایش','edit-opinion','','text-action')}`}</section>${n.doc&&n.pages?.length||n.source?.session_id?action('رفتن به منبع '+icon('book'),'note-source','','source-action'):''}${formError(s)}</div>`;}
export function drawerSectionMarkup({id,iconName,title,count,expanded,itemsHtml}){
 return `<div class="drawer-accordion-section" data-section-id="${id}"><button type="button" class="drawer-accordion-trigger" data-action="toggle-drawer-section" data-section="${id}" aria-expanded="${expanded}"><span class="trigger-main">${icon(iconName)}<span>${title}</span></span><span class="trigger-side">${count>0?`<span class="section-count-badge">${digits(count)}</span>`:''}<span class="section-chevron ${expanded?'is-open':''}" aria-hidden="true">${icon('chevron')}</span></span></button><div class="drawer-accordion-content" ${expanded?'':'hidden'}>${itemsHtml}</div></div>`;
}
export function drawerSections(s){
 const expanded=s.drawerSections||{highlights:true,bookmarks:true,notes:true};
 const bookNotes=(s.notes||[]).filter(n=>(n.doc===s.book||n.source?.book===s.book));
 const highlights=bookNotes.filter(n=>n.source?.capture==='highlight').sort((a,b)=>(a.pages?.[0]||0)-(b.pages?.[0]||0));
 const bookmarks=bookNotes.filter(n=>n.source?.capture==='bookmark').sort((a,b)=>(a.pages?.[0]||0)-(b.pages?.[0]||0));
 const notes=bookNotes.filter(n=>n.source?.capture!=='highlight'&&n.source?.capture!=='bookmark').sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at)));
 return `<div class="drawer-sections-wrap">`+
  drawerSectionMarkup({
   id:'highlights',
   iconName:'highlighter',
   title:'هایلایت‌ها',
   count:highlights.length,
   expanded:Boolean(expanded.highlights),
   itemsHtml:highlights.length?highlights.map(n=>`<button type="button" class="drawer-subitem" data-action="drawer-highlight" data-id="${n.id}"><span class="subitem-text">${esc(n.text)}</span><span class="subitem-meta">${n.pages?.length?pageLabel(n.pages):''}</span></button>`).join(''):'<p class="drawer-section-empty">هنوز هایلایتی ذخیره نشده است.</p>'
  })+
  drawerSectionMarkup({
   id:'bookmarks',
   iconName:'bookmark',
   title:'بوک‌مارک‌ها',
   count:bookmarks.length,
   expanded:Boolean(expanded.bookmarks),
   itemsHtml:bookmarks.length?bookmarks.map(n=>{const pg=n.pages?.[0]||1;return `<button type="button" class="drawer-subitem" data-action="drawer-bookmark" data-page="${pg}"><span class="subitem-title">صفحهٔ ${digits(pg)}</span><span class="subitem-meta">${esc(bookInfo(n.doc||s.book).title)}</span></button>`;}).join(''):'<p class="drawer-section-empty">هنوز صفحه‌ای نشان نشده است.</p>'
  })+
  drawerSectionMarkup({
   id:'notes',
   iconName:'notes',
   title:'یادداشت‌ها',
   count:notes.length,
   expanded:Boolean(expanded.notes),
   itemsHtml:notes.length?notes.map(n=>`<button type="button" class="drawer-subitem" data-action="drawer-note" data-id="${n.id}"><span class="subitem-text">${esc(n.text)}</span><span class="subitem-meta">${n.doc?esc(bookInfo(n.doc).title):'از گفتگوی همراه'}${n.pages?.length?' · '+pageLabel(n.pages):''}</span></button>`).join(''):'<p class="drawer-section-empty">هنوز یادداشتی ذخیره نشده است.</p>'
  })+
 `</div>`;
}
export function drawer(s){const nav=(n,text,a)=>`<button class="nav-item" data-action="${a}">${icon(n)}<span>${text}</span></button>`;const groups=[['امروز',0,1],['۷ روز گذشته',1,7],['قدیمی‌تر',7,Infinity]];const today=new Date();today.setHours(0,0,0,0);return `<button class="drawer-scrim" data-action="close-menu" aria-label="بستن منو"></button><aside class="drawer" role="dialog" aria-modal="true" aria-label="${s.view==='reader'?'منوی کتاب‌خوان':'منوی چت'}"><div class="drawer-title"><span>${s.view==='reader'?'کتاب‌خوان':'گفتگوهای شما'}</span>${ib('close','بستن منو','close-menu')}</div><nav class="drawer-nav">${s.view==='reader'?`<div class="reader-nav-group" role="group" aria-label="در کتاب"><p class="reader-nav-label">در کتاب</p>${nav('list','فهرست کتاب','contents')}${nav('search','جستجو در کتاب','book-search')}</div><div class="reader-nav-group" role="group" aria-label="گفتگو و یادداشت">${nav('chat','رفتن به چت','open-chat')}${nav('notes','دفتر یادداشت','notebook')}${drawerSections(s)}</div>`:nav('new','گفتگوی تازه','new-chat')+nav('book','کتاب‌خوان','open-reader')+nav('library','انتخاب کتاب','books')+nav('notes','دفتر یادداشت','notebook')}</nav><div class="history">${s.view==='chat'?s.sessions.length?groups.map(([label,min,max])=>{const rows=s.sessions.filter(r=>{const age=Math.max(0,Math.floor((today-new Date(r.updated_at))/86400000)+1);return age>=min&&age<max;});return rows.length?`<p class="history-label">${label}</p>${rows.map(r=>`<div class="history-item ${s.sessionId===r.id?'current':''}"><button class="history-name" data-action="open-session" data-id="${r.id}">${esc(r.title||'گفتگوی تازه')}<small>${esc(bookInfo(r.book).title)}</small></button>${ib('more','اقدام‌های گفتگو: '+esc(r.title),'session-more',`data-id="${r.id}" aria-haspopup="menu" aria-expanded="false"`)}</div>`).join('')}`:'';}).join(''):'<p class="history-empty">گفتگوهای شما پس از اولین پرسش اینجا می‌آیند.</p>':''}</div><button class="account-button" data-action="account"><span class="account-icon">${icon('user')}</span><span>${s.loginRequired?'حساب من':'اشتراک و تنظیمات'}<small>${s.profile?.subscription?.active?'اشتراک فعال':s.loginRequired?'مشاهدهٔ اشتراک و تنظیمات':'نمای روشن، تیره یا دستگاه'}</small></span></button></aside>`;}
export function renderSearchSnippet(snippet, query){
 if(!snippet)return '';
 const cleanSnippet=String(snippet).replace(/[\x00-\x1f]/g,' ');
 const safeText=esc(cleanSnippet);
 if(!query?.trim())return safeText;
 const terms=query.trim().split(/\s+/).filter(Boolean).map(t=>t.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'));
 if(!terms.length)return safeText;
 const pattern=new RegExp(`(${terms.join('|')})`,'gi');
 return safeText.replace(pattern,'<mark class="search-match">$1</mark>');
}

export function sheet(s){const sh=s.sheet;if(!sh)return '';let body='',title='';
 if(sh.type==='books'){title='انتخاب کتاب';body=books.map(b=>{const isCurrent=s.book===b.id;const disabled=b.available===false;const coverHtml=b.coverImage?`<img class="book-cover-img" src="${b.coverImage}" alt="${esc(b.title)}" width="52" height="74" loading="lazy">`:esc(b.cover);return `<button class="book-choice ${disabled?'book-choice-disabled':''}" data-action="select-book" data-book="${b.id}" ${disabled?'aria-disabled="true" tabindex="-1"':''}><span class="book-cover cover-${b.id} ${b.coverImage?'has-cover-img':''}">${coverHtml}</span><span class="book-info"><strong>${esc(b.title)}</strong><small>${b.author}${disabled?' · <span class="badge-coming-soon">به زودی...</span>':''}</small></span>${isCurrent?icon('check'):disabled?'<span class="status-pill-soon">به زودی...</span>':''}</button>`;}).join('');}
  if(sh.type==='pages'){title='صفحه و جلسهٔ پرسش';body=`<form data-pages-form><p>${esc(bookInfo(s.book).title)}</p>${!s.pageFiltering?'<p class="field-label">صفحات برای مشخص‌کردن بخش مطالعه ثبت می‌شوند؛ جستجوی پاسخ فعلاً در کل کتاب است.</p>':''}${pageSessionPickerMarkup({inputName:'single',page:s.pages?.[0]||activePage(s)})}<label class="range-check"><input type="checkbox" name="range" ${s.pages?.length>1&&!s.sessionContext?'checked':''}>انتخاب بازه</label><div class="range-inputs" ${s.pages?.length>1&&!s.sessionContext?'':'hidden'}><label>از صفحه<input name="from" inputmode="numeric" value="${digits(s.pages?.[0]||activePage(s))}"></label><label>تا صفحه<input name="to" inputmode="numeric" value="${digits(s.pages?.at(-1)||activePage(s))}"></label></div>${formError(s)}<button class="primary-action" type="submit">تأیید</button>${action('حذف انتخاب صفحات','clear-pages','','clear-pages')}</form>`;}

 if(sh.type==='rename'){title='تغییر نام گفتگو';body=`<form data-rename-form><label>عنوان گفتگو<input name="title" maxlength="120" value="${esc(sh.title)}" required></label>${formError(s)}<button class="primary-action" type="submit">ذخیره</button></form>`;}
 if(sh.type==='delete-session'){title='حذف گفتگو؟';body=`<p>«${esc(sh.title)}» حذف می‌شود. یادداشت‌های ذخیره‌شده باقی می‌مانند.</p>${primary('حذف','delete-session')}${action('انصراف','close-sheet','','clear-pages')}`;}
 if(sh.type==='delete-notes'){title='حذف یادداشت‌ها؟';body=`<p>${digits(sh.ids.length)} یادداشت حذف می‌شود.</p>${primary('حذف','confirm-delete-notes')}${action('انصراف','close-sheet','','clear-pages')}`;}
 if(sh.type==='note-more'){title='یادداشت';body=action('حذف یادداشت','delete-note','','danger-action');}
 if(sh.type==='notebook-more'){title='دفتر یادداشت';body=action('خروجی PDF از همین فهرست','export-notes');}
 if(sh.type==='answer-more'){title='پاسخ همراه';body=action('پرسیدن دوباره','ask-again')+action('دیدن منابع','answer-sources');}
 if(sh.type==='sources'){title='منابع پاسخ';body=(sh.sources||[]).map(c=>`<p>${esc(c.reference||bookInfo(c.doc).title)}</p><p>${esc(c.passage||c.text)}</p>`).join('')||'<p>این پاسخ منبع صفحه‌دار ندارد.</p>';}
 if(sh.type==='contents'){
  title='فهرست کتاب';
  const toc=resolveBookToc(s.book,s.outline);
  if(toc){
   const searchMarkup=`<div class="toc-search-bar"><span class="toc-search-icon" aria-hidden="true">${icon('search')}</span><input type="search" name="toc-search" class="toc-search-input" value="${esc(s.tocSearch||'')}" placeholder="جستجو در بخش‌ها و جلسات…" aria-label="جستجو در بخش‌ها و جلسات کتاب" autocomplete="off" spellcheck="false">${s.tocSearch?ib('close','پاک‌کردن جستجو','clear-toc-search','class="toc-search-clear"'):''}</div>`;
   const bodyMarkup=renderTocBodyMarkup({toc,currentPage:activePage(s),query:s.tocSearch||'',expandedGroups:s.tocExpanded||new Set()});
   body=`${searchMarkup}<div class="toc-scroll" data-toc-scroll>${bodyMarkup}</div>`;
  }else{
   body='<p class="toc-empty-fallback">فهرست قابل‌دسترسی داخل این کتاب موجود نیست. از شمارهٔ صفحه یا جستجوی متن استفاده کنید.</p>';
  }
 }
 if(sh.type==='book-search'){
  title='جستجو در کتاب';
  const hasSearched=Boolean(s.bookSearch);
  const results=s.searchResults;
  body=`<form class="book-search-form" data-book-search><div class="search-input-group"><span class="search-input-icon" aria-hidden="true">${icon('search')}</span><input type="search" name="search" class="book-search-input" value="${esc(s.bookSearch||'')}" placeholder="جستجوی کلمه یا عبارت در کتاب…" autocomplete="off" required>${s.bookSearch?`<button type="button" class="icon-button search-clear-btn" data-action="clear-book-search" aria-label="پاک‌کردن">${icon('close')}</button>`:''}</div><button class="primary-action search-submit-button" type="submit">${s.searching?'در حال جستجو…':'جستجو'}</button></form>${s.searching?'<div class="search-status-bar" role="status"><span class="loading-dot"></span><span>در حال جستجو در متن کتاب…</span></div>':''}${!s.searching&&results?`<div class="search-status-bar"><span class="search-count">${digits(results.length)} مورد یافت شد</span></div>`:''}<div class="search-results-scroll" role="region" aria-label="نتایج جستجو" tabindex="0">${!s.searching&&results?.map(r=>`<button type="button" class="search-result search-result-card" data-action="search-page" data-page="${r.page}" data-query="${esc(s.bookSearch||'')}" data-text="${esc(r.matchText||s.bookSearch||'')}"><div class="search-result-header"><span class="search-page-badge">${pageLabel([r.page])}</span><span class="search-result-arrow" aria-hidden="true">${icon('chevron')}</span></div><p class="search-result-snippet">${renderSearchSnippet(r.snippet||r.text,s.bookSearch)}</p></button>`).join('')||''}${!s.searching&&results?.length===0?`<div class="empty-search-state"><p>عبارت «${esc(s.bookSearch)}» در این کتاب پیدا نشد.</p></div>`:''}${!hasSearched&&!s.searching?'<div class="search-hint-box"><p>کلمه یا عبارتی را وارد کنید و جستجو را بزنید تا در متن کامل کتاب جستجو شود.</p></div>':''}</div>${formError(s)}`;
 }
 if(sh.type==='reading-settings'){title='تنظیمات مطالعه';body='<p>صفحه‌آرایی و قلم کتاب از PDF اصلی حفظ می‌شود.</p>'+action('شمارهٔ صفحه','pdf-pages');}
 if(sh.type==='edit-profile'){title='مشخصات و سبک یادگیری';body=profileForm(s,{isEdit:true});}
 return `<button class="sheet-scrim" data-action="close-sheet" aria-label="بستن پنل"></button><section class="sheet app-sheet${sh.type==='contents'?' toc-sheet':sh.type==='book-search'?' search-sheet':''}" role="dialog" aria-modal="true" aria-label="${title}"><div class="sheet-title"><h3>${title}</h3>${ib('close','بستن پنل','close-sheet')}</div>${body}${!['pages','rename','book-search','edit-profile','contents'].includes(sh.type)?formError(s):''}</section>`;
}
export const completeAnswer=p=>[p.text||blocksText(p.blocks),...(p.outside||[]).map(x=>`بیرون از کتاب\n${x.text}\n${x.title||'منبع وب'}: ${x.url||''}`)].filter(Boolean).join('\n\n');
