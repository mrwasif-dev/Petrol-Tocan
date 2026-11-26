'use strict';

require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const mongoose = require('mongoose');
const { parseMessage, normalizeBike, bikeKey, WEEK_MS } = require('./parser');

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1);

// ---------------------------------------------------------------------------
// Optional HTTP Basic Auth (enabled when APP_PASSWORD is set)
// ---------------------------------------------------------------------------
const safeEqual = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};

app.use((req, res, next) => {
  const password = process.env.APP_PASSWORD;
  if (!password) return next();
  const user = process.env.APP_USER || 'admin';
  const [scheme, encoded] = (req.headers.authorization || '').split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString();
    const idx = decoded.indexOf(':');
    if (idx > -1 && safeEqual(decoded.slice(0, idx), user) && safeEqual(decoded.slice(idx + 1), password)) {
      return next();
    }
  }
  res.set('WWW-Authenticate', 'Basic realm="Fuel Token Tracker", charset="UTF-8"');
  return res.status(401).send('Authentication required.');
});

// Security headers
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin'
  });
  next();
});

app.use(express.json({ limit: '10kb' }));

// Only the single front-end file is served, so server files are never exposed.
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// Install-as-app files (web app manifest, service worker, icons). Fixed list, nothing else is exposed.
const ASSETS = {
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/sw.js': ['sw.js', 'text/javascript'],
  '/icons/icon-192.png': ['icons/icon-192.png', 'image/png'],
  '/icons/icon-512.png': ['icons/icon-512.png', 'image/png'],
  '/icons/apple-touch-icon.png': ['icons/apple-touch-icon.png', 'image/png']
};
Object.entries(ASSETS).forEach(([route, [file, type]]) => {
  app.get(route, (req, res) => {
    res.type(type);
    if (route === '/sw.js') res.set('Cache-Control', 'no-cache');
    res.sendFile(path.join(__dirname, file));
  });
});

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------
const tokenSchema = new mongoose.Schema({
  token: { type: String, required: true, trim: true },
  bikeNumber: { type: String, default: '' },
  issuedAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true },
  amount: { type: Number, default: null },
  kind: { type: String, enum: ['issued', 'relief', 'unknown'], default: 'unknown' },
  raw: { type: String, maxlength: 1500, default: '' },
  addedAt: { type: Date, default: Date.now }
});

const bikeSchema = new mongoose.Schema(
  {
    // Bike number is the identity of a bike, e.g. "0786" or "MNR-14-1038".
    number: { type: String, trim: true, maxlength: 20 },
    numberKey: { type: String, index: { unique: true, sparse: true } },
    name: { type: String, trim: true, maxlength: 60, default: '' },
    sim: { type: String, trim: true, maxlength: 20, default: '' },
    lastTokenAt: { type: Date, required: true },
    nextTokenAt: { type: Date },
    // true after "Token collected" until the token SMS has been added
    pendingToken: { type: Boolean, default: true },
    tokens: { type: [tokenSchema], default: [] }
  },
  { timestamps: true }
);

bikeSchema.pre('validate', function setKey(next) {
  if (this.number) this.numberKey = bikeKey(this.number);
  next();
});

bikeSchema.set('toJSON', {
  versionKey: false,
  transform(doc, ret) {
    ret.nextTokenAt = ret.nextTokenAt || new Date(new Date(ret.lastTokenAt).getTime() + WEEK_MS);
    ret.tokens = [...(ret.tokens || [])].sort((a, b) => new Date(b.issuedAt) - new Date(a.issuedAt));
    return ret;
  }
});

const Bike = mongoose.model('Bike', bikeSchema);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const parseDate = (value) => {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

const nextOf = (bike) => (bike.nextTokenAt || new Date(bike.lastTokenAt.getTime() + WEEK_MS)).getTime();
const minute = (d) => Math.floor(d.getTime() / 60000);

const cleanNumber = (value) => {
  const n = normalizeBike(value);
  return /^[A-Z0-9][A-Z0-9-]{1,19}$/.test(n) ? n : null;
};
const BAD_NUMBER = 'Enter the bike number using letters, digits and hyphens, e.g. 0786 or MNR-14-1038.';

// Latest token decides the current cycle.
const syncCurrent = (bike) => {
  const latest = [...bike.tokens].sort((a, b) => b.issuedAt - a.issuedAt)[0];
  if (latest) {
    bike.lastTokenAt = latest.issuedAt;
    bike.nextTokenAt = latest.expiresAt;
  }
};

class ApiError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra || {};
  }
}

