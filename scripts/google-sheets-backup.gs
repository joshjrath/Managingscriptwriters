/**
 * SCALE Media scripts: the daily backup into this Google Sheet.
 *
 * Settings → Backups on the site gives you this script with the site's address and backup key filled in.
 *
 * Setting it up (once):
 *   1. In a new, empty Google Sheet: Extensions → Apps Script. Delete what's there, paste this whole script, and Save.
 *   2. At the top, pick "setUp" in the list of functions and click Run. Google asks you to allow it: choose your
 *      account → Advanced → Go to … (unsafe) → Allow. It's your own script; Google asks that of every script.
 *   3. That's all. It backs up now and then every night at about 3 am. Settings → Backups on the site shows the
 *      last backup, and the site's Admins are told if a day and a half goes by without one.
 *
 * What it does each time:
 *   - a tab for every table on the site, written whole (ids link the tabs: scripts.batch_id is batches.id);
 *   - every uploaded file saved once into the "Uploaded files" folder, checked byte for byte;
 *   - a dated copy of the tabs in "Daily copies" (each kept a year; the copy from the 1st of a month is kept for good).
 * Passwords, sign-ins, keys and secret calendar links never leave the site, so they aren't here.
 *
 * Anyone who can open this sheet can read everything in it. Share it only with the site's Admins.
 * There's also a Backup menu in the sheet: Back up now, Set up the daily backup, Stop the daily backup.
 */

const SITE = '__SITE_URL__';
const KEY = '__BACKUP_KEY__';

/** the hour (in this script's time zone, File → Project settings) the daily backup starts */
const RUN_HOUR = 3;
/** how long each daily copy is kept; the copy from the 1st of each month is kept for good */
const KEEP_DAILY_DAYS = 365;
/** Google stops a run at 6 minutes: stop before that and carry on a minute later */
const TIME_BUDGET_MS = 4.5 * 60 * 1000;
/** a big file is only started with this much time left */
const BIG_FILE_TIME_MS = 2 * 60 * 1000;
/** the most a cell holds */
const CELL_MAX = 50000;
/** the most cells a Google Sheet holds is 10 million; keep clear of it */
const SHEET_CELLS_MAX = 9500000;
const PAGE_ROWS = 5000;
/** files up to this size come in one go; bigger ones in pieces of PIECE (a multiple of 256 KB, as Drive needs) */
const SMALL_FILE = 45 * 1024 * 1024;
const PIECE = 32 * 1024 * 1024;
/** the tabs people look at most come first */
const FIRST_TABS = ['clients', 'shoots', 'batches', 'scripts', 'users', 'briefings', 'resources', 'submissions', 'reviews', 'deliveries', 'revision_requests', 'activity'];
/** if everything wouldn't fit in one sheet, these are left out first (they're still on the site) */
const LEAVE_OUT_FIRST = ['audit_log', 'notifications', 'calendar_events', 'timeliner_events', 'timeliner_tasks', 'activity'];
const ABOUT = 'About';
const SAVED = '_saved_files';
const STATE = 'backupState';

// ── menu and set-up ──────────────────────────────────────────────────────

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Backup')
    .addItem('Back up now', 'backUpNow')
    .addItem('Set up the daily backup', 'setUp')
    .addItem('Stop the daily backup', 'stopDailyBackup')
    .addToUi();
}

/** Run once: checks the key works, turns on the nightly backup, and backs up now. */
function setUp() {
  api_('get', '/hooks/backup');
  removeTriggers_('dailyBackup');
  ScriptApp.newTrigger('dailyBackup').timeBased().everyDays(1).atHour(RUN_HOUR).create();
  say_('The daily backup is on. Backing up now: this can take a few minutes, and a big first backup carries on by itself.');
  backUpNow();
}

function stopDailyBackup() {
  removeTriggers_('dailyBackup');
  removeTriggers_('continueBackup');
  PropertiesService.getScriptProperties().deleteProperty(STATE);
  say_('The daily backup is off. Back up now still works, and Set up the daily backup turns it back on.');
}

function backUpNow() { start_(true); }
function dailyBackup() { start_(false); }
function continueBackup() { run_(); }

// ── a backup, in steps that survive Google's time limit ──────────────────

