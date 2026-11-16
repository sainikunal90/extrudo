/**
 * Extrudo order API.
 *
 * Paste this into the "Extrudo Customers and Orders" sheet
 * (Extensions > Apps Script), then
 * Deploy > New deployment > Web app, with "Execute as: Me" and
 * "Who has access: Anyone".
 *
 * For every new order, the script also emails the owner (the account the
 * script runs as) with the order's details.
 *
 * Every request must carry a Google sign-in token issued for
 * GOOGLE_CLIENT_ID. The script checks it with Google and uses the
 * email inside the token, never an email sent by the browser, so a
 * customer can only add rows for their own account and only read
 * their own orders. Customers can never read the sheet, edit rows
 * or see anyone else's data.
 */

const GOOGLE_CLIENT_ID = '25832412551-72g8a86kfgr6hinn3hoib1n0m2uo5sqa.apps.googleusercontent.com';

// The "Extrudo Customers and Orders" sheet. Works whether this script was
// opened from the sheet or created on its own.
const SHEET_ID = '1uoIu0P7Pr9cnLUezvWIyA_z7Tu9Ad-rkXWi9Zyeyex8';

// The Extrudo > STL files folder in Drive. Customers' model files are saved
// here, named with the order ID.
const STL_FOLDER_ID = '1ieWRQSamuGr_ICGRYGqwhFQ2A__bsJ17';
const MAX_FILE_BYTES = 100 * 1024 * 1024;   // 100 MB
const CHUNK_BYTES = 8 * 1024 * 1024;        // files arrive in 8 MB pieces

const USERS = 'Users';
const ORDERS = 'Orders';
const FILES_COLUMN = 22;                    // column V, "Model files"
const MAX_REQUESTS_PER_10_MIN = 40;

function doGet() {
  return json_({ ok: true, service: 'Extrudo orders' });
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e && e.postData ? e.postData.contents : '');
  } catch (err) {
    return json_({ ok: false, error: 'bad_request' });
  }
  if (!body || typeof body !== 'object') return json_({ ok: false, error: 'bad_request' });

  try {
    const user = verifyGoogleToken_(body.idToken);
    if (!user) return json_({ ok: false, error: 'not_signed_in' });
    // File pieces are limited by the file's size instead, so they skip this count.
    if (body.action !== 'fileChunk' && !withinRateLimit_(user.email)) return json_({ ok: false, error: 'too_many_requests' });

    if (body.action === 'signin') return json_(locked_(function () { return upsertUser_(user, null); }));
    if (body.action === 'order') return json_(locked_(function () { return addOrder_(user, body.order); }));
    if (body.action === 'orders') return json_(listOrders_(user));
    if (body.action === 'fileStart') return json_(fileStart_(user, body));
    if (body.action === 'fileChunk') return json_(fileChunk_(user, body));
    return json_({ ok: false, error: 'unknown_action' });
  } catch (err) {
    console.error(err);
    return json_({ ok: false, error: err && err.message === 'busy' ? 'busy' : 'server_error' });
  }
}

