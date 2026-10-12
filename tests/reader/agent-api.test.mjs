import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi, parseAgentCitations } from '../../ui/mobile/api.mjs';
import { answer, CANONICAL_CITATION_REGEX } from '../../ui/mobile/views.mjs';

function makeSSEResponse(lines, { status = 200, statusText = 'OK' } = {}) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(line));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    statusText,
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
  });
}

test('parseAgentCitations extracts single-page and range references correctly', () => {
  const text = 'طبق document tarhe-kolli (pages 100-105) و همچنین document 70143-336 (page 42) نکته بیان شده است.';
  const citations = parseAgentCitations(text);
  assert.equal(citations.length, 2);
  assert.equal(citations[0].doc, 'tarhe-kolli');
  assert.equal(citations[0].page, 100);
  assert.equal(citations[0].lastPage, 105);
  assert.equal(citations[0].reference, 'document tarhe-kolli (pages 100-105)');

  assert.equal(citations[1].doc, '70143-336');
  assert.equal(citations[1].page, 42);
  assert.equal(citations[1].lastPage, 42);
  assert.equal(citations[1].reference, 'document 70143-336 (page 42)');
});

test('createApi.ask streams SSE responses, tracks tool status and delivers finalized answers', async () => {
  const sseLines = [
    'data: {"type":"tool-result","payload":{"toolName":"searchBooksTool"}}\n\n',
    'data: {"type":"text-delta","payload":{"id":"d1","text":"پاسخ کتاب: "}}\n\n',
    'data: {"type":"text-delta","payload":{"id":"d2","text":"بر اساس document tarhe-kolli (page 85) دین برنامه زیست است."}}\n\n',
    'data: {"type":"chat-answer-finalized","payload":{"answer":"پاسخ کتاب: بر اساس document tarhe-kolli (page 85) دین برنامه زیست است.","web_sourced":false,"sources":[],"window":{"remaining":29}}}\n\n',
    'data: [DONE]\n\n',
  ];

  const statuses = [];
  const deltas = [];
  const mockFetch = async (url, options) => {
    assert.equal(url, '/agent/chat');
    assert.equal(options.method, 'POST');
    const body = JSON.parse(options.body);
    assert.equal(body.query, 'دین چیست؟');
    assert.deepEqual(body.datasets, ['tarhe-kolli']);
    return makeSSEResponse(sseLines);
  };

  const api = createApi({ fetchImpl: mockFetch });
  const result = await api.ask(
    { question: 'دین چیست؟', book: 'tarhe-kolli' },
    {
      onStatus: s => statuses.push(s),
      onDelta: d => deltas.push(d),
    },
  );

  assert.match(result.text, /دین برنامه زیست است/);
  assert.equal(result.web_sourced, false);
  assert.equal(result.citations.length, 1);
  assert.equal(result.citations[0].doc, 'tarhe-kolli');
  assert.equal(result.citations[0].page, 85);
  assert.ok(statuses.includes('در حال جستجو در متن کتاب…'));
  assert.ok(deltas.length >= 2);
});

test('createApi.ask handles outside-web tool execution and marks sources', async () => {
  const sseLines = [
    'data: {"type":"tool-result","payload":{"toolName":"webSearchTool"}}\n\n',
    'data: {"type":"text-delta","payload":{"id":"d1","text":"اطلاعات اینترنت"}}\n\n',
    'data: {"type":"chat-answer-finalized","payload":{"answer":"اطلاعات اینترنت","web_sourced":true,"sources":[{"title":"منبع روز","url":"https://example.ir/news","snippet":"رویداد جدید"}],"window":{"remaining":28}}}\n\n',
  ];

  const mockFetch = async () => makeSSEResponse(sseLines);
  const api = createApi({ fetchImpl: mockFetch });
  const result = await api.ask({ question: 'رویداد روز', book: 'tarhe-kolli' });

  assert.equal(result.web_sourced, true);
  assert.equal(result.outside.length, 1);
  assert.equal(result.outside[0].title, 'منبع روز');
  assert.equal(result.outside[0].url, 'https://example.ir/news');
  assert.equal(result.outside[0].text, 'رویداد جدید');

  // Verify rendering with outside section
  const renderedHtml = answer(result, 0);
  assert.match(renderedHtml, /بیرون از کتاب/);
  assert.match(renderedHtml, /https:\/\/example\.ir\/news/);
  assert.match(renderedHtml, /منبع روز/);
});

