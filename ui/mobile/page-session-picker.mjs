import { sessionForPage } from '../book-reader/lecture-sync.mjs';

export function pageSessionPickerMarkup({inputName='page',page=1}={}) {
  const value=String(page).replace(/\d/g,d=>'۰۱۲۳۴۵۶۷۸۹'[d]);
  return `<div class="page-session-picker" data-page-session-picker><div class="picker-columns"><div class="picker-column"><p>جلسه</p><div class="wheel-frame"><div class="page-wheel" data-session-wheel role="listbox" tabindex="0" aria-label="شمارهٔ جلسه"></div></div></div><div class="picker-column"><p>صفحه</p><div class="wheel-frame"><div class="page-wheel" data-page-wheel role="listbox" tabindex="0" aria-label="شمارهٔ صفحه"></div></div></div></div><label class="picker-direct">شمارهٔ صفحه<input name="${inputName}" inputmode="numeric" value="${value}" aria-label="ورود مستقیم شمارهٔ صفحه"></label><p class="picker-status" data-picker-status role="status"></p></div>`;
}

const digits=value=>String(value).replace(/\d/g,d=>'۰۱۲۳۴۵۶۷۸۹'[d]);
const number=value=>Number(String(value).replace(/[۰-۹]/g,d=>'۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/[٠-٩]/g,d=>'٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
let pickerSequence=0;

export const SPECIAL_SECTIONS = [
  { id: 'eshareh', label: 'اشاره', start: 7, end: 34 },
  { id: 'preface', label: 'مقدمه مؤلف', start: 35, end: 40 }
];

export function sessionForPageWithSections(sessions, page) {
  if (!sessions?.length) return null;
  const s = sessionForPage(sessions, page);
  if (s) return s.session;
  if (page >= 7 && page <= 34) return 'eshareh';
  if (page >= 35 && page <= 40) return 'preface';
  return null;
}

export function pagesForSession(sessions, session, count) {
  if (session === null || session === 'none') {
    return Array.from({ length: count }, (_, i) => i + 1);
  }
  if (session === 'eshareh') {
    const first = Math.min(count, 7), last = Math.min(count, 34);
    return Array.from({ length: Math.max(0, last - first + 1) }, (_, i) => first + i);
  }
  if (session === 'preface') {
    const first = Math.min(count, 35), last = Math.min(count, 40);
    return Array.from({ length: Math.max(0, last - first + 1) }, (_, i) => first + i);
  }
  if (!sessions.length) return Array.from({ length: count }, (_, i) => i + 1);
  const selected = sessions.find(s => s.session === session);
  if (!selected?.book_pages) return [];
  const first = Math.max(1, selected.cover_page ?? selected.book_pages[0]),
        last = Math.min(count, selected.book_pages[1]);
  return Array.from({ length: Math.max(0, last - first + 1) }, (_, i) => first + i);
}

/** Both hosts edit a draft here; only their form's submit commits navigation/context. */
export function installPageSessionPicker({root, page, session, isAll = false, allowAll = true, count, sessions = [], onChange = () => {}}) {
  const win = root.ownerDocument.defaultView, life = new win.AbortController(), signal = life.signal;
  const id = ++pickerSequence, input = root.querySelector('input'), status = root.querySelector('[data-picker-status]');
  const pageWheel = root.querySelector('[data-page-wheel]'), sessionWheel = root.querySelector('[data-session-wheel]');
  let selectedSession = session !== undefined ? session : sessionForPageWithSections(sessions, page);
  let selectedPage = (isAll && allowAll) ? 'all' : Math.max(1, Math.min(count, page));
  let pageValues = [], sessionValues = [], scrollTimers = new Map(), disposed = false;

  function sessionLabel(value) {
    if (value === null || value === 'none') return 'بدون جلسه';
    if (value === 'eshareh') return 'اشاره';
    if (value === 'preface') return 'مقدمه مؤلف';
    return `جلسهٔ ${digits(value)}`;
  }

  function formatPageLabel(value) {
    if (value === 'all') {
      if (selectedSession === 'eshareh') return 'تمام اشاره';
      if (selectedSession === 'preface') return 'تمام مقدمه';
      return 'تمام جلسه';
    }
    return digits(value);
  }

  function options(wheel, values, label, current) {
    wheel.replaceChildren(...values.map((value, i) => {
      const node = root.ownerDocument.createElement('div');
      node.setAttribute('role', 'option');
      node.id = `picker-${id}-${wheel === pageWheel ? 'page' : 'session'}-${i}`;
      node.dataset.value = value === null ? 'none' : String(value);
      node.textContent = label(value);
      node.setAttribute('aria-selected', String(value === current));
      return node;
    }));
    wheel.scrollTop = Math.max(0, values.indexOf(current)) * 44;
    mark(wheel, values, current);
  }

  function mark(wheel, values, value) {
    const at = values.indexOf(value);
    for (const [i, node] of [...wheel.children].entries()) node.setAttribute('aria-selected', String(i === at));
    if (at >= 0) wheel.setAttribute('aria-activedescendant', wheel.children[at].id);
    else wheel.removeAttribute('aria-activedescendant');
  }

  function populatePages({ keepPage = false } = {}) {
    const rawPages = pagesForSession(sessions, selectedSession, count);
    if (selectedSession !== null && allowAll) {
      pageValues = ['all', ...rawPages];
      if (!keepPage || !pageValues.includes(selectedPage)) {
        selectedPage = 'all';
      }
    } else {
      pageValues = rawPages;
      if (!keepPage || selectedPage === 'all' || !pageValues.includes(selectedPage)) {
        selectedPage = pageValues[0] ?? 1;
      }
    }
    options(pageWheel, pageValues, formatPageLabel, selectedPage);
    const displayNum = selectedPage === 'all' ? (rawPages[0] ?? 1) : selectedPage;
    input.value = digits(displayNum);
    input.max = String(count);
  }

  function pickerValue() {
    const isAllSelected = allowAll && selectedPage === 'all';
    const rawPages = pagesForSession(sessions, selectedSession, count);
    const effectivePage = isAllSelected ? (rawPages[0] ?? 1) : (selectedPage === 'all' ? (rawPages[0] ?? 1) : selectedPage);
    const res = { page: effectivePage, session: selectedSession };
    Object.defineProperty(res, 'isAll', { value: isAllSelected, enumerable: false, configurable: true });
    Object.defineProperty(res, 'rawPage', { value: selectedPage, enumerable: false, configurable: true });
    Object.defineProperty(res, 'pages', { value: isAllSelected ? rawPages : [effectivePage], enumerable: false, configurable: true });
    return res;
  }

  function changed() {
    const val = pickerValue();
    onChange({
      page: val.page,
      session: val.session,
      isAll: val.isAll,
      rawPage: val.rawPage,
      pages: val.pages
    });
  }

  function select(wheel, value, { scroll = false } = {}) {
    if (disposed) return;
    if (wheel === sessionWheel) {
      if (value === selectedSession) return;
      selectedSession = value;
      populatePages({ keepPage: false });
    } else {
      if (!pageValues.includes(value)) return;
      selectedPage = value;
      const rawPages = pagesForSession(sessions, selectedSession, count);
      const displayNum = selectedPage === 'all' ? (rawPages[0] ?? 1) : selectedPage;
      input.value = digits(displayNum);
    }
    const values = wheel === sessionWheel ? sessionValues : pageValues;
    const current = wheel === sessionWheel ? selectedSession : selectedPage;
    mark(wheel, values, current);
    if (scroll) wheel.scrollTop = Math.max(0, values.indexOf(current)) * 44;
    changed();
  }

  for (const wheel of [sessionWheel, pageWheel]) {
    wheel.addEventListener('scroll', () => {
      clearTimeout(scrollTimers.get(wheel));
      scrollTimers.set(wheel, setTimeout(() => {
        const values = wheel === sessionWheel ? sessionValues : pageValues;
        const index = Math.max(0, Math.min(values.length - 1, Math.round(wheel.scrollTop / 44)));
        if (values.length) select(wheel, values[index]);
      }, 140));
    }, { signal });

    wheel.addEventListener('click', event => {
      const node = event.target.closest('[role="option"]');
      if (!node) return;
      if (wheel === sessionWheel) {
        const raw = node.dataset.value;
        const value = raw === 'none' ? null : ['eshareh', 'preface'].includes(raw) ? raw : Number(raw);
        select(wheel, value, { scroll: true });
      } else {
        const raw = node.dataset.value;
        const value = raw === 'all' ? 'all' : Number(raw);
        select(wheel, value, { scroll: true });
      }
    }, { signal });

    wheel.addEventListener('keydown', event => {
      const offset = { ArrowUp: -1, ArrowDown: 1, PageUp: -10, PageDown: 10 }[event.key];
      if (offset === undefined && !['Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const values = wheel === sessionWheel ? sessionValues : pageValues;
      const value = wheel === sessionWheel ? selectedSession : selectedPage;
      const at = event.key === 'Home' ? 0 : event.key === 'End' ? values.length - 1 : Math.max(0, Math.min(values.length - 1, values.indexOf(value) + offset));
      if (values.length) select(wheel, values[at], { scroll: true });
    }, { signal });
  }

  input.addEventListener('input', () => {
    const value = number(input.value);
    if (!Number.isInteger(value) || value < 1 || value > count) return;
    selectedSession = sessionForPageWithSections(sessions, value);
    selectedPage = value;
    populatePages({ keepPage: true });
    mark(sessionWheel, sessionValues, selectedSession);
    sessionWheel.scrollTop = Math.max(0, sessionValues.indexOf(selectedSession)) * 44;
    pageWheel.scrollTop = Math.max(0, pageValues.indexOf(selectedPage)) * 44;
    changed();
  }, { signal });

  function setSessions(next) {
    for (const timer of scrollTimers.values()) clearTimeout(timer);
    sessions = next;
    if (session === undefined) {
      selectedSession = sessionForPageWithSections(sessions, selectedPage === 'all' ? (pagesForSession(sessions, selectedSession, count)[0] ?? 1) : selectedPage);
    }
    sessionValues = [null];
    if (sessions.length) {
      sessionValues = [
        null,
        'eshareh',
        'preface',
        ...sessions.filter(s => s.book_pages).map(s => s.session)
      ];
    }
    options(sessionWheel, sessionValues, sessionLabel, selectedSession);
    sessionWheel.setAttribute('aria-disabled', String(!sessions.length));
    sessionWheel.tabIndex = sessions.length ? 0 : -1;
    populatePages({ keepPage: true });
    status.textContent = '';
  }

  setSessions(sessions);
  return {
    setSessions,
    get value() { return pickerValue(); },
    dispose() {
      disposed = true;
      life.abort();
      for (const timer of scrollTimers.values()) clearTimeout(timer);
    }
  };
}

export async function fetchLectureSessions(book, fetchImpl, { signal } = {}) {
  if (!fetchImpl) return [];
  const response = await fetchImpl(`/books/${encodeURIComponent(book)}/lectures`, { signal });
  if (response.status === 404) return [];
  if (!response.ok) throw new Error('دریافت جلسات ممکن نشد؛ دوباره انتخابگر را باز کنید.');
  const body = await response.json();
  return body.sessions ?? [];
}