// Runs fn while holding the script lock, so two orders never write the same row.
function locked_(fn) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (err) {
    throw new Error('busy');
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

/* ---------- Sign-in check ---------- */

function verifyGoogleToken_(token) {
  if (!token || typeof token !== 'string' || token.length > 4096) return null;
  const res = UrlFetchApp.fetch(
    'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(token),
    { muteHttpExceptions: true }
  );
  if (res.getResponseCode() !== 200) return null;
  const p = JSON.parse(res.getContentText());
  if (p.aud !== GOOGLE_CLIENT_ID) return null;
  if (p.iss !== 'accounts.google.com' && p.iss !== 'https://accounts.google.com') return null;
  if (String(p.email_verified) !== 'true') return null;
  if (Number(p.exp) * 1000 < Date.now()) return null;
  return { id: String(p.sub), email: String(p.email).toLowerCase(), name: clean_(p.name || '', 120) };
}

function withinRateLimit_(email) {
  const cache = CacheService.getScriptCache();
  const key = 'rl:' + email;
  const count = Number(cache.get(key) || 0) + 1;
  cache.put(key, String(count), 600);
  return count <= MAX_REQUESTS_PER_10_MIN;
}

/* ---------- Users ---------- */

function upsertUser_(user, details) {
  const sh = sheet_(USERS);
  const last = lastRow_(sh);
  const emails = last >= 2 ? sh.getRange(2, 3, last - 1, 1).getValues() : [];
  let row = 0;
  for (let i = 0; i < emails.length; i++) {
    if (String(emails[i][0]).toLowerCase() === user.email) { row = i + 2; break; }
  }
  if (!row) {
    row = last + 1;
    ensureRow_(sh, row);
    sh.getRange(row, 1, 1, 5).setValues([[user.id, user.name, user.email, '', new Date()]]);
  }
  if (details) {
    if (details.phone) sh.getRange(row, 4).setValue(details.phone);
    if (details.addressText) sh.getRange(row, 6, 1, 2).setValues([[details.addressText, details.pin]]);
  }
  return { ok: true };
}

/* ---------- Orders ---------- */

function addOrder_(user, o) {
  if (!o || typeof o !== 'object') return { ok: false, error: 'bad_order' };
  const id = String(o.id || '');
  if (!/^EX[A-Z0-9]{4,12}$/.test(id)) return { ok: false, error: 'bad_order' };
  if (!/^\d{12}$/.test(String(o.utr || ''))) return { ok: false, error: 'bad_utr' };

  const a = o.address || {};
  const phone = String(a.phone || '');
  const pin = String(a.pin || '');
  if (!/^[6-9]\d{9}$/.test(phone) || !/^[1-9]\d{5}$/.test(pin)) return { ok: false, error: 'bad_address' };

  const items = Array.isArray(o.items) ? o.items.slice(0, 50) : [];
  if (!items.length) return { ok: false, error: 'bad_order' };
  const lines = items.map(function (i) {
    const qty = Math.max(1, Math.min(100, Math.round(Number(i.qty) || 1)));
    return clean_(i.name, 120) + ' × ' + qty + ': ' + clean_(i.spec, 300) + ' (₹' + (money_(i.total) || 0) + ')';
  });
  const pieces = items.reduce(function (t, i) { return t + Math.max(1, Math.round(Number(i.qty) || 1)); }, 0);

  const amounts = [o.subtotal, o.setup, o.topUp, o.shipping, o.remote].map(money_);
  if (amounts.some(function (n) { return n === null; })) return { ok: false, error: 'bad_order' };

  const sh = sheet_(ORDERS);
  const last = lastRow_(sh);
  if (last >= 2) {
    const ids = sh.getRange(2, 1, last - 1, 1).getValues();
    for (let i = 0; i < ids.length; i++) if (String(ids[i][0]) === id) return { ok: true, duplicate: true };
  }

  const addressText = [a.line1, a.line2, a.city, a.state].map(function (s) { return clean_(s, 120); }).filter(String).join(', ');
  const arrive = Number(o.arriveBy);
  const expected = arrive > Date.now() && arrive < Date.now() + 60 * 864e5 ? new Date(arrive) : '';
  const row = last + 1;
  ensureRow_(sh, row);

  sh.getRange(row, 1, 1, 14).setValues([[
    id, new Date(), clean_(a.name, 120), user.email, phone, addressText, pin,
    lines.join('\n'), pieces
  ].concat(amounts)]);
  sh.getRange(row, 16, 1, 4).setValues([[String(o.utr), 'Payment being checked', 'New', expected]]);

  upsertUser_(user, o.saveAddress ? { phone: phone, addressText: addressText, pin: pin } : { phone: phone });

  notifyOwner_({
    id: id, row: row, name: clean_(a.name, 120), email: user.email, phone: phone,
    address: addressText + ' ' + pin, lines: lines, pieces: pieces, amounts: amounts,
    utr: String(o.utr), expected: expected
  });
  return { ok: true, id: id };
}

/* ---------- Email to the shop owner ---------- */

// Emails the owner of this script about a new order. A failed email never
// stops the order from being saved.
function notifyOwner_(o) {
  try {
    const to = Session.getEffectiveUser().getEmail();
    if (!to) return;
    const total = o.amounts.reduce(function (t, n) { return t + n; }, 0);
    const labels = ['Items', 'Setup fee', 'Minimum order top-up', 'Shipping', 'Remote area'];
    const rupees = function (n) { return '₹' + Number(n).toLocaleString('en-IN'); };
    const when = o.expected ? Utilities.formatDate(o.expected, 'Asia/Kolkata', 'EEE d MMM') : 'not worked out';
    const sheetLink = 'https://docs.google.com/spreadsheets/d/' + SHEET_ID + '/edit#gid=' + sheet_(ORDERS).getSheetId() + '&range=A' + o.row;
    const folderLink = 'https://drive.google.com/drive/folders/' + STL_FOLDER_ID;

    const charges = o.amounts.map(function (n, i) { return [labels[i], n]; }).filter(function (c, i) { return i < 2 || c[1] > 0; });
    const text = [
      'New order ' + o.id + ', ' + rupees(total),
      '',
      'Customer: ' + o.name + ', ' + o.email + ', ' + o.phone,
      'Deliver to: ' + o.address,
      'Expected delivery: ' + when,
      '',
      'Models (' + o.pieces + (o.pieces > 1 ? ' pieces' : ' piece') + '):',
    ].concat(o.lines.map(function (l) { return '- ' + l; })).concat([
      '',
    ]).concat(charges.map(function (c) { return c[0] + ': ' + rupees(c[1]); })).concat([
      'Total: ' + rupees(total),
      '',
      'UPI reference (UTR): ' + o.utr + '. Check it against your UPI payments, then set Payment status to Paid.',
      '',
      'Order in the sheet: ' + sheetLink,
      'STL files folder: ' + folderLink,
      'The model files are uploading from the customer\'s browser and appear in the Model files column when they finish.'
    ]).join('\n');

    const h = function (v) { return String(v).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
    const row = function (k, v) { return '<tr><td style="padding:4px 16px 4px 0;color:#5A6472;vertical-align:top">' + h(k) + '</td><td style="padding:4px 0">' + v + '</td></tr>'; };
    const html = '<div style="font-family:Arial,sans-serif;font-size:14px;color:#18202B;max-width:620px">'
      + '<h2 style="margin:0 0 4px">New order ' + h(o.id) + '</h2>'
      + '<p style="margin:0 0 16px;font-size:18px"><b>' + rupees(total) + '</b>, payment being checked</p>'
      + '<table style="border-collapse:collapse">'
      + row('Customer', h(o.name) + '<br>' + h(o.email) + '<br>' + h(o.phone))
      + row('Deliver to', h(o.address))
      + row('Expected delivery', h(when))
      + row('Models', o.lines.map(h).join('<br>'))
      + charges.map(function (c) { return row(c[0], rupees(c[1])); }).join('')
      + row('<b>Total</b>', '<b>' + rupees(total) + '</b>')
      + row('UPI reference', '<b>' + h(o.utr) + '</b>')
      + '</table>'
      + '<p>Check the UPI reference against your payments, then set Payment status to Paid in the sheet.</p>'
      + '<p><a href="' + sheetLink + '">Open this order in the sheet</a> &nbsp; <a href="' + folderLink + '">Open the STL files folder</a></p>'
      + '<p style="color:#5A6472">The model files are uploading from the customer\'s browser and appear in the Model files column when they finish.</p>'
      + '</div>';

    MailApp.sendEmail({
      to: to,
      replyTo: o.email,
      name: 'Extrudo orders',
      subject: 'New order ' + o.id + ': ' + rupees(total) + ' from ' + o.name,
      body: text,
      htmlBody: html
    });
  } catch (err) {
    console.error('Order email failed: ' + err);
  }
}

function listOrders_(user) {
  const sh = sheet_(ORDERS);
  const last = lastRow_(sh);
  if (last < 2) return { ok: true, orders: [] };
  const rows = sh.getRange(2, 1, last - 1, FILES_COLUMN).getValues();
  const iso = function (d) { return d instanceof Date ? d.toISOString() : ''; };
  const orders = rows
    .filter(function (r) { return String(r[3]).toLowerCase() === user.email; })
    .map(function (r) {
      return {
        id: String(r[0]), placedAt: iso(r[1]), items: String(r[7]), pieces: Number(r[8]) || 0,
        total: Number(r[14]) || 0, utr: String(r[15]), payment: String(r[16]), status: String(r[17]),
        expected: iso(r[18]), tracking: String(r[19]),
        files: String(r[FILES_COLUMN - 1]).split('\n').filter(String).length
      };
    })
    .reverse()
    .slice(0, 50);
  return { ok: true, orders: orders };
}

/* ---------- Model files ---------- */

// Finds the customer's own order. Returns its row and how many models it has.
function findOwnOrder_(user, orderId) {
  if (!/^EX[A-Z0-9]{4,12}$/.test(String(orderId || ''))) return null;
  const sh = sheet_(ORDERS);
  const last = lastRow_(sh);
  if (last < 2) return null;
  const rows = sh.getRange(2, 1, last - 1, 8).getValues();
  for (let i = rows.length - 1; i >= 0; i--) {
    if (String(rows[i][0]) === orderId) {
      if (String(rows[i][3]).toLowerCase() !== user.email) return null;
      return { sheet: sh, row: i + 2, items: String(rows[i][7]).split('\n').filter(String).length };
    }
  }
  return null;
}

// Starts saving one model file to the STL files folder, named after the order.
function fileStart_(user, body) {
  const order = findOwnOrder_(user, body.orderId);
  if (!order) return { ok: false, error: 'order_not_found' };
  const index = Math.floor(Number(body.index));
  const size = Math.floor(Number(body.size));
  if (!(index >= 0 && index < order.items)) return { ok: false, error: 'bad_file' };
  if (!(size > 84 && size <= MAX_FILE_BYTES)) return { ok: false, error: 'file_too_large' };

  const name = body.orderId + (order.items > 1 ? '-' + (index + 1) : '') + '.stl';
  DriveApp.getFolderById(STL_FOLDER_ID); // also gives this script permission to use Drive

  const res = UrlFetchApp.fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name', {
    method: 'post',
    contentType: 'application/json; charset=UTF-8',
    headers: {
      Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
      'X-Upload-Content-Type': 'application/octet-stream',
      'X-Upload-Content-Length': String(size)
    },
    payload: JSON.stringify({ name: name, parents: [STL_FOLDER_ID], description: 'Extrudo order ' + body.orderId + ', model ' + (index + 1) }),
    muteHttpExceptions: true
  });
  const uri = res.getHeaders()['Location'] || res.getHeaders()['location'];
  if (res.getResponseCode() !== 200 || !uri) return driveFailure_('Drive upload start', res);

  CacheService.getScriptCache().put(uploadKey_(body.orderId, index), JSON.stringify({ uri: uri, size: size, name: name, email: user.email }), 21600);
  return { ok: true, chunkSize: CHUNK_BYTES, name: name };
}

