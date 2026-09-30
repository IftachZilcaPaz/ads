# התקנה צעד אחר צעד

זמן משוער: 30-40 דקות. הגיליון, ה-service account, בוט הטלגרם, Cloudinary וה-token של Meta כבר קיימים אצלך, אז לא צריך להקים אותם מחדש.

## 1. Google: הרשאה לאפליקציה

1. ב-Google Cloud Console, אותו service account ש-n8n משתמש בו (`ReynovationSocial`): **Keys → Add key → JSON**. יורד קובץ.
2. לוודא שהגיליון משותף עם ה-`client_email` מהקובץ, בהרשאת **Editor**.
3. להעתיק את `SPREADSHEET_ID` מה-URL של הגיליון.

> האפליקציה תוסיף בעצמה בכניסה הראשונה את העמודות `campaign_id, product_id, approved_at, approval_ref, notes, permalink, created_at, updated_at` בסוף לשונית `calendar`, ואת הלשוניות `campaigns`, `products`, `brand`. היא לא מוחקת ולא מזיזה עמודות קיימות.

## 2. Netlify

1. [app.netlify.com](https://app.netlify.com) → **Add new site → Import an existing project → GitHub** → `IftachZilcaPaz/ads`.
2. Build command ו-publish directory נקראים מ-`netlify.toml`, אז אין מה לשנות.
3. **Site configuration → Environment variables**:

| משתנה | ערך |
|---|---|
| `APP_PASSWORD` | סיסמה ארוכה לכניסה |
| `SESSION_SECRET` | מחרוזת אקראית של 32 תווים ומעלה (`openssl rand -base64 48`) |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | כל התוכן של קובץ ה-JSON (אפשר גם כ-base64) |
| `SPREADSHEET_ID` | מהשלב הקודם |
| `ANTHROPIC_API_KEY` | מ-[console.anthropic.com](https://console.anthropic.com) |
| `API_TOKEN` | מחרוזת אקראית נוספת (n8n ישתמש בה) |

4. **Deploy**. נכנסים לכתובת האתר עם הסיסמה.
5. בלשונית **🎙 מותג** ממלאים את קול המותג (פעם אחת). ב-**📣 קמפיינים ומוצרים** מוסיפים את מה שרלוונטי. כדאי לתת מזהים קצרים באנגלית (למשל `winter`), כי אותם כותבים בטלגרם.

## 3. לשונית `config` בגיליון

מוסיפים שורות (key / value) לצד מה שכבר קיים:

| key | value |
|---|---|
| `app_url` | כתובת האתר ב-Netlify, למשל `https://bp-social.netlify.app` |
| `app_api_token` | אותו ערך כמו `API_TOKEN` ב-Netlify |
| `approval_lead_hours` | כמה שעות לפני המועד לשלוח בקשת אישור בטלגרם (ברירת מחדל 12) |

`cloudinary_cloud` ו-`cloudinary_preset` כבר קיימים. האפליקציה מעלה ישירות ל-Cloudinary עם אותו unsigned preset.

## 4. n8n

> **קודם שלב 3**: הגיליון חייב כבר לכלול את העמודות והלשוניות החדשות (כניסה אחת לאפליקציה ב-Netlify מוסיפה אותן), אחרת BP 1 ו-BP 2 ייפלו.

### דרך א': פקודה אחת (מומלץ)

דרך ה-API הציבורי של n8n, שלא דורש Enterprise (ב-Cloud רק לא בתקופת ניסיון). כל workflow מתעדכן במקום עם אותו מזהה, כך שה-webhook של הטלגרם וקישור ה-error workflow נשמרים.

1. ב-n8n: **Settings → n8n API → Create an API key**.
2. ב-`.env` (מ-`.env.example`):
   ```
   SPREADSHEET_ID=...
   TELEGRAM_CHAT_ID=...
   N8N_URL=https://<your-instance>.app.n8n.cloud
   N8N_API_KEY=...
   ```
3. להריץ:
   ```bash
   npm run n8n:deploy -- --dry-run   # מה יתעדכן, בלי לגעת בכלום
   npm run n8n:deploy                # מעדכן את כל ה-5 ומפעיל
   ```

אפשרויות נוספות:

| פקודה | מה עושה |
|---|---|
| `npm run n8n:deploy -- --only bp1-publisher,bp3-watchdog` | רק workflows מסוימים |
| `npm run n8n:deploy -- --no-activate` | מעדכן ולא מפעיל |
| `npm run n8n:deploy -- --restore n8n/backups/<file>.json` | מחזיר גרסה קודמת |

לפני כל החלפה, הגרסה הקודמת נשמרת ב-`n8n/backups/` (מחוץ לגיט). אם הפעלה של workflow נכשלת, בדרך כלל בגלל credential, מופיעה ⚠️ עם שם ה-node, והשאר ממשיכים.

### דרך ב': ידנית

```bash
npm run n8n:build                        # יוצר n8n/dist/*.json
pbcopy < n8n/dist/bp1-publisher.json     # במק: מעתיק ללוח
```
ב-n8n: לפתוח את ה-workflow הקיים, Cmd+A, Delete, Cmd+V. ב-**Settings**: Timezone = `Asia/Jerusalem`, ו-Error workflow = `BP 5 - Error Alert`. אחר כך **Save** ו-**Active**. הסדר: BP 5, BP 4, BP 3, BP 1, BP 2.

ה-credentials מזוהים לפי השם `ReynovationSocial`. אם n8n מסמן node באדום, בוחרים שוב את ה-credential ב-node.

### מה השתנה ב-workflows

| Workflow | שינוי |
|---|---|
| **BP 1 Publisher** | מפרסם רק פוסטים מאושרים. פוסט שלא אושר לא עולה: נשלחת עליו בקשה בטלגרם מראש. נעילה לפני פרסום (claim + קריאה חוזרת), כך שביטול אישור ברגע האחרון מכובד. שומר `permalink`. תמיכה בווידאו בתוך קרוסלה. |
| **BP 2 Telegram Hub** | מגיב רק לך. כפתורים עם קוד חד-פעמי (הודעה ישנה לא תאשר תוכן שהשתנה), הגנה מלחיצה כפולה, ההודעה מתעדכנת אחרי לחיצה. אישור לפני המועד = יעלה בזמן; אחרי המועד = עולה מיד. תמונה או וידאו → Cloudinary → קפשן מ-AI לפי `#קמפיין #מוצר` → טיוטה. הוסר הענף הכפול שהיה מושבת. |
| **BP 3 Watchdog** | תוקן: הקוד הקודם נפל על משתנים לא מוגדרים. עכשיו מדווח על פוסטים תקועים ושולח ב-20:30 סיכום של מחר (מה מאושר ומה מחכה לך). |
| **BP 4 Token Refresh** | תוקן: הטוקן החדש לא נשמר קודם, כי המיפוי כתב רק את המפתח. עכשיו הוא נשמר, ורץ פעמיים בחודש. |
| **BP 5 Error Alert** | תוקן `YOUR_CHAT_ID`. מוגדר כ-error workflow של כל האחרים. |

בכל המקומות: כתיבה לגיליון היא `RAW` ו-update בלבד (בלי שורות יתומות), ה-timezone הוא Asia/Jerusalem, ובלי "sent with n8n" בהודעות.

## 5. Apps Script (לא חובה)

הלוח הישן בתוך הגיליון הוחלף באפליקציה. אם עורכים ישירות בגיליון, כדאי להדביק את [`apps-script/Code.gs`](../apps-script/Code.gs) במקום הקוד הקיים (ולמחוק את `index.html`), ולעדכן בו את `APP_URL`. הוא מבטל אישור כשעורכים תוכן, שומר את `publish_at` כטקסט, ומוסיף תפריט שפותח את הלוח.

## בדיקה ראשונה (מומלץ)

1. בסטודיו: להעלות תמונה, לכתוב קפשן עם העוזר, לקבוע מועד בעוד 20 דקות ← **לאישור שלי**.
2. תוך 15 דקות מגיעה בקשה בטלגרם. לוחצים ✅.
3. הפוסט עובר ל"מאושר ומתוזמן" ועולה במועד, ומגיעה הודעת 🎉 עם קישור.
