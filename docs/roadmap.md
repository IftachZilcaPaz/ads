# המשך

דברים שסוכמו ונדחו עד שהמערכת תעבוד יציב בייצור.

## פריסה אוטומטית מ-GitHub
GitHub Action שבכל דחיפה ל-`main` מריץ טסטים, `npm run db:migrate` ו-`npm run n8n:deploy`, בנוסף ל-Netlify שכבר עולה לבד. אחרי זה כל עדכון הוא רק `git push`, בלי פקודות מקומיות.

- **Secrets:** ב-GitHub, **Settings → Secrets and variables → Actions**: `DATABASE_URL`, `N8N_URL`, `N8N_API_KEY`, `N8N_POSTGRES_CREDENTIAL_ID`, `TELEGRAM_CHAT_ID`.
- **הגנה:** להריץ את הפריסה רק אחרי שהטסטים עברו, ורק על `main` (לא על PRs מ-forks, כי הריפו ציבורי).

## רעיונות פתוחים
- **אלבום בטלגרם:** כמה תמונות שנשלחות יחד (`media_group_id`) → טיוטת קרוסלה אחת, במקום טיוטה לכל תמונה.
