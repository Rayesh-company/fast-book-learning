/**
 * The authenticated API for the mobile application.
 * Connects directly to the Mastra chat agent via /agent/chat with streaming SSE (ADR-0018).
 */

import { CANONICAL_CITATION_REGEX } from './views.mjs';

export function parseAgentCitations(text = '', defaultBook = '') {
  if (!text) return [];
  const citations = [];
  const seen = new Set();
  const regex = new RegExp(CANONICAL_CITATION_REGEX.source, 'g');
  let match;
  while ((match = regex.exec(text)) !== null) {
    const doc = match[1] || defaultBook;
    const first = Number(match[3]);
    const last = match[4] ? Number(match[4]) : first;
    const key = `${doc}:${first}-${last}`;
    if (!seen.has(key)) {
      seen.add(key);
      citations.push({
        doc,
        page: first,
        lastPage: last,
        reference: match[0],
        text: match[0],
      });
    }
  }
  return citations;
}

export async function readAgentStream(response, { signal, onStatus, onDelta } = {}) {
  if (!response.body || !response.body.getReader) {
    throw new Error('ارتباط با عامل گفت‌وگو قطع شد؛ دوباره بپرسید.');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let accumulatedText = '';
  let finalized = null;
  let hasWebResults = false;

  const cleanup = () => {
    try {
      reader.cancel();
    } catch {}
  };

  if (signal) {
    if (signal.aborted) {
      cleanup();
      throw new DOMException('Aborted', 'AbortError');
    }
    signal.addEventListener('abort', cleanup, { once: true });
  }

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const at = buffer.indexOf('\n\n');
        if (at === -1) break;
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 2);
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (raw === '[DONE]') break;
        let frame;
        try {
          frame = JSON.parse(raw);
        } catch {
          continue;
        }
        if (!frame || typeof frame.type !== 'string') continue;

        if (frame.type === 'text-delta') {
          const delta = frame.payload?.text;
          if (typeof delta === 'string') {
            accumulatedText += delta;
            onStatus?.('در حال نوشتن پاسخ…');
            onDelta?.(delta, accumulatedText);
          }
        } else if (frame.type === 'tool-result') {
          const toolName = frame.payload?.toolName || '';
          if (/web/i.test(toolName)) {
            hasWebResults = true;
            onStatus?.('در حال جستجو در اینترنت…');
          } else if (/book/i.test(toolName)) {
            onStatus?.('در حال جستجو در متن کتاب…');
          }
        } else if (frame.type === 'chat-answer-finalized') {
          finalized = frame.payload || frame;
          break;
        } else if (frame.type === 'chat-answer-error') {
          const detail = frame.payload?.detail || frame.detail || 'عامل گفت‌وگو پاسخ نداد؛ دوباره بپرسید.';
          throw new Error(detail);
        }
      }
      if (finalized) break;
    }
  } finally {
    if (signal) {
      signal.removeEventListener('abort', cleanup);
    }
  }

  if (!finalized && !accumulatedText) {
    throw new Error('عامل گفت‌وگو پاسخ نداد؛ دوباره بپرسید.');
  }

  const answerText = finalized?.answer ?? accumulatedText;
  const webSourced = finalized?.web_sourced === true || hasWebResults;
  const rawSources = Array.isArray(finalized?.sources) ? finalized.sources : [];
  const outside = webSourced
    ? rawSources.map(s => ({
        title: s.title || 'منبع وب',
        url: s.url || '',
        text: s.snippet || '',
      }))
    : [];

  return {
    text: answerText,
    web_sourced: webSourced,
    outside,
    window: finalized?.window,
  };
}

