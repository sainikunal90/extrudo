/**
 * Extrudo order API.
 *
 * Paste this into the "Extrudo Customers and Orders" sheet
 * (Extensions > Apps Script), then
 * Deploy > New deployment > Web app, with "Execute as: Me" and
 * "Who has access: Anyone".
 *
 * For every new order, the script emails NOTIFY_EMAIL (or, if that is
 * empty, the account the script runs as) with the order's details, and
 * emails the customer a confirmation. Run turnOnPaymentEmails once to also
 * email customers when you set an order's Payment status to Paid.
 *
 * It also runs the website's Shop: it reads the Shop, Settings and Prices
 * tabs of the "Extrudo Pricing Controls" sheet, and saves the pictures the
 * website makes of each Shop model.
 *
 * After changing this file, publish it with Deploy > Manage deployments >
 * pencil icon > Version: New version > Deploy. That keeps the same web app
 * URL, so the website doesn't need changing.
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

// The website's address. Customers' browsers send model files straight to
// Drive from this site, using an upload link this script creates.
const SITE_ORIGIN = 'https://sainikunal90.github.io';

// Where new-order emails go. Leave empty to use the account this script runs
// as. Gmail doesn't notify you about mail you send to yourself, so put a
// different address here if you want a phone notification.
const NOTIFY_EMAIL = '';

const SITE_URL = SITE_ORIGIN + '/extrudo/';

// The "Extrudo Pricing Controls" sheet, with the Prices, Shop and Settings tabs.
const PRICING_SHEET_ID = '1cWLCh_2Ead388qhd6jEJeEdk5E3iSkTQjY0CxOa3Rac';
// Extrudo > Shop pictures (each picture is viewable by anyone with its link)
// and Extrudo > Shop previews (private; sent to customers only while 3D spin is on).
const SHOP_PICTURES_FOLDER_ID = '1AB-Z0HlvIb3wQVJnpaXPziseJv9PRKxr';
const SHOP_PREVIEWS_FOLDER_ID = '16ELLyJyTMach9jkmEeKpQLb_wuLn-BEa';
const SHOP_CACHE_SECONDS = 60;              // sheet changes reach the website within a minute
const SHOP_READ_BYTES = 8 * 1024 * 1024;
const PAYMENT_COLUMN = 17;                  // column Q, "Payment status"

const USERS = 'Users';
const ORDERS = 'Orders';
const FILES_COLUMN = 22;                    // column V, "Model files"
const MAX_REQUESTS_PER_10_MIN = 40;

function doGet(e) {
  const action = e && e.parameter ? String(e.parameter.action || '') : '';
  try {
    if (action === 'shop') return json_(shopPublic_());
    if (action === 'preview') return json_(shopPreview_(String(e.parameter.key || '')));
  } catch (err) {
    console.error(err);
    return json_({ ok: false, error: 'server_error' });
  }
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
    // File pieces and upload checks are limited by the file's size instead, so they skip this count.
    if (body.action !== 'fileChunk' && body.action !== 'fileStatus' && !isOwner_(user) && !withinRateLimit_(user.email)) return json_({ ok: false, error: 'too_many_requests' });

    if (body.action === 'signin') return json_(locked_(function () { return Object.assign(upsertUser_(user, null), { owner: isOwner_(user) }); }));
    if (body.action === 'shopAdmin') return json_(shopAdmin_(user));
    if (body.action === 'shopRead') return json_(shopRead_(user, body));
    if (body.action === 'shopSave') return json_(shopSave_(user, body));
    if (body.action === 'order') return json_(locked_(function () { return addOrder_(user, body.order); }));
    if (body.action === 'orders') return json_(listOrders_(user));
    if (body.action === 'fileStart') return json_(fileStart_(user, body));
    if (body.action === 'fileChunk') return json_(fileChunk_(user, body));
    if (body.action === 'fileStatus') return json_(fileStatus_(user, body));
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
  // A token Google has already confirmed is remembered for a few minutes, so a
  // file sent in many pieces isn't slowed down by a check on every piece.
  const cache = CacheService.getScriptCache();
  const key = 'tok:' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token));
  const hit = cache.get(key);
  if (hit) {
    const u = JSON.parse(hit);
    if (u.exp * 1000 > Date.now()) return { id: u.id, email: u.email, name: u.name };
  }
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
  const user = { id: String(p.sub), email: String(p.email).toLowerCase(), name: clean_(p.name || '', 120) };
  const ttl = Math.min(600, Math.floor(Number(p.exp) - Date.now() / 1000));
  if (ttl > 30) cache.put(key, JSON.stringify({ id: user.id, email: user.email, name: user.name, exp: Number(p.exp) }), ttl);
  return user;
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
  // Shop models are already in your Drive, so their files are linked straight away.
  const shopItems = items.some(function (i) { return i && i.shopKey; }) ? shopData_().items : [];
  const shopLinks = [];
  const lines = items.map(function (i) {
    const qty = Math.max(1, Math.min(100, Math.round(Number(i.qty) || 1)));
    let label = '';
    if (i.shopKey) {
      const it = shopItems.filter(function (x) { return x.key === String(i.shopKey); })[0];
      label = it ? 'Shop: ' : 'Shop (no longer listed): ';
      if (it) shopLinks.push(it);
    }
    return label + clean_(i.name, 120) + ' × ' + qty + ': ' + clean_(i.spec, 300) + ' (₹' + (money_(i.total) || 0) + ')';
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

  shopLinks.forEach(function (it) {
    addFileLink_(sh, row, 'Shop: ' + it.name, 'https://drive.google.com/file/d/' + it.file + '/view');
  });
  upsertUser_(user, o.saveAddress ? { phone: phone, addressText: addressText, pin: pin } : { phone: phone });

  const mail = {
    id: id, row: row, name: clean_(a.name, 120), email: user.email, phone: phone,
    address: addressText + ' ' + pin, lines: lines, pieces: pieces, amounts: amounts,
    utr: String(o.utr), expected: expected
  };
  notifyOwner_(mail);
  return { ok: true, id: id, customerEmailed: emailCustomerOrder_(mail) };
}

/* ---------- Email to the shop owner ---------- */

