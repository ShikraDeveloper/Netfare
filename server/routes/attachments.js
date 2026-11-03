'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const router = express.Router();
const db = require('../db');
const { bad, notFound } = require('../util');

const ENTITY_TABLES = {
  invoice: 'invoices',
  bill: 'bills',
  booking: 'bookings',
  visa: 'visa_applications',
  cancellation: 'cancellations',
  refund: 'refunds',
  credit_note: 'credit_notes',
  supplier_credit: 'supplier_credit_notes',
  customer: 'customers',
};

const ALLOWED_EXTENSIONS = new Set([
  '.pdf', '.png', '.jpg', '.jpeg', '.webp', '.gif',
  '.csv', '.txt', '.xls', '.xlsx', '.doc', '.docx',
]);

function assertEntity(entityType, entityId) {
  const table = ENTITY_TABLES[entityType];
  if (!table) throw bad('Attachments must belong to a customer, invoice, bill, booking, visa, cancellation, refund or credit note');
  const id = Number(entityId);
  if (!Number.isInteger(id) || id <= 0) throw bad('Choose a valid document for this attachment');
  const row = db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(id);
  if (!row) throw notFound('Document not found');
  return id;
}

function cleanFileName(value) {
  const name = path.basename(String(value || '').trim());
  if (!name || name.length > 200) throw bad('Choose a file with a valid name');
  const extension = path.extname(name).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw bad('Attachments must be PDF, image, spreadsheet, Word or text files');
  }
  return name;
}

function listAttachments(entityType, entityId) {
  const id = assertEntity(entityType, entityId);
  return db.prepare(`
    SELECT id, entity_type, entity_id, file_name, mime_type, size_bytes, created_at
    FROM attachments
    WHERE entity_type = ? AND entity_id = ?
    ORDER BY created_at DESC, id DESC
  `).all(entityType, id).map((row) => ({
    ...row,
    download_url: `/api/attachments/${row.id}/download`,
  }));
}

router.get('/', (req, res) => {
  res.json(listAttachments(String(req.query.entity_type || ''), req.query.entity_id));
});

router.post('/', express.raw({ type: 'application/octet-stream', limit: '15mb' }), (req, res) => {
  const entityType = String(req.query.entity_type || '');
  const entityId = assertEntity(entityType, req.query.entity_id);
  const fileName = cleanFileName(req.query.filename);
  const mimeType = String(req.query.type || 'application/octet-stream').slice(0, 120);
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw bad('Choose a file to upload');
  if (req.body.length > 15 * 1024 * 1024) throw bad('Attachments must be 15 MB or smaller');

  const extension = path.extname(fileName).toLowerCase();
  const info = db.prepare(`
    INSERT INTO attachments (entity_type, entity_id, file_name, mime_type, size_bytes, storage_name, data)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    entityType,
    entityId,
    fileName,
    mimeType,
    req.body.length,
    `${crypto.randomUUID()}${extension}`,
    req.body,
  );
  res.status(201).json({
    id: Number(info.lastInsertRowid),
    entity_type: entityType,
    entity_id: entityId,
    file_name: fileName,
    mime_type: mimeType,
    size_bytes: req.body.length,
    download_url: `/api/attachments/${info.lastInsertRowid}/download`,
  });
});

router.get('/:id/download', (req, res) => {
  const attachment = db.prepare('SELECT * FROM attachments WHERE id = ?').get(Number(req.params.id));
  if (!attachment) throw notFound('Attachment not found');
  if (!attachment.data) throw notFound('The attachment file is missing');
  res.attachment(attachment.file_name);
  res.type(attachment.mime_type || 'application/octet-stream');
  res.send(attachment.data);
});

router.delete('/:id', (req, res) => {
  const attachment = db.prepare('SELECT id FROM attachments WHERE id = ?').get(Number(req.params.id));
  if (!attachment) throw notFound('Attachment not found');
  db.prepare('DELETE FROM attachments WHERE id = ?').run(attachment.id);
  res.json({ deleted: true });
});

module.exports = router;
