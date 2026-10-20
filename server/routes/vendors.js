'use strict';

const router = require('express').Router();
const db = require('../db');
const { bad, notFound, str, optionalStr, isTruthy } = require('../util');

function listVendors() {
  return db.prepare(`
    SELECT v.*,
      (SELECT COUNT(*) FROM bills b WHERE b.vendor_id = v.id) AS bill_count,
      (SELECT COALESCE(SUM(b.total_cents - b.amount_paid_cents), 0)
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

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM vendors WHERE id = ?').get(id);
  if (!existing) throw notFound('Vendor not found');
  const count = db.prepare('SELECT COUNT(*) AS c FROM bills WHERE vendor_id = ?').get(id).c;
  if (count > 0) throw bad('This vendor has bills. Archive them instead of deleting.');
  db.prepare('DELETE FROM vendors WHERE id = ?').run(id);
  res.json({ deleted: true });
});

module.exports = router;
module.exports.listVendors = listVendors;