// Emails the owner of this script about a new order. A failed email never
// stops the order from being saved.
function notifyOwner_(o) {
  try {
    const to = NOTIFY_EMAIL || Session.getEffectiveUser().getEmail();
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

/* ---------- Customer emails ---------- */

// Customer emails always go to the address in the customer's Google sign-in
// (or, for payment emails, the Email column), never to an address typed into
// the website, so nobody can use the site to email someone else.

function escHtml_(v) {
  return String(v).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
}
function rupees_(n) {
  return '₹' + Number(n).toLocaleString('en-IN');
}
function dayText_(d) {
  return d instanceof Date && !isNaN(d) ? Utilities.formatDate(d, 'Asia/Kolkata', 'EEE d MMM') : '';
}

// Sends one customer email in the shop's plain style. rows are [label, text]
// pairs; a label starting with * is shown in bold.
function sendCustomerEmail_(to, subject, heading, intro, rows) {
  const ordersLink = SITE_URL + '#orders';
  const clean = rows.filter(function (r) { return r[1] !== '' && r[1] !== null && r[1] !== undefined; });
  const label = function (k) { return k.replace(/^\*/, ''); };
  const text = [heading, '', intro, '']
    .concat(clean.map(function (r) { return label(r[0]) + ': ' + String(r[1]).split('\n').join('\n  '); }))
    .concat(['', 'Follow your order: ' + ordersLink, 'Questions? Reply to this email.', '', 'Extrudo, 3D printing in Gurgaon'])
    .join('\n');
  const cell = function (r) {
    const bold = r[0].charAt(0) === '*';
    const v = escHtml_(r[1]).split('\n').join('<br>');
    return '<tr><td style="padding:5px 18px 5px 0;color:#5A6472;vertical-align:top;white-space:nowrap">' + escHtml_(label(r[0])) + '</td>'
      + '<td style="padding:5px 0">' + (bold ? '<b>' + v + '</b>' : v) + '</td></tr>';
  };
  const html = '<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5;color:#18202B;max-width:600px">'
    + '<p style="margin:0 0 18px;font-size:20px;font-weight:bold;color:#2448D8">Extrudo</p>'
    + '<h2 style="margin:0 0 8px;font-size:20px">' + escHtml_(heading) + '</h2>'
    + '<p style="margin:0 0 16px">' + escHtml_(intro) + '</p>'
    + '<table style="border-collapse:collapse;margin:0 0 18px">' + clean.map(cell).join('') + '</table>'
    + '<p style="margin:0 0 18px"><a href="' + ordersLink + '" style="display:inline-block;background:#2448D8;color:#FFFFFF;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:bold">See your orders</a></p>'
    + '<p style="margin:0;color:#5A6472">Questions? Reply to this email.<br>Extrudo, 3D printing in Gurgaon</p>'
    + '</div>';
  MailApp.sendEmail({ to: to, name: 'Extrudo', subject: subject, body: text, htmlBody: html });
}

// Confirms a new order to the customer. A failed email never stops the order.
function emailCustomerOrder_(o) {
  try {
    const labels = ['Items', 'Setup fee', 'Minimum order top-up', 'Shipping', 'Remote area delivery'];
    const total = o.amounts.reduce(function (t, n) { return t + n; }, 0);
    const charges = o.amounts.map(function (n, i) { return [labels[i], n]; })
      .filter(function (c, i) { return i < 2 || c[1] > 0; })
      .map(function (c) { return [c[0], rupees_(c[1])]; });
    sendCustomerEmail_(o.email,
      'Extrudo order ' + o.id + ' received: ' + rupees_(total),
      'We’ve received your order ' + o.id,
      'Hi ' + o.name + ', thanks for your order. We’re now checking your UPI payment of ' + rupees_(total)
        + ', and printing starts as soon as it’s confirmed, usually within a day.',
      [['Order', o.id], ['Models', o.lines.join('\n')]].concat(charges).concat([
        ['*Total', rupees_(total)],
        ['UPI reference', o.utr],
        ['Deliver to', o.name + '\n' + o.address + '\n' + o.phone],
        ['Expected delivery', dayText_(o.expected) ? dayText_(o.expected) + ' (estimate)' : '']
      ]));
    return true;
  } catch (err) {
    console.error('Customer order email failed: ' + err);
    return false;
  }
}

/**
 * Run this once from the Apps Script editor (choose it in the function list,
 * then click Run). From then on, setting an order's Payment status to Paid in
 * the sheet emails that customer. Running it again is harmless.
 */
function turnOnPaymentEmails() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'onOrderSheetEdit') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('onOrderSheetEdit').forSpreadsheet(SHEET_ID).onEdit().create();
  console.log('Payment emails are on. Set an order\'s Payment status to Paid and the customer gets an email.');
}