// Receives one 8 MB piece of a file and passes it on to Drive.
function fileChunk_(user, body) {
  const index = Math.floor(Number(body.index));
  const key = uploadKey_(body.orderId, index);
  const saved = CacheService.getScriptCache().get(key);
  if (!saved) return { ok: false, error: 'upload_expired' };
  const up = JSON.parse(saved);
  if (up.email !== user.email) return { ok: false, error: 'order_not_found' };

  const offset = Math.floor(Number(body.offset));
  const bytes = Utilities.base64Decode(String(body.data || ''));
  const end = offset + bytes.length;
  if (!(offset >= 0) || !bytes.length || end > up.size) return { ok: false, error: 'bad_file' };
  if (end < up.size && bytes.length % (256 * 1024) !== 0) return { ok: false, error: 'bad_file' };

  const res = UrlFetchApp.fetch(up.uri, {
    method: 'put',
    contentType: 'application/octet-stream',
    headers: { 'Content-Range': 'bytes ' + offset + '-' + (end - 1) + '/' + up.size },
    payload: bytes,
    muteHttpExceptions: true
  });
  const code = res.getResponseCode();
  if (code === 308) {
    const range = res.getHeaders()['Range'] || res.getHeaders()['range'] || '';
    const m = /bytes=0-(\d+)/.exec(range);
    return { ok: true, done: false, received: m ? Number(m[1]) + 1 : end };
  }
  if (code !== 200 && code !== 201) return driveFailure_('Drive upload piece', res);

  const file = JSON.parse(res.getContentText());
  CacheService.getScriptCache().remove(key);
  locked_(function () {
    const order = findOwnOrder_(user, body.orderId);
    if (order) addFileLink_(order.sheet, order.row, up.name, 'https://drive.google.com/file/d/' + file.id + '/view');
  });
  return { ok: true, done: true, name: up.name };
}