function start_(byHand) {
  const state = loadState_();
  // one still going (carrying on after the time limit) finishes first, unless it's been stuck for hours
  if (state && Date.now() - Date.parse(state.started) < 6 * 3600 * 1000) {
    if (byHand) say_('A backup is already running. It carries on by itself.');
    return;
  }
  saveState_({ started: new Date().toISOString(), stamp: today_(), phase: 'tables', finished: [], table: null, after: null, written: 0, rows: 0, problems: [], tried: [], copied: [] });
  run_();
}

function run_() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10 * 1000)) return;
  const began = Date.now();
  const left = () => TIME_BUDGET_MS - (Date.now() - began);
  try {
    const state = loadState_();
    if (!state) { removeTriggers_('continueBackup'); return; }
    // if this run is cut off, this carries on from what was saved
    removeTriggers_('continueBackup');
    ScriptApp.newTrigger('continueBackup').timeBased().after(8 * 60 * 1000).create();
    try {
      if (state.phase === 'tables') copyTables_(state, left);
      if (state.phase === 'files') copyFiles_(state, left);
      if (state.phase === 'copy') keepDatedCopy_(state, left);
      if (state.phase === 'report') {
        report_(state);
        PropertiesService.getScriptProperties().deleteProperty(STATE);
        removeTriggers_('continueBackup');
        return;
      }
      saveState_(state);
      // out of time: carry on in a minute
      removeTriggers_('continueBackup');
      ScriptApp.newTrigger('continueBackup').timeBased().after(60 * 1000).create();
    } catch (err) {
      PropertiesService.getScriptProperties().deleteProperty(STATE);
      removeTriggers_('continueBackup');
      writeAbout_(null, 'The last backup stopped: ' + err.message);
      throw err;
    }
  } finally {
    lock.releaseLock();
  }
}

// ── tables ───────────────────────────────────────────────────────────────

function copyTables_(state, left) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  aboutSheet_(ss);
  const m = api_('get', '/hooks/backup');
  const byName = {};
  m.tables.forEach((t) => { byName[t.name] = t; });
  const skip = tablesToLeaveOut_(m.tables, SHEET_CELLS_MAX);
  if (skip.length) problem_(state, 'Too much for one Google Sheet, so these tabs are from an earlier backup (or missing): ' + skip.join(', ') + '. They’re still on the site.');
  const names = orderTables_(m.tables.map((t) => t.name)).filter((n) => skip.indexOf(n) < 0);
  for (let i = 0; i < names.length; i++) {
    const t = byName[names[i]];
    if (state.finished.indexOf(t.name) >= 0) continue;
    if (state.table !== t.name) { state.table = t.name; state.after = null; }
    const tmpName = '~' + t.name;
    let tmp = ss.getSheetByName(tmpName);
    if (!state.after || !tmp) {
      if (tmp) ss.deleteSheet(tmp);
      tmp = newTab_(ss, tmpName, t.columns);
      state.after = null;
      state.written = 0;
    } else {
      trimTo_(tmp, state.written + 1);
    }
    do {
      if (left() <= 0) return;
      const page = api_('get', '/hooks/backup/tables/' + t.name + '?limit=' + PAGE_ROWS + (state.after ? '&after=' + encodeURIComponent(JSON.stringify(state.after)) : ''));
      writeRows_(tmp, state.written + 2, page.rows);
      state.written += page.rows.length;
      state.after = page.next;
      saveState_(state);
    } while (state.after);
    finishTab_(ss, tmp, t.name);
    state.rows += state.written;
    state.finished.push(t.name);
    state.table = null;
    state.written = 0;
    saveState_(state);
  }
  // tidy: the tabs in order; a table's tab from an earlier backup that the site no longer has goes (tabs you
  // added yourself are never touched)
  const props = PropertiesService.getScriptProperties();
  const keep = names.concat(skip);
  const before = JSON.parse(props.getProperty('tabs') || '[]');
  ss.getSheets().forEach((sh) => {
    const n = sh.getName();
    if (keep.indexOf(n) < 0 && (/^~/.test(n) || before.indexOf(n) >= 0)) ss.deleteSheet(sh);
  });
  props.setProperty('tabs', JSON.stringify(keep));
  [ABOUT].concat(names).forEach((n, k) => {
    const sh = ss.getSheetByName(n);
    if (sh) { ss.setActiveSheet(sh); ss.moveActiveSheet(k + 1); }
  });
  ss.setActiveSheet(ss.getSheetByName(ABOUT));
  state.phase = 'files';
  saveState_(state);
}

