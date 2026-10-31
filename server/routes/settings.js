'use strict';

const router = require('express').Router();
const db = require('../db');
const { bad, str, optionalStr, num } = require('../util');

router.get('/', (req, res) => {
  res.json(db.prepare('SELECT * FROM settings WHERE id = 1').get());
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

  db.prepare(`
    UPDATE settings SET company_name = ?, company_email = ?, company_phone = ?, company_address = ?,
      currency = ?, payment_terms_days = ?, invoice_prefix = ?, bill_prefix = ?,
      booking_prefix = ?, visa_prefix = ?, topup_prefix = ?, fiscal_year_start_month = ?, updated_at = datetime('now')
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
    fiscalMonth,
  );

  res.json(db.prepare('SELECT * FROM settings WHERE id = 1').get());
});

module.exports = router;
