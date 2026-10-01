# התקנה צעד אחר צעד

הסדר חשוב: קודם מסד הנתונים, אחריו האפליקציה ב-Netlify, ובסוף n8n.

## 0. הכנה מקומית

```bash
cd ~/development/ads
git pull
npm install
cp -n .env.example .env
```

## 1. Postgres ב-Railway

1. אם נשאר שירות `ads` שנוצר מהריפו (זה שנכשל בבנייה): **Settings → Delete Service**. האפליקציה רצה ב-Netlify, לא ב-Railway.
2. בפרויקט: **+ Create → Database → PostgreSQL**.
3. בשירות ה-Postgres: **Settings → Region → EU West (Amsterdam)**.
4. **Variables → `DATABASE_PUBLIC_URL`**: להעתיק את הערך ל-`.env` בשם `DATABASE_URL=`.
5. מומלץ: **Backups** על ה-volume של ה-Postgres.

## 2. להשלים את `.env`

לפי ההסברים שבתוך `.env.example`:
- `APP_PASSWORD`, `SESSION_SECRET`, `ANTHROPIC_API_KEY`, `API_TOKEN`
- להעברה החד-פעמית: `GOOGLE_SERVICE_ACCOUNT_JSON`, `SPREADSHEET_ID`

## 3. ליצור את הסכמה ולהעביר את הגיליון

```bash
npm run db:import-sheet
```