// Runs when you edit the sheet. Only edits to the Payment status column matter.
function onOrderSheetEdit(e) {
  try {
    if (!e || !e.range) return;
    const sh = e.range.getSheet();
    if (sh.getName() !== ORDERS) return;
    const first = e.range.getColumn(), last = first + e.range.getNumColumns() - 1;
    if (PAYMENT_COLUMN < first || PAYMENT_COLUMN > last) return;
    const top = e.range.getRow();
    for (let r = Math.max(2, top); r < top + e.range.getNumRows(); r++) emailPaymentReceived_(sh, r);
  } catch (err) {
    console.error('Payment email failed: ' + err);
  }
}

// Emails the customer once when their order is marked Paid.
function emailPaymentReceived_(sh, row) {
  const v = sh.getRange(row, 1, 1, 19).getValues()[0];
  const id = String(v[0]);
  if (String(v[PAYMENT_COLUMN - 1]) !== 'Paid' || !/^EX[A-Z0-9]{4,12}$/.test(id)) return;
  const to = String(v[3]).trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return;
  const props = PropertiesService.getScriptProperties();
  const key = 'paidMail:' + id;
  if (props.getProperty(key)) return;   // already told this customer

  const total = [9, 10, 11, 12, 13].reduce(function (t, i) { return t + (Number(v[i]) || 0); }, 0);
  const expected = dayText_(v[18]);
  sendCustomerEmail_(to,
    'Payment received for Extrudo order ' + id,
    'Payment received, your order is in the print queue',
    'Hi ' + String(v[2]) + ', we’ve matched your UPI payment of ' + rupees_(total) + ' for order ' + id
      + '. It’s now in our print queue.',
    [['Order', id], ['Models', String(v[7])], ['*Paid', rupees_(total)], ['UPI reference', String(v[15])],
     ['Expected delivery', expected ? expected + ' (estimate)' : '']]);
  props.setProperty(key, new Date().toISOString());
}

/* ---------- Shop ---------- */

