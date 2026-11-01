# دامپ دیتابیس حافظه — `cognee_db.dump` چیست و چگونه بازیافت می‌شود

> این برگه در جریان ری‌استورِ ۳۰ اکتبر ۲۰۲۶ نوشته شد؛ همان روزی که همین فایل،
> حافظهٔ جست‌وجوی «چت با کتاب» را بعد از پاک‌شدن سرور برگرداند.
> مسیر کل بازسازی سرور: `docs/server-rebuild-runbook.fa.md`.

---

## «دامپ» اصلاً چیست؟

`cognee_db.dump` یک **اسنپ‌شاتِ منجمد در زمان** از دیتابیس PostgreSQL پلتفرم حافظه
(cognee) است — نه یک کپی زنده:

- با `pg_dump -Fc` ساخته می‌شود: «فرمت سفارشی» یعنی فشرده (gzip) و فقط با
  `pg_restore` خواندنی. ساده‌ترین تصویر: بایگانی بارگیری/بازبارگیریِ دیتابیس.
- دیتای **زنده** جای دیگری است: volume داکری `chat-withbooks_postgres_data` روی
  سرور. تا سرور زنده است، هیچ‌کس به دامپ نیاز ندارد؛ دامپ بیمهٔ سرورِ مرده است.
- اسنپ‌شات یعنی «در لحظهٔ ساخت» — هرچه بعدش اتفاق بیفتد داخلش نیست. دامپ ما مال
  **۱۲ سپتامبر ۲۰۲۶** است؛ بعد از آن فقط بردارهای پرسش‌وپاسخِ نشست‌ها جلو رفته
  بود — و sqlite همان نشست‌ها هم در پاک‌شدن سوخت، پس این عقب‌ماندگی عملاً بی‌ضرر است
  (پایین را ببینید).

## مشخصات همین فایل (خوانده از سربرگِ خود آرشیو با `pg_restore -l`)

| ویژگی | مقدار |
|---|---|
| ساخته‌شده در | `2026-09-12 16:43:43 UTC` |
| دیتابیس مبدأ | `cognee_db` — کانتینر `chat-with-books-postgres` |
| فرمت | custom نسخهٔ `1.16-0`، فشرده‌سازی gzip |
| مدخل‌های TOC | ۲۹۳ (۵۰ جدولِ داده + ایندکس‌ها و محدودیت‌ها) |
| حجم | ۳۱۷ مگابایتِ فشرده ← حدود ۸۰۰ مگابایت بعد از ری‌استور |
| جای فعلی روی سرور | `/home/chat-with-books/backups/cognee_db.dump` (مالک: `cwdeploy` — ری‌استورِ بعدی بدون نیاز به root) |

## داخل فایل چیست؟ — ۵۰ جدول در چهار خانواده

**۱) خودِ حافظه — همان که پرسش‌وپاسخ از آن می‌خواند:**

| جدول | ردیف بعد از ری‌استور | چیستی |
|---|---:|---|
| `DocumentChunk_text` | ۳۴۱ | تکه‌های متن کتاب + بردارهایشان |
| `TextDocument_name` | ۲ | سندها |
| `TextSummary_text` | ۳۴۱ | خلاصهٔ هر تکه |
| `Entity_name` + `EntityType_name` | ۳٬۷۹۴ | نهادها و انواع‌شان |
| `graph_node` / `graph_edge` (+ `graph_metadata`، `graph_metrics`) | ۴٬۶۲۳ / ۱۸٬۶۴۱ | گراف معنایی |
| `SessionQAVector_text` | ۷۰ | بردار پرسش‌وپاسخ نشست‌ها (تا لحظهٔ دامپ) |
| `provenance_edge_evidence` / `provenance_entries` | — | شواهد منشأ برای نقل‌قول‌ها |

**۲) هویت و دسترسیِ خود cognee:** `users`، `tenants`، `principals`، `roles`،
`permissions`، `acls`، `user_roles`، `user_tenants`، `role/tenant/user_default_permissions`.
داخل دامپ فقط **یک** کاربر هست: `default_user@example.com` (id `1fd3ec20…`) —
همانی که دیتاست‌ها به او تعلق دارند. حساب‌های واقعیِ محصول اینجا **نیستند**؛
آن‌ها در sqlite کانتینر session اند.

**۳) دیتاست‌ها و خط لوله:** `datasets` (۲ ردیف؛ `tarhe-kolli` کتابِ درس است)،
`data`، `dataset_configurations`، `dataset_database`، `pipeline_runs`،
`queries` / `results` / `notebooks`، `sync_operations`.

**۴) زیرساختی/کش:** `alembic_version` (شمارهٔ نسخهٔ اسکیما)، `cache_*`،
`session_model_usage`، `session_records`، `tool_connections`،
`tool_write_proposals`، `integration_credentials`، `user_api_key`،
`nodes` / `edges` (جدول‌های لِگسی).

### چه چیزی عمداً داخلش نیست

- **نشست‌ها، گفت‌وگوها، حساب‌ها، یادداشت‌ها، پیوندهای ایتا، مصرف و اعتبار** ←
  sqlite کانتینر session (volume `session_quota` در `/data`). دامپ فقط نیمهٔ
  postgres است.
- گفت‌وگوهای ایجنت (volume `agent_data`)، کتاب‌های PDF و صداها، خود کد، `.env`،
  nginx و گواهی‌ها.
- یعنی **بازیافت کاملِ محصول = این دامپ + دو volume داکری sqlite** (نقشهٔ کامل:
  ران‌بوک بازسازی سرور و «MIGRATION MAP» در حافظهٔ پروژه).

