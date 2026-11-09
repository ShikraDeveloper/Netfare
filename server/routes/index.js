'use strict';

const router = require('express').Router();
const db = require('../db');
const auth = require('../services/auth');
const { runWithUser } = require('../request-context');
const { refusal } = require('../permissions');
const { CHANGED_BY_TABLES, markChanged } = require('../created-by');
const { router: authRouter, readToken } = require('./auth');

router.get('/health', (req, res) => {
  let database = 'ok';
  try {
    db.prepare('SELECT 1').get();
  } catch {
    database = 'error';
  }
  res.status(database === 'ok' ? 200 : 503).json({
    ok: database === 'ok',
    app: 'Netfare',
    version: require('../../package.json').version,
    database,
    uptime_seconds: Math.round(process.uptime()),
  });
});

router.use('/auth', authRouter);

// Everything below needs a signed-in user. A user given a one-time password
// must change it before anything else.
router.use((req, res, next) => {
  const user = auth.userForToken(db, readToken(req));
  if (!user) return res.status(401).json({ error: 'Sign in to continue', code: 'auth_required' });
  if (user.must_change_password) {
    return res.status(403).json({ error: 'Change your password to continue', code: 'password_change_required' });
  }
  const refused = refusal(db, user, req);
  if (refused) return res.status(403).json({ error: refused, code: 'no_right' });
  req.user = user;
  return runWithUser(user, next);
});

// A record saved from its form remembers who saved it and when. The stamp is
// written just before the reply goes out, so the reply already carries it.
router.put('/:kind/:id', (req, res, next) => {
  const table = CHANGED_BY_TABLES[req.params.kind];
  if (!table || !/^\d+$/.test(req.params.id)) return next();
  const reply = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode < 400) {
      markChanged(db, table, req.params.id);
      if (body && typeof body === 'object' && Number(body.id) === Number(req.params.id)) {
        Object.assign(body, db.prepare(`SELECT changed_by, changed_at FROM ${table} WHERE id = ?`).get(Number(req.params.id)));
      }
    }
    return reply(body);
  };
  return next();
});

// Two people editing the same record: the app sends the version (updated_at)
// it loaded, and an edit made from an older copy is refused instead of
// silently overwriting the other person's change.
const VERSIONED_TABLES = {
  accounts: 'accounts',
  bills: 'bills',
  bookings: 'bookings',
  cheques: 'post_dated_cheques',
  compliance: 'compliance_items',
  customers: 'customers',
  invoices: 'invoices',
  portals: 'supplier_portals',
  vendors: 'vendors',
  visas: 'visa_applications',
};

router.put('/:kind/:id', (req, res, next) => {
  const table = VERSIONED_TABLES[req.params.kind];
  const expected = req.get('x-record-version');
  if (!table || expected === undefined || !/^\d+$/.test(req.params.id)) return next();
  const current = db.prepare(`SELECT updated_at FROM ${table} WHERE id = ?`).get(Number(req.params.id));
  if (current && current.updated_at !== expected) {
    return res.status(409).json({
      error: 'Someone else changed this record while you were editing. Close it and open it again to see their changes.',
      code: 'record_changed',
    });
  }
  return next();
});

function adminOnly(req, res, next) {
  if (req.user.is_admin) return next();
  return res.status(403).json({ error: 'Only the admin can do this' });
}

router.use('/accounts', require('./accounts'));
router.use('/customers', require('./customers'));
router.use('/customer-balances', require('./customer-balances'));
router.use('/settlement-queue', require('./settlement-queue'));
router.use('/vendors', require('./vendors'));
router.use('/bookings', require('./bookings'));
router.use('/visas', require('./visas'));
router.use('/cancellations', require('./cancellations'));
router.use('/advances', require('./advances'));
router.use('/visa-deposits', require('./visa-deposits'));
router.use('/portals', require('./portals'));
router.use('/invoices', require('./invoices'));
router.use('/credits', require('./credits'));
router.use('/attachments', require('./attachments'));
router.use('/bills', require('./bills'));
router.use('/supplier-credits', require('./supplier-credits'));
router.use('/refunds', require('./refunds'));
router.use('/compliance', require('./compliance'));
router.use('/reminders', require('./reminders'));
router.use('/cheques', require('./cheques'));
router.use('/cash', require('./cash'));
router.use('/journal-entries', require('./journal'));
router.use('/opening-balances', require('./opening-balances'));
router.use('/bank-reconciliations', require('./bank-reconciliations'));
router.use('/petty-cash', require('./petty-cash'));
router.use('/card-settlements', require('./card-settlements'));
router.use('/reports', require('./reports'));
router.use('/settings', require('./settings'));
router.use('/audit-logs', require('./audit-logs'));
router.use('/audit-chain', require('./audit-chain'));
router.use('/users', adminOnly, require('./users'));
router.use('/admin', adminOnly, require('./admin'));

module.exports = router;
