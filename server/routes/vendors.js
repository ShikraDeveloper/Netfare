'use strict';

const router = require('express').Router();
const db = require('../db');
const { bad, notFound, str, optionalStr, isTruthy } = require('../util');
const statementService = require('../services/statements');
const partyOpening = require('../services/party-opening');
const { markCreated } = require('../created-by');
const { assignPartyNumber } = require('../party-numbers');

function listVendors() {
  return db.prepare(`
    SELECT v.*,
      (SELECT COUNT(*) FROM bills b WHERE b.vendor_id = v.id) AS bill_count,
      (SELECT COALESCE(SUM(b.total_cents - b.amount_paid_cents - b.credit_applied_cents), 0)
       FROM bills b WHERE b.vendor_id = v.id AND b.status = 'received') AS outstanding_cents,
      (SELECT COALESCE(SUM(b.total_cents), 0)
       FROM bills b WHERE b.vendor_id = v.id AND b.status <> 'void') AS total_billed_cents
    FROM vendors v
    ORDER BY v.name COLLATE NOCASE
  `).all();
}

router.get('/', (req, res) => {
  const includeInactive = isTruthy(req.query.include_inactive);
  const rows = listVendors();
  res.json(includeInactive ? rows : rows.filter((row) => row.is_active));
});

router.get('/:id/statement', (req, res) => {
  res.json(statementService.vendorStatement(db, req.params.id, req.query));
});

// Only the admin may give a new record an opening balance.
// Money the supplier pays back from the credit it holds for us.
router.post('/:id/receive-refund', (req, res) => {
  res.status(201).json(require('../services/supplier-credits').receiveVendorRefund(db, Number(req.params.id), req.body || {}));
});

// The opening balance after the record exists: shown to all, changed by the admin only.
router.get('/:id/opening', (req, res) => {
  res.json(partyOpening.openingStatus(db, 'vendor', Number(req.params.id)));
});

router.post('/:id/opening', (req, res) => {
  if (!req.user?.is_admin) throw bad('Only the admin can change an opening balance');
  res.json(partyOpening.setOpening(db, 'vendor', Number(req.params.id), req.body || {}));
});

router.post('/', (req, res) => {
  const body = req.body || {};
  if (body.opening && !req.user?.is_admin) throw bad('Only the admin can enter an opening balance');
  const created = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO vendors (name, email, phone, address, notes)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      str(body.name, 'Vendor name', { max: 160 }),
      optionalStr(body.email, 'Email', 200),
      optionalStr(body.phone, 'Phone', 60),
      optionalStr(body.address, 'Address', 500),
      optionalStr(body.notes, 'Notes', 1000),
    );
    markCreated(db, 'vendors', info.lastInsertRowid);
    assignPartyNumber(db, 'vendors', info.lastInsertRowid);
    const row = db.prepare('SELECT * FROM vendors WHERE id = ?').get(info.lastInsertRowid);
    return { ...row, opening: partyOpening.forVendor(db, row, body.opening) };
  })();
  res.status(201).json(created);
});

router.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM vendors WHERE id = ?').get(id);
  if (!existing) throw notFound('Vendor not found');
  const body = req.body || {};
  db.prepare(`
    UPDATE vendors SET name = ?, email = ?, phone = ?, address = ?, notes = ?, is_active = ?, updated_at = datetime('now') WHERE id = ?
  `).run(
    body.name != null ? str(body.name, 'Vendor name', { max: 160 }) : existing.name,
    body.email != null ? optionalStr(body.email, 'Email', 200) : existing.email,
    body.phone != null ? optionalStr(body.phone, 'Phone', 60) : existing.phone,
    body.address != null ? optionalStr(body.address, 'Address', 500) : existing.address,
    body.notes != null ? optionalStr(body.notes, 'Notes', 1000) : existing.notes,
    body.is_active != null ? (isTruthy(body.is_active) ? 1 : 0) : existing.is_active,
    id,
  );
  res.json(db.prepare('SELECT * FROM vendors WHERE id = ?').get(id));
});

function deleteVendor(id) {
  const existing = db.prepare('SELECT * FROM vendors WHERE id = ?').get(id);
  if (!existing) throw notFound('Vendor not found');
  const count = db.prepare('SELECT COUNT(*) AS c FROM bills WHERE vendor_id = ?').get(id).c;
  if (count > 0) throw bad('This vendor has bills. Archive it instead of deleting.');
  const bookingItems = db.prepare(`
    SELECT COUNT(*) AS c FROM booking_items
    WHERE item_type = 'cost' AND vendor_id = ?
  `).get(id).c;
  if (bookingItems > 0) {
    throw bad('This vendor is used on a booking cost line. Archive it instead of deleting.');
  }
  const visaItems = db.prepare(`
    SELECT COUNT(*) AS c FROM visa_items
    WHERE item_type = 'cost' AND vendor_id = ?
  `).get(id).c;
  if (visaItems > 0) {
    throw bad('This vendor is used on a visa cost line. Archive it instead of deleting.');
  }
  const cheques = db.prepare('SELECT COUNT(*) AS c FROM post_dated_cheques WHERE vendor_id = ?').get(id).c;
  if (cheques > 0) throw bad('This vendor has post-dated cheques. Archive it instead of deleting.');
  const credits = db.prepare('SELECT COUNT(*) AS c FROM supplier_credit_notes WHERE vendor_id = ?').get(id).c;
  if (credits > 0) throw bad('This vendor has supplier credit notes. Archive it instead of deleting.');
  const portals = db.prepare('SELECT COUNT(*) AS c FROM supplier_portals WHERE vendor_id = ?').get(id).c;
  if (portals > 0) throw bad('This supplier is linked to a portal. Archive it instead of deleting.');
  const refunds = db.prepare(`
    SELECT COUNT(*) AS c FROM refunds WHERE refund_type = 'supplier' AND party_id = ?
  `).get(id).c;
  if (refunds > 0) throw bad('This vendor has supplier refunds. Archive it instead of deleting.');
  db.prepare('DELETE FROM vendors WHERE id = ?').run(id);
  return { deleted: true };
}

router.delete('/:id', (req, res) => {
  res.json(deleteVendor(Number(req.params.id)));
});

module.exports = router;
module.exports.listVendors = listVendors;
module.exports.deleteVendor = deleteVendor;