## چگونه ساخته می‌شود (بکاپ)

روی سرور، از پوشهٔ پلتفرم:

```bash
sudo docker exec chat-with-books-postgres \
  pg_dump -Fc -U cognee cognee_db > /home/chat-with-books/backups/cognee_db.dump
sudo chown cwdeploy:cwdeploy /home/chat-with-books/backups/cognee_db.dump
```

بعد از هر اینجست مهم (کتاب جدید)، همین یک بار تکرار شود تا اسنپ‌شات تازه بماند.

## چگونه بازیافت می‌شود — همان‌کاری که ۳۰ اکتبر شد

```bash
# ۱) سرویس‌های نویسنده را نگه دار (cognee هنگام ری‌استور نباید بالا باشد)
sudo docker stop chat-with-books-cognee chat-with-books-cognee-next-tier

# ۲) دامپ را داخل کانتینر postgres ببر
sudo docker cp /home/chat-with-books/backups/cognee_db.dump \
  chat-with-books-postgres:/tmp/cognee_db.dump

# ۳) ری‌استور با پرچم‌های HANDOFF (scripts/restore.sh) — nohup که ssh قطع نشود
sudo docker exec chat-with-books-postgres \
  pg_restore -U cognee -d cognee_db --clean --if-exists /tmp/cognee_db.dump

# ۴) پاک‌سازی و روشن‌کردن دوباره
sudo docker exec chat-with-books-postgres rm /tmp/cognee_db.dump
sudo docker start chat-with-books-cognee chat-with-books-cognee-next-tier
```

### تله‌ای که ری‌استور ۳۰ اکتبر گرفت — حتماً بخوانید

`pg_restore` با حدود ۱۳ «خطای نادیده‌شده» تمام می‌شود که ظاهرش خطرناک و جوهرش
یکی است: **تصویر جدید cognee هنگام بوتِ روی دیتابیسِ خالی، کاربر پیش‌فرض خودش را
با همان ایمیل `default_user@example.com` ساخته بود.** ردیف تکراری یعنی ایندکس
یکتای email ساخته نمی‌شود و بدتر از آن — probe بازیابی کاربرِ *تازه* را resolve
می‌کند که مالک هیچ دیتاستی نیست ← `DatasetNotFoundError: tarhe-kolli` ← `/ask`
همیشه پُل خالی برمی‌گرداند. درمان (قبل از DELETE، مرجع‌ها را بشمارید؛
`acls`/`permissions`/`data` باید همه به id قدیمیِ دامپ چسبیده باشند):

```sql
DELETE FROM pipeline_runs WHERE user_id = '<شناسهٔ تکراریِ تازه>';
DELETE FROM users         WHERE id      = '<شناسهٔ تکراریِ تازه>';
DELETE FROM principals    WHERE id      = '<شناسهٔ تکراریِ تازه>';
CREATE UNIQUE INDEX ix_users_email ON public.users (email);
```

سپس `docker restart` هر دو سرویس cognee (هر حالت درون‌حافظه‌ای از هویت پاک شود).

### تأییدِ سبز

```bash
# شمارش‌ها باید مرجع مهاجرت را بگیرند
sudo docker exec chat-with-books-postgres psql -U cognee -d cognee_db -Atc \
  'select count(*) from "DocumentChunk_text"'    # انتظار: 341

# probe بازیابی با همان payload خود /ask
sudo curl -s -X POST http://127.0.0.1:18000/api/v1/recall \
  -H 'Content-Type: application/json' \
  -d '{"searchType":"HYBRID_COMPLETION","query":"قرآن","datasets":["tarhe-kolli"],"includeReferences":true,"only_context":true}'
# انتظار: HTTP 200 + قطعه‌های واقعی کتاب
```

نتیجهٔ ۳۰ اکتبر: شمارش‌ها دقیقاً برابر مرجع (۳۴۱ / ۳٬۷۹۴ / ۱۸٬۶۴۱ / ۴٬۶۲۳)،
probe ← ۲۰۰ با نقل‌قول واقعی، و یک `/ask` واقعی روی خود کانتینر session ←
**pool_size 10**. بعد از یک ری‌استارت کاملِ هر چهار کانتینر هم دوباره سبز شد.

## افت دانسته‌شده

`SessionQAVector_text` برابر ۷۰ است در حالی که مرجع پیش از پاک‌شدن ۲۴۰ بود:
بردارهای نشست‌های بین ۱۲ سپتامبر تا پاک‌شدن سرور در هیچ آرتیفکت باقی‌مانده‌ای
نیستند — و sqlite خودِ آن نشست‌ها هم سوخته، پس یتیم بودند. برای نشست‌های جدید
هیچ اثری ندارد.

## قانون طلایی

«ری‌استارت» یا «ری‌بیلد» کانتینرها حافظه را نه می‌سازد و نه نمی‌شکند — state در
volume و postgres است، نه در ایمیج (ایمیج‌ها فقط کدند). اگر سؤال‌جواب «نشده»،
اول این چهار حالت را از هم جدا کنید:

| نشانه | معنا |
|---|---|
| `pool_size: 0` بدون خطا | حافظه خالی است — ری‌استور نشده یا دیتاست resolve نمی‌شود |
| ۴۰۲ «اعتبار این حساب تمام شده است» | حساب کاربر صفر است — ری‌استور ربطی ندارد؛ شارژ از میز `/admin/topup` |
| ۵۰۲/۴۲۲ در لاگ cognee | کلید LLM/embedding مرده است |
| پاسخ می‌آید ولی کاربر نمی‌بیند | کلاینتِ کهنه — PWA را یک بار کامل ببندید و باز کنید |