// Logs Drive's answer (see Executions in Apps Script) and passes a short reason back.
function driveFailure_(step, res) {
  const text = res.getContentText();
  console.error(step + ' failed: ' + res.getResponseCode() + ' ' + text.slice(0, 500));
  let detail = '';
  try { detail = JSON.parse(text).error.message; } catch (err) { detail = text; }
  return { ok: false, error: 'upload_failed', status: res.getResponseCode(), detail: String(detail).slice(0, 200) };
}

function uploadKey_(orderId, index) {
  return 'up:' + orderId + ':' + index;
}

// Adds a linked file name on a new line in the order's "Model files" cell.
function addFileLink_(sh, row, name, url) {
  const cell = sh.getRange(row, FILES_COLUMN);
  const old = cell.getRichTextValue();
  const oldText = old ? old.getText() : '';
  const text = oldText ? oldText + '\n' + name : name;
  const b = SpreadsheetApp.newRichTextValue().setText(text);
  if (old) old.getRuns().forEach(function (r) {
    const u = r.getLinkUrl();
    if (u) b.setLinkUrl(r.getStartIndex(), r.getEndIndex(), u);
  });
  b.setLinkUrl(text.length - name.length, text.length, url);
  cell.setRichTextValue(b.build());
}

/* ---------- Helpers ---------- */

function sheet_(name) {
  const sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName(name);
  if (!sh) throw new Error('Missing tab: ' + name);
  return sh;
}

// Makes sure the tab has room for the given row.
function ensureRow_(sh, row) {
  const max = sh.getMaxRows();
  if (row > max) sh.insertRowsAfter(max, Math.max(200, row - max));
}

// Last row with an ID in column A. Columns worked out by formulas are ignored.
function lastRow_(sh) {
  const max = sh.getMaxRows();
  if (max < 2) return 1;
  const ids = sh.getRange(2, 1, max - 1, 1).getValues();
  let n = ids.length;
  while (n && ids[n - 1][0] === '') n--;
  return n + 1;
}

// Plain text only, and never a formula: a leading = + - or @ is escaped.
function clean_(v, max) {
  let s = String(v == null ? '' : v).replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, max || 200);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return s;
}

function money_(v) {
  const n = Math.round(Number(v));
  return isFinite(n) && n >= 0 && n <= 10000000 ? n : null;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
