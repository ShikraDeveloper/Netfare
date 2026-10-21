'use strict';

const router = require('express').Router();
const db = require('../db');
const { bad, notFound, str, optionalStr, isTruthy } = require('../util');
const statementService = require('../services/statements');

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

router.post('/', (req, res) => {
  const body = req.body || {};
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
  res.status(201).json(db.prepare('SELECT * FROM vendors WHERE id = ?').get(info.lastInsertRowid));
});

router.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM vendors WHERE id = ?').get(id);
  if (!existing) throw notFound('Vendor not found');
  const body = req.body || {};
  db.prepare(`
    UPDATE vendors SET name = ?, email = ?, phone = ?, address = ?, notes = ?, is_active = ? WHERE id = ?
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
