'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMessage, normalizeBike } = require('./parser');

const REF = new Date('2026-11-25T06:00:00Z');
const pkt = (s) => new Date(s + '+05:00').getTime();

const issued = `ٹوکن کی معیاد پوری ہونے تک اگلا ٹوکن جاری نہیں ہو سکتا
آپ کا ٹوکن 9869256819، ‎25-Nov‏ کو جاری ہوا۔
آپ کی سواری کا نمبر MNR-14-1038 ہے۔
یہ ٹوکن ‎10:44 02-Dec‏ تک قابلِ استعمال ہے۔
اگلا ٹوکن ‎02-Dec‏ سے حاصل کریں۔`;

const relief = `آپ ٹوکن نمبر 9869256819 سے سواری نمبر MNR-14-1038 کے لیے 500 روپے کا فیول ریلیف حاصل کر سکتے ہیں۔ یہ ٹوکن ‎10:44 02-Dec‏ تک قابلِ استعمال ہے۔`;

test('issued-token SMS', () => {
  const p = parseMessage(issued, REF);
  assert.equal(p.ok, true);
  assert.equal(p.token, '9869256819');
  assert.equal(p.bikeNumber, 'MNR-14-1038');
  assert.equal(p.kind, 'issued');
  assert.equal(p.expiresAt, pkt('2026-12-02T10:44:00'));
  assert.equal(p.issuedAt, pkt('2026-11-25T10:44:00'));
  assert.equal(p.nextTokenAt, p.expiresAt);
  assert.equal(p.amount, null);
});

test('fuel-relief SMS', () => {
  const p = parseMessage(relief, REF);
  assert.equal(p.ok, true);
  assert.equal(p.token, '9869256819');
  assert.equal(p.bikeNumber, 'MNR-14-1038');
  assert.equal(p.kind, 'relief');
  assert.equal(p.amount, 500);
  assert.equal(p.expiresAt, pkt('2026-12-02T10:44:00'));
  assert.equal(p.issuedAt, pkt('2026-11-25T10:44:00'));
});

test('Urdu digits and year rollover', () => {
  const p = parseMessage('آپ کا ٹوکن ۹۸۶۹۲۵۶۸۱۹، 28-Dec کو جاری ہوا۔ آپ کی سواری کا نمبر ABC-21-777 ہے۔ یہ ٹوکن 09:15 04-Jan تک قابلِ استعمال ہے۔', new Date('2026-12-29T00:00:00Z'));
  assert.equal(p.token, '9869256819');
  assert.equal(p.expiresAt, pkt('2027-01-04T09:15:00'));
  assert.equal(p.issuedAt, pkt('2026-12-28T09:15:00'));
});

test('missing pieces are reported', () => {
  assert.deepEqual(parseMessage('hello', REF).missing, ['token', 'bike']);
  assert.equal(parseMessage('', REF).ok, false);
});

test('bike number normalising', () => {
  assert.equal(normalizeBike(' mnr 14 1038 '), 'MNR-14-1038');
  assert.equal(normalizeBike('0786'), '0786');
});