const handler = (fn) => (req, res) =>
  fn(req, res).catch((err) => {
    if (err instanceof ApiError) return res.status(err.status).json({ error: err.message, ...err.extra });
    if (err.name === 'CastError') return res.status(404).json({ error: 'Bike not found.' });
    if (err.code === 11000) return res.status(409).json({ error: 'A bike with this number already exists.' });
    console.error(err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  });

const findBike = async (id) => {
  const bike = await Bike.findById(id);
  if (!bike) throw new ApiError(404, 'Bike not found.');
  return bike;
};

const describeBike = (b) => ({ id: String(b._id), number: b.number || b.name || '' });

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
app.get('/api/bikes', handler(async (req, res) => {
  const bikes = await Bike.find();
  bikes.sort((a, b) => nextOf(a) - nextOf(b));
  res.json(bikes);
}));

app.post('/api/bikes', handler(async (req, res) => {
  const { number, name, sim, lastTokenAt } = req.body || {};
  const at = parseDate(lastTokenAt);
  const num = cleanNumber(number);
  if (!num) throw new ApiError(400, BAD_NUMBER);
  if (!at) throw new ApiError(400, 'Last token time is required.');
  const bike = await Bike.create({
    number: num, name, sim, lastTokenAt: at,
    nextTokenAt: new Date(at.getTime() + WEEK_MS), pendingToken: true
  });
  res.status(201).json(bike);
}));

app.put('/api/bikes/:id', handler(async (req, res) => {
  const bike = await findBike(req.params.id);
  const { number, name, sim, lastTokenAt } = req.body || {};
  if (number !== undefined) {
    const num = cleanNumber(number);
    if (!num) throw new ApiError(400, BAD_NUMBER);
    bike.number = num;
  }
  if (name !== undefined) bike.name = name;
  if (sim !== undefined) bike.sim = sim;
  if (lastTokenAt) {
    const at = parseDate(lastTokenAt);
    if (!at) throw new ApiError(400, 'Invalid date.');
    if (minute(at) !== minute(bike.lastTokenAt)) {
      bike.lastTokenAt = at;
      bike.nextTokenAt = new Date(at.getTime() + WEEK_MS);
    }
  }
  await bike.save();
  res.json(bike);
}));

// "Token collected": starts the next 7-day cycle and waits for the token SMS.
app.post('/api/bikes/:id/token', handler(async (req, res) => {
  const bike = await findBike(req.params.id);
  const at = (req.body && parseDate(req.body.at)) || new Date();
  bike.lastTokenAt = at;
  bike.nextTokenAt = new Date(at.getTime() + WEEK_MS);
  bike.pendingToken = true;
  await bike.save();
  res.json(bike);
}));

// Preview what would be extracted from a pasted SMS (nothing is saved).
app.post('/api/parse', handler(async (req, res) => {
  const parsed = parseMessage(String((req.body && req.body.message) || '').slice(0, 1500));
  if (parsed.token) {
    const dup = await Bike.findOne({ 'tokens.token': parsed.token });
    if (dup) parsed.duplicateOf = describeBike(dup);
  }
  if (parsed.bikeKey) {
    const match = await Bike.findOne({ numberKey: parsed.bikeKey });
    if (match) parsed.match = describeBike(match);
  }
  res.json(parsed);
}));

// Add the pasted SMS to a bike. The system extracts everything from the text.
app.post('/api/bikes/:id/tokens', handler(async (req, res) => {
  const bike = await findBike(req.params.id);
  const message = String((req.body && req.body.message) || '').slice(0, 1500);
  const parsed = parseMessage(message);
  if (!parsed.ok) {
    const what = parsed.missing.map((m) => (m === 'token' ? 'token number' : 'bike number')).join(' and ');
    throw new ApiError(400, `Could not find the ${what} in this message.`, { parsed });
  }
  const dup = await Bike.findOne({ 'tokens.token': parsed.token });
  if (dup) {
    throw new ApiError(409, `Token ${parsed.token} is already saved for ${dup.number || dup.name}.`, { code: 'DUPLICATE' });
  }
  if (bike.numberKey && parsed.bikeKey !== bike.numberKey && !(req.body && req.body.force)) {
    throw new ApiError(409, `This message is for ${parsed.bikeNumber}, not ${bike.number}.`, { code: 'BIKE_MISMATCH', parsed });
  }
  if (!bike.number) bike.number = parsed.bikeNumber;

  const newest = bike.tokens.reduce((max, t) => Math.max(max, t.issuedAt.getTime()), 0);
  bike.tokens.push({
    token: parsed.token,
    bikeNumber: parsed.bikeNumber,
    issuedAt: new Date(parsed.issuedAt),
    expiresAt: new Date(parsed.expiresAt),
    amount: parsed.amount,
    kind: parsed.kind,
    raw: message
  });
  // An older message only goes into history; a newer one starts the current cycle.
  if (parsed.issuedAt >= newest) {
    syncCurrent(bike);
    bike.pendingToken = false;
  }
  await bike.save();
  res.status(201).json(bike);
}));

app.delete('/api/bikes/:id/tokens/:tokenId', handler(async (req, res) => {
  const bike = await findBike(req.params.id);
  const entry = bike.tokens.id(req.params.tokenId);
  if (!entry) throw new ApiError(404, 'Token not found.');
  entry.deleteOne();
  if (bike.tokens.length) syncCurrent(bike);
  else bike.pendingToken = true;
  await bike.save();
  res.json(bike);
}));

app.delete('/api/bikes/:id', handler(async (req, res) => {
  await Bike.findByIdAndDelete(req.params.id);
  res.json({ ok: true });
}));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/fuel-token-tracker';

mongoose
  .connect(MONGODB_URI)
  .then(() => app.listen(PORT, () => console.log(`Fuel Token Tracker listening on port ${PORT}`)))
  .catch((err) => {
    console.error('MongoDB connection failed:', err.message);
    process.exit(1);
  });
