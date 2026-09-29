// ===== BP Social - Apps Script (in-sheet safety net) =====
// The board moved to the Netlify app. This script only keeps the sheet honest
// when someone edits cells by hand:
//   - long dashes in captions become "-"
//   - publish_at stays text "YYYY-MM-DD HH:mm" (never a Date cell)
//   - editing caption/media/type revokes an existing approval
//   - typing "ready" in status is validated, otherwise reverted to draft
//
// Setup: Extensions → Apps Script → paste this file → set APP_URL below.

const SHEET_NAME = 'calendar';
const TZ = 'Asia/Jerusalem';
const APP_URL = 'https://YOUR-SITE.netlify.app';
const DATE_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
const CONTENT_COLUMNS = ['caption', 'media_urls', 'type'];

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('📸 פרסום')
    .addItem('🗂 פתח את לוח הפרסום', 'openApp')
    .addToUi();
}

function openApp() {
  const html = HtmlService.createHtmlOutput(
    '<script>window.open(' + JSON.stringify(APP_URL) + ', "_blank");google.script.host.close();</script>',
  ).setWidth(10).setHeight(10);
  SpreadsheetApp.getUi().showModalDialog(html, 'פותח...');
}

function isVideo_(url) {
  return /\.(mp4|mov|m4v|webm)(\?|#|$)/i.test(url) || /\/video\/upload\//.test(url);
}

/** Mirrors scheduleIssues() in src/shared/post.ts (first issue only). */
function validateRow_(r) {
  if (!DATE_RE.test(String(r.publish_at || ''))) return 'publish_at חייב להיות בפורמט 2026-09-01 18:30';
  const urls = String(r.media_urls || '').split(/[\s,]+/).filter(Boolean);
  if (!urls.length) return 'חסר קישור לתמונה/וידאו (media_urls)';
  if (urls.some(function (u) { return !/^https:\/\//.test(u); })) return 'media_urls חייב להתחיל ב-https://';
  const type = String(r.type || 'POST').toUpperCase();
  if (['POST', 'CAROUSEL', 'REEL', 'STORY'].indexOf(type) === -1) return 'type חייב להיות POST / CAROUSEL / REEL / STORY';
  const videos = urls.filter(isVideo_).length;
  if (type === 'POST' && (urls.length > 1 || videos)) return 'POST = תמונה אחת. כמה תמונות → CAROUSEL, וידאו → REEL';
  if (type === 'REEL' && (urls.length !== 1 || videos !== 1)) return 'REEL צריך בדיוק וידאו אחד';
  if (type === 'CAROUSEL' && (urls.length < 2 || urls.length > 10)) return 'CAROUSEL צריך 2-10 פריטים';
  if (String(r.caption || '').length > 2200) return 'הקפשן ארוך מ-2200 תווים';
  return '';
}

function rowObject_(sh, rowNum, headers) {
  const values = sh.getRange(rowNum, 1, 1, headers.length).getValues()[0];
  const r = {};
  headers.forEach(function (h, i) {
    let v = values[i];
    if (v instanceof Date) v = Utilities.formatDate(v, TZ, 'yyyy-MM-dd HH:mm');
    r[h] = String(v == null ? '' : v);
  });
  return r;
}

function onEdit(e) {
  if (!e || !e.range) return;
  const sh = e.range.getSheet();
  if (sh.getName() !== SHEET_NAME || e.range.getRow() === 1) return;
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  const col = function (name) { return headers.indexOf(name) + 1; };

  // Multi-cell paste: handle every touched row/column.
  for (let r = e.range.getRow(); r <= e.range.getLastRow(); r++) {
    for (let c = e.range.getColumn(); c <= e.range.getLastColumn(); c++) {
      const name = headers[c - 1];
      const cell = sh.getRange(r, c);

      if (name === 'caption') {
        const v = String(cell.getValue() || '');
        const clean = v.replace(/[—–]/g, '-');
        if (clean !== v) cell.setValue(clean);
      }

      if (name === 'publish_at') {
        const v = cell.getValue();
        if (v instanceof Date) {
          cell.setNumberFormat('@');
          cell.setValue(Utilities.formatDate(v, TZ, 'yyyy-MM-dd HH:mm'));
        }
      }

      // An approval covers specific content; changing it requires re-approval.
      if (CONTENT_COLUMNS.indexOf(name) !== -1 && col('approved_at') > 0) {
        const approved = sh.getRange(r, col('approved_at'));
        if (String(approved.getValue()).trim()) {
          approved.setValue('');
          SpreadsheetApp.getActiveSpreadsheet().toast('התוכן השתנה - האישור בוטל. אשר שוב בלוח.', '⚠️ ' + name, 6);
        }
      }

      if (name === 'status' && String(cell.getValue()).trim() === 'ready') {
        const err = validateRow_(rowObject_(sh, r, headers));
        if (err) {
          cell.setValue('draft');
          SpreadsheetApp.getActiveSpreadsheet().toast('הוחזר ל-draft: ' + err, '⚠️ הפוסט לא מוכן', 8);
        }
      }
    }
  }
}