// Shop tab columns: Rank, Hide from website, Name, Category, Description,
// STL file (Drive link), Picture colour, then four the website fills in:
// Status, Size (mm), Pictures, Website data.
const SHOP_TAB = 'Shop';
const SETTINGS_TAB = 'Settings';
const PRICES_TAB = 'Prices';

function pricingTab_(name) {
  return SpreadsheetApp.openById(PRICING_SHEET_ID).getSheetByName(name);
}
function text_(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, max || 200);
}
function driveIdOf_(link) {
  const m = /[-\w]{25,}/.exec(String(link || ''));
  return m ? m[0] : '';
}
function isOwner_(user) {
  const me = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
  return !!me && !!user && user.email === me;
}

function shopRows_() {
  const sh = pricingTab_(SHOP_TAB);
  if (!sh) return [];
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, 11).getValues().map(function (v, i) {
    let data = null;
    try { data = v[10] ? JSON.parse(String(v[10])) : null; } catch (err) { data = null; }
    return {
      row: i + 2, rank: v[0], hide: v[1] === true || /^true$/i.test(String(v[1])),
      name: text_(v[2], 120), cat: text_(v[3], 40), desc: text_(v[4], 600),
      link: text_(v[5], 500), fileId: driveIdOf_(v[5]), colour: text_(v[6], 40),
      status: text_(v[7], 200), data: data
    };
  }).filter(function (r) { return r.name || r.link; });
}

function shopSpinOn_() {
  const sh = pricingTab_(SETTINGS_TAB);
  if (!sh) return false;
  const v = sh.getDataRange().getValues();
  for (let i = 1; i < v.length; i++) {
    if (/3d spin/i.test(String(v[i][0]))) return v[i][1] === true || /^(true|on|yes)$/i.test(String(v[i][1]).trim());
  }
  return false;
}

// Everything the Shop needs, kept for a minute so the website stays quick.
function shopData_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('shop:data');
  if (hit) return JSON.parse(hit);
  const pricesTab = pricingTab_(PRICES_TAB);
  const items = shopRows_()
    .filter(function (r) { return !r.hide && r.name && r.data && r.data.key && r.fileId && r.data.file === r.fileId; })
    .map(function (r, i) {
      const rank = typeof r.rank === 'number' ? r.rank : (String(r.rank).trim() && isFinite(Number(r.rank)) ? Number(r.rank) : null);
      return {
        key: r.data.key, name: r.name, cat: r.cat, desc: r.desc, colour: r.colour,
        dims: r.data.dims, vol: r.data.vol, area: r.data.area, pics: r.data.pics || [],
        preview: r.data.preview || '', file: r.fileId, rank: rank, order: i
      };
    });
  items.sort(function (a, b) {
    if (a.rank !== null && b.rank !== null && a.rank !== b.rank) return a.rank - b.rank;
    if (a.rank !== null && b.rank === null) return -1;
    if (a.rank === null && b.rank !== null) return 1;
    return a.order - b.order;
  });
  const out = { spin: shopSpinOn_(), prices: pricesTab ? pricesTab.getDataRange().getDisplayValues() : [], items: items, at: new Date().toISOString() };
  try { cache.put('shop:data', JSON.stringify(out), SHOP_CACHE_SECONDS); } catch (err) { /* too big to keep; read fresh next time */ }
  return out;
}

// What anyone visiting the website gets. File IDs stay on the server.
function shopPublic_() {
  const d = shopData_();
  return {
    ok: true, spin: d.spin, prices: d.prices, at: d.at,
    items: d.items.map(function (it) {
      return { key: it.key, name: it.name, cat: it.cat, desc: it.desc, colour: it.colour, dims: it.dims, vol: it.vol, area: it.area, pics: it.pics, spin: d.spin && !!it.preview };
    })
  };
}

// The lighter 3D copy of a Shop model, only while 3D spin is ticked in Settings.
function shopPreview_(key) {
  const d = shopData_();
  if (!d.spin) return { ok: false, error: 'spin_off' };
  const it = d.items.filter(function (x) { return x.key === key; })[0];
  if (!it || !it.preview) return { ok: false, error: 'not_found' };
  return { ok: true, data: Utilities.base64Encode(DriveApp.getFileById(it.preview).getBlob().getBytes()) };
}

function setShopStatus_(sh, r, text) {
  if (r.status !== text) sh.getRange(r.row, 8).setValue(text);
}