function newTab_(ss, name, columns) {
  const sh = ss.insertSheet(name, ss.getNumSheets());
  const extra = sh.getMaxColumns() - columns.length;
  if (extra > 0) sh.deleteColumns(columns.length + 1, extra);
  else if (extra < 0) sh.insertColumnsAfter(sh.getMaxColumns(), -extra);
  const head = sh.getRange(1, 1, 1, columns.length);
  head.setNumberFormat('@');
  head.setValues([columns]);
  head.setFontWeight('bold');
  sh.setFrozenRows(1);
  return sh;
}

/** Writes rows from row `at` on, every cell as plain text (so nothing turns into a date, a number or a formula). */
function writeRows_(sh, at, rows) {
  if (!rows.length) return;
  const need = at + rows.length - 1;
  if (sh.getMaxRows() < need) sh.insertRowsAfter(sh.getMaxRows(), need - sh.getMaxRows());
  const range = sh.getRange(at, 1, rows.length, rows[0].length);
  range.setNumberFormat('@');
  range.setValues(rows.map((r) => r.map(cellText_)));
}

/** Clears anything below `lastRow` (rows a cut-off run wrote but didn't count). */
function trimTo_(sh, lastRow) {
  const over = sh.getLastRow() - lastRow;
  if (over > 0) sh.getRange(lastRow + 1, 1, over, sh.getMaxColumns()).clearContent();
}

/** The new tab replaces the old one, with no empty rows left over (they count towards the sheet's limit). */
function finishTab_(ss, tmp, name) {
  const last = Math.max(tmp.getLastRow(), 1);
  if (tmp.getMaxRows() > last) tmp.deleteRows(last + 1, tmp.getMaxRows() - last);
  const old = ss.getSheetByName(name);
  if (old) ss.deleteSheet(old);
  tmp.setName(name);
}

// ── uploaded files ───────────────────────────────────────────────────────

function copyFiles_(state, left) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const tab = ss.getSheetByName('files');
  if (tab && tab.getLastRow() > 1) {
    const data = tab.getRange(1, 1, tab.getLastRow(), tab.getLastColumn()).getDisplayValues();
    const col = (n) => data[0].indexOf(n);
    const saved = savedFiles_(ss);
    const folder = folder_('filesFolder', 'Uploaded files');
    for (let r = 1; r < data.length; r++) {
      const f = { id: data[r][col('id')], name: data[r][col('filename')], mime: data[r][col('mime')] || 'application/octet-stream', size: Number(data[r][col('size')]), sha256: data[r][col('sha256')] };
      if (saved.ids[f.id] || state.tried.indexOf(f.id) >= 0) continue;
      if (left() <= 0 || (f.size > SMALL_FILE && left() < BIG_FILE_TIME_MS)) return;
      try {
        const driveId = saveFile_(folder, f);
        saved.sheet.appendRow([f.id, f.sha256, driveId, f.name, new Date().toISOString()]);
        saved.ids[f.id] = true;
      } catch (err) {
        if (state.tried.length < 200) state.tried.push(f.id);
        problem_(state, 'File ' + f.id + ' (' + f.name + ') wasn’t saved: ' + err.message + '. It’s tried again next time.');
      }
      saveState_(state);
    }
  }
  state.phase = 'copy';
  saveState_(state);
}

function saveFile_(folder, f) {
  const name = f.id + ' · ' + f.name;
  // already there (a run cut off before it noted it)
  const there = folder.getFilesByName(name);
  while (there.hasNext()) {
    const x = there.next();
    if (x.getSize() === f.size) return x.getId();
  }
  if (f.size > SMALL_FILE) return saveBigFile_(folder, f, name);
  const bytes = fetch_('get', '/hooks/backup/files/' + f.id).getContent();
  if (bytes.length !== f.size) throw new Error('only ' + bytes.length + ' of its ' + f.size + ' bytes arrived');
  if (f.sha256 && hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes)) !== f.sha256) throw new Error('it arrived damaged (its fingerprint didn’t match)');
  return folder.createFile(Utilities.newBlob(bytes, f.mime, name)).getId();
}

