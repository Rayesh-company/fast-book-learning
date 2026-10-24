import { Agent } from "@mastra/core/agent";
import { ToolCallFilter } from "@mastra/core/processors";
import { Memory } from "@mastra/memory";
import { searchBooksTool } from "../tools/search-books";
import { webSearchTool } from "../tools/web-search";

const AVALAI_BASE_URL = (
  process.env.AVALAI_BASE_URL ?? "https://api.avalai.ir/v1"
).replace(/\/+$/, "");

export interface UserProfileContext {
  usage_purpose?: string;
  martyr_leader_familiarity?: string;
  martyr_works_familiarity?: string;
  knowledge_level?: string;
  age?: string | number;
  politics_familiarity?: string;
  religion_familiarity?: string;
  job?: string;
  occupation?: string;
  tone?: string;
  assistant_tone?: string;
}

export function buildPersonalizedDirectives(
  profile?: UserProfileContext | null,
): string {
  if (!profile || typeof profile !== "object") return "";

  const parts: string[] = [];

  // ۱. لحن همراه هوشمند (Agent Tone)
  const tone = (profile.assistant_tone || profile.tone)?.trim();
  if (tone === "حرفه‌ای" || tone === "حرفه ای" || tone === "professional") {
    parts.push(
      "- لحن همراه: کاملاً حرفه‌ای، رسمی، آکادمیک، عمیقاً تحلیلی و مستدل با زبانی ساختاریافته و عینی. از هرگونه شوخی یا تعابیر عامیانه بپرهیز و متن را با وقار علمی ارائه بده.",
    );
  } else if (tone === "آموزشی" || tone === "اموزشی" || tone === "educational") {
    parts.push(
      "- لحن همراه: آموزشی، مشفقانه، صبور، همراه با هدایت گام‌به‌گام و شیوهٔ سقراطی. تعاریف روشن از مفاهیم پایه ارائه بده و یادگیرنده را به تفکر فعالانه تشویق کن.",
    );
  } else if (
    tone === "برای نوجوان و کودک" ||
    tone === "برای نو جوان و کودک" ||
    tone === "kids"
  ) {
    parts.push(
      "- لحن همراه: بسیار صمیمی، گرم، پرانرژی و متناسب با ردهٔ سنی کودک و نوجوان. از اصطلاحات سنگین کلامی، فقهی و حوزوی کاملاً پرهیز کن، از تمثیل‌های ملموس، داستان‌واره و جذاب روزمره استفاده کن و با ریتمی گیرا و ترغیب‌کننده پاسخ بده.",
    );
  } else if (tone === "ساده و روان" || tone === "simple") {
    parts.push(
      "- لحن همراه: بسیار ساده، صمیمی، روان، همه‌فهم و مکالمه‌ای. از پیچیدگی‌های ادبی، جملات تو در تو، کلمات مهجور و تکلف‌های زبانی دوری کن.",
    );
  }

  // ۲. سن یادگیرنده و داربست‌بندی شناختی متناسب با سن (Age-Adapted Scaffolding)
  if (profile.age != null && String(profile.age).trim() !== "") {
    const ageNum = Number(profile.age);
    if (!Number.isNaN(ageNum)) {
      if (ageNum < 15) {
        parts.push(
          `- سن یادگیرنده: ${ageNum} سال (کودک/نوجوان زیر ۱۵ سال) — داربست‌بندی شناختی متناسب: توضیحات بسیار ملموس، همراه با مثال‌های عینی و تجربی از دنیای واقعی، واژگان ساده و پرهیز کامل از اصطلاحات انتزاعی پیچیده.`,
        );
      } else if (ageNum <= 22) {
        parts.push(
          `- سن یادگیرنده: ${ageNum} سال (نوجوان/جوان ۱۵ تا ۲۲ سال) — داربست‌بندی شناختی متناسب: درگیر کردن ذهن نقاد و پرسش‌گر، پیوند مباحث با دغدغه‌های جوانی، دانشجویی و زندگی امروزی، همراه با استدلال‌های پویا.`,
        );
      } else {
        parts.push(
          `- سن یادگیرنده: ${ageNum} سال (بزرگسال ۲۲+ سال) — تحلیل‌های ژرف، استدلال‌های دقیق، مستند و موشکافانه، تبیین ابعاد ساختاری و چندوجهی مباحث.`,
        );
      }
    } else {
      parts.push(
        `- سن یادگیرنده: ${profile.age} سال — مطالب، لحن و تمثیل‌ها با این رده سنی هماهنگ باشد.`,
      );
    }
  }

  // ۳. میزان آشنایی و دانش با مباحث کتاب‌ها (Knowledge Scaffolding)
  const knowledge = (
    profile.knowledge_level ||
    profile.martyr_works_familiarity ||
    profile.martyr_leader_familiarity
  )?.trim();
  if (
    knowledge === "کم" ||
    knowledge === "آشنایی ندارم" ||
    knowledge === "اشنایی ندارم" ||
    knowledge === "low" ||
    knowledge === "none"
  ) {
    parts.push(
      "- سطح آشنایی و دانش: مقدماتی/کم — مفاهیم پایه و کلیدی را از صفر و با تعاریف روشن و همه‌فهم تبیین کن و هیچ پیش‌فرضی از آشنایی قبلی مخاطب با اصطلاحات خاص متن کتاب قرار نده.",
    );
  } else if (knowledge === "متوسط" || knowledge === "medium") {
    parts.push(
      "- سطح آشنایی و دانش: متوسط — روی پیوند و انسجام ساختاری مفاهیم و تحلیل نکات اصلی تمرکز کن، بدون آنکه وقت را صرف بازگویی تعاریف بدیهی و اولیه کنی.",
    );
  } else if (knowledge === "زیاد" || knowledge === "high") {
    parts.push(
      "- سطح آشنایی و دانش: پیشرفته/زیاد — مستقیماً به عمق تحلیل، ظرایف کلامی و فلسفی و مقایسهٔ اندیشه‌ها ورود کن و از تکرار مقدمات و تعاریف ابتدایی عبور کن.",
    );
  }

  // ۴. هدف استفاده (در صورت وجود، سازگاری پیشین)
  const purpose = profile.usage_purpose?.trim();
  if (purpose === "اکادمیک") {
    parts.push(
      "- هدف استفاده: اکادمیک — تمرکز بر دقت نظری، نقل مستند عبارات، تحلیل مفاهیم بنیادی و بررسی دقیق استنادات فصول.",
    );
  } else if (purpose === "مطالعه آزاد") {
    parts.push(
      "- هدف استفاده: مطالعه آزاد — پاسخ‌ها را شیوا، دلنشین و با نگاه کلی ارائه بده تا لذت خواندن و بینش کلی حاصل شود و از ورود به مناقشات ریز غیرضروری خودداری کن.",
    );
  } else if (purpose === "یادگیری") {
    parts.push(
      "- هدف استفاده: یادگیری — نکات کلیدی و چکیده‌های راهبردی را مشخص کن تا فهم عمیق ایجاد شود و نکات مهم را مرور کن.",
    );
  } else if (purpose === "مباحثه") {
    parts.push(
      "- هدف استفاده: مباحثه — به ساختار استدلال‌ها، دلایل، پرسش‌های احتمالی و زوایای تحلیلی گزاره‌ها بپرداز.",
    );
  } else if (purpose === "آموزش" || purpose === "اموزش") {
    parts.push(
      "- هدف استفاده: آموزش — متن را با اسلوب درسنامه‌ای، تفکیک سرفصل‌ها و گزاره‌های قابل تدریس و انتقال به دیگران تنظیم کن.",
    );
  } else if (purpose === "ارائه") {
    parts.push(
      "- هدف استفاده: ارائه — پاسخ را به صورت محورهای شفاف، تیتروار، جمع‌بندی شده و آمادهٔ ارائه یا سخنرانی مرتب کن.",
    );
  }

  // ۵. سایر زمینه‌های اختیاری (سازگاری پیشین)
  const familiarityPol = profile.politics_familiarity?.trim();
  if (familiarityPol === "زیاد") {
    parts.push(
      "- آشنایی با سیاست: بالا — ابعاد سیاسی و جامعه‌شناختی وقایع تاریخ اسلام در کتاب انسان ۲۵۰ ساله و پیوند دین و سیاست در طرح کلی را با تحلیل‌های مبارزاتی دقیق تشریح کن.",
    );
  } else if (
    familiarityPol === "کم" ||
    familiarityPol === "آشنایی ندارم" ||
    familiarityPol === "اشنایی ندارم"
  ) {
    parts.push(
      "- آشنایی با سیاست: مقدماتی — مفاهیم مبارزه سیاسی ائمه و مباحث حکومتی را با بیانی ساده و بدون پیش‌فرض‌های اصطلاحات سیاسی پیچیده بیان کن.",
    );
  }

  const familiarityRel = profile.religion_familiarity?.trim();
  if (familiarityRel === "زیاد") {
    parts.push(
      "- آشنایی با مباحث دینی: بالا — می‌توانی از تعابیر قرآنی، فقهی و حدیثی به صورت تخصصی و غنی استفاده کنی.",
    );
  } else if (
    familiarityRel === "کم" ||
    familiarityRel === "آشنایی ندارم" ||
    familiarityRel === "اشنایی ندارم"
  ) {
    parts.push(
      "- آشنایی با مباحث دینی: مقدماتی — اصطلاحات مذهبی، قرآنی و روایی را با معانی روشن و قابل فهم عمومی بازگو کن.",
    );
  }

  const job = (profile.job || profile.occupation)?.trim();
  if (job) {
    parts.push(
      `- شغل/نقش یادگیرنده: ${job} (در صورت لزوم مثال‌ها و کاربردها را به این حیطه نزدیک کن).`,
    );
  }

  if (parts.length === 0) return "";
  return (
    "\n\n### مشخصات و تنظیمات یادگیرنده (Personalized Learner Profile):\n" +
    parts.join("\n")
  );
}

