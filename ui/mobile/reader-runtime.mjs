import { createBookReader, PDF_RENDER_OPTIONS } from '../book-reader/index.mjs';
import { installNarrationControls } from '../book-reader/audio-controls.mjs';
import { createPanelFocus } from './panel-focus.mjs';
import { installContinuousAudio } from '../book-reader/continuous-audio.mjs';
import { pdfParagraphs } from '../book-reader/paragraphs.mjs';
import { readPdfText } from '../book-reader/pdf-text.mjs';
import { buildPdfTextIndex } from '../book-reader/pdf-content.mjs';
import { installReaderGestures, installReaderChrome } from './reader-interactions.mjs';

const titles = { 'tarhe-kolli': 'طرح کلی اندیشۀ اسلامی در قرآن', '70143-336': 'انسان ۲۵۰ ساله' };
const digits = n => String(n).replace(/\d/g, c => '۰۱۲۳۴۵۶۷۸۹'[c]);
const number = value => Number(String(value).replace(/[۰-۹]/g, c => '۰۱۲۳۴۵۶۷۸۹'.indexOf(c)).replace(/[٠-٩]/g, c => '٠١٢٣٤٥٦٧٨٩'.indexOf(c)));
let enginePromise;
const loadEngine = () => enginePromise ??= import('/vendor/pdf.min.mjs').then(pdfjs => {
  pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.mjs';
  return pdfjs;
});

