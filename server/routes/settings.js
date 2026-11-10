'use strict';

const router = require('express').Router();
const db = require('../db');
const { bad, str, optionalStr, num, dateISO, todayISO } = require('../util');
const audit = require('../services/audit');

// Every screen reads the company settings. Where backups are copied, the
// update address and the office network are the admin's business only.
const ADMIN_ONLY = ['backup_mirror_dir', 'backup_mirror_at', 'backup_mirror_error', 'update_feed', 'lan_enabled', 'lan_hosts'];

function settingsFor(user) {
  const settings = db.prepare('SELECT * FROM settings WHERE id = 1').get();
  if (!user?.is_admin) for (const key of ADMIN_ONLY) delete settings[key];
  return settings;
}

router.get('/', (req, res) => {
  res.json(settingsFor(req.user));
});

router.put('/', (req, res) => {
  const body = req.body || {};
  const current = db.prepare('SELECT * FROM settings WHERE id = 1').get();

  const companyName = body.company_name != null
    ? str(body.company_name, 'Company name', { max: 160 })
    : current.company_name;
  const currency = 'AED';
  if (body.currency != null && String(body.currency).trim().toUpperCase() !== currency) {
    throw bad('Netfare records all amounts in AED');
  }

  const terms = body.payment_terms_days != null
    ? Math.round(num(body.payment_terms_days, 'Payment terms', { min: 0, max: 365 }))
    : current.payment_terms_days;
  const fiscalMonth = body.fiscal_year_start_month != null
    ? Math.round(num(body.fiscal_year_start_month, 'Fiscal year start month', { min: 1, max: 12 }))
    : current.fiscal_year_start_month;

  const invoicePrefix = body.invoice_prefix != null
    ? str(body.invoice_prefix, 'Invoice prefix', { max: 12 }).toUpperCase()
    : current.invoice_prefix;
  const billPrefix = body.bill_prefix != null
    ? str(body.bill_prefix, 'Bill prefix', { max: 12 }).toUpperCase()
    : current.bill_prefix;
  const bookingPrefix = body.booking_prefix != null
    ? str(body.booking_prefix, 'Booking prefix', { max: 12 }).toUpperCase()
    : (current.booking_prefix || 'BK');
  const topupPrefix = body.topup_prefix != null
    ? str(body.topup_prefix, 'Top-up prefix', { max: 12 }).toUpperCase()
    : (current.topup_prefix || 'TOP');
  const visaPrefix = body.visa_prefix != null
    ? str(body.visa_prefix, 'Visa prefix', { max: 12 }).toUpperCase()
    : (current.visa_prefix || 'VIS');
  const receiptPrefix = body.receipt_prefix != null
    ? str(body.receipt_prefix, 'Receipt prefix', { max: 12 }).toUpperCase()
    : (current.receipt_prefix || 'RCP');
  // The closing date (admin only): checked here, saved after the other settings.
  const closed = body.books_closed_through === undefined
    ? (current.books_closed_through || '')
    : (body.books_closed_through ? dateISO(body.books_closed_through, 'Books closed through') : '');
  const closedChanged = closed !== (current.books_closed_through || '');
  if (closedChanged && !req.user?.is_admin) throw bad('Only the admin can change the closing date');
  if (closed > todayISO()) throw bad('The closing date cannot be in the future');
  const printPreparedBy = body.print_prepared_by != null ? (body.print_prepared_by ? 1 : 0) : (current.print_prepared_by ?? 1);

  db.prepare(`
    UPDATE settings SET company_name = ?, company_email = ?, company_phone = ?, company_address = ?,
      currency = ?, payment_terms_days = ?, invoice_prefix = ?, bill_prefix = ?,
      booking_prefix = ?, visa_prefix = ?, topup_prefix = ?, receipt_prefix = ?, fiscal_year_start_month = ?, print_prepared_by = ?,
      updated_at = datetime('now')
    WHERE id = 1
  `).run(
    companyName,
    body.company_email != null ? optionalStr(body.company_email, 'Company email', 200) : current.company_email,
    body.company_phone != null ? optionalStr(body.company_phone, 'Company phone', 60) : current.company_phone,
    body.company_address != null ? optionalStr(body.company_address, 'Company address', 500) : current.company_address,
    currency,
    terms,
    invoicePrefix,
    billPrefix,
    bookingPrefix,
    visaPrefix,
    topupPrefix,
    receiptPrefix,
    fiscalMonth,
    printPreparedBy,
  );

  if (closedChanged) {
    db.prepare('UPDATE settings SET books_closed_through = ? WHERE id = 1').run(closed);
    audit.record(db, {
      entity_type: 'settings', entity_number: 'Closing date', action: closed ? 'enable' : 'disable',
      remarks: closed ? `Books closed through ${closed}` : 'Closing date removed',
    });
  }

  res.json(settingsFor(req.user));
});

module.exports = router;