הפקודה יוצרת את הטבלאות ומעתיקה את הלשוניות `calendar`, `campaigns`, `products`, `brand` ו-`config`. מה שהיה ב-`config` (הטוקן של Meta, `ig_user_id`, `telegram_chat_id`, Cloudinary וכו') עובר לטבלת `settings`, ו-`API_TOKEN` נשמר שם בשם `app_api_token`.

- שורות לא תקינות מדווחות ומדולגות, ולא עוצרות את ההעברה.
- אפשר להריץ שוב בלי לשכפל נתונים. `-- --overwrite` מעדיף את ערכי הגיליון.
- מכאן הגיליון כבר לא בשימוש. אפשר להשאיר אותו כגיבוי.

לבדוק את ההגדרות:
```bash
npm run db:set                  # רשימת המפתחות (ערכים סודיים מוסתרים)
```

## 4. Netlify

1. [app.netlify.com](https://app.netlify.com): **Add new site → Import an existing project → GitHub → `ads`**, branch `main`. הבנייה מוגדרת ב-`netlify.toml`.
2. **Site configuration → Environment variables**: `APP_PASSWORD`, `SESSION_SECRET`, `DATABASE_URL`, `ANTHROPIC_API_KEY`, `API_TOKEN`, עם אותם ערכים כמו ב-`.env`.
3. מומלץ: **Site configuration → Functions → Region → Frankfurt (eu-central-1)**, קרוב ל-DB. אם האפשרות לא זמינה בתוכנית שלך, זה לא קריטי.
4. **Deploy**, ואז לשמור את כתובת האתר כדי ש-n8n ישלח קישורים ויבקש קפשנים:
   ```bash
   npm run db:set -- app_url https://<your-site>.netlify.app
   ```
5. להיכנס לאתר, ולמלא פעם אחת את **🎙 מותג** ואת **📣 קמפיינים ומוצרים**. כדאי לתת מזהים קצרים באנגלית, למשל `winter`.

## 5. n8n

1. **Credentials → Create → Postgres**. את הפרטים לוקחים מ-`DATABASE_PUBLIC_URL`, שבנוי כך: `postgresql://USER:PASSWORD@HOST:PORT/DATABASE`.
   - Host / Port / Database / User / Password לפי הכתובת.
   - SSL: **Allow**. אם החיבור נכשל: **Require**, ולסמן **Ignore SSL Issues**.
   - אם n8n רץ על Railway באותו פרויקט: Host `postgres.railway.internal`, Port `5432`. החיבור אז ברשת הפנימית.
   - לשמור. המזהה הוא החלק האחרון בכתובת של ה-credential: `.../credentials/<ID>`.
2. ב-`.env` למלא: `N8N_POSTGRES_CREDENTIAL_ID`, `TELEGRAM_CHAT_ID`, `N8N_URL`, `N8N_API_KEY` (מ-**Settings → n8n API**).
   ואת הטוקן של הבוט, כדי שהאפליקציה תוכל לנהל איתך שיחה בטלגרם (BotFather → `/mybots` → הבוט → **API Token**, אותו טוקן כמו ב-credential של טלגרם ב-n8n):
   ```bash
   npm run db:set -- telegram_bot_token <הטוקן>
   ```
3. לנקות פוסטים שהמועד שלהם עבר. אחרי הפריסה, פוסט מאושר שהמועד שלו עבר יעלה מיד:
   ```bash
   npm run db:overdue                # רשימה בלבד, לא משנה כלום
   npm run db:overdue -- --draft     # מחזיר את כולם לטיוטות (או --archive לארכיון)
   ```
4. לפרוס:
   ```bash
   npm run n8n:deploy -- --dry-run   # בודק חיבור ומראה מה יתעדכן
   npm run n8n:deploy                # מעדכן את כל ה-5 ומפעיל
   ```
   לפני כל החלפה, הגרסה הקודמת נשמרת ב-`n8n/backups/`. להחזרה: `npm run n8n:deploy -- --restore n8n/backups/<file>.json`.

ה-credential של טלגרם (`ReynovationSocial`) נשאר כמו שהיה. אם n8n מסמן node באדום, בוחרים בו שוב את ה-credential.

### נתונים ומודעות ממומנות (דף הקמפיין)

1. `npm run db:migrate` (מוסיף את הטבלאות של תוכניות ונתונים).
2. נתוני אינסטגרם משתמשים ב-`access_token` הקיים. הטוקן צריך הרשאת `instagram_manage_insights` (בדרך כלל כבר יש).
3. למודעות ממומנות:
   - מזהה חשבון המודעות: `npm run meta:check` מציג את כל החשבונות (או ב-Ads Manager, המספר שאחרי `act=` בכתובת):
     ```bash
     npm run db:set -- meta_ad_account_id act_123456789
     ```
   - הטוקן צריך גם `ads_read` (לנתונים) ו-`ads_management` (ליצירת קמפיין). אם חסרה הרשאה, הדף מציג את השגיאה של Meta עם שם ההרשאה.

### טוקן של Meta: בדיקה והוספת הרשאות

```bash
npm run meta:check
```
מראה אם הטוקן תקף ועד מתי, אילו הרשאות יש לו (✅/❌), ואת חשבונות המודעות שהוא רואה, כולל הפקודה שמגדירה את `meta_ad_account_id`.

אם חסרות הרשאות, יוצרים טוקן חדש:
1. [Graph API Explorer](https://developers.facebook.com/tools/explorer/) ← בצד ימין **Meta App**: האפליקציה שלך (אותה אחת כמו `meta_app_id`).
2. **User or Page** ← **User Token**.
3. **Permissions** ← להוסיף: `instagram_basic`, `instagram_content_publish`, `instagram_manage_insights`, `pages_show_list`, `pages_read_engagement`, `business_management`, `ads_read`, `ads_management`.
4. **Generate Access Token** ← בחלון שנפתח לאשר, ולסמן את הדף, חשבון האינסטגרם וחשבון המודעות.
5. להעתיק את הטוקן ולהריץ (הפקודה מחליפה אותו לטוקן של 60 יום, שומרת, ובודקת שוב):
   ```bash
   npm run meta:check -- --token <הטוקן>
   ```

### איך ה-workflows עובדים עכשיו

| Workflow | מה עושה |
|---|---|
| **BP 1 Publisher** | כל 15 דקות: `claim_due_posts()` נועל פוסטים **מאושרים** שהגיע זמנם ומחזיר רק אותם, ואז הם מתפרסמים. `request_approvals()` מסמן פוסטים שעוד לא אושרו (עד `approval_lead_hours` לפני המועד, ברירת מחדל 12) ושולח עליהם בקשה בטלגרם |
| **BP 2 Telegram Hub** | כפתור ✅/❌ → `decide_approval()` בפעולה אטומית אחת. כפתור ישן או לחיצה כפולה לא עושים כלום. אישור אחרי המועד = מפרסם מיד. תמונה/וידאו → Cloudinary → שיחה עם האפליקציה (`/api/bot`): קמפיין, מוצר, בריף, 3 גרסאות מ-Claude, מועד ואישור. מגיב רק ל-chat שלך |
| **BP 3 Watchdog** | כל ערב ב-20:30: פוסטים תקועים, וסיכום של מחר (מה מאושר ומה מחכה לך) |
| **BP 4 Token Refresh** | פעמיים בחודש מבקש מהאפליקציה (`/api/connections/meta/refresh`) לחדש את הטוקן של Meta. ה-App Secret נשאר באפליקציה ולא עובר דרך n8n |
| **BP 5 Error Alert** | כל נפילה של workflow → טלגרם, עם שם ה-node והשגיאה |

## בדיקה ראשונה

1. בסטודיו: להעלות תמונה, לכתוב קפשן עם העוזר, לקבוע מועד בעוד 20 דקות ← **לאישור שלי**.
2. תוך 15 דקות מגיעה בקשה בטלגרם. לוחצים ✅.
3. הפוסט עובר ל"מאושר ומתוזמן" ועולה במועד, ומגיעה הודעת 🎉 עם קישור.

ה-Publisher רץ כל רבע שעה (‎:00, :15, :30, :45), אז פוסט עולה בריצה הראשונה אחרי המועד שלו. מועד של 14:10 יעלה ב-14:15. לבדיקות אפשר לקצר: `N8N_PUBLISH_EVERY_MINUTES=2` ב-`.env` ואז `npm run n8n:deploy -- --only bp1-publisher`. כדי לחזור ל-15, מוחקים את הערך ומריצים שוב.

תמונות: אינסטגרם מקבל רק JPEG, ובפיד רק יחס בין 4:5 ל-1.91:1. ה-Publisher שולח את תמונות ה-Cloudinary דרך המרה שמוסיפה שוליים לתמונה חריגה (בלי לחתוך) וממירה ל-JPEG. הקובץ המקורי לא משתנה.

## פוסט לא עלה?

```bash
npm run doctor
```

מציג בשורה אחת לכל פוסט (פעיל, או במרחק 24 שעות) למה הוא עוד לא עלה, אילו הגדרות חסרות, האם כל workflow פעיל, מתי רץ לאחרונה, ומה השגיאה האחרונה ובאיזה node.
