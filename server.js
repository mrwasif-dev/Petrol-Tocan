'use strict';

require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const mongoose = require('mongoose');
const { parseMessage, normalizeBike, bikeKey, WEEK_MS } = require('./parser');
const auth = require('./auth');

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1);

const COOKIE = 'ftt_session';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

let SECRET = process.env.SESSION_SECRET;
if (!SECRET) {
  SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('SESSION_SECRET is not set. Everyone will be signed out whenever the app restarts. Set it in the config vars.');
}

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

// Public files: the page itself holds no data, the API below is what needs a sign-in.
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// Install-as-app files (web app manifest, service worker, icons). Fixed list, nothing else is exposed.
const ASSETS = {
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/sw.js': ['sw.js', 'text/javascript'],
  '/icon-192.png': ['icon-192.png', 'image/png'],
  '/icon-512.png': ['icon-512.png', 'image/png'],
  '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png']
};
Object.entries(ASSETS).forEach(([route, [file, type]]) => {
  app.get(route, (req, res) => {
    res.type(type);
    if (route === '/sw.js') res.set('Cache-Control', 'no-cache');
    res.sendFile(path.join(__dirname, file));
  });
});

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------
const userSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 30 },
    name: { type: String, trim: true, maxlength: 60, default: '' },
    passwordHash: { type: String, required: true },
    // Hash of the APP_PASSWORD that last set this account's password (admin from config vars only).
    envPasswordHash: { type: String, default: '' },
    role: { type: String, enum: ['admin', 'user'], default: 'user' },
    disabled: { type: Boolean, default: false }
  },
  { timestamps: true }
);
const User = mongoose.model('User', userSchema);

const tokenSchema = new mongoose.Schema({
  token: { type: String, required: true, trim: true },
  bikeNumber: { type: String, default: '' },
  issuedAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true },
  amount: { type: Number, default: null },
  // Set when the fuel for this token has been taken at the pump.
  fuelCollectedAt: { type: Date, default: null },
  kind: { type: String, enum: ['issued', 'relief', 'unknown'], default: 'unknown' },
  raw: { type: String, maxlength: 1500, default: '' },
  addedAt: { type: Date, default: Date.now }
});

const bikeSchema = new mongoose.Schema(
  {
    // Which user this bike belongs to. Admins can see every bike.
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
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
    if (ret.owner) ret.owner = String(ret.owner);
    return ret;
  }
});

const Bike = mongoose.model('Bike', bikeSchema);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
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
    if (err.name === 'CastError') return res.status(404).json({ error: 'Not found.' });
    if (err.code === 11000) {
      const taken = err.keyPattern && err.keyPattern.username ? 'That username is already taken.' : 'A bike with this number already exists.';
      return res.status(409).json({ error: taken });
    }
    console.error(err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  });

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

const isAdmin = (req) => req.user.role === 'admin';
// Regular users only ever touch their own bikes; admins touch all.
const scopeOf = (req) => (isAdmin(req) ? {} : { owner: req.user._id });
const canSee = (req, bike) => isAdmin(req) || String(bike.owner) === String(req.user._id);

const findBike = async (req, id) => {
  const bike = await Bike.findOne({ _id: id, ...scopeOf(req) });
  if (!bike) throw new ApiError(404, 'Bike not found.');
  return bike;
};

const describeBike = (req, b) => ({ id: String(b._id), number: canSee(req, b) ? b.number || b.name || '' : 'another account' });

const publicUser = (u) => ({ id: String(u._id), username: u.username, name: u.name || u.username, role: u.role });

const setSession = (req, res, user) => {
  const token = auth.createSession(String(user._id), auth.passwordVersion(user.passwordHash), SECRET, SESSION_MS);
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: SESSION_MS, path: '/' });
};