export function getRequestContextValue<T>(
  context: unknown,
  key: string,
): T | undefined {
  if (!context || typeof context !== "object") return undefined;
  if ("get" in context && typeof (context as any).get === "function") {
    return (context as any).get(key) as T | undefined;
  }
  return (context as Record<string, unknown>)[key] as T | undefined;
}

export interface PageContext {
  book?: string;
  page: number | string;
  last_page?: number | string;
  pages?: (number | string)[];
  text: string;
  prev_page?: number | string | null;
  prev_paragraph?: string | null;
  next_page?: number | string | null;
  next_paragraph?: string | null;
}

export function buildPageContextDirectives(
  pageContext?: PageContext | null,
): string {
  if (!pageContext || typeof pageContext !== "object" || !pageContext.text) {
    return "";
  }

  const bookName = pageContext.book || "کتاب";
  const pageNum = pageContext.page;
  const n = Number(pageNum);
  const lastPageNum = pageContext.last_page;
  const hasRange =
    lastPageNum !== undefined &&
    lastPageNum !== null &&
    lastPageNum !== "" &&
    Number(lastPageNum) > n;

  const parts: string[] = [];
  const pageLabelStr = hasRange
    ? `صفحات فعلی: ${pageNum} تا ${lastPageNum}`
    : `صفحهٔ فعلی: ${pageNum}`;

  parts.push(
    `### بافت صفحهٔ فعال (Active Page Context):\nکتاب: ${bookName}\n${pageLabelStr}`,
  );

  if (pageContext.prev_paragraph) {
    const prevPageNum =
      pageContext.prev_page ??
      (Number.isFinite(n) && n > 1 ? n - 1 : "");
    parts.push(
      `[پاراگراف پایانی صفحهٔ قبل${prevPageNum ? ` (${prevPageNum})` : ""} جهت پیوستگی متن]:\n${pageContext.prev_paragraph}`,
    );
  }

  const pageRangeRef = hasRange
    ? `صفحات ${pageNum} تا ${lastPageNum}`
    : `صفحهٔ ${pageNum}`;

  parts.push(`[متن کامل ${pageRangeRef}]:\n${pageContext.text}`);

  if (pageContext.next_paragraph) {
    const endN = hasRange ? Number(lastPageNum) : n;
    const nextPageNum =
      pageContext.next_page ??
      (Number.isFinite(endN) ? endN + 1 : "");
    parts.push(
      `[پاراگراف ابتدایی صفحهٔ بعد${nextPageNum ? ` (${nextPageNum})` : ""} جهت پیوستگی متن]:\n${pageContext.next_paragraph}`,
    );
  }

  const canonicalCitation = hasRange
    ? `document ${bookName} (pages ${pageNum}-${lastPageNum})`
    : `document ${bookName} (page ${pageNum})`;

  parts.push(
    `دستورالعمل‌های بافت صفحهٔ فعال (Tier 2 Page Grounding Directives):\n` +
      `۱. پاسخ مستقیم با ۰ فراخوانی ابزار (Direct Answer with Zero Tool Calls): ابتدا بررسی کن که آیا پرسش یادگیرنده با متن این ${hasRange ? "صفحات" : "صفحه"} (یا پاراگراف‌های مرزی متصل به آن) پوشش داده می‌شود یا خیر. اگر پاسخ در متن این ${hasRange ? "صفحات" : "صفحه"} وجود دارد، پاسخ را مستقیماً و منحصراً از متن همین ${hasRange ? "صفحات" : "صفحه"} با ۰ فراخوانی ابزار (بدون اجرای search_books یا web_search) تدوین کن.\n` +
      `۲. استناد استاندارد و متعارف (Canonical Citation): هر ادعا، نقل یا گزاره‌ای که از متن این ${hasRange ? "صفحات" : "صفحه"} استخراج می‌شود را با فرمت استاندارد ارجاع بده: ${canonicalCitation}. اگر گزاره‌ای از پاراگراف‌های مرزی (صفحهٔ قبل یا بعد) استخراج شده یا میان صفحات امتداد یافته است، دقیقاً همان صفحهٔ مرزی یا بازه را ارجاع بده: document ${bookName} (page <N>) یا document ${bookName} (pages <N>-<M>).\n` +
      `۳. تصریح مؤدبانه به عدم پوشش در صفحه (Boundary Acknowledgment): اگر پرسش یادگیرنده مفهومی را می‌پرسد که در متن ${pageRangeRef} مطرح نشده است، در پاسخ خود حتماً و پیش از ارائهٔ پاسخ بسط‌یافته، به صراحت و با لحنی مؤدبانه اعلام کن که در ${pageRangeRef} کتاب ${bookName} به این موضوع پرداخته نشده است.\n` +
      `۴. ارتقای خودکار به جستجوی کتاب‌ها (search_books Escalation): پس از اعلام صریح عدم پوشش موضوع در ${pageRangeRef}، به صورت خودکار ابزار search_books را برای جستجو در کل مجموعهٔ کتاب‌ها فراخوانی کن تا پاسخ کامل بر پایهٔ کتاب‌ها تدوین شود.\n` +
      `۵. ارجاع به وب در صورت عدم پوشش در کتاب‌ها (Web Search Fallback): اگر موضوع نه در متن ${pageRangeRef} و نه در کل کتاب‌ها یافت نشد، از ابزار web_search برای جستجو استفاده کن و هر گزارهٔ حاصل از وب را با نشان صریح «بیرون از کتاب» و پیوند منبع مشخص نما.`,
  );

  return "\n\n" + parts.join("\n\n");
}