/** Files bigger than Google lets a script fetch at once: a resumable upload to Drive, a piece at a time. */
function saveBigFile_(folder, f, name) {
  const start = UrlFetchApp.fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true', {
    method: 'post',
    contentType: 'application/json; charset=UTF-8',
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken(), 'X-Upload-Content-Type': f.mime, 'X-Upload-Content-Length': String(f.size) },
    payload: JSON.stringify({ name: name, parents: [folder.getId()], mimeType: f.mime }),
    muteHttpExceptions: true,
  });
  const session = header_(start, 'location');
  if (start.getResponseCode() !== 200 || !session) throw new Error('Google Drive didn’t start the upload (' + start.getResponseCode() + ')');
  let done = null;
  for (let from = 0; from < f.size; from += PIECE) {
    const bytes = fetch_('get', '/hooks/backup/files/' + f.id + '?from=' + from + '&length=' + PIECE).getContent();
    const end = from + bytes.length;
    if (!bytes.length || (end < f.size && bytes.length !== PIECE)) throw new Error('a piece of it arrived short');
    const put = UrlFetchApp.fetch(session, {
      method: 'put', contentType: f.mime, payload: bytes,
      headers: { 'Content-Range': 'bytes ' + from + '-' + (end - 1) + '/' + f.size },
      muteHttpExceptions: true,
    });
    const code = put.getResponseCode();
    if (code === 200 || code === 201) done = JSON.parse(put.getContentText());
    else if (code !== 308) throw new Error('Google Drive stopped the upload (' + code + ')');
  }
  if (!done || !done.id) throw new Error('Google Drive didn’t finish the upload');
  return done.id;
}

/** The files already saved (a hidden tab), by the site's file id. */
function savedFiles_(ss) {
  let sh = ss.getSheetByName(SAVED);
  if (!sh) {
    sh = ss.insertSheet(SAVED, ss.getNumSheets());
    sh.getRange(1, 1, sh.getMaxRows(), 5).setNumberFormat('@');
    sh.getRange(1, 1, 1, 5).setValues([['file id', 'sha256', 'drive file id', 'name', 'saved at']]).setFontWeight('bold');
    sh.hideSheet();
  }
  const ids = {};
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, 1).getDisplayValues().forEach((r) => { ids[r[0]] = true; });
  return { sheet: sh, ids: ids };
}

// ── the dated copy ───────────────────────────────────────────────────────

/** A copy of the tabs (just the data: no script, no key) in "Daily copies", then copies past their time go to the bin. */
function keepDatedCopy_(state, left) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const folder = folder_('copiesFolder', 'Daily copies');
  const name = 'Backup ' + state.stamp;
  let copy = state.copyId ? SpreadsheetApp.openById(state.copyId) : null;
  if (!copy) {
    copy = SpreadsheetApp.create(name);
    DriveApp.getFileById(copy.getId()).moveTo(folder);
    state.copyId = copy.getId();
    state.blank = copy.getSheets()[0].getSheetId();
    state.copied = [];
    saveState_(state);
  }
  const tabs = ss.getSheets().filter((sh) => sh.getName() !== SAVED && !/^~/.test(sh.getName()));
  for (let i = 0; i < tabs.length; i++) {
    const n = tabs[i].getName();
    if (state.copied.indexOf(n) >= 0) continue;
    if (left() <= 0) return;
    tabs[i].copyTo(copy).setName(n);
    state.copied.push(n);
    saveState_(state);
  }
  copy.getSheets().forEach((sh) => { if (sh.getSheetId() === state.blank && copy.getSheets().length > 1) copy.deleteSheet(sh); });
  // an earlier backup today is replaced; past their time, the others go to the bin (Drive keeps them there 30 days)
  const all = [];
  const it = folder.getFiles();
  while (it.hasNext()) all.push(it.next());
  const old = copiesToBin_(all.map((f) => f.getName()), state.stamp, KEEP_DAILY_DAYS);
  all.forEach((f) => {
    if (f.getId() === state.copyId) return;
    if (f.getName() === name || old.indexOf(f.getName()) >= 0) f.setTrashed(true);
  });
  state.phase = 'report';
  saveState_(state);
}

// ── telling the site and the About tab ───────────────────────────────────

function report_(state) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const tab = ss.getSheetByName('files');
  const files = tab ? Math.max(tab.getLastRow() - 1, 0) : 0;
  const saved = Object.keys(savedFiles_(ss).ids).length;
  const summary = {
    sheetUrl: ss.getUrl(), tables: state.finished.length, rows: state.rows, files: files,
    filesSaved: Math.min(saved, files), filesWaiting: Math.max(files - saved, 0), problems: state.problems,
  };
  writeAbout_(summary, null);
  api_('post', '/hooks/backup/done', summary);
}

