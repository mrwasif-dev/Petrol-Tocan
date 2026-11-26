'use strict';

require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const mongoose = require('mongoose');

const app = express();
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

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

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin'
  });
  next();
});

app.use(express.json({ limit: '20kb' }));

// Only the single front-end file is served, so server files are never exposed.
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------
const normalizeKey = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

const tokenSchema = new mongoose.Schema({
  tokenNumber: { type: String, required: true, trim: true, maxlength: 40 },
  bikeNumber: { type: String, trim: true, maxlength: 20, default: '' },
  message: { type: String, maxlength: 2000, default: '' },
  cycleAt: { type: Date },
  addedAt: { type: Date, default: Date.now }
});

const bikeSchema = new mongoose.Schema(
  {
    bikeNumber: { type: String, required: true, trim: true, uppercase: true, maxlength: 20 },
    bikeKey: { type: String, unique: true, index: true },
    simNumber: { type: String, trim: true, maxlength: 20, default: '' },
    simName: { type: String, trim: true, maxlength: 60, default: '' },
    lastTokenAt: { type: Date, required: true },
    tokenPending: { type: Boolean, default: false },
    history: { type: [Date], default: [] },
    tokens: { type: [tokenSchema], default: [] }
  },
  { timestamps: true }
);

bikeSchema.pre('validate', function setKey(next) {
  this.bikeKey = normalizeKey(this.bikeNumber);
  next();
});

bikeSchema.virtual('nextTokenAt').get(function nextTokenAt() {
  return new Date(this.lastTokenAt.getTime() + WEEK_MS);
});
bikeSchema.set('toJSON', { virtuals: true, versionKey: false, id: false });

const Bike = mongoose.model('Bike', bikeSchema);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const parseDate = (value) => {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

const handler = (fn) => (req, res) =>
  fn(req, res).catch((err) => {
    if (err.name === 'CastError') return res.status(404).json({ error: 'Not found.' });
    if (err.code === 11000) return res.status(409).json({ error: 'A bike with this number already exists.' });
    if (err.name === 'ValidationError') return res.status(400).json({ error: 'Please check the entered details.' });
    console.error(err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  });

const findBike = async (req, res) => {
  const bike = await Bike.findById(req.params.id);
  if (!bike) res.status(404).json({ error: 'Bike not found.' });
  return bike;
};

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
app.get('/api/bikes', handler(async (req, res) => {
  const bikes = await Bike.find();
  bikes.sort((a, b) => a.nextTokenAt - b.nextTokenAt);
  res.json(bikes);
}));

app.post('/api/bikes', handler(async (req, res) => {
  const { bikeNumber, simNumber, simName, lastTokenAt } = req.body || {};
  const at = parseDate(lastTokenAt);
  if (!bikeNumber || !normalizeKey(bikeNumber) || !at) {
    return res.status(400).json({ error: 'Bike number and last token time are required.' });
  }
  const bike = await Bike.create({ bikeNumber, simNumber, simName, lastTokenAt: at, history: [at] });
  return res.status(201).json(bike);
}));

app.put('/api/bikes/:id', handler(async (req, res) => {
  const bike = await findBike(req, res);
  if (!bike) return undefined;
  const { bikeNumber, simNumber, simName, lastTokenAt } = req.body || {};
  if (bikeNumber) bike.bikeNumber = bikeNumber;
  if (simNumber !== undefined) bike.simNumber = simNumber;
  if (simName !== undefined) bike.simName = simName;
  if (lastTokenAt) {
    const at = parseDate(lastTokenAt);
    if (!at) return res.status(400).json({ error: 'Invalid date.' });
    bike.lastTokenAt = at;
  }
  await bike.save();
  return res.json(bike);
}));

// "Token collected": starts the next 7-day cycle and flags that the token message is still to be added.
app.post('/api/bikes/:id/collect', handler(async (req, res) => {
  const bike = await findBike(req, res);
  if (!bike) return undefined;
  const at = (req.body && parseDate(req.body.at)) || new Date();
  bike.lastTokenAt = at;
  bike.tokenPending = true;
  bike.history = [at, ...bike.history].slice(0, 60);
  await bike.save();
  return res.json(bike);
}));

// Save the token details extracted from the pasted message.
app.post('/api/bikes/:id/tokens', handler(async (req, res) => {
  const bike = await findBike(req, res);
  if (!bike) return undefined;
  const { tokenNumber, bikeNumber, message } = req.body || {};
  const number = String(tokenNumber || '').trim();
  if (!number) return res.status(400).json({ error: 'Token number is required.' });
  if (bike.tokens.some((t) => t.tokenNumber.toUpperCase() === number.toUpperCase())) {
    return res.status(409).json({ error: 'This token number is already saved for this bike.' });
  }
  bike.tokens.unshift({
    tokenNumber: number,
    bikeNumber: String(bikeNumber || '').trim().toUpperCase(),
    message: String(message || '').slice(0, 2000),
    cycleAt: bike.lastTokenAt
  });
  bike.tokens = bike.tokens.slice(0, 60);
  bike.tokenPending = false;
  await bike.save();
  return res.status(201).json(bike);
}));

app.delete('/api/bikes/:id/tokens/:tokenId', handler(async (req, res) => {
  const bike = await findBike(req, res);
  if (!bike) return undefined;
  bike.tokens = bike.tokens.filter((t) => String(t._id) !== req.params.tokenId);
  await bike.save();
  return res.json(bike);
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