// For the owner's Update shop button: which rows need pictures made.
function shopAdmin_(user) {
  if (!isOwner_(user)) return { ok: false, error: 'not_owner' };
  const sh = pricingTab_(SHOP_TAB);
  if (!sh) return { ok: false, error: 'no_shop_tab' };
  const items = shopRows_().map(function (r) {
    const item = { row: r.row, name: r.name || 'Row ' + r.row, colour: r.colour, hide: r.hide, ready: false, need: false, error: '' };
    if (!r.name) { setShopStatus_(sh, r, 'Add a name'); item.error = 'no_name'; return item; }
    if (!r.fileId) { setShopStatus_(sh, r, 'Add the STL file link'); item.error = 'no_link'; return item; }
    let f;
    try { f = DriveApp.getFileById(r.fileId); f.getName(); } catch (err) {
      setShopStatus_(sh, r, 'Can’t open this link. Paste the Drive link of an .stl file in your Drive.');
      item.error = 'bad_link'; return item;
    }
    const size = f.getSize();
    if (size > MAX_FILE_BYTES) { setShopStatus_(sh, r, 'This file is over 100 MB'); item.error = 'too_big'; return item; }
    if (size < 84) { setShopStatus_(sh, r, 'This file is empty or isn’t an STL'); item.error = 'empty'; return item; }
    item.fileId = r.fileId; item.size = size; item.fileName = f.getName();
    item.sig = r.fileId + ':' + f.getLastUpdated().getTime() + ':' + r.colour;
    item.ready = !!(r.data && r.data.sig === item.sig);
    item.need = !item.ready;
    if (item.need) setShopStatus_(sh, r, 'Needs pictures: tap Update shop on the website');
    return item;
  });
  return { ok: true, items: items, sheetUrl: 'https://docs.google.com/spreadsheets/d/' + PRICING_SHEET_ID + '/edit#gid=' + sh.getSheetId() };
}

// Sends the owner's browser one 8 MB piece of a Shop STL, so it can make the pictures.
function shopRead_(user, body) {
  if (!isOwner_(user)) return { ok: false, error: 'not_owner' };
  const id = String(body.fileId || '');
  if (!shopRows_().some(function (r) { return r.fileId === id; })) return { ok: false, error: 'not_found' };
  const offset = Math.max(0, Math.floor(Number(body.offset) || 0));
  const res = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(id) + '?alt=media', {
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken(), Range: 'bytes=' + offset + '-' + (offset + SHOP_READ_BYTES - 1) },
    muteHttpExceptions: true
  });
  const code = res.getResponseCode();
  if (code !== 200 && code !== 206) return driveFailure_('Shop file read', res);
  const bytes = res.getContent();
  const h = res.getHeaders();
  const m = /\/(\d+)\s*$/.exec(String(h['Content-Range'] || h['content-range'] || ''));
  const total = code === 206 && m ? Number(m[1]) : offset + bytes.length;
  return { ok: true, data: Utilities.base64Encode(bytes), size: total, done: offset + bytes.length >= total };
}

