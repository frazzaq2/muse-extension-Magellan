'use strict';
/**
 * Castify backend server.
 *
 * Sync target for the Castify Chrome extension + admin dashboard.
 * Stack: Express + better-sqlite3 (single file DB) + JWT auth.
 *
 * Env:
 *   PORT        http port (default 3001)
 *   JWT_SECRET  secret used to sign tokens (REQUIRED in production)
 *   DB_PATH     sqlite file path (default ./data/castify.db)
 */

const path = require('path');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');

// ---------------------------------------------------------------- config

const PORT = parseInt(process.env.PORT || '3001', 10);
const JWT_SECRET = process.env.JWT_SECRET || '';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'castify.db');
const TOKEN_TTL = '12h';

if (!JWT_SECRET || JWT_SECRET === 'changeme') {
  console.warn('⚠  WARNING: JWT_SECRET is not set (or is the default). Set a strong random secret in .env before production use.');
}
const SECRET = JWT_SECRET || 'castify-dev-secret-do-not-use-in-prod';

// ---------------------------------------------------------------- database

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    name          TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
    created_at    TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS claims (
    id              INTEGER PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES users(id),
    ext_id          TEXT NOT NULL,          -- extension claim id, unique per user
    patient         TEXT,
    mrn             TEXT,
    payer           TEXT,
    member_id       TEXT,
    center          TEXT,
    service_date    TEXT,
    cpt             TEXT,
    units           INTEGER,
    charges         REAL,
    status          TEXT NOT NULL DEFAULT 'ready'
                      CHECK (status IN ('billed','unbilled','ready')),
    tcn             TEXT,                   -- Availity transaction id (billed)
    unbilled_reason TEXT,                   -- (unbilled)
    unbilled_step   TEXT,                    -- (unbilled)
    note            TEXT,
    synced_at       TEXT NOT NULL,
    UNIQUE (user_id, ext_id)
  );
  CREATE INDEX IF NOT EXISTS idx_claims_user_status ON claims(user_id, status);
  CREATE INDEX IF NOT EXISTS idx_claims_synced      ON claims(synced_at);
