'use strict';

// Reads a fuel-token SMS (Urdu or English) and pulls out the bike number,
// token number, dates and relief amount. No external service is used.
//
// Supported messages (examples):
//   آپ کا ٹوکن 9869256819، 25-Nov کو جاری ہوا۔ آپ کی سواری کا نمبر MNR-14-1038 ہے۔
//   یہ ٹوکن 10:44 02-Dec تک قابلِ استعمال ہے۔ اگلا ٹوکن 02-Dec سے حاصل کریں۔
//
//   آپ ٹوکن نمبر 9869256819 سے سواری نمبر MNR-14-1038 کے لیے 500 روپے کا
//   فیول ریلیف حاصل کر سکتے ہیں۔ یہ ٹوکن 10:44 02-Dec تک قابلِ استعمال ہے۔

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
// Times in the SMS are local (Pakistan, UTC+5 by default).
const TZ_MIN = Number(process.env.APP_TZ_OFFSET_MIN || 300);

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

const normalize = (text) =>
  String(text || '')
    .replace(/[​-‏‪-‮⁦-⁩﻿]/g, '')
    .replace(/[٠-٩]/g, (d) => d.charCodeAt(0) - 0x0660)
    .replace(/[۰-۹]/g, (d) => d.charCodeAt(0) - 0x06f0)
    .replace(/[‐-―−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();

const normalizeBike = (s) =>
  String(s || '').trim().toUpperCase().replace(/\s*-\s*/g, '-').replace(/\s+/g, '-');

const bikeKey = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// Build a timestamp from local (Pakistan) wall-clock parts; null if the date does not exist.
const wall = (y, mo, d, h = 0, mi = 0) => {
  const t = Date.UTC(y, mo, d, h, mi) - TZ_MIN * 60000;
  const back = new Date(t + TZ_MIN * 60000);
  return back.getUTCMonth() === mo && back.getUTCDate() === d ? t : null;
};

const yearOf = (ms) => new Date(ms + TZ_MIN * 60000).getUTCFullYear();

const monthIndex = (name) => MONTHS[String(name).slice(0, 3).toLowerCase()];

const hour24 = (h, ap) => {
  let x = Number(h);
  if (ap) {
    const pm = /p/i.test(ap);
    if (pm && x < 12) x += 12;
    if (!pm && x === 12) x = 0;
  }
  return x;
};

// Year is usually missing in the SMS, so choose the year that lands nearest to `anchor`.
const nearestYear = (mo, d, h, mi, anchor) => {
  const base = yearOf(anchor);
  let best = null;
  for (const y of [base - 1, base, base + 1]) {
    const t = wall(y, mo, d, h, mi);
    if (t !== null && (best === null || Math.abs(t - anchor) < Math.abs(best - anchor))) best = t;
  }
  return best;
};

const DATE = String.raw`(?<d>\d{1,2})\s*-\s*(?<mon>[A-Za-z]{3,9})(?:\s*-?\s*(?<y>\d{4}))?`;
const TIME = String.raw`(?<h>\d{1,2}):(?<mi>\d{2})(?:\s*(?<ap>[AaPp]\.?[Mm]\.?))?`;
const EXPIRY_A = new RegExp(`${TIME}\\s*,?\\s*${DATE}`);
const EXPIRY_B = new RegExp(`${DATE}\\s*,?\\s*${TIME}`);
const ISSUED = new RegExp(`${DATE}\\s*(?:کو\\s*)?جاری`);
const ISSUED_EN = new RegExp(`issued\\s*(?:on)?\\s*${DATE}`, 'i');

function parseMessage(message, ref = new Date()) {
  const text = normalize(message);
  const now = ref.getTime();
  const warnings = [];
  const out = {
    ok: false, token: null, bikeNumber: null, bikeKey: null,
    issuedAt: null, expiresAt: null, nextTokenAt: null,
    amount: null, kind: 'unknown', warnings, missing: []
  };
  if (!text) { out.missing = ['token', 'bike']; return out; }

  // Token number
  let m = /(?:ٹوکن|token)\s*(?:نمبر|no\.?|number|#)?\s*[:：]?\s*(\d{6,14})/i.exec(text);
  if (!m) m = /(?<![\d-])(\d{8,14})(?![\d-])/.exec(text);
  if (m) out.token = m[1];

  // Bike number
  m = /(?:سواری|بائیک|موٹر\s?سائیکل|گاڑی|vehicle|bike|motorcycle)\s*(?:کا\s*)?(?:نمبر|no\.?|number|#)?\s*[:：]?\s*([A-Za-z0-9]+(?:\s*-\s*[A-Za-z0-9]+){0,3})/i.exec(text);
  let bike = m ? normalizeBike(m[1]) : null;
  if (bike && (/^\d{1,2}-[A-Z]{3}/.test(bike) || bike === out.token)) bike = null;
  if (!bike) {
    const p = /\b([A-Za-z]{2,4}[-\s]\d{1,3}[-\s]\d{1,5})\b/.exec(text);
    if (p && monthIndex(p[1]) === undefined) bike = normalizeBike(p[1]);
  }
  if (bike) { out.bikeNumber = bike; out.bikeKey = bikeKey(bike); }

  // Validity (expiry) — "10:44 02-Dec"
  const em = EXPIRY_A.exec(text) || EXPIRY_B.exec(text);
  if (em && monthIndex(em.groups.mon) !== undefined) {
    const g = em.groups;
    const mo = monthIndex(g.mon);
    const h = hour24(g.h, g.ap);
    const t = g.y ? wall(Number(g.y), mo, Number(g.d), h, Number(g.mi)) : nearestYear(mo, Number(g.d), h, Number(g.mi), now);
    if (t !== null) out.expiresAt = t;
  }

  // Issue date — "25-Nov کو جاری ہوا" (date only, no time)
  const im = ISSUED.exec(text) || ISSUED_EN.exec(text);
  if (im && monthIndex(im.groups.mon) !== undefined) {
    const g = im.groups;
    const mo = monthIndex(g.mon);
    const d = Number(g.d);
    // The 7-day window means the issue time of day equals the expiry time of day.
    const clock = out.expiresAt !== null ? new Date(out.expiresAt + TZ_MIN * 60000) : null;
    const h = clock ? clock.getUTCHours() : 0;
    const mi = clock ? clock.getUTCMinutes() : 0;
    let t = null;
    if (g.y) t = wall(Number(g.y), mo, d, h, mi);
    else if (out.expiresAt !== null) {
      for (const y of [yearOf(out.expiresAt), yearOf(out.expiresAt) - 1]) {
        const c = wall(y, mo, d, h, mi);
        if (c !== null && c <= out.expiresAt) { t = c; break; }
      }
    } else t = nearestYear(mo, d, h, mi, now);
    if (t !== null) out.issuedAt = t;
  }

  // Fill gaps
  if (out.issuedAt === null && out.expiresAt !== null) out.issuedAt = out.expiresAt - WEEK_MS;
  if (out.expiresAt === null) {
    if (out.issuedAt === null) {
      out.issuedAt = now;
      warnings.push('Dates not found. Using the time of adding as issue time.');
    }
    out.expiresAt = out.issuedAt + WEEK_MS;
    warnings.push('Validity not found. Assuming 7 days from issue.');
  }
  out.nextTokenAt = out.expiresAt;

  // Relief amount
  m = /(\d[\d,]*)\s*(?:روپے|روپیہ|rs\.?|rupees)/i.exec(text) || /(?:rs\.?|rupees)\s*(\d[\d,]*)/i.exec(text);
  if (m) out.amount = Number(m[1].replace(/,/g, ''));

  // Message type
  if (/جاری\s*ہوا|issued/i.test(text)) out.kind = 'issued';
  else if (out.amount !== null || /ریلیف|relief/i.test(text)) out.kind = 'relief';

  if (!out.token) out.missing.push('token');
  if (!out.bikeNumber) out.missing.push('bike');
  out.ok = out.missing.length === 0;
  return out;
}

module.exports = { parseMessage, normalizeBike, bikeKey, normalize, WEEK_MS };
