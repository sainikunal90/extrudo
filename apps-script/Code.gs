/**
 * Extrudo order API.
 *
 * Paste this into the "Extrudo Customers and Orders" sheet
 * (Extensions > Apps Script), then
 * Deploy > New deployment > Web app, with "Execute as: Me" and
 * "Who has access: Anyone".
 *
 * Every request must carry a Google sign-in token issued for
 * GOOGLE_CLIENT_ID. The script checks it with Google and uses the
 * email inside the token, never an email sent by the browser, so a
 * customer can only add rows for their own account and only read
 * their own orders. Customers can never read the sheet, edit rows
 * or see anyone else's data.
 */

const GOOGLE_CLIENT_ID = '25832412551-72g8a86kfgr6hinn3hoib1n0m2uo5sqa.apps.googleusercontent.com';

const USERS = 'Users';
const ORDERS = 'Orders';
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

  const user = verifyGoogleToken_(body.idToken);
  if (!user) return json_({ ok: false, error: 'not_signed_in' });
  if (!withinRateLimit_(user.email)) return json_({ ok: false, error: 'too_many_requests' });

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (err) {
    return json_({ ok: false, error: 'busy' });
  }
  try {
    if (body.action === 'signin') return json_(upsertUser_(user, null));
    if (body.action === 'order') return json_(addOrder_(user, body.order));
    if (body.action === 'orders') return json_(listOrders_(user));
    return json_({ ok: false, error: 'unknown_action' });
  } catch (err) {
    console.error(err);
    return json_({ ok: false, error: 'server_error' });
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
  return { ok: true, id: id };
}

function listOrders_(user) {
  const sh = sheet_(ORDERS);
  const last = lastRow_(sh);
  if (last < 2) return { ok: true, orders: [] };
  const rows = sh.getRange(2, 1, last - 1, 21).getValues();
  const iso = function (d) { return d instanceof Date ? d.toISOString() : ''; };
  const orders = rows
    .filter(function (r) { return String(r[3]).toLowerCase() === user.email; })
    .map(function (r) {
      return {
        id: String(r[0]), placedAt: iso(r[1]), items: String(r[7]), pieces: Number(r[8]) || 0,
        total: Number(r[14]) || 0, utr: String(r[15]), payment: String(r[16]), status: String(r[17]),
        expected: iso(r[18]), tracking: String(r[19])
      };
    })
    .reverse()
    .slice(0, 50);
  return { ok: true, orders: orders };
}

/* ---------- Helpers ---------- */

function sheet_(name) {
  const sh = SpreadsheetApp.getActive().getSheetByName(name);
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