// Saves the pictures, 3D preview and measurements the owner's browser made for one Shop row.
function shopSave_(user, body) {
  if (!isOwner_(user)) return { ok: false, error: 'not_owner' };
  const sh = pricingTab_(SHOP_TAB);
  const rowNo = Math.floor(Number(body.row));
  if (!sh || !(rowNo >= 2 && rowNo <= sh.getLastRow())) return { ok: false, error: 'row_changed' };
  const v = sh.getRange(rowNo, 1, 1, 11).getValues()[0];
  const fileId = driveIdOf_(v[5]);
  if (!fileId || fileId !== String(body.fileId || '')) return { ok: false, error: 'row_changed' };

  const dims = (Array.isArray(body.dims) ? body.dims : []).slice(0, 3).map(Number);
  const vol = Number(body.vol), area = Number(body.area);
  if (dims.length !== 3 || !dims.every(function (d) { return isFinite(d) && d > 0 && d < 10000; }) || !(vol > 0) || !(area > 0)) return { ok: false, error: 'bad_model' };
  const pics = (Array.isArray(body.pics) ? body.pics : []).slice(0, 4).map(function (b) { return Utilities.base64Decode(String(b)); });
  if (!pics.length || pics.some(function (b) { return !b.length || b.length > 800 * 1024; })) return { ok: false, error: 'bad_pictures' };
  const preview = body.preview ? Utilities.base64Decode(String(body.preview)) : null;
  if (preview && preview.length > 24 * 1024 * 1024) return { ok: false, error: 'preview_too_big' };

  const name = text_(v[2], 80) || 'Model';
  const picFolder = DriveApp.getFolderById(SHOP_PICTURES_FOLDER_ID);
  const picIds = pics.map(function (bytes, i) {
    const f = picFolder.createFile(Utilities.newBlob(bytes, 'image/jpeg', name + ' ' + (i + 1) + '.jpg'));
    f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    return f.getId();
  });
  const previewId = preview ? DriveApp.getFolderById(SHOP_PREVIEWS_FOLDER_ID).createFile(Utilities.newBlob(preview, 'application/octet-stream', name + '.preview')).getId() : '';

  let old = null;
  try { old = v[10] ? JSON.parse(String(v[10])) : null; } catch (err) { old = null; }
  if (old) (old.pics || []).concat(old.preview ? [old.preview] : []).forEach(function (id) {
    try { DriveApp.getFileById(id).setTrashed(true); } catch (err) { /* already gone */ }
  });

  const f = DriveApp.getFileById(fileId);
  const round = function (n, d) { const k = Math.pow(10, d); return Math.round(n * k) / k; };
  const data = {
    key: (old && old.key) || Utilities.getUuid().replace(/-/g, '').slice(0, 12),
    file: fileId, sig: fileId + ':' + f.getLastUpdated().getTime() + ':' + text_(v[6], 40),
    vol: round(vol, 1), area: round(area, 1), dims: dims.map(function (d) { return round(d, 2); }),
    pics: picIds, preview: previewId, tris: Math.floor(Number(body.tris) || 0), at: new Date().toISOString()
  };
  const label = 'Picture ';
  const text = picIds.map(function (id, i) { return label + (i + 1); }).join(', ');
  const rich = SpreadsheetApp.newRichTextValue().setText(text);
  let at = 0;
  picIds.forEach(function (id, i) {
    const part = label + (i + 1);
    rich.setLinkUrl(at, at + part.length, 'https://drive.google.com/file/d/' + id + '/view');
    at += part.length + 2;
  });
  sh.getRange(rowNo, 8, 1, 2).setValues([[
    'Ready, pictures made ' + Utilities.formatDate(new Date(), 'Asia/Kolkata', 'd MMM, h:mm a'),
    dims.map(function (d) { return Math.round(d); }).join(' × ') + ' mm'
  ]]);
  sh.getRange(rowNo, 10).setRichTextValue(rich.build());
  sh.getRange(rowNo, 11).setValue(JSON.stringify(data));
  CacheService.getScriptCache().remove('shop:data');
  return { ok: true, key: data.key };
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

  const meta = { name: name, parents: [STL_FOLDER_ID], description: 'Extrudo order ' + body.orderId + ', model ' + (index + 1) };
  // The upload link is made for the website's address, so the customer's
  // browser can send the file to Drive itself. If Drive won't make one, the
  // file comes through this script instead.
  let direct = true, res = null;
  try { res = startDriveUpload_(meta, size, SITE_ORIGIN); } catch (err) { res = null; }
  if (!res || res.getResponseCode() !== 200 || !locationOf_(res)) {
    direct = false;
    res = startDriveUpload_(meta, size, '');
  }
  const uri = locationOf_(res);
  if (res.getResponseCode() !== 200 || !uri) return driveFailure_('Drive upload start', res);

  CacheService.getScriptCache().put(uploadKey_(body.orderId, index), JSON.stringify({ uri: uri, size: size, name: name, email: user.email }), 21600);
  return { ok: true, chunkSize: CHUNK_BYTES, name: name, gzip: true, uploadUrl: direct ? uri : '' };
}

function startDriveUpload_(meta, size, origin) {
  const headers = {
    Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
    'X-Upload-Content-Type': 'application/octet-stream',
    'X-Upload-Content-Length': String(size)
  };
  if (origin) headers.Origin = origin;
  return UrlFetchApp.fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name', {
    method: 'post',
    contentType: 'application/json; charset=UTF-8',
    headers: headers,
    payload: JSON.stringify(meta),
    muteHttpExceptions: true
  });
}