const USERNAME_RE = /^[a-z0-9._-]{3,30}$/;
const checkPassword = (pw) => {
  if (typeof pw !== 'string' || pw.length < 6 || pw.length > 100) {
    throw new ApiError(400, 'Password must be 6 to 100 characters.');
  }
};

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------
const limiter = auth.createLimiter({ max: 6, windowMs: 15 * 60 * 1000 });
let dummyHash;

app.use('/api', async (req, res, next) => {
  try {
    const token = auth.parseCookies(req.headers.cookie)[COOKIE];
    const uid = auth.sessionUserId(token);
    if (uid && mongoose.isValidObjectId(uid)) {
      const user = await User.findById(uid);
      if (user && !user.disabled && auth.verifySession(token, SECRET, auth.passwordVersion(user.passwordHash))) {
        req.user = user;
      }
    }
  } catch (err) {
    console.error(err);
  }
  next();
});

app.post('/api/login', handler(async (req, res) => {
  const username = String((req.body && req.body.username) || '').trim().toLowerCase();
  const password = String((req.body && req.body.password) || '');
  const key = `${req.ip}|${username}`;
  if (limiter.blocked(key)) throw new ApiError(429, 'Too many attempts. Wait a few minutes and try again.');
  const user = username ? await User.findOne({ username }) : null;
  if (!dummyHash) dummyHash = await auth.hashPassword('not-a-real-password');
  const ok = await auth.verifyPassword(password, user ? user.passwordHash : dummyHash);
  if (!user || !ok) {
    limiter.hit(key);
    throw new ApiError(401, 'Wrong username or password.');
  }
  if (user.disabled) throw new ApiError(403, 'This account is turned off. Ask the admin.');
  limiter.reset(key);
  setSession(req, res, user);
  res.json(publicUser(user));
}));

app.post('/api/logout', (req, res) => {
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Please sign in.' });
  return res.json(publicUser(req.user));
});

// Everything below needs a signed-in user.
app.use('/api', (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Please sign in.' });
  return next();
});

const requireAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only the admin can do this.' });
  return next();
};

