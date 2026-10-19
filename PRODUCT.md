# Product design context

<!-- impeccable:product-schema 1 -->

## Register

product

## Platform

web

## Users and purpose

فراگیران فارسی‌زبان داخل ایران که می‌خواهند یک کتاب را عمیق یاد بگیرند،
مخاطب اصلی‌اند. محصول مطالعهٔ PDF اصلی، پرسش از همراه آموزشی، شنیدن
درس‌گفتار ضبط‌شده و نگهداری یادداشت و هایلایت متصل به منبع را کنار هم می‌آورد.
هدف، فهم و تسلط بر کتاب است؛ کتاب آغازین «طرح کلی اندیشۀ اسلامی در قرآن» است.

The canonical product decisions are GitHub issue #20 and the resolved launch
and agent decisions in #13 and #18 of Rayesh-company/fast-book-learning.
CONTEXT.md remains the repository's domain vocabulary; this file guides design.

## Operating Context

- **اولویت این فاز موبایل است.** تصمیم‌های رابط و ارزیابی تجربه ابتدا بر اساس
  استفاده در مرورگر موبایل انجام شوند؛ چیدمان، کنترل‌های لمسی، فضای امن دستگاه
  و رفتار صفحه‌کلید باید متناسب با موبایل باشند. این اولویت به معنی اپ بومی نیست.
- رابط اجرایی در `ui/mobile/` است. راه‌اندازی و تفاوت حالت واقعی با نمونه در
  `ui/mobile/README.md` توضیح داده شده‌اند.
- فراگیر از مطالعه به پرسش و یادداشت می‌رود و باید بتواند به همان منبع و موقعیت
  قبلی برگردد. سؤال می‌تواند دربارهٔ متن انتخاب‌شده، صفحه یا کل کتاب باشد.

## Capabilities and Constraints

- PDF اصلی، انتخاب متن، هایلایت، یادداشت و بازگشت به منبع از امکانات فعلی‌اند.
- همراه آموزشی زمینهٔ متن انتخاب‌شده، صفحه یا کل کتاب را در نظر می‌گیرد.
  پاسخ‌های متکی به وب باید با نشان «بیرون از کتاب» و پیوند منابع مشخص باشند.
  تصمیم زمینهٔ پرسش در `docs/adr/0023-hierarchical-chat-context-page-and-web-routing.md`
  ثبت شده است.
- پخش‌کنندهٔ کتاب‌خوان فعلی از درس‌گفتار ضبط‌شده استفاده می‌کند؛ تولید گفتار
  مصنوعی، قابلیت آمادهٔ این پخش‌کننده معرفی نشود.
- ثبت‌نام پیامکی، فهرست انتظار، اشتراک و پرداخت در برنامه‌اند؛ طبق
  `ui/mobile/README.md` سرویس آن‌ها هنوز آماده نیست. ورود ایمیلی موجود را از
  ثبت‌نام پیامکی برنامه‌ریزی‌شده متمایز نگه دارید. نمایش یک جریان در حالت نمونه
  به معنی اتصال سرویس نیست.
- الزام قدیمی صوت کامل تولیدشده برای انتشار در
  `docs/adr/0021-b2c-launch-posture.md` با پخش درس‌گفتار ضبط‌شدهٔ فعلی یکسان نیست؛
  نسبت این دو برای انتشار هنوز نیازمند تصمیم محصول است. این فایل آن الزام
  را لغو یا برآورده‌شده اعلام نمی‌کند.
- قیمت، سهمیه، موفقیت پرداخت و آمادگی انتشار را فقط بر اساس تصمیم معتبر و
  وضعیت واقعی سرویس بیان کنید؛ از دادهٔ نمایشی برای اثبات آن‌ها استفاده نکنید.

## Personality and references

Quiet, legible, direct. Preserve the approved mobile-preview design and its
local references: open chat layout, right drawer, and the Google/Gemini floating
question and response over the original PDF. The companion name remains a
provisional “همراه”. No avatar, sharing, extra plus tools, or Research Mode.

## Design principles

- Start in reading; restore the last activity and each book's reading position.
- Open the reader question only after selecting text and choosing ask-agent.
- Preserve drafts, message context, and scroll position through navigation.
- Keep sources reachable; never invent a page or imply a payment succeeded.
- Distinguish interactive preview data from account data and real services.

## Evidence on Hand

- `ui/mobile/README.md`: امکانات فعلی، سرویس‌های آماده‌نشده و راه‌اندازی نمونه.
- `docs/design/mobile-preview/` و `docs/design/references/`: مراجع محلی طراحی
  تأییدشده؛ تصاویر `docs/design/ui-complete-*.png` ثبت رابط اجرایی‌اند، نه تضمین
  انطباق تصویری با آخرین نسخهٔ کد.
- `books/tarhe-kolli/lectures/` و `README.md`: دارایی‌ها و توضیح درس‌گفتار ضبط‌شده.
- فایل‌های PDF کتاب محلی‌اند و در مخزن ثبت نشده‌اند؛ آماده‌بودن آن‌ها در هر
  محیط اجرا باید جداگانه بررسی شود.

## Accessibility and inclusion

Persian RTL, local Vazirmatn fonts, 44px minimum primary touch targets,
keyboard access, focus restoration, reduced motion, light/dark/system themes,
readable contrast, growing composers, and safe-area/keyboard-aware mobile layout.
Exact PDF typography belongs to the original file, not the UI font.