export function createApi({ fetchImpl = fetch } = {}) {
  async function request(path, { method = 'GET', body, signal } = {}) {
    const r = await fetchImpl(path, {
      method,
      signal,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    let data;
    try {
      data = await r.json();
    } catch {}
    if (!r.ok) {
      const e = new Error(data?.detail || 'ارتباط برقرار نشد. دوباره تلاش کنید.');
      e.status = r.status;
      throw e;
    }
    return data;
  }

  const unavailable = async message => {
    throw new Error(message);
  };

  return {
    demo: false,
    pageFiltering: false,
    me: async () => {
      try {
        return await request('/auth/me');
      } catch (e) {
        if (e.status === 401) return null;
        throw e;
      }
    },
    login: ({ email, password }) =>
      request('/auth/login', { method: 'POST', body: { email, password } }),
    logout: () => request('/auth/logout', { method: 'POST' }),
    requestOtp: () =>
      unavailable('ورود پیامکی هنوز فعال نشده است. اگر حساب قبلی دارید از ورود با ایمیل استفاده کنید.'),
    verifyOtp: () => unavailable('تأیید پیامکی هنوز فعال نشده است.'),
    joinWaitlist: () => unavailable('ثبت فهرست انتظار هنوز در دسترس نیست. بعداً دوباره تلاش کنید.'),
    profile: async () => {
      await request('/profile/data');
      return { subscription: null, subscription_available: false, questions_remaining: null };
    },
    getProfile: () => request('/api/user/profile'),
    saveProfile: profile =>
      request('/api/user/profile', { method: 'POST', body: profile }),
    sessions: async () => (await request('/sessions')).sessions,
    session: id => request(`/sessions/${Number(id)}`),
    createSession: (book, title) =>
      request('/sessions', { method: 'POST', body: { book, title } }),
    renameSession: () => unavailable('تغییر نام گفتگو در سرویس فعلی هنوز فعال نشده است.'),
    deleteSession: id => request(`/sessions/${Number(id)}`, { method: 'DELETE' }),
    append: (id, role, payload) =>
      request(`/sessions/${Number(id)}/messages`, { method: 'POST', body: { role, payload } }),
    ask: async (input, { signal, onStatus, onDelta } = {}) => {
      onStatus?.('در حال ارتباط با عامل گفت‌وگو');
      const question = input.question;
      const page = input.page ?? input.pages?.[0];
      const body = {
        query: question,
        datasets: input.book ? [input.book] : undefined,
        book: input.book,
        page,
        scope: input.scope || 'all',
      };
      if (input.pages) {
        body.pages = input.pages;
      }
      if (input.selection) {
        body.selection = input.selection;
      }

      let response;
      try {
        response = await fetchImpl('/agent/chat', {
          method: 'POST',
          signal,
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch (e) {
        if (e.name === 'AbortError' || signal?.aborted) throw e;
        throw new Error('ارتباط با عامل گفت‌وگو قطع شد؛ دوباره بپرسید.');
      }

      if (!response.ok) {
        let errData;
        try {
          errData = await response.json();
        } catch {}
        const detail = errData?.detail || 'عامل گفت‌وگو پاسخ نداد؛ دوباره بپرسید.';
        if ([402, 429].includes(response.status)) {
          return { text: detail, limited: true, citations: [], outside: [] };
        }
        const err = new Error(detail);
        err.status = response.status;
        throw err;
      }

      try {
        const streamed = await readAgentStream(response, { signal, onStatus, onDelta });
        return {
          ...streamed,
          citations: parseAgentCitations(streamed.text, input.book),
        };
      } catch (e) {
        if (e.name === 'AbortError' || signal?.aborted) throw e;
        if ([402, 429].includes(e.status)) {
          return { text: e.message, limited: true, citations: [], outside: [] };
        }
        throw e;
      }
    },
    notes: async () => (await request('/notes')).notes,
    saveNote: note => request('/notes', { method: 'POST', body: note }),
    updateNote: (id, opinion) =>
      request(`/notes/${Number(id)}`, { method: 'POST', body: { opinion } }),
    deleteNotes: ids => request('/notes/bulk-delete', { method: 'POST', body: { ids } }),
    purchase: () =>
      unavailable('خرید اشتراک هنوز در دسترس نیست. اتصال درگاه پرداخت تکمیل نشده است.'),
    verifyPayment: () => unavailable('وضعیت پرداخت هنوز تأیید نشده است. دوباره بررسی کنید.'),
    transcribe: () =>
      unavailable('تبدیل گفتار به متن هنوز فعال نشده است. می‌توانید پرسش را بنویسید.'),
  };
}

export function blocksText(blocks = []) {
  return blocks
    .map(
      b =>
        b.text ||
        b.parts?.map(p => p.quote ?? p.text ?? '').join(' ') ||
        b.items?.join('\n') ||
        '',
    )
    .filter(Boolean)
    .join('\n\n');
}