function aboutSheet_(ss) {
  let sh = ss.getSheetByName(ABOUT);
  if (sh) return sh;
  // a new sheet's empty first tab becomes About
  const sheets = ss.getSheets();
  if (sheets.length === 1 && sheets[0].getLastRow() === 0) return sheets[0].setName(ABOUT);
  sh = ss.insertSheet(ABOUT, 0);
  return sh;
}

function writeAbout_(summary, failure) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = aboutSheet_(ss);
  const props = PropertiesService.getScriptProperties();
  const last = props.getProperty('lastSummary');
  const s = summary || (last ? JSON.parse(last) : null);
  if (summary) props.setProperty('lastSummary', JSON.stringify(summary).slice(0, 8000));
  if (summary) props.setProperty('lastAt', new Date().toISOString());
  const at = props.getProperty('lastAt');
  const tz = Session.getScriptTimeZone();
  const rows = [
    ['Backup of the SCALE Media scripts site', ''],
    ['From', SITE],
    ['Last backup', at ? Utilities.formatDate(new Date(at), tz, 'EEE d MMM yyyy, h:mm a') : 'Not yet'],
    ['Tables', s ? String(s.tables) + ' (a tab each)' : ''],
    ['Rows', s ? String(s.rows) : ''],
    ['Uploaded files', s ? s.filesSaved + ' of ' + s.files + ' saved in Drive' + (s.filesWaiting ? ' (' + s.filesWaiting + ' still to save: they’re tried again next time)' : '') : ''],
    ['Daily copies', folderUrl_('copiesFolder')],
    ['Uploaded files folder', folderUrl_('filesFolder')],
    ['Problems', failure || (s && s.problems.length ? s.problems.join('\n') : 'None')],
    ['', ''],
    ['Good to know', 'Anyone who can open this sheet can read everything in it. Share it only with the site’s Admins.'],
    ['', 'Every tab is one table on the site, rewritten whole each night. Ids link them: scripts.batch_id is the id in batches, batches.client_id the id in clients.'],
    ['', 'To get something back, find it here or in a daily copy and type it back in on the site. Each daily copy is kept a year; the 1st of each month is kept for good.'],
    ['', 'Passwords, sign-ins, keys and secret calendar links are left out on purpose.'],
  ];
  sh.clear();
  const range = sh.getRange(1, 1, rows.length, 2);
  range.setNumberFormat('@');
  range.setValues(rows.map((r) => [r[0], cellText_(r[1])]));
  range.setVerticalAlignment('top').setWrap(true);
  sh.getRange(1, 1).setFontSize(14).setFontWeight('bold');
  sh.getRange(2, 1, rows.length - 1, 1).setFontWeight('bold');
  if (failure) sh.getRange(9, 2).setFontColor('#B3261E');
  sh.setColumnWidth(1, 170);
  sh.setColumnWidth(2, 620);
}

// ── the site ─────────────────────────────────────────────────────────────

function api_(method, path, body) {
  return JSON.parse(fetch_(method, path, body).getContentText());
}

/** A call to the site with the backup key, tried again while the site restarts or is busy. */
function fetch_(method, path, body) {
  if (SITE.indexOf('__') === 0 || KEY.indexOf('__') === 0) throw new Error('This script has no site address or key. Copy it again from Settings → Backups on the site: it comes with both filled in.');
  const opts = { method: method, headers: { Authorization: 'Bearer ' + KEY }, muteHttpExceptions: true };
  if (body) { opts.contentType = 'application/json'; opts.payload = JSON.stringify(body); }
  let last = '';
  for (let attempt = 1; attempt <= 4; attempt++) {
    let r = null;
    try { r = UrlFetchApp.fetch(SITE + path, opts); } catch (err) { last = err.message; }
    if (r) {
      const code = r.getResponseCode();
      if (code < 300) return r;
      last = siteMessage_(r);
      if (code < 500 && code !== 429) throw new Error(last);
    }
    if (attempt < 4) Utilities.sleep(attempt * 5000);
  }
  throw new Error('Couldn’t reach the site: ' + last);
}

