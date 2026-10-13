import test from 'node:test';
import assert from 'node:assert/strict';
import { answer, formatAgentMarkdown, parseInline } from '../../ui/mobile/views.mjs';

test('formatAgentMarkdown renders headings properly', () => {
  const text = `# عنوان اصلی
## بخش اول
### زیربخش یک
#### جزئیات`;
  const html = formatAgentMarkdown(text);
  assert.match(html, /<h2>عنوان اصلی<\/h2>/);
  assert.match(html, /<h3>بخش اول<\/h3>/);
  assert.match(html, /<h4>زیربخش یک<\/h4>/);
  assert.match(html, /<h5>جزئیات<\/h5>/);
});

test('formatAgentMarkdown renders bold, italic, and strikethrough', () => {
  const text = 'این **متن پررنگ** و این *متن کج* و این ***پررنگ و کج*** و این ~~خط‌خورده~~ است.';
  const html = formatAgentMarkdown(text);
  assert.match(html, /<strong>متن پررنگ<\/strong>/);
  assert.match(html, /<em>متن کج<\/em>/);
  assert.match(html, /<strong><em>پررنگ و کج<\/em><\/strong>/);
  assert.match(html, /<del>خط‌خورده<\/del>/);
});

test('formatAgentMarkdown renders unordered and ordered lists with Persian digits', () => {
  const text = `- مورد الف
- مورد ب با **توضیح**

1. مرحله اول
2. مرحله دوم

۱. گام اول
۲. گام دوم`;
  const html = formatAgentMarkdown(text);
  assert.match(html, /<ul><li>مورد الف<\/li><li>مورد ب با <strong>توضیح<\/strong><\/li><\/ul>/);
  assert.match(html, /<ol><li>مرحله اول<\/li><li>مرحله دوم<\/li><\/ol>/);
  assert.match(html, /<ol><li>گام اول<\/li><li>گام دوم<\/li><\/ol>/);
});

test('formatAgentMarkdown renders blockquotes and horizontal rules', () => {
  const text = `> ایمان تعهدی است که عمل صالح به دنبال دارد.
> خط دوم نقل قول

---

متن بعد از خط`;
  const html = formatAgentMarkdown(text);
  assert.match(html, /<blockquote><p>ایمان تعهدی است که عمل صالح به دنبال دارد\.<br>خط دوم نقل قول<\/p><\/blockquote>/);
  assert.match(html, /<hr>/);
  assert.match(html, /<p>متن بعد از خط<\/p>/);
});

test('formatAgentMarkdown renders fenced code blocks and inline code', () => {
  const text = `کد دستور \`npm test\` است:

\`\`\`python
def hello():
    return "سلام دنیا"
\`\`\`
`;
  const html = formatAgentMarkdown(text);
  assert.match(html, /<code>npm test<\/code>/);
  assert.match(html, /<pre><code class="language-python">def hello\(\):\n    return &quot;سلام دنیا&quot;<\/code><\/pre>/);
});

test('formatAgentMarkdown renders markdown tables', () => {
  const text = `| مفهوم | تعریف |
| --- | --- |
| ایمان | باور همراه با تعهد |
| توحید | یگانگی خداوند |`;
  const html = formatAgentMarkdown(text);
  assert.match(html, /<div class="table-wrap"><table><thead><tr><th>مفهوم<\/th><th>تعریف<\/th><\/tr><\/thead><tbody><tr><td>ایمان<\/td><td>باور همراه با تعهد<\/td><\/tr><tr><td>توحید<\/td><td>یگانگی خداوند<\/td><\/tr><\/tbody><\/table><\/div>/);

  const textNoLeadingPipe = `مفهوم | تعریف
--- | ---
ایمان | عمل`;
  const htmlNoLeading = formatAgentMarkdown(textNoLeadingPipe);
  assert.match(htmlNoLeading, /<div class="table-wrap"><table><thead><tr><th>مفهوم<\/th><th>تعریف<\/th><\/tr><\/thead><tbody><tr><td>ایمان<\/td><td>عمل<\/td><\/tr><\/tbody><\/table><\/div>/);
});

test('formatAgentMarkdown renders task lists with checkboxes', () => {
  const text = `- [x] کار انجام‌شده
- [ ] کار باقی‌مانده`;
  const html = formatAgentMarkdown(text);
  assert.match(html, /<input type="checkbox" disabled checked> کار انجام‌شده/);
  assert.match(html, /<input type="checkbox" disabled> کار باقی‌مانده/);
});

test('formatAgentMarkdown renders links safely', () => {
  const text = 'اطلاعات در [دانشنامه](https://fa.wikipedia.org) موجود است.';
  const html = formatAgentMarkdown(text);
  assert.match(html, /<a href="https:\/\/fa\.wikipedia\.org" target="_blank" rel="noopener noreferrer">دانشنامه<\/a>/);
});

test('formatAgentMarkdown properly escapes raw HTML to prevent XSS', () => {
  const text = 'یک پیام مشکوک: <script>alert("xss")</script> و <img src="x" onerror="evil()"/>';
  const html = formatAgentMarkdown(text);
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img/);
});

test('views.answer renders complex agent response in markdown with interactive citations', () => {
  const agentAnswer = {
    text: `### خلاصه پاسخ
ایمان در قرآن یک **تعهد عملی** است:
- جهت‌گیری در زندگی طبق document tarhe-kolli (page 85)
- مبارزه مستمر طبق document 70143-336 (pages 40-42)

> ایمان بدون عمل، ادعایی بیش نیست.`,
    book: 'tarhe-kolli',
    citations: [
      { doc: 'tarhe-kolli', page: 85, reference: 'document tarhe-kolli (page 85)', text: 'document tarhe-kolli (page 85)' },
    ],
    outside: [],
  };

  const rendered = answer(agentAnswer, 0);
  assert.match(rendered, /<h4>خلاصه پاسخ<\/h4>/);
  assert.match(rendered, /<strong>تعهد عملی<\/strong>/);
  assert.match(rendered, /<ul>/);
  assert.match(rendered, /class="cite-sent agent-cite"/);
  assert.match(rendered, /data-book="tarhe-kolli"/);
  assert.match(rendered, /data-page="85"/);
  assert.match(rendered, /data-book="70143-336"/);
  assert.match(rendered, /data-page="40"/);
  assert.match(rendered, /<blockquote><p>ایمان بدون عمل، ادعایی بیش نیست\.<\/p><\/blockquote>/);
});
