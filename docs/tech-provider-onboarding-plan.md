# תוכנית: Onboarding של לקוחות ל-WhatsApp דרך האתר (Tech Provider)

מצב נכון ל-26.9.2026, לפי המסכים ב-developers.facebook.com של אפליקציית ReynovationTrips.

## איפה אנחנו

| שלב | סטטוס |
|---|---|
| Business Verification | ✅ Approved |
| Integrity | ✅ Cleared |
| App Roles | ✅ |
| App Review (Advanced access ל-`whatsapp_business_messaging` + `whatsapp_business_management`) | ⏳ In review |
| Access Verification | ⏳ לפי Embedded Signup Builder: נדרש לפני פרודקשן |
| Facebook Login for Business configuration | ❌ לא נוצר |
| Domains allowlist | ❌ לא הוגדר |
| System user token לאפליקציה | ❌ |

עד אישור App Review ו-Access Verification: אפשר לבנות ולבדוק עם משתמשים שהוספו ידנית לאפליקציה, לא עם לקוחות אמיתיים.

## מה לבנות

### 1. הגדרות באפליקציה (Embedded Signup Builder ← App Setup)
- **Create configuration**: Login configuration מסוג WhatsApp Embedded Signup. הרשאות: `whatsapp_business_management`, `whatsapp_business_messaging`. לא לשתף את ה-config_id עם אפליקציות אחרות.
- **Manage allowlist**: הדומיין של האתר (HTTPS בלבד), גם סביבת בדיקות וגם פרודקשן.
- **System user token** עם האפליקציה משויכת ב-Assign assets (בלי זה: "No permissions available").

### 2. נקודת הכניסה של הלקוח (שתי אפשרויות)
- **Meta-hosted landing page** (הכי פשוט): קישור מוכן מ-Meta
  `https://business.facebook.com/messaging/whatsapp/onboard/?app_id=<APP_ID>&config_id=<CONFIG_ID>&extras=...`
  שמים אותו ככפתור באתר, בלי JavaScript.
- **כפתור מוטמע** עם JavaScript SDK: `FB.login` עם `config_id`, Embedded Signup v4, Session info version 3. מאפשר Pre-fill של פרטי העסק וקבלת WABA ID ו-Phone number ID ישר בדף.

### 3. צד השרת (אחרי שהלקוח סיים את החלון)
לפי הסדר:
1. **Exchange token**: מחליפים את ה-`code` שחזר מהחלון ב-business token של הלקוח. קריאה משרת לשרת עם App Secret. שומרים מוצפן לכל לקוח.
2. **APIs for fetching WhatsApp Accounts / Account details**: מביאים את ה-WABA שהלקוח שיתף ואת המספרים שבו.
3. **Subscribe app to WABA**: `POST /{WABA_ID}/subscribed_apps`, כדי שה-webhooks של הלקוח יגיעו לשרת שלנו.
4. **Phone Registration**: `POST /{PHONE_NUMBER_ID}/register` עם PIN, כדי שהמספר יוכל לשלוח.
5. **Payment**: ב-Tech Provider הלקוח מוסיף אמצעי תשלום משלו ב-WhatsApp Manager. (Line of credit משותף הוא מסלול של Solution Partners.)
6. **Send messages**: תבנית מאושרת לפנייה יזומה, או תשובה חופשית בתוך חלון 24 השעות.

### 4. Webhooks מרובי-לקוחות
- Callback אחד לכל הלקוחות (הקיים ב-Railway: `/webhook/whatsapp-inbound`).
- ניתוב לפי `entry[].changes[].value.metadata.phone_number_id` → לקוח → הבוט שלו.
- סינון כפילויות לפי `messages[].id`. תשובה 200 מיידית ועיבוד בתור.
- לבדוק את השדות `user_id` / `from_user_id` שמופיעים ב-payload (מזהה משתמש שלא תלוי במספר) לפני שבונים עליהם.

## משאבים שמופיעים בדשבורד
- Tech Provider Sample App (GitHub): בסיס לקוד של הפלטפורמה.
- Onboarding documentation / Onboarding support / Tech Provider Content Hub.

## השלב הבא אחרי Tech Provider
Tech Partner: לפחות 2,500 הודעות ביום (ממוצע 7 ימים), 10 לקוחות פעילים בחודש, Quality metric של 90% ומעלה.

## פתוח
- [ ] תוצאת App Review. אם נדחה: לבדוק שהסרטון מראה גם שליחה מהאפליקציה וגם קבלה ב-WhatsApp.
- [ ] Access Verification: לבדוק אם נדרש בנפרד (בדף ה-onboarding הוא לא מופיע, ב-Builder כן).
- [ ] להחליט: Meta-hosted link או כפתור JS.
- [ ] Webhook לדמו של הקורס: n8n או שרת קטן בריפו.