function locationOf_(res) {
  const h = res.getHeaders();
  return h['Location'] || h['location'] || '';
}

// The upload this customer started for one file, or an error to send back.
function savedUpload_(user, body) {
  const index = Math.floor(Number(body.index));
  const key = uploadKey_(body.orderId, index);
  const saved = CacheService.getScriptCache().get(key);
  if (!saved) return { error: { ok: false, error: 'upload_expired' } };
  const up = JSON.parse(saved);
  if (up.email !== user.email) return { error: { ok: false, error: 'order_not_found' } };
  return { key: key, up: up };
}

// How many bytes Drive holds, from the Range header of a 308 answer.
function receivedOf_(res) {
  const h = res.getHeaders();
  const m = /bytes=0-(\d+)/.exec(h['Range'] || h['range'] || '');
  return m ? Number(m[1]) + 1 : 0;
}

// Asks Drive how much of a file has arrived. When it's all there, links the
// file in the order's row. The website calls this after sending a file to
// Drive itself, and to carry on after an interruption.
function fileStatus_(user, body) {
  const s = savedUpload_(user, body);
  if (s.error) return s.error;
  if (s.up.linked) return { ok: true, done: true, name: s.up.name };
  const res = UrlFetchApp.fetch(s.up.uri, {
    method: 'put',
    headers: { 'Content-Range': 'bytes */' + s.up.size },
    muteHttpExceptions: true
  });
  const code = res.getResponseCode();
  if (code === 308) return { ok: true, done: false, received: receivedOf_(res) };
  if (code === 200 || code === 201) return finishUpload_(user, body, s, res);
  return driveFailure_('Drive upload check', res);
}

// Adds the finished file to the order's "Model files" cell, once.
function finishUpload_(user, body, s, res) {
  let id = '';
  try { id = JSON.parse(res.getContentText()).id || ''; } catch (err) { id = ''; }
  if (!id) {
    const files = DriveApp.getFolderById(STL_FOLDER_ID).getFilesByName(s.up.name);
    let newest = null;
    while (files.hasNext()) {
      const f = files.next();
      if (!newest || f.getDateCreated() > newest.getDateCreated()) newest = f;
    }
    if (!newest) return { ok: false, error: 'upload_failed', detail: 'Drive finished the upload but the file wasn’t found.' };
    id = newest.getId();
  }
  locked_(function () {
    const order = findOwnOrder_(user, body.orderId);
    if (order) addFileLink_(order.sheet, order.row, s.up.name, 'https://drive.google.com/file/d/' + id + '/view');
  });
  s.up.linked = true;
  CacheService.getScriptCache().put(s.key, JSON.stringify(s.up), 21600);
  return { ok: true, done: true, name: s.up.name };
}