app.put('/api/me/password', handler(async (req, res) => {
  const { current, next } = req.body || {};
  if (!(await auth.verifyPassword(String(current || ''), req.user.passwordHash))) {
    throw new ApiError(400, 'Your current password is not correct.');
  }
  checkPassword(next);
  req.user.passwordHash = await auth.hashPassword(next);
  await req.user.save();
  setSession(req, res, req.user); // other devices are signed out, this one stays signed in
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Users (admin only)
// ---------------------------------------------------------------------------
app.get('/api/users', requireAdmin, handler(async (req, res) => {
  const [users, counts] = await Promise.all([
    User.find().sort({ createdAt: 1 }),
    Bike.aggregate([{ $group: { _id: '$owner', n: { $sum: 1 } } }])
  ]);
  const byOwner = new Map(counts.map((c) => [String(c._id), c.n]));
  res.json(users.map((u) => ({ ...publicUser(u), disabled: u.disabled, bikes: byOwner.get(String(u._id)) || 0 })));
}));

app.post('/api/users', requireAdmin, handler(async (req, res) => {
  const { username, name, password, role } = req.body || {};
  const uname = String(username || '').trim().toLowerCase();
  if (!USERNAME_RE.test(uname)) {
    throw new ApiError(400, 'Username needs 3 to 30 letters, digits, dots, dashes or underscores.');
  }
  checkPassword(password);
  const user = await User.create({
    username: uname,
    name: String(name || '').slice(0, 60),
    passwordHash: await auth.hashPassword(password),
    role: role === 'admin' ? 'admin' : 'user'
  });
  res.status(201).json({ ...publicUser(user), disabled: false, bikes: 0 });
}));

app.put('/api/users/:id', requireAdmin, handler(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) throw new ApiError(404, 'User not found.');
  const { name, password, role, disabled } = req.body || {};
  const self = String(user._id) === String(req.user._id);
  if (self && ((role !== undefined && role !== 'admin') || disabled)) {
    throw new ApiError(400, 'You cannot turn off or demote your own account.');
  }
  if (name !== undefined) user.name = String(name).slice(0, 60);
  if (role !== undefined) user.role = role === 'admin' ? 'admin' : 'user';
  if (disabled !== undefined) user.disabled = !!disabled;
  if (password !== undefined && password !== '') {
    checkPassword(password);
    user.passwordHash = await auth.hashPassword(password);
  }
  await user.save();
  res.json(publicUser(user));
}));

app.delete('/api/users/:id', requireAdmin, handler(async (req, res) => {
  if (String(req.params.id) === String(req.user._id)) throw new ApiError(400, 'You cannot delete your own account.');
  const owned = await Bike.countDocuments({ owner: req.params.id });
  if (owned) {
    throw new ApiError(409, `This user still has ${owned} bike${owned === 1 ? '' : 's'}. Delete them first, or turn the account off instead.`);
  }
  await User.findByIdAndDelete(req.params.id);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Bikes
// ---------------------------------------------------------------------------
const ownerFromBody = async (req, value) => {
  if (!isAdmin(req) || !value) return req.user._id;
  const owner = await User.findById(value);
  if (!owner) throw new ApiError(400, 'That user does not exist.');
  return owner._id;
};

app.get('/api/bikes', handler(async (req, res) => {
  const bikes = await Bike.find(scopeOf(req));
  bikes.sort((a, b) => nextOf(a) - nextOf(b));
  if (!isAdmin(req)) return res.json(bikes);
  const users = await User.find();
  const names = new Map(users.map((u) => [String(u._id), u.name || u.username]));
  return res.json(bikes.map((b) => ({ ...b.toJSON(), ownerName: names.get(String(b.owner)) || '' })));
}));

app.post('/api/bikes', handler(async (req, res) => {
  const { number, name, sim, lastTokenAt, owner } = req.body || {};
  const at = parseDate(lastTokenAt);
  const num = cleanNumber(number);
  if (!num) throw new ApiError(400, BAD_NUMBER);
  if (!at) throw new ApiError(400, 'Last token time is required.');
  const bike = await Bike.create({
    owner: await ownerFromBody(req, owner),
    number: num, name, sim, lastTokenAt: at,
    nextTokenAt: new Date(at.getTime() + WEEK_MS), pendingToken: true
  });
  res.status(201).json(bike);
}));

app.put('/api/bikes/:id', handler(async (req, res) => {
  const bike = await findBike(req, req.params.id);
  const { number, name, sim, lastTokenAt, owner } = req.body || {};
  if (number !== undefined) {
    const num = cleanNumber(number);
    if (!num) throw new ApiError(400, BAD_NUMBER);
    bike.number = num;
  }
  if (name !== undefined) bike.name = name;
  if (sim !== undefined) bike.sim = sim;
  if (isAdmin(req) && owner) bike.owner = await ownerFromBody(req, owner);
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
  const bike = await findBike(req, req.params.id);
  const at = (req.body && parseDate(req.body.at)) || new Date();
  bike.lastTokenAt = at;
  bike.nextTokenAt = new Date(at.getTime() + WEEK_MS);
  bike.pendingToken = true;
  await bike.save();
  res.json(bike);
}));

// "Fuel collected": marks the current token's fuel as taken (collected:false undoes it).
app.post('/api/bikes/:id/fuel', handler(async (req, res) => {
  const bike = await findBike(req, req.params.id);
  const latest = [...bike.tokens].sort((a, b) => b.issuedAt - a.issuedAt)[0];
  if (bike.pendingToken || !latest) throw new ApiError(400, 'Add the token message first.');
  const collected = !(req.body && req.body.collected === false);
  latest.fuelCollectedAt = collected ? (req.body && parseDate(req.body.at)) || new Date() : null;
  await bike.save();
  res.json(bike);
}));

// Preview what would be extracted from a pasted SMS (nothing is saved).
app.post('/api/parse', handler(async (req, res) => {
  const parsed = parseMessage(String((req.body && req.body.message) || '').slice(0, 1500));
  if (parsed.token) {
    const dup = await Bike.findOne({ 'tokens.token': parsed.token });
    if (dup) parsed.duplicateOf = describeBike(req, dup);
  }
  if (parsed.bikeKey) {
    const match = await Bike.findOne({ numberKey: parsed.bikeKey, ...scopeOf(req) });
    if (match) parsed.match = describeBike(req, match);
  }
  res.json(parsed);
}));

// Add the pasted SMS to a bike. The system extracts everything from the text.
app.post('/api/bikes/:id/tokens', handler(async (req, res) => {
  const bike = await findBike(req, req.params.id);
  const message = String((req.body && req.body.message) || '').slice(0, 1500);
  const parsed = parseMessage(message);
  if (!parsed.ok) {
    const what = parsed.missing.map((m) => (m === 'token' ? 'token number' : 'bike number')).join(' and ');
    throw new ApiError(400, `Could not find the ${what} in this message.`, { parsed });
  }
  const dup = await Bike.findOne({ 'tokens.token': parsed.token });
  if (dup) {
    throw new ApiError(409, `Token ${parsed.token} is already saved for ${describeBike(req, dup).number}.`, { code: 'DUPLICATE' });
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
  const bike = await findBike(req, req.params.id);
  const entry = bike.tokens.id(req.params.tokenId);
  if (!entry) throw new ApiError(404, 'Token not found.');
  entry.deleteOne();
  if (bike.tokens.length) syncCurrent(bike);
  else bike.pendingToken = true;
  await bike.save();
  res.json(bike);
}));

app.delete('/api/bikes/:id', handler(async (req, res) => {
  await Bike.findOneAndDelete({ _id: req.params.id, ...scopeOf(req) });
  res.json({ ok: true });
}));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/fuel-token-tracker';

// The admin account follows the APP_USER / APP_PASSWORD config vars:
//  - no such user yet: it is created (as admin);
//  - the user exists but APP_PASSWORD changed since it was last applied: the
//    password is reset to the new value and the account is turned on as admin.
// A password changed inside the app stays until APP_PASSWORD is changed again.
// Bikes saved before accounts existed are handed to an admin.
async function bootstrap() {
  const password = process.env.APP_PASSWORD;
  const username = String(process.env.APP_USER || 'admin').trim().toLowerCase();
  let admin = null;

  if (password) {
    let user = await User.findOne({ username });
    if (!user) {
      user = await User.create({
        username,
        name: 'Admin',
        role: 'admin',
        passwordHash: await auth.hashPassword(password),
        envPasswordHash: await auth.hashPassword(password)
      });
      console.log(`Admin created: ${username}`);
    } else if (!(await auth.verifyPassword(password, user.envPasswordHash))) {
      user.passwordHash = await auth.hashPassword(password);
      user.envPasswordHash = await auth.hashPassword(password);
      user.role = 'admin';
      user.disabled = false;
      await user.save();
      console.log(`Admin "${username}" updated from APP_PASSWORD (password reset).`);
    }
    admin = user;
  } else if (!(await User.countDocuments())) {
    console.warn('There are no users yet. Set APP_PASSWORD (and APP_USER) and restart to create the first admin.');
  }

  if (!admin) admin = await User.findOne({ role: 'admin', disabled: false }).sort({ createdAt: 1 });
  if (admin) await Bike.updateMany({ owner: null }, { $set: { owner: admin._id } });
}

mongoose
  .connect(MONGODB_URI)
  .then(bootstrap)
  .then(() => app.listen(PORT, () => console.log(`Fuel Token Tracker listening on port ${PORT}`)))
  .catch((err) => {
    console.error('Startup failed:', err.message);
    process.exit(1);
  });
