# کلیدهای امضای اپ موبایل

این سندِ مکانِ کلیدهاست، نه خود کلیدها — **هیچ کلید خصوصی‌ای وارد ریپو نمی‌شود** (F-018/F-019 بازبینی امنیتی 2026-11-01، `docs/security-review-2026-11-01-mobile.fa.md`). مالک کلیدها اپراتور است؛ اگر مالکیت دستگاه عوض شد، این سند باید به‌روز شود.

## ۱. کلید آپلود APK (امضای باینری)

- **مکان:** `~/.cwb-keys/cwb-upload.jks` (بیرون ریپو) + رمزها در `~/.cwb-keys/cwb-upload.properties` (اجازهٔ 600).
- **نام مستعار:** `cwb-upload`
- **اثر انگشت SHA-256 گواهی:** `CD:59:9C:D8:06:4D:21:D3:13:DD:85:4A:AE:83:BA:C0:0B:96:D3:F8:A0:A3:83:23:AB:74:FB:6D:31:4C:B6:D0`
- **استفاده:** envهای زیر را بگذارید و بعد بیلد release — بدون آن‌ها بیلد release عمداً می‌شکند (گارد `whenReady` در `android/app/build.gradle`)، تا هیچ‌وقت دوباره با کلید debug عمومی امضا نشود:
  ```
  CWB_UPLOAD_STORE_FILE=<مسیر jks>
  CWB_UPLOAD_STORE_PASSWORD=<storePassword از properties>
  CWB_UPLOAD_KEY_ALIAS=cwb-upload
  CWB_UPLOAD_KEY_PASSWORD=<keyPassword از properties>
  ```
- **مهاجرت نصب‌های فعلی (یک‌بار):** امضای APKهای نصب‌شده کلید debug عمومی بود؛ APK با کلید تازه روی آن‌ها «به‌روزرسانی» نمی‌نشیند (اندروید امضای ناجور را رد می‌کند). کاربران **یک بار uninstall + install** می‌کنند؛ توکن‌شان پاک می‌شود و دوباره وارد می‌شوند. بعد از این موج، هر APK بعدی روی APK تازه آپدیت می‌شود.
- **⚠️ prebuild این فایل را از نو می‌سازد:** `npx expo prebuild` بلاک signing و گارد `whenReady` را در `android/app/build.gradle` پاک می‌کند — بعد از هر prebuild دوباره اعمالشان کنید (کامنت داخل خود فایل یادآور است).
- **از دست رفتن این کلید = پایان آپدیت درون‌روی APK.** بکاپش مسئولیت اپراتور است.

## ۲. کلید امضای OTA (expo-updates code signing — F-019)

- **کلید خصوصی:** `~/.cwb-keys/ota/private-key.pem` (PKCS#1) + `public-key.pem` — هرگز به ریپو و هرگز به سرور نمی‌رود؛ فقط ماشینِ publish.
- **گواهی (عمومی، رهگیری‌شده):** `mobile/certs/certificate.pem` — prebuild آن را داخل باینری می‌گذارد (`expo.modules.updates.CODE_SIGNING_CERTIFICATE`).
- **اثر انگشت SHA-256 گواهی:** `EB:79:C6:0B:D6:6F:7A:F9:E7:79:08:03:10:CC:AC:01:9E:EC:55:EB:1F:DD:95:B0:E4:AC:BB:3E:6E:06:12:BC` (CN=`chat-with-books OTA (Rayesh Company)`، اعتبار ۱۰ سال)
- **پارامترها:** `keyid=main`، `alg=rsa-v1_5-sha256` (`mobile/app.json` → `updates.codeSigningMetadata`).
- **استفاده:** `publish_ota.py` در زمان انتشار، منیفست را با کلید خصوصی امضا می‌کند (env `CWB_OTA_PRIVATE_KEY` = مسیر pem) و امضا را کنار منیفست می‌نویسد؛ `serve.py` همان را در هدر `expo-signature` می‌فرستد. APKای که گواهی را حمل می‌کند منیفستِ بی‌امضا را **رد می‌کند** — پس تا publish امضاشدار منتشر نشده، APK تازه روی باندلِ داخلی‌اش می‌ماند (anti-brick خود expo-updates).
- **چرخش:** کلید تازه + `keyid` تازه (مثلاً `main-2027`) + بیلد APK تازه. کلیدهای قدیمی را دور نیندازید تا موج نصب‌ها کامل شود.

## ۳. گارد

- `mobile/.gitignore` هر `.pem` و `.jks` را زیر `certs/` می‌بندد به‌جز خودِ `certificate.pem` (عمومی)؛ با این حال پیش از هر کامیت، `git status` را برای فایل‌های کلیدی چک کنید.
- تست‌های `tests/test_ota_docs.py` پیکربندی OTA را pin می‌کنند؛ تغییر `keyid`/مسیر گواهی باید تست را هم به‌روز کند.