export interface SelectionContext {
  text: string;
  page?: number | string;
  book?: string;
}

export function buildSelectionDirectives(
  selectionContext?: SelectionContext | string | null,
  activePageOrContext?: PageContext | number | string | null,
  activeBookFallback?: string | null,
): string {
  if (!selectionContext) return "";

  const ctx: SelectionContext =
    typeof selectionContext === "string"
      ? { text: selectionContext }
      : selectionContext;

  if (!ctx.text || typeof ctx.text !== "string" || !ctx.text.trim()) {
    return "";
  }

  let activePage: number | string | undefined;
  let activeBook: string | undefined;

  if (activePageOrContext && typeof activePageOrContext === "object") {
    activePage = activePageOrContext.page;
    activeBook = activePageOrContext.book;
  } else if (
    activePageOrContext !== undefined &&
    activePageOrContext !== null &&
    activePageOrContext !== ""
  ) {
    activePage = activePageOrContext;
    activeBook = activeBookFallback || undefined;
  } else if (activeBookFallback) {
    activeBook = activeBookFallback;
  }

  const bookName = ctx.book || activeBook || "کتاب";
  const pageNum =
    ctx.page !== undefined && ctx.page !== null && ctx.page !== ""
      ? ctx.page
      : (activePage !== undefined && activePage !== null && activePage !== ""
        ? activePage
        : undefined);

  const parts: string[] = [];

  let header = `### بافت فراز منتخب (Selected Passage Context / Tier 1 Grounding):`;
  if (bookName !== "کتاب" && pageNum !== undefined) {
    header += `\nکتاب: ${bookName}\nصفحه: ${pageNum}`;
  } else if (pageNum !== undefined) {
    header += `\nصفحه: ${pageNum}`;
  } else if (bookName !== "کتاب") {
    header += `\nکتاب: ${bookName}`;
  }
  parts.push(header);

  parts.push(`[متن فراز انتخاب‌شده]:\n${ctx.text.trim()}`);

  const citationFormat =
    pageNum !== undefined
      ? `document ${bookName} (page ${pageNum})`
      : `document ${bookName} (page <N>)`;

  parts.push(
    `دستورالعمل‌های بافت فراز منتخب (Tier 1 Selection Grounding Directives):\n` +
      `۱. تقدم و اولویت درک مطلب متن‌بسته بر بافت صفحه و جستجوی کل کتاب (Precedence of Closed-Passage Reading Comprehension): بافت این فراز منتخب اولویت نخست (Tier 1) است و بر بافت کل صفحه (Tier 2) و جستجوی کل کتاب (Tier 3) تقدم کامل دارد. پرسش یادگیرنده را منحصراً دربارهٔ همین فراز انتخاب‌شده پاسخ بده و تمرکز کامل خود را بر عبارات و واژگان عینی (verbatim wording) آن معطوف کن. پاسخ باید در چارچوب درک مطلب بسته (closed-passage reading comprehension) و وفادار به متن بدون حدس و گمان‌های خارج از متن تنظیم شود.\n` +
      `۲. پاسخ مستقیم با ۰ فراخوانی ابزار (Direct Answer with Zero Tool Calls): تا زمانی که پرسش یادگیرنده با واژگان و مفاهیم همین فراز قابل پاسخ‌گویی است، پاسخ را مستقیماً با ۰ فراخوانی ابزار (بدون اجرای search_books یا web_search) تدوین کن. ابزار جستجوی کل کتاب (search_books) را فراخوانی نکن مگر اینکه پاسخ به پرسش صراحتاً نیازمند تعاریف یا اطلاعات تکمیلی بیرونی باشد که در فراز نیامده است.\n` +
      `۳. استناد استاندارد و متعارف (Canonical Citation): ادعاها و گزاره‌های استخراج‌شده از این فراز را حتماً با فرمت استاندارد ارجاع بده: ${citationFormat}.`,
  );

  return "\n\n" + parts.join("\n\n");
}

