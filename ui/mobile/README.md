# رابط کامل کتاب و همراه

رابط اجرایی `/mobile/` ادامهٔ همان طراحی فارسی و راست‌به‌چپ در
`docs/design/mobile-preview/` است. طرح اولیه و نمای چندقابی برای مرور در
`/mobile/preview.html` حفظ شده‌اند؛ نسخهٔ اجرایی یک صفحهٔ تمام‌قد دارد.

مبنای رفتارها [ایشوی ۲۰](https://github.com/Rayesh-company/fast-book-learning/issues/20)،
تصمیم‌های محصول در [ایشوی ۱۳](https://github.com/Rayesh-company/fast-book-learning/issues/13)
و ایجنت در [ایشوی ۱۸](https://github.com/Rayesh-company/fast-book-learning/issues/18) هستند.
طبق تصمیم صاحب محصول، این دور تکمیل رابط است؛ سرویس‌های جدید در دور بعد اجرا می‌شوند.

## اجرا و دو حالت

سرور فعلی `ui/serve.py` را اجرا کنید. `/mobile/` از ورود ایمیل، نشست‌های گفتگو،
پاسخ استنادی و دفتر یادداشت موجود استفاده می‌کند. برای PDF اصلی،
`SESSION_BOOKS_DIR` باید شامل `<book-id>.pdf` باشد. مجوز دریافت PDF همان مجوز
حساب فعلی سرور است. فایل کتاب و کلید سرویس صوت در این پوشه بسته‌بندی نشده‌اند.

`/mobile/?demo=1` پیش‌نمایش تعاملی است. گفتگو، یادداشت، سهمیه و
اشتراک نمونه فقط در مرورگر نگهداری می‌شوند. پیامک، پرداخت و درخواست به
ارائه‌دهندهٔ هوش مصنوعی انجام نمی‌شود؛ تولید صوت در این حالت مسدود است.
ورود از پیش‌نمایش حذف شده است؛ رابط مستقیماً باز می‌شود و خروج از حساب نمونه ندارد.
برای نمایش PDF بدون ورود و اشتراک روی شبکهٔ محلی، میزبان مستقل زیر را اجرا کنید:

```sh
python ui/mobile/share.py --host 0.0.0.0 --port 8766 --books-dir /absolute/path/to/books
```

از دستگاه دیگر آدرس `http://<LAN-IP>:8766/` را باز کنید. میزبان اشتراکی فقط
فایل‌های رابط و PDF/نمایهٔ کتاب‌های تعیین‌شده را ارائه می‌دهد و مسیر حساب،
پرداخت یا پایگاه داده ندارد. حتی بدون پارامتر `demo` حالت نمونه را فعال می‌کند.
داده‌های گفتگو و یادداشت روی هر دستگاه مستقل‌اند. ورود سرویس اصلی در
`ui/serve.py` تغییر نکرده؛ برای پیش‌نمایش PDF بدون ورود از میزبان اشتراکی استفاده کنید.

## رفتارهای تکمیل‌شده

- مطالعهٔ PDF واقعی، صفحه و بزرگ‌نمایی، انتخاب دقیق متن، کپی و ذخیرهٔ هایلایت؛
  پرسش داخل کتاب‌خوان در حالت عادی پنهان است و فقط با انتخاب متن و اقدام
  «پرسش از ایجنت» باز می‌شود. ورودی خالی و متن انتخاب‌شده زمینهٔ پرسش است.
- چت با شروع خالی، پیشنهاد آغاز، پاسخ و کارت مطالعه، وضعیت جستجو/نوشتن و توقف،
  تلاش مجدد پیام ناموفق، زمینهٔ مستقل هر پیام و سهمیهٔ تمام‌شده با ارسال فعال.
- حفظ صفحه، پیش‌نویس و موقعیت گفتگو؛ رفتن به منبع مقصد مشخص دارد، انتخاب کتاب
  آخرین گفتگوی آن را باز می‌کند. تاریخچه، تغییر نام، حذف با تأیید و گفتگوی تازه.
- دفتر با دو بخش یادداشت/هایلایت، فیلتر کتاب، جستجو، انتخاب گروهی، کپی، حذف،
  جزئیات، متن ذخیره‌شدهٔ ثابت و ویرایش نظر شخصی، بازگشت به منبع و چاپ/PDF فهرست.
- حساب، سهمیه و وضعیت اشتراک، نمای دستگاه/روشن/تیره و نتیجهٔ پرداخت موفق/ناموفق/انصراف/نامشخص با تأیید وضعیت.
- ضبط با پایان و لغو و تبدیل پس از پایان؛ هیچ متن نمونه‌ای خودکار ارسال نمی‌شود.
  در حالت واقعی میکروفون با اجازهٔ مرورگر ضبط می‌کند و هنگام خروج خاموش می‌شود.

## اتصال موجود و کار دور بعد

`api.mjs` به مسیرهای موجود مخزن و عامل گفت‌وگوی Mastra متصل است. پرسش‌های
همراه از طریق مسیر جریانی `/agent/chat` (SSE) ارسال و پردازش می‌شوند؛ استنادات کتاب
به‌صورت پیوند مستقیم به صفحات کتاب‌خوان باز می‌شوند و پاسخ‌های بیرونی با نشان
«بیرون از کتاب» و پیوند منابع وب مشخص می‌گردند. تغییر نام نشست در سرویس فعلی،
اشتراک و زرین‌پال و تبدیل گفتار به متن هنوز سرویس ندارند؛
رابط واقعی به‌جای اعلام موفقیت خطای قابل‌فهم نشان می‌دهد. ورود پیامکی واقعی است:
شمارهٔ بی‌حساب خطای «ثبت نشده» می‌گیرد (Account ها فقط با مدیر ساخته می‌شوند،
ADR-0013؛ فهرست انتظار ۲۰۲۶-۱۰-۲۴ حذف شد).
وضعیت اشتراک/سهمیهٔ ناشناخته عدد ساختگی ندارد. نمای نمونه جریان‌های این قابلیت‌ها را برای بررسی طراحی پوشش می‌دهد.

کتاب‌خوان و صوت در `../book-reader` و `../narration` مستقل‌اند؛ تولید صوت واقعی
به تنظیم کلید و هم‌ترازی جمله‌ها نیاز دارد. کد طوبی منبع فقط خوانده شده است؛
ذخیرهٔ یادداشت و رفتار حساب طوبی به میزبان منتقل نشده‌اند.

## بررسی

`python -m pytest -q tests/test_mobile_share.py` برای میزبان شبکه و
`npm ci --prefix tests/reader` و `npm test --prefix tests/reader` برای انتخاب
دقیق، پخش/هایلایت، چرخهٔ عمر PDF و رفتارهای رابط هستند. تصاویر
`docs/design/ui-complete-*.png` از مرورگر واقعی و رابط اجرایی گرفته شده‌اند.
فونت محلی وزیرمتن، کنترل‌های اصلی ۴۴ پیکسل، کاهش حرکت، صفحات امن دستگاه،
رشد ورودی و ارتفاع صفحه‌کلید در رابط لحاظ شده‌اند؛ صفحه‌کلید سخت‌افزار موبایل
به بررسی روی دستگاه نیاز دارد.

## حرکت رابط

`motion.mjs` حرکت‌های کوتاه و قابل قطع رابط را مدیریت می‌کند و `motion.css`
بازخورد لمس، اشاره‌گر و کانون را تعریف می‌کند. منو از راست در ۲۴۰ میلی‌ثانیه،
پنل پایین در ۲۲۰ میلی‌ثانیه و خروجشان در حدود ۱۶۰ میلی‌ثانیه انجام می‌شود.
جابه‌جایی نما، پیام تازه، پاسخ شناور، نشانگر تب دفتر و تأیید کپی/ذخیره حرکت
جداگانه دارند؛ دریافت دوبارهٔ سابقه و پیام‌های قدیمی ورود مجدد ندارند.

خروج پنل به‌صورت لایهٔ موقت غیرتعاملی و خارج از درخت دسترس‌پذیری انجام می‌شود؛
این لایه پس از پایان، تغییر نما، تغییر ترجیح حرکت یا بستن میزبان پاک می‌شود.
در `prefers-reduced-motion` همهٔ گذارها فوری‌اند. رندر PDF، لایهٔ انتخاب متن
و هایلایت جمله‌ها هدف هیچ‌کدام از این انیمیشن‌ها نیستند. کتاب‌خوان و صوت
سازوکار قبلی خود را حفظ می‌کنند. حرکت روی موبایل با transform/opacity اجرا
می‌شود؛ وابستگی یا دریافت کتابخانهٔ تازه‌ای اضافه نشده است.

## اصلاح‌های کاربردپذیری پس از نقد

پنل‌های میزبان و ابزارهای PDF از قرارداد مشترک `panel-focus.mjs` استفاده می‌کنند:
کانون وارد پنل می‌شود، Tab داخل آن می‌ماند، پس‌زمینه inert می‌شود و بستن/Escape
کانون را به دکمهٔ قبلی برمی‌گرداند. جابه‌جایی از منوی میزبان به ابزار PDF
از رویداد `reader-tools-open` انجام می‌شود تا دو پنل هم‌زمان کانون را نگیرند.

بزرگ‌نمایی با ژست دو انگشتی و میان‌برهای صفحه‌کلید در دسترس است.
دکمهٔ رفتن به صفحه ناحیهٔ لمس ۴۴ پیکسلی دارد.

راهنمای کوتاه انتخاب متن تا اولین انتخاب یا بستن نمایش داده می‌شود؛ وضعیتش
همراه تنظیمات همان حساب ذخیره می‌شود. ورودی پرسش همچنان در حالت پیش‌فرض
پنهان است. دفتر خالی به فعالیت مبدأ برمی‌گردد، جستجو قابل پاک‌کردن است و تب‌ها
با کلیدهای جهت و Home/End قابل استفاده‌اند. فهرست دفتر با ارتفاع واقعی
نوار ابزار جریان می‌یابد و به فاصلهٔ ثابت از بالای صفحه وابسته نیست.

### Reader gestures and compact controls

The product reader now uses an RTL horizontal swipe (right = next), a two-finger
PDF pinch (75–300%), and small audio/page controls that fade after five idle
seconds. Native selection and zoomed panning take precedence over page turns.
Keyboard users can turn with left/right and zoom with +, - and 0 on the reader.
The page badge and chat context control share session/page scroll-snap wheels
with arrow/Home/End navigation, direct numeric entry, and explicit confirmation.
The session limits the page wheel to its cover and reading pages; uncovered pages
remain reachable through «بدون جلسه». The focus trap shares the existing panel lifecycle.

Reader questions show a first-three/last-three word excerpt only. The complete
canonical selection stays attached to the draft and request. Outside taps,
Escape and downward handle drags minimise it; upward handle drags transfer it
to the current chat without sending. A previous ordinary chat draft is retained
and restored when returning to reading. Empty composers show the microphone;
nonempty composers show send, and pending answers show stop.

The product's central player now controls recorded session audio exclusively. Its
previous/next controls seek to paragraphs whose PDF geometry overlaps existing
lecture timings, preserving pause/play across page boundaries within the session.
Tap the handle/body or hold any compact control for two seconds to expand without
starting playback. Expanded controls include seek, ±10 seconds, session choice,
intro skipping, and 0.75–2× speed. Opening/closing the player preserves playback;
manual navigation pauses it. A plain page tap cannot start an unused player.
The standalone narration modules and server endpoints remain available to their
other hosts; the product reader never requests provider-generated narration.

Saved highlights use a separate overlay from lecture focus, join selected word
runs into continuous line strips, and rehydrate from notebook selections after
page/zoom remounts or a return to reading. Canonical text and offsets are unchanged.
Chat's scope control stays neutral in both states, with context on the right and
record/send/stop on the left. The header book button restores the last reading
position. Conversation overflow actions appear beside their row inside the open
drawer, with Rename/Delete only, keyboard navigation, and deletion confirmation.