// Receives one 8 MB piece of a file (compressed by the browser when it can)
// and passes it on to Drive. Used when the browser can't reach Drive itself.
function fileChunk_(user, body) {
  const s = savedUpload_(user, body);
  if (s.error) return s.error;
  const up = s.up;
  if (up.linked) return { ok: true, done: true, name: up.name };

  const offset = Math.floor(Number(body.offset));
  let bytes = Utilities.base64Decode(String(body.data || ''));
  if (body.gz) {
    try {
      bytes = Utilities.ungzip(Utilities.newBlob(bytes, 'application/x-gzip')).getBytes();
    } catch (err) {
      return { ok: false, error: 'gzip_failed' };
    }
    if (bytes.length !== Math.floor(Number(body.rawSize))) return { ok: false, error: 'gzip_failed' };
  }
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
  if (code === 308) return { ok: true, done: false, received: receivedOf_(res) || end };
  if (code !== 200 && code !== 201) return driveFailure_('Drive upload piece', res);
  return finishUpload_(user, body, s, res);
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
// If the name is already there (a file sent again), its link is updated instead.
function addFileLink_(sh, row, name, url) {
  const cell = sh.getRange(row, FILES_COLUMN);
  const old = cell.getRichTextValue();
  const oldText = old ? old.getText() : '';
  const lines = oldText ? oldText.split('\n') : [];
  const at = lines.indexOf(name);
  const text = at >= 0 ? oldText : (oldText ? oldText + '\n' + name : name);
  const start = at >= 0 ? lines.slice(0, at).join('\n').length + (at ? 1 : 0) : text.length - name.length;
  const b = SpreadsheetApp.newRichTextValue().setText(text);
  if (old) old.getRuns().forEach(function (r) {
    const u = r.getLinkUrl();
    if (u) b.setLinkUrl(r.getStartIndex(), r.getEndIndex(), u);
  });
  b.setLinkUrl(start, start + name.length, url);
  cell.setRichTextValue(b.build());
}

/* ---------- Upload self-test ---------- */

/**
 * Checks the model-file upload on its own. In the Apps Script editor, choose
 * testDriveUpload in the function list at the top, click Run, then read the
 * Execution log. It saves a small test file to the STL files folder exactly
 * the way the website does, step by step, then moves it to the bin.
 */
function testDriveUpload() {
  const step = function (name, ok, info) {
    console.log((ok ? 'OK      ' : 'FAILED  ') + name + (info ? ': ' + info : ''));
    return ok;
  };
  let folder;
  try {
    folder = DriveApp.getFolderById(STL_FOLDER_ID);
    step('1. Open the STL files folder', true, folder.getName());
  } catch (err) {
    return step('1. Open the STL files folder', false, String(err));
  }

  const size = 300 * 1024;
  const bytes = [];
  for (let i = 0; i < size; i++) bytes.push((i % 200) - 100);
  const meta = { name: 'EXTEST-upload-check.stl', parents: [STL_FOLDER_ID] };

  let start = null, direct = true;
  try { start = startDriveUpload_(meta, size, SITE_ORIGIN); } catch (err) { start = null; }
  if (!start || start.getResponseCode() !== 200 || !locationOf_(start)) {
    direct = false;
    start = startDriveUpload_(meta, size, '');
  }
  const uri = locationOf_(start);
  if (!step('2. Start a Drive upload', start.getResponseCode() === 200 && !!uri,
    (direct ? 'link for the website, ' : 'through this script only, ') + start.getResponseCode() + ' ' + start.getContentText().slice(0, 300))) return;

  // The browser compresses pieces; this checks the script can open them.
  const piece = Utilities.ungzip(Utilities.gzip(Utilities.newBlob(bytes.slice(0, 262144)))).getBytes();
  const first = UrlFetchApp.fetch(uri, {
    method: 'put', contentType: 'application/octet-stream',
    headers: { 'Content-Range': 'bytes 0-262143/' + size },
    payload: piece, muteHttpExceptions: true
  });
  if (!step('3. Send the first piece (compressed and opened again)', first.getResponseCode() === 308 && piece.length === 262144,
    first.getResponseCode() + ' ' + first.getContentText().slice(0, 300))) return;

  const check = UrlFetchApp.fetch(uri, { method: 'put', headers: { 'Content-Range': 'bytes */' + size }, muteHttpExceptions: true });
  if (!step('4. Ask Drive how much arrived', check.getResponseCode() === 308 && receivedOf_(check) === 262144,
    check.getResponseCode() + ', ' + receivedOf_(check) + ' bytes')) return;

  const last = UrlFetchApp.fetch(uri, {
    method: 'put', contentType: 'application/octet-stream',
    headers: { 'Content-Range': 'bytes 262144-' + (size - 1) + '/' + size },
    payload: bytes.slice(262144), muteHttpExceptions: true
  });
  if (!step('5. Send the last piece', last.getResponseCode() === 200 || last.getResponseCode() === 201,
    last.getResponseCode() + ' ' + last.getContentText().slice(0, 300))) return;

  const done = UrlFetchApp.fetch(uri, { method: 'put', headers: { 'Content-Range': 'bytes */' + size }, muteHttpExceptions: true });
  let id = '';
  try { id = JSON.parse(done.getContentText()).id || ''; } catch (err) { id = ''; }
  step('6. Ask Drive again once it is finished', done.getResponseCode() === 200 || done.getResponseCode() === 201,
    done.getResponseCode() + (id ? ', file found' : ', no file id (the script will look it up by name)'));

  const file = JSON.parse(last.getContentText());
  step('7. File saved in STL files', true, file.name);
  try {
    DriveApp.getFileById(file.id).setTrashed(true);
    step('8. Test file moved to the bin', true);
  } catch (err) {
    step('8. Move the test file to the bin', false, String(err));
  }
  console.log('Uploads to Drive work. If the website still says "Didn\'t upload", the website is calling an older version of this script.');
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