const BASE_INSTRUCTIONS = `
You are کتاب‌خوان's Chat agent (عامل گفت‌وگو) — the conversational answerer of a
Farsi book-learning product (ADR-0018). The Learner chats with you about their
Book set: «طرح کلی اندیشۀ اسلامی در قرآن» and «انسان ۲۵۰ ساله».

Answer in Farsi by default; follow the Learner's language if they write
otherwise. You compose your answers freely, under these rules:

1. Follow this strict context and retrieval hierarchy across four tiers:
   - Tier 1: If selected passage context is present, prioritize closed-passage
     reading comprehension strictly over the excerpt without calling search tools
     (unless external definitions are required), citing canonical document <book> (page <N>).
   - Tier 2: If active page context is present and covers the question,
     answer directly from that text first with zero tool calls without executing search tools.
     Cite every claim sourced from the injected page using the canonical format:
     document <book> (page <N>). If a claim is sourced from a boundary page or spans
     across boundaries, cite that boundary page or range: document <book> (page <N>)
     or document <book> (pages <N>-<M>). If the question asks about a concept not
     covered in the page, explicitly output a polite acknowledgment in your answer
     stating that page <N> does not discuss the topic before providing the expanded answer,
     then automatically call search_books across the Book set.
   - Tier 3: If in whole-book mode or page overflow (anything the Books might answer
     beyond the excerpt or active page), call search_books FIRST. Ground Book-sourced
     statements in the returned passages and cite each with its reference (the Book
     and its pages) exactly as the tool returned it or as specified in the page context.
     Never invent a page number or a Book quote — cite only references from the tool
     or the provided context.
   - Tier 4: If neither page nor books cover the question — current events,
     general knowledge beyond the Book set, facts the passages don't cover —
     call web_search. Mark every web-sourced statement with «بیرون از کتاب» and name
     its source as a visible link.
2. Never present web content or your own knowledge as Book content. When
   you answer from your own knowledge with neither tool, say plainly that
   it is not from the Books.
3. One Learner message is one Question: answer directly and completely;
   ask a clarifying question only when the message is truly ambiguous.
4. This is not Research Mode: no research plans, no maps, no journeys —
   just the Learner's conversation with their Books.
`;