function siteMessage_(r) {
  try {
    const e = JSON.parse(r.getContentText()).error;
    return (e && (e.message || e)) + ' (' + r.getResponseCode() + ')';
  } catch (err) {
    return 'The site answered ' + r.getResponseCode();
  }
}

// ── small helpers ────────────────────────────────────────────────────────

/** What a cell shows: text, cut to what a cell holds, never read as a formula. */
function cellText_(v) {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (s.length > CELL_MAX - 1) s = s.slice(0, CELL_MAX - 200) + ' … [cut here: the rest is too long for one cell; it’s whole on the site]';
  if (/^[=+@]/.test(s) || /^-[^\d.]/.test(s)) s = "'" + s;
  return s;
}

/** The order of the tabs: the ones people look at most, then the rest by name. */
function orderTables_(names) {
  const first = FIRST_TABS.filter((n) => names.indexOf(n) >= 0);
  return first.concat(names.filter((n) => first.indexOf(n) < 0).sort());
}

/**
 * Tables left out because everything wouldn't fit under Google's limit on cells in one sheet. While a tab is
 * rewritten its old copy is still there, so the biggest tab counts twice.
 */
function tablesToLeaveOut_(tables, max) {
  const cells = (t) => (t.rows + 1) * t.columns.length;
  let left = tables.slice();
  const total = () => left.reduce((n, t) => n + cells(t), 0) + left.reduce((n, t) => Math.max(n, cells(t)), 0);
  const out = [];
  for (let i = 0; i < LEAVE_OUT_FIRST.length && total() > max; i++) {
    const t = left.filter((x) => x.name === LEAVE_OUT_FIRST[i])[0];
    if (!t) continue;
    out.push(t.name);
    left = left.filter((x) => x !== t);
  }
  return out;
}

/** Daily copies past their time ("Backup 2025-10-15"), given today; the 1st of each month is kept for good. */
function copiesToBin_(names, today, keepDays) {
  const day = (s) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
  return names.filter((n) => {
    const m = /^Backup (\d{4}-\d{2}-\d{2})$/.exec(n);
    if (!m || m[1].slice(8) === '01') return false;
    return (day(today) - day(m[1])) / 86400000 > keepDays;
  });
}

function hex_(bytes) {
  return bytes.map((b) => ((b + 256) % 256).toString(16).padStart(2, '0')).join('');
}

function header_(response, name) {
  const h = response.getHeaders();
  for (const k in h) if (k.toLowerCase() === name) return h[k];
  return null;
}

function problem_(state, text) {
  if (state.problems.length < 10) state.problems.push(text.slice(0, 300));
  else if (state.problems.length === 10) state.problems.push('…and more.');
}

/** "My backup" next to this sheet, with its two folders inside. */
function folder_(prop, name) {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty(prop);
  if (id) {
    try {
      const f = DriveApp.getFolderById(id);
      if (!f.isTrashed()) return f;
    } catch (err) { /* deleted: make it again */ }
  }
  const f = home_().createFolder(name);
  props.setProperty(prop, f.getId());
  return f;
}

function home_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('homeFolder');
  if (id) {
    try {
      const f = DriveApp.getFolderById(id);
      if (!f.isTrashed()) return f;
    } catch (err) { /* deleted: make it again */ }
  }
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const parents = DriveApp.getFileById(ss.getId()).getParents();
  const where = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
  const f = where.createFolder(ss.getName() + ' (backups)');
  props.setProperty('homeFolder', f.getId());
  return f;
}

function folderUrl_(prop) {
  const id = PropertiesService.getScriptProperties().getProperty(prop);
  return id ? 'https://drive.google.com/drive/folders/' + id : '';
}

function removeTriggers_(fn) {
  ScriptApp.getProjectTriggers().forEach((t) => { if (t.getHandlerFunction() === fn) ScriptApp.deleteTrigger(t); });
}

function loadState_() {
  const s = PropertiesService.getScriptProperties().getProperty(STATE);
  return s ? JSON.parse(s) : null;
}

function saveState_(state) {
  PropertiesService.getScriptProperties().setProperty(STATE, JSON.stringify(state));
}

function today_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function say_(text) {
  Logger.log(text);
  try { SpreadsheetApp.getActiveSpreadsheet().toast(text, 'Backup', 15); } catch (err) { /* running on a timer: nobody to tell */ }
}
