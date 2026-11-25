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

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------
const bikeSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 60 },
    sim: { type: String, trim: true, maxlength: 20, default: '' },
    lastTokenAt: { type: Date, required: true },
    history: { type: [Date], default: [] }
  },
  { timestamps: true }
);

bikeSchema.virtual('nextTokenAt').get(function nextTokenAt() {
  return new Date(this.lastTokenAt.getTime() + WEEK_MS);
});
bikeSchema.set('toJSON', { virtuals: true, versionKey: false });

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
    if (err.name === 'CastError') return res.status(404).json({ error: 'Bike not found.' });
    console.error(err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  });

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
app.get('/api/bikes', handler(async (req, res) => {
  const bikes = await Bike.find();
  bikes.sort((a, b) => a.nextTokenAt - b.nextTokenAt);
  res.json(bikes);
}));

app.post('/api/bikes', handler(async (req, res) => {
  const { name, sim, lastTokenAt } = req.body || {};
  const at = parseDate(lastTokenAt);
  if (!name || !at) {
    return res.status(400).json({ error: 'Bike name and last token time are required.' });
  }
  const bike = await Bike.create({ name, sim, lastTokenAt: at, history: [at] });
  return res.status(201).json(bike);
}));

app.put('/api/bikes/:id', handler(async (req, res) => {
  const bike = await Bike.findById(req.params.id);
  if (!bike) return res.status(404).json({ error: 'Bike not found.' });
  const { name, sim, lastTokenAt } = req.body || {};
  if (name) bike.name = name;
  if (sim !== undefined) bike.sim = sim;
  if (lastTokenAt) {
    const at = parseDate(lastTokenAt);
    if (!at) return res.status(400).json({ error: 'Invalid date.' });
    bike.lastTokenAt = at;
  }
  await bike.save();
  return res.json(bike);
}));

// "Token collected": records it and starts the next 7-day cycle.
app.post('/api/bikes/:id/token', handler(async (req, res) => {
  const bike = await Bike.findById(req.params.id);
  if (!bike) return res.status(404).json({ error: 'Bike not found.' });
  const at = (req.body && parseDate(req.body.at)) || new Date();
  bike.lastTokenAt = at;
  bike.history = [at, ...bike.history].slice(0, 30);
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
