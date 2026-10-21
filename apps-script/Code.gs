// Freed backend: one tab per person in the Google Sheet, photos in Drive.
// Deploy: Extensions > Apps Script > paste this > Deploy > Web app
// (Execute as: Me, Who has access: Anyone). Paste the /exec URL into config.js.
const SHEET_ID = '1sJw0GarGdg2NFJ7SBNDA4s7z-rEgRntO5QDnTabbLh0';
const PHOTO_FOLDER_ID = '1yYtvAo1xv2nbPSTFbK7n169eDHkFlHBW'; // Freed Drive folder
const RESERVED = ['users', 'leaderboard'];
const HEAD = ['Type', 'ID', 'Date', 'Summary', 'Avg rating', 'Data'];

function ss_() { return SpreadsheetApp.openById(SHEET_ID); }
function out_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function cleanName_(n) {
  n = String(n || '').trim();
  if (!/^[\p{L}\p{N} _.-]{2,30}$/u.test(n) || RESERVED.indexOf(n.toLowerCase()) >= 0) throw new Error('Invalid name');
  return n;
}

function doGet() { return out_({ ok: true, users: getAll_() }); }

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const req = JSON.parse(e.postData.contents);
    const fn = ACTIONS[req.action];
    if (!fn) throw new Error('Unknown action');
    return out_(Object.assign({ ok: true }, fn(req) || {}));
  } catch (err) {
    return out_({ ok: false, error: String(err.message || err) });
  } finally { lock.releaseLock(); }
}

const ACTIONS = {
  auth(r) {
    const name = cleanName_(r.name), sh = usersSheet_(), rows = sh.getDataRange().getValues();
    for (let i = 1; i < rows.length; i++) if (rows[i][0] === name) {
      if (rows[i][1] !== r.pinHash) throw new Error('Wrong PIN');
      return { created: false };
    }
    sh.appendRow([name, r.pinHash, new Date()]);
    userSheet_(name);
    return { created: true };
  },
  getAll() { return { users: getAll_() }; },
  upsert(r) {
    check_(r);
    const sh = userSheet_(r.name), rec = r.record, row = toRow_(rec);
    const hit = sh.getRange('B:B').createTextFinder(rec.id).matchEntireCell(true).findNext();
    if (hit) sh.getRange(hit.getRow(), 1, 1, row.length).setValues([row]);
    else sh.appendRow(row);
    rebuildLeaderboard_();
  },
  remove(r) {
    check_(r);
    const sh = userSheet_(r.name);
    const hit = sh.getRange('B:B').createTextFinder(r.id).matchEntireCell(true).findNext();
    if (hit && hit.getRow() > 1) sh.deleteRow(hit.getRow());
    rebuildLeaderboard_();
  },
  photo(r) {
    check_(r);
    const m = /^data:image\/\w+;base64,(.+)$/.exec(r.dataUrl || '');
    if (!m) throw new Error('Bad image');
    const folder = DriveApp.getFolderById(PHOTO_FOLDER_ID);
    const file = folder.createFile(Utilities.newBlob(Utilities.base64Decode(m[1]), 'image/jpeg', r.name + '-' + Date.now() + '.jpg'));
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    return { url: 'https://drive.google.com/thumbnail?id=' + file.getId() + '&sz=w800' };
  },
};

function check_(r) {
  const name = cleanName_(r.name), rows = usersSheet_().getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) if (rows[i][0] === name && rows[i][1] === r.pinHash) return;
  throw new Error('Not signed in');
}

function usersSheet_() {
  const s = ss_();
  let sh = s.getSheetByName('Users');
  if (!sh) { sh = s.insertSheet('Users'); sh.appendRow(['Name', 'PinHash', 'Created']); sh.setFrozenRows(1); }
  return sh;
}

function userSheet_(name) {
  const s = ss_();
  let sh = s.getSheetByName(name);
  if (!sh) {
    sh = s.insertSheet(name);
    sh.getRange('A:F').setNumberFormat('@');
    sh.appendRow(HEAD);
    sh.setFrozenRows(1);
    sh.getRange('A1:F1').setFontWeight('bold');
    sh.setColumnWidth(4, 420);
  }
  return sh;
}

function toRow_(rec) {
  const d = rec.data || {};
  let summary = '', avg = '';
  if (rec.type === 'session') {
    const t = d.tasks || [], rated = t.filter(function (x) { return x.rating; });
    summary = (d.status === 'active' ? '[in progress] ' : '') + t.map(function (x) { return x.text + ' (' + x.cat + (x.rating ? ', ' + x.rating + '/5' : '') + ')'; }).join('; ');
    if (rated.length) avg = rated.reduce(function (a, x) { return a + x.rating; }, 0) / rated.length;
  } else if (rec.type === 'goal') summary = (d.done ? '[x] ' : '[ ] ') + d.kind + ': ' + d.text;
  else if (rec.type === 'date') summary = d.label;
  return [rec.type, rec.id, rec.date, summary, avg, JSON.stringify(d)];
}

function getAll_() {
  const out = {}, users = usersSheet_().getDataRange().getValues().slice(1);
  users.forEach(function (u) {
    const sh = ss_().getSheetByName(u[0]);
    out[u[0]] = sh && sh.getLastRow() > 1
      ? sh.getRange(2, 1, sh.getLastRow() - 1, 6).getValues().map(function (r) {
          return { type: r[0], id: r[1], date: String(r[2]), data: JSON.parse(r[5] || '{}') };
        })
      : [];
  });
  return out;
}

// Leaderboard tab: points = sum of self-ratings (1-5) on tasks in finished sessions.
function rebuildLeaderboard_() {
  const all = getAll_(), tz = Session.getScriptTimeZone(), now = new Date();
  const dow = (now.getDay() + 6) % 7;
  const wk = Utilities.formatDate(new Date(now.getTime() - dow * 864e5), tz, 'yyyy-MM-dd');
  const rows = Object.keys(all).map(function (n) {
    function sum(from) {
      let pts = 0, cnt = 0, ses = 0;
      all[n].forEach(function (r) {
        if (r.type !== 'session' || r.data.status !== 'done' || r.date < from) return;
        ses++;
        (r.data.tasks || []).forEach(function (t) { if (t.rating) { pts += t.rating; cnt++; } });
      });
      return [pts, cnt ? Math.round(pts / cnt * 10) / 10 : 0, ses];
    }
    return [n].concat(sum(wk), sum('0000'));
  }).sort(function (a, b) { return b[1] - a[1] || b[4] - a[4]; });
  const s = ss_();
  let sh = s.getSheetByName('Leaderboard') || s.insertSheet('Leaderboard', 0);
  sh.clear();
  sh.getRange(1, 1, 1, 8).setValues([['Name', 'Week points', 'Week avg', 'Week sessions', 'All-time points', 'All-time avg', 'All-time sessions', 'Updated']]).setFontWeight('bold');
  if (rows.length) sh.getRange(2, 1, rows.length, 7).setValues(rows);
  sh.getRange('H2').setValue(new Date());
}