test('createApi.ask handles quota limit (429) gracefully without throwing', async () => {
  const mockFetch = async () =>
    new Response(JSON.stringify({ detail: 'پنجرهٔ پرسش‌های این حساب پر شده است.' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json' },
    });

  const api = createApi({ fetchImpl: mockFetch });
  const result = await api.ask({ question: 'یک سوال', book: 'tarhe-kolli' });

  assert.equal(result.limited, true);
  assert.match(result.text, /پر شده است/);
  assert.deepEqual(result.citations, []);
});

test('createApi.ask handles chat-answer-error frame from upstream', async () => {
  const sseLines = [
    'data: {"type":"chat-answer-error","payload":{"detail":"عامل گفت‌وگو پاسخ نداد؛ دوباره بپرسید."}}\n\n',
  ];

  const mockFetch = async () => makeSSEResponse(sseLines);
  const api = createApi({ fetchImpl: mockFetch });

  await assert.rejects(
    () => api.ask({ question: 'یک سوال', book: 'tarhe-kolli' }),
    /عامل گفت‌وگو پاسخ نداد/,
  );
});

test('views.answer formats agent citations as interactive buttons', () => {
  const agentAnswer = {
    text: 'نکته اصلی در document tarhe-kolli (pages 50-52) بیان شده است.',
    citations: [{ doc: 'tarhe-kolli', page: 50, lastPage: 52, reference: 'document tarhe-kolli (pages 50-52)', text: 'document tarhe-kolli (pages 50-52)' }],
    outside: [],
  };

  const html = answer(agentAnswer, 0);
  assert.match(html, /class="cite-sent agent-cite"/);
  assert.match(html, /data-action="citation"/);
  assert.match(html, /data-book="tarhe-kolli"/);
  assert.match(html, /data-page="50"/);
});

test('CANONICAL_CITATION_REGEX matches canonical single and range citations', () => {
  const m1 = 'document tarhe-kolli (page 85)'.match(CANONICAL_CITATION_REGEX);
  assert.ok(m1);
  assert.equal(m1[1], 'tarhe-kolli');
  assert.equal(m1[2], 'page 85');
  assert.equal(m1[3], '85');
  assert.equal(m1[4], undefined);

  const m2 = 'document 70143-336 (pages 40-45)'.match(CANONICAL_CITATION_REGEX);
  assert.ok(m2);
  assert.equal(m2[1], '70143-336');
  assert.equal(m2[2], 'pages 40-45');
  assert.equal(m2[3], '40');
  assert.equal(m2[4], '45');
});

test('createApi.ask does not leak selection text into query prompt', async () => {
  let capturedBody = null;
  const mockFetch = async (url, options) => {
    capturedBody = JSON.parse(options.body);
    return makeSSEResponse([
      'data: {"type":"chat-answer-finalized","payload":{"answer":"پاسخ"}}\n\n',
    ]);
  };
  const api = createApi({ fetchImpl: mockFetch });
  await api.ask({
    question: 'سوال درباره توحید',
    book: 'tarhe-kolli',
    selection: { text: 'عبارت انتخاب شده از کتاب', page: 85, book: 'tarhe-kolli' },
  });

  assert.ok(capturedBody);
  assert.equal(capturedBody.query, 'سوال درباره توحید');
  assert.doesNotMatch(capturedBody.query, /متن انتخاب‌شده/);
  assert.deepEqual(capturedBody.selection, {
    text: 'عبارت انتخاب شده از کتاب',
    page: 85,
    book: 'tarhe-kolli',
  });
});