/** The designed host owns navigation and selection context; Tuba owns only PDF/media. */
export function installMobileReaders({ root = document, fetchImpl = fetch, pdfjsLoader = loadEngine } = {}) {
  const doc = root.ownerDocument ?? root;
  const records = new Map();
  const documents = new Map();
  const query = new URLSearchParams(doc.defaultView.location.search);
  const initialBook = titles[query.get('book')] ? query.get('book') : 'tarhe-kolli';
  const initialPage = Number.isInteger(number(query.get('page'))) && number(query.get('page')) > 0 ? number(query.get('page')) : 1;
  const listeners = new doc.defaultView.AbortController();
  let loginPromise;
  let disposed = false;
  let authOverlay;

  async function ensureLogin(phone) {
    if (phone.dataset.loginRequired === 'false') return;
    if (loginPromise) return loginPromise;
    loginPromise = (async () => {
      const response = await fetchImpl('/auth/me', {signal:listeners.signal});
      if (disposed || listeners.signal.aborted) return;
      if (response.ok) return;
      if (response.status !== 401) throw new Error('ورود به حساب در دسترس نیست.');
      authOverlay = doc.createElement('div');
      authOverlay.className = 'mobile-auth';
      authOverlay.innerHTML = '<form><h2>ورود برای مطالعهٔ کتاب</h2><label>ایمیل<input type="email" name="email" autocomplete="username" required></label><label>گذرواژه<input type="password" name="password" autocomplete="current-password" required></label><p role="alert"></p><button class="primary-action" type="submit">ورود</button></form>';
      doc.body.append(authOverlay);
      await new Promise((resolve, reject) => {
        listeners.signal.addEventListener('abort', () => reject(new Error('نمای کتاب بسته شد.')), { once: true });
        authOverlay.querySelector('form').addEventListener('submit', async event => {
          event.preventDefault();
          const form = event.currentTarget;
          const button = form.querySelector('button');
          button.disabled = true;
          try {
            const result = await fetchImpl('/auth/login', { method: 'POST', signal: listeners.signal, headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({email: form.elements.email.value, password: form.elements.password.value}) });
            if (disposed) return;
            if (!result.ok) {
              const body = await result.json();
              throw new Error(body.detail || 'ورود تأیید نشد.');
            }
            authOverlay.remove(); resolve();
          } catch (error) { form.querySelector('[role="alert"]').textContent = error.message; }
          finally { button.disabled = false; }
        }, { signal: listeners.signal });
      });
    })();
    return loginPromise;
  }

  async function bookDocument(pdfjs, book) {
    if (!documents.has(book)) {
      const task = pdfjs.getDocument({ url: `/books/${book}/book`, ...PDF_RENDER_OPTIONS,
        cMapUrl: '/vendor/cmaps/', cMapPacked: true, standardFontDataUrl: '/vendor/standard_fonts/',
        isEvalSupported: false, disableAutoFetch: true });
      documents.set(book, task);
    }
    return documents.get(book).promise;
  }

  function selectionChanged() {
    for (const state of records.values()) {
      const selected = state.reader?.captureSelection();
      state.actionSelection = selected ?? null;
      state.phone.querySelector('.reader-selection-actions').hidden = !selected;
      if (selected && state.phone.classList.contains('product-shell')) {
        const native = doc.getSelection();
        const rect = native?.rangeCount && native.getRangeAt(0).getBoundingClientRect?.();
        const panel = state.phone.querySelector('.reader-selection-actions');
        const box = state.phone.getBoundingClientRect();
        if (rect?.height) { panel.style.bottom = 'auto'; panel.style.top = `${Math.max(76,Math.min(box.height - 120,rect.bottom - box.top + 10))}px`; }
      }
      if (selected) {
        state.selection = selected;
        state.phone.dispatchEvent(new doc.defaultView.CustomEvent('book-selection', { detail: selected }));
      }
    }
  }

  async function render(state, requestedPage, keepContext = false, {audio=false,anchor}={}) {
    const revision = ++state.revision;
    const current = () => !disposed && records.get(state.phone) === state && state.revision === revision;
    try {
    const oldWidth = state.width;
    const oldScroll = state.viewport.scrollTop;
    const selected=keepContext?state.reader?.captureSelection():null;
    if (keepContext) state.reader?.removePage(state.page);
    else { if(!audio)state.controls?.reset();
      if(state.product)state.reader?.removePage(state.page);else state.reader?.clear();state.selection = null; state.actionSelection = null;
      state.phone.querySelector('.reader-selection-actions').hidden = true;
      if (state.phone.readerQuestion&&!audio) state.phone.dispatchEvent(new doc.defaultView.CustomEvent('reader-question-reset', {bubbles:true}));
    }
    const readButton=state.phone.querySelector('[data-reader-read]');if(readButton)readButton.disabled = true;
    syncZoom(state);
    const pdf = state.pdf;
    state.page = Math.max(1, Math.min(pdf.numPages, requestedPage));
    state.phone.dataset.pdfPage = String(state.page);
    state.viewport.scrollTop = 0;
    state.surface.replaceChildren();
    const loading = doc.createElement('p'); loading.className = 'pdf-placeholder';
    loading.textContent = 'در حال بازکردن صفحه…'; state.surface.append(loading);
    const page = await pdf.getPage(state.page);
    if (!current()) return;
    const width = Math.max(200, (state.viewport.clientWidth - 16) * state.zoom);
    state.width = width;
    const mounted = state.reader.mountPage({page, surface: state.surface, width,
      pixelRatio: Math.min(2.5, doc.defaultView.devicePixelRatio || 1), isCurrent: current});
    const indexed = await mounted.ready;
    if (!current() || !indexed) return;
    state.phone.querySelector('.topbar h3').textContent = titles[state.book];
    if(!state.product)state.phone.querySelector('.topbar p').textContent = `صفحهٔ ${digits(state.page)} از ${digits(pdf.numPages)}`;
    state.phone.querySelector('[name="page"]').value = digits(state.page);
    state.phone.querySelector('[data-pdf-page-count]').textContent = `${digits(pdf.numPages)} صفحه`;
    const prev=state.phone.querySelector('[data-pdf-prev]'),next=state.phone.querySelector('[data-pdf-next]');
    if(prev)prev.disabled=state.page===1;if(next)next.disabled=state.page===pdf.numPages;
    if(readButton)readButton.disabled=false;
    const data=buildPdfTextIndex(indexed.content,state.page);
    state.pageData?.set(state.page,Promise.resolve({index:data.index,paragraphs:pdfParagraphs(data.index,data.indexItems,state.page)}));
    state.chrome?.sync();
    if(selected){
      const passage=selected.pages.find(p=>p.page===state.page),index=mounted.index;
      if(passage&&index.text.slice(passage.start,passage.end)===passage.text){
        const start=index.items.find(item=>item.start<=passage.start&&item.end>passage.start);
        const end=[...index.items].reverse().find(item=>item.start<passage.end&&item.end>=passage.end);
        const a=start&&mounted.layer.querySelector(`span[data-pdf-item-index="${start.textItemIndex}"]`)?.firstChild;
        const b=end&&mounted.layer.querySelector(`span[data-pdf-item-index="${end.textItemIndex}"]`)?.firstChild;
        if(a&&b){const range=doc.createRange();range.setStart(a,passage.start-start.rawStart);range.setEnd(b,passage.end-end.rawStart);const native=doc.getSelection();native.removeAllRanges();native.addRange(range);selectionChanged();}
      }
    }
    if (keepContext && oldWidth) state.viewport.scrollTop = oldScroll * width / oldWidth;
    if(anchor){const box=state.viewport.getBoundingClientRect(),ratio=state.zoom/anchor.oldZoom;
      state.viewport.scrollTop=state.surface.offsetTop+anchor.y*ratio-(anchor.clientY-box.top);
      state.viewport.scrollLeft=state.surface.offsetLeft+anchor.x*ratio-(anchor.clientX-box.left);
    }
    await mounted.painted;
    if (current()) state.surface.querySelector('.pdf-placeholder')?.remove();
    if (current()) state.phone.dispatchEvent(new doc.defaultView.CustomEvent('book-page-ready', {bubbles:true, detail:{page:state.page,numPages:pdf.numPages,outline:state.outline||[]}}));
    } catch (error) { if (current()) fail(state,error); }
  }

  function fail(state, error) {
    if (disposed || records.get(state.phone) !== state) return;
    const message = doc.createElement('p'); message.className = 'pdf-placeholder'; message.setAttribute('role', 'alert');
    message.textContent = error.message || 'بازکردن این صفحه ممکن نشد.';
    state.surface.append(message);
  }

  function attach(phone) {
    const surface = phone.querySelector('.pdf-surface');
    if (!surface) return;
    const state = {phone, surface, book:titles[phone.dataset.book]?phone.dataset.book:initialBook, viewport: phone.querySelector('.reader-page'), revision: 0,
      page: number(phone.dataset.pdfPage) || initialPage, zoom: number(phone.dataset.pdfZoom) || 1, selection: null,
      product:phone.classList.contains('product-shell'),pageData:new Map()};
    state.panelFocus = createPanelFocus(phone);
    records.set(phone, state);
    state.ready = (async () => {
      await ensureLogin(phone);
      if (disposed || records.get(phone) !== state) return;
      const pdfjs = await pdfjsLoader();
      if (disposed || records.get(phone) !== state) return;
      state.pdf = await bookDocument(pdfjs,state.book);
      if (disposed || records.get(phone) !== state) return;
      state.reader = createBookReader({pdfjs, onSelection: selectionChanged,
        onPaintError: () => fail(state, new Error('نمایش PDF این صفحه ممکن نشد.'))});
      phone.bookReader = state.reader;
      const audioFetch = phone.dataset.demo === 'true' ? async () => ({ok:false,json:async()=>({detail:'صوت نمونه تولید نمی‌شود؛ شنیدن واقعی کتاب در نسخهٔ متصل به سرویس در دسترس است.'})}) : fetchImpl;
      if(state.product){
        const changePage=page=>{state.ready=render(state,page);return state.ready;};
        const pageData=page=>{
          if(!state.pageData.has(page))state.pageData.set(page,(async()=>{
            const pdfPage=await state.pdf.getPage(page),content=await readPdfText(pdfPage,pdfjs.OPS.showText);
            const data=buildPdfTextIndex(content,page);
            return {index:data.index,paragraphs:pdfParagraphs(data.index,data.indexItems,page)};
          })().catch(error=>{state.pageData.delete(page);throw error;}));
          return state.pageData.get(page);
        };
        state.controls=installContinuousAudio({element:phone,fetchImpl:audioFetch,reader:state.reader,
          getContext:()=>({doc:state.book,page:state.page,numPages:state.pdf.numPages}),getPageData:pageData,
          showPage:async page=>{if(page===state.page){await state.ready;return;}await render(state,page,false,{audio:true});}});
        state.chrome=installReaderChrome({phone,getPage:()=>state.page,getCount:()=>state.pdf.numPages,goToPage:changePage});
        state.gestures=installReaderGestures({viewport:state.viewport,surface:state.surface,getZoom:()=>state.zoom,
          hasSelection:()=>!!state.reader.captureSelection()||!doc.getSelection()?.isCollapsed,
          turnPage:direction=>{const page=Math.max(1,Math.min(state.pdf.numPages,state.page+direction));if(page!==state.page)changePage(page);},
          setZoom:(zoom,anchor)=>{state.zoom=zoom;phone.dataset.pdfZoom=String(zoom);state.ready=render(state,state.page,true,{anchor});}});
      }else state.controls = installNarrationControls({element: phone, fetchImpl:audioFetch,
        reader: {captureSelection: () => state.reader.captureSelection() ?? state.selection,
          getPageIndex: page => state.reader.getPageIndex(page), loadAudio: input => state.reader.loadAudio(input)},
        getContext: async () => { await state.ready; return records.get(phone) === state ? {doc:state.book,page:state.page} : null; }});
      try {
        const flatten = nodes => (nodes||[]).flatMap(node => [node,...flatten(node.items)]);
        state.outline = (await Promise.all(flatten(await state.pdf.getOutline?.()).slice(0,120).map(async node => {
          try { const dest = typeof node.dest === 'string' ? await state.pdf.getDestination(node.dest) : node.dest;
            const page = dest?.length ? typeof dest[0] === 'number' ? dest[0] + 1 : await state.pdf.getPageIndex(dest[0]) + 1 : null;
            return page ? {title:node.title,page} : null;
          } catch { return null; }
        }))).filter(Boolean);
      } catch { state.outline = []; }
      if (disposed || records.get(phone) !== state) return;
      await render(state, state.page, true);
      if (records.get(phone) !== state) return;
      state.viewport.scrollTop = number(phone.dataset.pdfScroll) || 0;
      if (doc.defaultView.ResizeObserver) {
        state.observer = new doc.defaultView.ResizeObserver(() => {
          if (records.get(phone) !== state || Math.abs(Math.max(200, (state.viewport.clientWidth - 16) * state.zoom) - state.width) < 2) return;
          state.ready = render(state, state.page, true).catch(error => fail(state, error));
        });
        state.observer.observe(state.viewport);
      }
    })().catch(error => fail(state, error));
  }

  function remove(state) {
    state.phone.dataset.pdfScroll = String(state.viewport.scrollTop);
    state.revision++; state.panelFocus.dispose(); state.chrome?.dispose();state.gestures?.dispose();state.controls?.dispose(); state.reader?.clear(); state.observer?.disconnect();
    delete state.phone.bookReader; records.delete(state.phone);
  }

  function reconcile() {
    if (disposed) return;
    for (const state of [...records.values()]) {
      if (!state.phone.isConnected || state.phone.dataset.type !== 'reader' || state.phone.querySelector('.pdf-surface') !== state.surface) remove(state);
    }
    for (const phone of root.querySelectorAll('.phone[data-type="reader"]')) if (!records.has(phone)) attach(phone);
  }
  const mutation = new doc.defaultView.MutationObserver(reconcile);
  mutation.observe(root.querySelector('#boards') ?? doc.body, { childList: true, subtree: true });
  doc.addEventListener('selectionchange', selectionChanged, { signal: listeners.signal });
  doc.addEventListener('copy', event => {
    for (const state of records.values()) {
      const selected = state.reader?.captureSelection();
      if (selected && event.clipboardData) { event.preventDefault(); event.clipboardData.setData('text/plain', selected.text); return; }
    }
  }, { signal: listeners.signal });

  function closeSheets(phone,{restore=true}={}) {
    phone.querySelectorAll('.reader-tools .sheet,.pdf-page-sheet,.pdf-audio-sheet,.pdf-zoom-sheet,[data-pdf-dismiss]').forEach(node => { if (node.matches('.sheet,.sheet-scrim')) node.hidden = true; });
    const state=records.get(phone);state?.panelFocus.close({restore});state?.chrome?.setOpen(false);if(state&&restore)state.toolTrigger=null;
  }
  function syncZoom(state) {
    state.phone.querySelectorAll('[data-pdf-zoom-value]').forEach(node=>node.textContent=`${digits(Math.round(state.zoom*100))}٪`);
    state.phone.querySelectorAll('button[data-pdf-zoom]').forEach(node=>node.disabled=Number(node.dataset.pdfZoom)<0?state.zoom<=.75:state.zoom>=3);
    state.phone.querySelectorAll('[data-pdf-zoom-reset]').forEach(node=>node.disabled=state.zoom===1);
  }
  function openTools(phone,type,trigger) {
    const state=records.get(phone);if(!state)return;
    const returnTrigger=trigger?.closest('.sheet,.drawer')?state.toolTrigger||phone.querySelector('[data-action="menu"]'):trigger;
    phone.querySelectorAll('.drawer,.drawer-scrim').forEach(node=>node.hidden=true);
    closeSheets(phone,{restore:false});
    const tools=phone.querySelector('.reader-tools');if(tools)tools.hidden=false;
    const panel=phone.querySelector(type==='pdf-audio'?'.pdf-audio-sheet':type==='pdf-zoom'?'.pdf-zoom-sheet':'.pdf-page-sheet');
    if(!panel)return;
    phone.querySelector('.sheet-scrim[data-pdf-dismiss]').hidden=false;panel.hidden=false;syncZoom(state);
    state.toolTrigger=returnTrigger;
    state.chrome?.setOpen(true);
    state.panelFocus.open(panel,{trigger:returnTrigger,initial:type==='pdf-pages'?(state.product?'[data-page-wheel]':'input[name="page"]'):'button:not([disabled])',onClose:()=>closeSheets(phone)});
  }
  doc.addEventListener('reader-tools-open',event=>openTools(event.target.closest('.phone'),event.detail.type,event.detail.trigger),{signal:listeners.signal});
  doc.addEventListener('pointerdown', event => {
    if (event.target.closest('[data-action="ask-agent"],[data-action="highlight"],[data-action="copy-selection"]')) event.preventDefault();
  }, {signal:listeners.signal});
  doc.addEventListener('click', event => {
    const target = event.target.closest('[data-action],[data-pdf-dismiss],[data-pdf-prev],[data-pdf-next],[data-pdf-clear-selection],button[data-pdf-zoom],[data-pdf-zoom-reset]');
    const phone = target?.closest('.phone'); const state = records.get(phone);
    if (!state) return;
    if (['highlight','copy-selection'].includes(target.dataset.action)) {
      const selection = state.reader?.captureSelection() ?? state.actionSelection;
      if (selection) phone.dispatchEvent(new doc.defaultView.CustomEvent('reader-selection-action', {bubbles:true,detail:{action:target.dataset.action,selection}}));
    }
    if (target.dataset.action === 'ask-agent') {
      const selection = state.reader?.captureSelection() ?? state.actionSelection;
      if (!selection) return;
      phone.querySelector('.reader-selection-actions').hidden = true;
      phone.dispatchEvent(new doc.defaultView.CustomEvent('reader-question', {bubbles:true,detail:{...selection}}));
      state.actionSelection = null;
      doc.getSelection()?.removeAllRanges();
    }
    if (target.dataset.action === 'close-question') {
      state.selection = null; state.actionSelection = null;
      doc.getSelection()?.removeAllRanges();
      phone.querySelector('.reader-selection-actions').hidden = true;
    }
    if (target.matches('[data-pdf-dismiss]')) closeSheets(phone);
    if (['pdf-pages','pdf-audio','pdf-zoom'].includes(target.dataset.action)&&!phone.classList.contains('product-shell'))openTools(phone,target.dataset.action,target);
    if (target.matches('[data-pdf-prev],[data-pdf-next]') && state.pdf) {
      state.ready = render(state, state.page + (target.hasAttribute('data-pdf-next') ? 1 : -1)).catch(error => fail(state, error));
    }
    if (target.matches('[data-pdf-clear-selection]')) { state.selection = null; state.actionSelection = null; doc.getSelection()?.removeAllRanges(); selectionChanged(); }
    if (target.matches('button[data-pdf-zoom],[data-pdf-zoom-reset]') && state.pdf) {
      state.zoom = target.hasAttribute('data-pdf-zoom-reset')?1:Math.max(.75, Math.min(3, state.zoom + Number(target.dataset.pdfZoom)));
      state.phone.dataset.pdfZoom = String(state.zoom);
      state.ready = render(state,state.page,true).catch(error => fail(state,error));
    }
  }, {signal:listeners.signal, capture:true});
  doc.addEventListener('submit', event => {
    if (!event.target.matches('[data-pdf-page-form]')) return;
    event.preventDefault();
    const phone = event.target.closest('.phone'); const state = records.get(phone);
    const page = number(event.target.elements.page.value);
    const error = phone.querySelector('[data-pdf-error]');
    if (!state?.pdf || !Number.isInteger(page) || page < 1 || page > state.pdf.numPages) { error.textContent = 'شمارهٔ صفحه را بررسی کنید.'; return; }
    error.textContent = ''; closeSheets(phone);
    state.ready = render(state,page).catch(error => fail(state,error));
  }, {signal:listeners.signal});
  reconcile();
  return { records, ready: () => Promise.all([...records.values()].map(state => state.ready)),
    dispose() { disposed = true; mutation.disconnect(); listeners.abort(); authOverlay?.remove();
      for (const state of [...records.values()]) remove(state);
      for (const task of documents.values()) Promise.resolve(task.destroy()).catch(() => {}); documents.clear(); } };
}

if (typeof document !== 'undefined') installMobileReaders();