// ADR-0018: the chat agent's model is deepseek-v4.1-flash via Avalai
// (OpenAI-compatible), chosen by the PM 2026-10-04.
export const chatAgent = new Agent({
  id: "chat-agent",
  name: "عامل گفت‌وگو",
  instructions: ({ requestContext }) => {
    const userProfile = getRequestContextValue<UserProfileContext>(
      requestContext,
      "userProfile",
    );

    const pageContext = getRequestContextValue<PageContext>(
      requestContext,
      "pageContext",
    );

    const selectionText = getRequestContextValue<SelectionContext | string>(
      requestContext,
      "selectionText",
    );

    return (
      BASE_INSTRUCTIONS.trim() +
      buildPersonalizedDirectives(userProfile) +
      buildSelectionDirectives(selectionText, pageContext) +
      buildPageContextDirectives(pageContext)
    );
  },
  model: {
    get id(): `${string}/${string}` {
      let m = (
        process.env.CHAT_AGENT_MODEL ||
        process.env.AGENT_MODEL ||
        process.env.LLM_MODEL ||
        "avalai/deepseek-v4.1-flash"
      ).trim();

      // If user provided Qwen3.8-27B-GGUF for unsloth, ensure the repo owner prefix unsloth/ is present
      if (m === "Qwen3.8-27B-GGUF") {
        m = "unsloth/Qwen3.8-27B-GGUF";
      }

      // Mastra's ModelRouterLanguageModel requires "provider/model" format.
      // If no provider prefix is supplied or it's a HuggingFace-style repo model (e.g. unsloth/model),
      // prefix "openai/" so Mastra treats it as an OpenAI-compatible model and passes the model id as-is to the endpoint.
      if (!m.includes("/")) {
        m = `openai/${m}`;
      } else if (!m.startsWith("openai/") && !m.startsWith("avalai/") && !m.startsWith("google/")) {
        m = `openai/${m}`;
      }
      return m as `${string}/${string}`;
    },
    get url() {
      let u = (
        process.env.AVALAI_BASE_URL ||
        process.env.LLM_ENDPOINT ||
        "https://api.avalai.ir/v1"
      ).replace(/\/+$/, "");
      if (
        !process.env.VITEST &&
        process.env.NODE_ENV === "production" &&
        (u.includes("127.0.0.1") || u.includes("localhost"))
      ) {
        u = u.replace("127.0.0.1", "host.docker.internal").replace("localhost", "host.docker.internal");
      }
      return u;
    },
    get apiKey() {
      return (
        process.env.AVALAI_API_KEY ||
        process.env.LLM_API_KEY ||
        ""
      );
    },
  },
  tools: { searchBooksTool, webSearchTool },
  inputProcessors: [
    new ToolCallFilter({
      exclude: ["searchBooksTool", "webSearchTool"],
    }),
  ],
  memory: new Memory({
    options: {
      // The durable conversation (ADR-0014's persistence leg): the
      // thread history rides the Mastra storage, keyed per Learner.
      lastMessages: parseInt(process.env.CHAT_AGENT_LAST_MESSAGES || "10", 10),
      messageHistory: {
        maxTokens: 8000,
        atMaxRemoveTokens: 2000,
      },
      workingMemory: {
        enabled: process.env.MASTRA_WORKING_MEMORY !== "false",
        scope: "resource",
      },
    },
  }),
});