`);

// First-run: seed a default admin so the dashboard is reachable.
if (db.prepare('SELECT COUNT(*) AS c FROM users').get().c === 0) {
  const hash = bcrypt.hashSync('changeme123', 10);
  db.prepare(
    'INSERT INTO users (email, password_hash, name, role, created_at) VALUES (?,?,?,?,?)'
  ).run('admin@castify.local', hash, 'Administrator', 'admin', new Date().toISOString());
  console.log('\n' + '='.repeat(72));
  console.log('!!! FIRST RUN: default admin account created');
  console.log('!!!   email:    admin@castify.local');
  console.log('!!!   password: changeme123');
  console.log('!!! CHANGE THIS PASSWORD IMMEDIATELY after first login (Users tab).');
  console.log('='.repeat(72) + '\n');
}

// ---------------------------------------------------------------- app

const app = express();
app.use(helmet({ contentSecurityPolicy: false })); // CSP off: single-file SPA w/ inline handlers is fine on LAN/VPS
app.use(cors());                                    // extension calls this API cross-origin
app.use(express.json({ limit: '5mb' }));

const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, try again in a minute.' },
});

// ---- auth middleware

function authRequired(req, res, next) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  if (!m) return res.status(401).json({ error: 'Missing Bearer token' });
  try {
    const p = jwt.verify(m[1], SECRET);
    req.user = { id: p.uid, email: p.email, role: p.role };
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function adminRequired(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role });

// ---- auth routes

app.post('/api/auth/login', loginLimiter, (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  const user = db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE')
    .get(String(email).trim());
  if (!user || !bcrypt.compareSync(String(password), user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  const token = jwt.sign({ uid: user.id, email: user.email, role: user.role }, SECRET, { expiresIn: TOKEN_TTL });
  res.json({ token, user: publicUser(user) });
});

// ---- admin: user management

app.post('/api/admin/users', authRequired, adminRequired, (req, res) => {
  const { email, password, name, role } = req.body || {};
  if (!email || !/^\S+@\S+\.\S+$/.test(String(email))) return res.status(400).json({ error: 'Valid email required' });
  if (!password || String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name required' });
  if (!['admin', 'user'].includes(role)) return res.status(400).json({ error: "role must be 'admin' or 'user'" });
  try {
    const info = db.prepare(
      'INSERT INTO users (email, password_hash, name, role, created_at) VALUES (?,?,?,?,?)'
    ).run(String(email).trim().toLowerCase(), bcrypt.hashSync(String(password), 10), String(name).trim(), role, new Date().toISOString());
    const u = db.prepare('SELECT id, email, name, role, created_at FROM users WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json(u);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'Email already exists' });
    throw e;
  }
});

app.get('/api/admin/users', authRequired, adminRequired, (req, res) => {
  const rows = db.prepare(
    `SELECT u.id, u.email, u.name, u.role, u.created_at,
            (SELECT COUNT(*) FROM claims c WHERE c.user_id = u.id) AS claim_count
     FROM users u ORDER BY u.id`
  ).all();
  res.json(rows); // never returns password_hash
});

app.delete('/api/admin/users/:id', authRequired, adminRequired, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account' });
  const target = db.prepare('SELECT id FROM users WHERE id = ?').get(id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  db.transaction(() => {
    db.prepare('DELETE FROM claims WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
  })();
  res.json({ ok: true });
});

// ---- claims: batch upsert (idempotent on user_id + ext_id)

const STATUS_RANK = { ready: 1, unbilled: 2, billed: 3 };

// Map one extension item onto the claims row shape.
function mapItem(src, status, userId, now) {
  return {
    user_id: userId,
    ext_id: String(src.claimId || src.id || ''),
    patient: src.patient || null,
    mrn: src.mrn || null,
    payer: src.payer || null,
    member_id: src.memberId || src.member_id || null,
    center: src.center || null,
    service_date: src.serviceDate || src.service_date || null,
    cpt: src.cpt || null,
    units: src.units != null && src.units !== '' ? Number(src.units) : null,
    charges: src.charges != null && src.charges !== '' ? Number(src.charges) : null,
    status,
    // outcome fields only travel with their own status so a later lower-status
    // sync can never wipe a recorded TCN or unbilled reason:
    tcn: status === 'billed' ? (src.tcn || null) : null,
    unbilled_reason: status === 'unbilled' ? (src.reason || src.unbilled_reason || null) : null,
    unbilled_step: status === 'unbilled' ? (src.step || src.unbilled_step || null) : null,
    note: status === 'billed' ? (src.note || null) : null,
    synced_at: now,
  };
}

const selClaim = db.prepare('SELECT status FROM claims WHERE user_id = ? AND ext_id = ?');
const insClaim = db.prepare(`INSERT INTO claims
  (user_id, ext_id, patient, mrn, payer, member_id, center, service_date, cpt, units,
   charges, status, tcn, unbilled_reason, unbilled_step, note, synced_at)
  VALUES (@user_id, @ext_id, @patient, @mrn, @payer, @member_id, @center, @service_date,
          @cpt, @units, @charges, @status, @tcn, @unbilled_reason, @unbilled_step, @note, @synced_at)`);
const updClaim = db.prepare(`UPDATE claims SET
  patient=@patient, mrn=@mrn, payer=@payer, member_id=@member_id, center=@center,
  service_date=@service_date, cpt=@cpt, units=@units, charges=@charges, status=@status,
  tcn=@tcn, unbilled_reason=@unbilled_reason, unbilled_step=@unbilled_step,
  note=@note, synced_at=@synced_at
  WHERE user_id=@user_id AND ext_id=@ext_id`);

const upsertBatch = db.transaction((rows) => {
  let n = 0;
  for (const r of rows) {
    if (!r.ext_id) continue;
    const existing = selClaim.get(r.user_id, r.ext_id);
    if (!existing) {
      insClaim.run(r); n++;
    } else if (STATUS_RANK[r.status] >= STATUS_RANK[existing.status]) {
      // Never downgrade a finalized outcome (billed/unbilled) back to 'ready'.
      updClaim.run(r); n++;
    }
  }
  return n;
});

app.post('/api/claims/batch', authRequired, (req, res) => {
  const { billed = [], unbilled = [], claims = [] } = req.body || {};
  if (!Array.isArray(billed) || !Array.isArray(unbilled) || !Array.isArray(claims)) {
    return res.status(400).json({ error: 'billed, unbilled and claims must be arrays' });
  }
  const now = new Date().toISOString();
  const seen = new Set();
  const rows = [];
  // Precedence: explicit outcomes (billed/unbilled) beat the raw queue snapshot.
  for (const [arr, status] of [[billed, 'billed'], [unbilled, 'unbilled'], [claims, 'ready']]) {
    for (const item of arr) {
      const key = String(item.claimId || item.id || '');
      if (!key || seen.has(key)) continue;
      seen.add(key);
      rows.push(mapItem(item, item.status && STATUS_RANK[item.status] ? item.status : status, req.user.id, now));
    }
  }
  const upserted = upsertBatch(rows);
  res.json({ ok: true, received: rows.length, upserted });
});

// ---- claims: summary stats

function scopeClause(req) {
  // Admins see everyone; normal users only their own rows.
  return req.user.role === 'admin' ? { sql: '', params: [] } : { sql: 'AND user_id = ?', params: [req.user.id] };
}

app.get('/api/claims/summary', authRequired, (req, res) => {
  const days = Math.min(365, Math.max(1, parseInt(req.query.days || '30', 10) || 30));
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const scope = scopeClause(req);

  const totals = db.prepare(`
    SELECT
      SUM(CASE WHEN status='billed'   THEN 1 ELSE 0 END) AS billedCount,
      SUM(CASE WHEN status='unbilled' THEN 1 ELSE 0 END) AS unbilledCount,
      SUM(CASE WHEN status='billed'   THEN COALESCE(charges,0) ELSE 0 END) AS billedCharges,
      SUM(CASE WHEN status='unbilled' THEN COALESCE(charges,0) ELSE 0 END) AS unbilledCharges
    FROM claims WHERE synced_at >= ? ${scope.sql}`).get(since, ...scope.params);

  const breakdown = (col) => db.prepare(`
    SELECT COALESCE(NULLIF(${col},''), '(unknown)') AS k,
           COUNT(*) AS n,
           ROUND(COALESCE(SUM(charges),0), 2) AS charges
    FROM claims WHERE synced_at >= ? ${scope.sql}
    GROUP BY k ORDER BY n DESC`).all(since, ...scope.params);

  res.json({
    days,
    billedCount: totals.billedCount || 0,
    unbilledCount: totals.unbilledCount || 0,
    billedCharges: Math.round((totals.billedCharges || 0) * 100) / 100,
    unbilledCharges: Math.round((totals.unbilledCharges || 0) * 100) / 100,
    byCenter: breakdown('center'),
    byPayer: breakdown('payer'),
    byCpt: breakdown('cpt'),
  });
});

// ---- claims: paginated list with filters

app.get('/api/claims', authRequired, (req, res) => {
  const { status, payer, center, q } = req.query;
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || '50', 10) || 50));
  const offset = Math.max(0, parseInt(req.query.offset || '0', 10) || 0);
  const where = [];
  const params = [];
  const scope = scopeClause(req);
  if (scope.sql) { where.push('1=1 ' + scope.sql); params.push(...scope.params); }
  if (status && ['billed', 'unbilled', 'ready'].includes(status)) { where.push('status = ?'); params.push(status); }
  if (payer) { where.push('payer = ?'); params.push(payer); }
  if (center) { where.push('center = ?'); params.push(center); }
  if (q) {
    where.push('(patient LIKE ? OR mrn LIKE ? OR member_id LIKE ? OR tcn LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) AS c FROM claims ${whereSql}`).get(...params).c;
  const items = db.prepare(
    `SELECT * FROM claims ${whereSql} ORDER BY synced_at DESC, id DESC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);
  res.json({ items, total, limit, offset });
});

// ---- health + dashboard

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ---- boot

app.listen(PORT, () => {
  console.log(`Castify server listening on http://localhost:${PORT}`);
  console.log(`DB: ${DB_PATH}`);
});
