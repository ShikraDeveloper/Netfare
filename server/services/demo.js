'use strict';

const { bad, addDays, todayISO } = require('../util');
const { postEntry } = require('../accounting');
const invoiceService = require('./invoices');
const billService = require('./bills');
const bookingService = require('./bookings');
const visaService = require('./visas');
const advanceService = require('./advances');
const portalService = require('./portals');

function accountId(db, code) {
  const account = db.prepare('SELECT id FROM accounts WHERE code = ?').get(code);
  if (!account) throw bad(`Missing account ${code}`);
  return account.id;
}

function daysAgo(n) {
  return addDays(todayISO(), -n);
}

function assertLedgerEmpty(db) {
  const invoiceCount = db.prepare('SELECT COUNT(*) AS c FROM invoices').get().c;
  const billCount = db.prepare('SELECT COUNT(*) AS c FROM bills').get().c;
  const customerCount = db.prepare('SELECT COUNT(*) AS c FROM customers').get().c;
  const bookingCount = db.prepare('SELECT COUNT(*) AS c FROM bookings').get().c;
  const visaCount = db.prepare('SELECT COUNT(*) AS c FROM visa_applications').get().c;
  if (invoiceCount > 0 || billCount > 0 || customerCount > 0 || bookingCount > 0 || visaCount > 0) {
    throw bad('Sample data can only be loaded into an empty ledger. Clear all data first.');
  }
}

function loadDemo(db) {
  assertLedgerEmpty(db);

  return db.transaction(() => {
    const settings = db.prepare('SELECT * FROM settings WHERE id = 1').get();
    const placeholders = ['My Company', 'Northstar Studio'];
    if (placeholders.includes(settings.company_name)) {
      db.prepare(`
        UPDATE settings SET company_name = ?, company_email = ?, company_address = ?, company_phone = ?,
          currency = 'AED'
        WHERE id = 1
      `).run(
        'Skyline Travels',
        'hello@skylinetravels.ae',
        'Office 1204, Business Bay Tower\nDubai, United Arab Emirates',
        '+971 4 555 0142',
      );
    } else {
      db.prepare("UPDATE settings SET currency = 'AED' WHERE id = 1").run();
    }

    // Opening capital so the agency has cash to operate with (AED 250,000).
    postEntry(db, {
      entry_date: daysAgo(180),
      memo: 'Opening capital contribution',
      reference: 'OPEN-001',
      source_type: 'opening',
      lines: [
        { account_id: accountId(db, '1010'), debit_cents: 25_000_000, credit_cents: 0, description: 'Opening bank balance' },
        { account_id: accountId(db, '3000'), debit_cents: 0, credit_cents: 25_000_000, description: 'Owner capital' },
      ],
    });

    const insertCustomer = db.prepare('INSERT INTO customers (name, email, phone, address) VALUES (?, ?, ?, ?)');
    const customers = {};
    const customerRows = [
      ['Rahul Menon', 'rahul.menon@example.com', '+971 50 555 0110', 'JLT Cluster D\nDubai, UAE'],
      ['Aisha Khan', 'aisha.khan@example.com', '+971 55 555 0121', 'Al Barsha 1\nDubai, UAE'],
      ['Gulf Tech FZE', 'travel@gulftech.example', '+971 4 555 0188', 'Sharjah Free Zone\nSharjah, UAE'],
      ['Fatima Al Zaabi', 'fatima.zaabi@example.com', '+971 52 555 0134', 'Khalifa City\nAbu Dhabi, UAE'],
      ['Corporate Travel Co', 'bookings@corptravel.example', '+971 4 555 0177', 'Deira, Baniyas Road\nDubai, UAE'],
    ];
    for (const row of customerRows) {
      const info = insertCustomer.run(...row);
      customers[row[0]] = Number(info.lastInsertRowid);
    }

    const insertVendor = db.prepare('INSERT INTO vendors (name, email, phone, address) VALUES (?, ?, ?, ?)');
    const vendors = {};
    const vendorRows = [
      ['Emirates Consolidator', 'ticketing@emiratesconsol.example', '+971 4 555 0201', 'Al Garhoud\nDubai, UAE'],
      ['FlyDubai Partner Desk', 'partners@flydubaidesk.example', '+971 4 555 0202', 'Dubai International Airport\nDubai, UAE'],
      ['Jumeirah Hotel Group', 'reservations@jumeirahhotels.example', '+971 4 555 0203', 'Umm Suqeim\nDubai, UAE'],
      ['Dubai Visa Services', 'support@dubaivisaservice.example', '+971 4 555 0204', 'Bur Dubai\nDubai, UAE'],
      ['Desert Safari Tours', 'sales@desertsafari.example', '+971 4 555 0205', 'Al Qusais\nDubai, UAE'],
    ];
    for (const row of vendorRows) {
      const info = insertVendor.run(...row);
      vendors[row[0]] = Number(info.lastInsertRowid);
    }

    const bank = accountId(db, '1010');
    const ticketSales = accountId(db, '4000');
    const packageSales = accountId(db, '4100');
    const serviceCharge = accountId(db, '4300');
    const visaRevenue = accountId(db, '4320');
    const ticketCost = accountId(db, '5000');
    const hotelCost = accountId(db, '5100');
    const visaCost = accountId(db, '5120');

    // Supplier portals / wallets. Prepaid portals get topped up and settle their
    // supplier's bills automatically; the visa account is postpaid (credit).
    const insertPortal = db.prepare(`
      INSERT INTO supplier_portals (name, portal_type, settlement, vendor_id, login_ref, notes, credit_limit_cents)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const portals = {};
    const portalRows = [
      ['Emirates Consolidator Portal', 'consolidator', 'prepaid', 'Emirates Consolidator',
        'portal.emiratesconsol.example · user SKY-1187', 'Deposit account held with the consolidator.', 0],
      ['FlyDubai Trade Portal', 'airline', 'prepaid', 'FlyDubai Partner Desk',
        'trade.flydubai.example · user SKY-TRAVEL', 'Airline B2B wallet for direct ticketing.', 0],
      ['Dubai Visa Services (credit)', 'other', 'credit', 'Dubai Visa Services',
        'visa.dubaivisaservice.example · user SKY', 'Postpaid visa account, 30-day terms.', 5_000_000],
    ];
    for (const [name, type, settlement, vendor, ref, notes, limit] of portalRows) {
      const info = insertPortal.run(name, type, settlement, vendors[vendor], ref, notes, limit);
      portals[name] = Number(info.lastInsertRowid);
    }

    portalService.topUp(db, {
      portal_id: portals['Emirates Consolidator Portal'],
      topup_date: daysAgo(170),
      amount_cents: 1_200_000,
      method: 'Bank transfer',
      reference: 'TOP-EC-021',
      deposit_account_id: bank,
    });
    portalService.topUp(db, {
      portal_id: portals['FlyDubai Trade Portal'],
      topup_date: daysAgo(160),
      amount_cents: 800_000,
      method: 'Bank transfer',
      reference: 'TOP-FD-014',
      deposit_account_id: bank,
    });

    const plans = [
      {
        customer: 'Rahul Menon', booking: 150, travel: 120, ret: 100, destination: 'Karachi, Pakistan',
        pnr: 'EK-2381', status: 'travelled', pay: 'full',
        sale: [
          ['Return ticket DXB–KHI', 1, 180_000, ticketSales],
          ['Service charge & markup', 1, 15_000, serviceCharge],
        ],
        cost: [
          ['Consolidator ticket DXB–KHI', 1, 165_000, ticketCost, 'Emirates Consolidator'],
        ],
      },
      {
        customer: 'Aisha Khan', booking: 90, travel: -40, ret: -30, destination: 'Jeddah & Makkah, Saudi Arabia',
        pnr: 'SV-7712', status: 'confirmed', pay: 'partial', advance: 200_000,
        sale: [
          ['Return ticket DXB–JED', 1, 220_000, ticketSales],
          ['Hotel — 5 nights', 1, 140_000, packageSales],
          ['Umrah visa & documentation', 1, 50_000, visaRevenue],
          ['Service charge & markup', 1, 25_000, serviceCharge],
        ],
        cost: [
          ['Consolidator ticket DXB–JED', 1, 195_000, ticketCost, 'FlyDubai Partner Desk'],
          ['Hotel booking — 5 nights', 1, 115_000, hotelCost, 'Jumeirah Hotel Group'],
          ['Visa processing', 1, 35_000, visaCost, 'Dubai Visa Services'],
        ],
      },
      {
        customer: 'Gulf Tech FZE', booking: 70, travel: -35, ret: -25, destination: 'Riyadh, Saudi Arabia',
        pnr: 'SV-3345', status: 'travelled', pay: 'full',
        sale: [
          ['Business class ticket DXB–RUH', 1, 320_000, ticketSales],
          ['Corporate service charge', 1, 20_000, serviceCharge],
        ],
        cost: [
          ['Consolidator business ticket', 1, 290_000, ticketCost, 'Emirates Consolidator'],
        ],
      },
      {
        customer: 'Fatima Al Zaabi', booking: 55, travel: -10, ret: 2, destination: 'Baku, Azerbaijan',
        pnr: 'J2-8890', status: 'confirmed', pay: 'partial',
        sale: [
          ['Baku city tour package — 4 nights', 1, 560_000, packageSales],
          ['Service charge & markup', 1, 35_000, serviceCharge],
        ],
        cost: [
          ['Tour package — 4 nights', 1, 470_000, hotelCost, 'Jumeirah Hotel Group'],
        ],
      },
      {
        customer: 'Corporate Travel Co', booking: 30, travel: 20, ret: 12, destination: 'Multiple — group booking',
        pnr: 'GROUP-118', status: 'confirmed', pay: 'none',
        sale: [
          ['Group tickets DXB–LHR (4 pax)', 4, 150_000, ticketSales],
          ['Group service charge', 1, 60_000, serviceCharge],
        ],
        cost: [
          ['Group tickets (4 pax)', 4, 130_000, ticketCost, 'Emirates Consolidator'],
        ],
      },
      {
        customer: 'Rahul Menon', booking: 20, travel: -5, ret: null, destination: 'UAE tourist visa',
        pnr: '', status: 'travelled', pay: 'full',
        sale: [
          ['UAE tourist visa (30 days)', 1, 65_000, visaRevenue],
          ['Documentation service', 1, 5_000, serviceCharge],
        ],
        cost: [
          ['Visa processing fee', 1, 45_000, visaCost, 'Dubai Visa Services'],
        ],
      },
      {
        customer: 'Aisha Khan', booking: 15, travel: 6, ret: null, destination: 'Desert safari — Dubai',
        pnr: '', status: 'cancelled', pay: 'none',
        sale: [
          ['Desert safari — evening package', 1, 45_000, packageSales],
          ['Service charge', 1, 4_000, serviceCharge],
        ],
        cost: [
          ['Safari booking', 1, 32_000, hotelCost, 'Desert Safari Tours'],
        ],
      },
      {
        customer: 'Gulf Tech FZE', booking: 5, travel: 40, ret: 34, destination: 'Singapore — hotel only',
        pnr: '', status: 'draft', pay: 'none',
        sale: [
          ['Hotel booking — 6 nights', 1, 240_000, packageSales],
          ['Service charge & markup', 1, 18_000, serviceCharge],
        ],
        cost: [
          ['Hotel booking — 6 nights', 1, 190_000, hotelCost, 'Jumeirah Hotel Group'],
        ],
      },
    ];

    for (const plan of plans) {
      const booking = bookingService.createBooking(db, {
        customer_id: customers[plan.customer],
        booking_date: daysAgo(plan.booking),
        due_date: daysAgo(plan.booking),
        travel_date: plan.travel == null ? null : daysAgo(plan.travel),
        return_date: plan.ret == null ? null : daysAgo(plan.ret),
        destination: plan.destination,
        pnr: plan.pnr,
        notes: 'Thank you for booking with Skyline Travels.',
        sale_items: plan.sale.map(([description, quantity, unitPrice, account]) => ({
          description, quantity, unit_price_cents: unitPrice, account_id: account,
        })),
        cost_items: plan.cost.map(([description, quantity, unitPrice, account, vendor]) => ({
          description, quantity, unit_price_cents: unitPrice, account_id: account, vendor_id: vendors[vendor],
        })),
      });

      if (plan.status === 'cancelled') {
        bookingService.confirmBooking(db, booking.id);
        bookingService.cancelBooking(db, booking.id);
        continue;
      }

      if (plan.status === 'draft') continue;

      const confirmed = bookingService.confirmBooking(db, booking.id);

      if (plan.advance) {
        const advance = advanceService.createAdvance(db, {
          customer_id: customers[plan.customer],
          booking_id: booking.id,
          advance_date: daysAgo(plan.booking),
          amount_cents: plan.advance,
          method: 'Bank transfer',
          reference: `ADV-${booking.id}`,
          deposit_account_id: bank,
        });
        advanceService.applyAdvance(db, advance.id, { invoice_id: confirmed.invoice_id, payment_date: daysAgo(plan.booking) });
      }

      if (plan.pay === 'full') {
        const fresh = db.prepare('SELECT * FROM invoices WHERE id = ?').get(confirmed.invoice_id);
        const balance = fresh.total_cents - fresh.amount_paid_cents - (fresh.credit_applied_cents || 0);
        if (balance > 0) {
          invoiceService.recordInvoicePayment(db, confirmed.invoice_id, {
            amount_cents: balance,
            payment_date: daysAgo(plan.booking),
            method: 'Bank transfer',
            reference: `PAY-${confirmed.invoice_id}`,
            deposit_account_id: bank,
          });
        }
      } else if (plan.pay === 'partial') {
        const fresh = db.prepare('SELECT * FROM invoices WHERE id = ?').get(confirmed.invoice_id);
        const balance = fresh.total_cents - fresh.amount_paid_cents - (fresh.credit_applied_cents || 0);
        const half = Math.round(balance / 2);
        if (half > 0) {
          invoiceService.recordInvoicePayment(db, confirmed.invoice_id, {
            amount_cents: half,
            payment_date: daysAgo(Math.max(0, plan.booking - 5)),
            method: 'Bank transfer',
            reference: `PAY-${confirmed.invoice_id}`,
            deposit_account_id: bank,
          });
        }
      }

      if (plan.status === 'travelled') {
        bookingService.markTravelled(db, booking.id);
      }
    }

    // Visa applications exercise the dedicated visa workflow: draft → submitted
    // (invoice + supplier bill) → approved → issued, with a rejected example.
    const visaPlans = [
      {
        customer: 'Aisha Khan', country: 'Saudi Arabia', type: 'tourist', applicant: 'Aisha Khan',
        nationality: 'Indian', passport: 'P4821993', expiryDays: 1250, birthDays: 11_200, ref: 'KSA-88214',
        application: 25, travel: -20, status: 'submitted', pay: 'partial',
        sale: [
          ['Saudi Arabia tourist visa (Umrah)', 1, 75_000, visaRevenue],
          ['Visa processing service', 1, 8_000, serviceCharge],
        ],
        cost: [
          ['Saudi visa processing & insurance', 1, 52_000, visaCost, 'Dubai Visa Services'],
        ],
      },
      {
        customer: 'Gulf Tech FZE', country: 'United Arab Emirates', type: 'business', applicant: 'Omar Haddad',
        nationality: 'Lebanese', passport: 'LR902144', expiryDays: 820, birthDays: 14_600, ref: 'UAE-BIZ-4471',
        application: 18, travel: 12, status: 'approved', pay: 'full',
        sale: [
          ['UAE business visa (60 days)', 1, 120_000, visaRevenue],
          ['Corporate documentation service', 1, 15_000, serviceCharge],
        ],
        cost: [
          ['Business visa processing', 1, 88_000, visaCost, 'Dubai Visa Services'],
        ],
      },
      {
        customer: 'Fatima Al Zaabi', country: 'France (Schengen)', type: 'tourist', applicant: 'Fatima Al Zaabi',
        nationality: 'Emirati', passport: 'AE771209', expiryDays: 1600, birthDays: 13_400, ref: 'SCH-2026-1180',
        application: 30, travel: 25, status: 'issued', pay: 'full',
        sale: [
          ['Schengen tourist visa', 1, 95_000, visaRevenue],
          ['Travel insurance & documentation', 1, 12_000, serviceCharge],
        ],
        cost: [
          ['Schengen visa appointment & processing', 1, 61_000, visaCost, 'Dubai Visa Services'],
        ],
      },
      {
        customer: 'Rahul Menon', country: 'United Kingdom', type: 'visit', applicant: 'Rahul Menon',
        nationality: 'Indian', passport: 'P4821993', expiryDays: 1250, birthDays: 11_200, ref: 'UK-VIS-5521',
        application: 6, travel: 45, status: 'draft', pay: 'none',
        sale: [
          ['UK standard visitor visa', 1, 110_000, visaRevenue],
          ['Application service charge', 1, 10_000, serviceCharge],
        ],
        cost: [
          ['UK visa application centre fee', 1, 82_000, visaCost, 'Dubai Visa Services'],
        ],
      },
      {
        customer: 'Corporate Travel Co', country: 'United States', type: 'business', applicant: 'Group — 3 delegates',
        nationality: 'Mixed', passport: 'GROUP-US-03', expiryDays: 900, birthDays: 15_000, ref: 'US-B1-9930',
        application: 40, travel: -12, status: 'rejected', pay: 'partial',
        sale: [
          ['US B1 business visa (per applicant)', 3, 95_000, visaRevenue],
          ['Group documentation service', 1, 25_000, serviceCharge],
        ],
        cost: [
          ['US visa application fee (3 applicants)', 3, 70_000, visaCost, 'Dubai Visa Services'],
        ],
      },
      {
        customer: 'Aisha Khan', country: 'Turkey', type: 'tourist', applicant: 'Aisha Khan',
        nationality: 'Indian', passport: 'P4821993', expiryDays: 1400, birthDays: 11_200, ref: 'TR-2026-7742',
        application: 3, travel: 45, status: 'submitted', pay: 'none',
        sale: [
          ['Turkey tourist visa', 1, 90_000, visaRevenue],
          ['Visa processing service', 1, 10_000, serviceCharge],
        ],
        cost: [
          ['Turkey visa processing', 1, 60_000, visaCost, 'Dubai Visa Services'],
        ],
      },
    ];

    for (const plan of visaPlans) {
      const visa = visaService.createVisa(db, {
        customer_id: customers[plan.customer],
        application_date: daysAgo(plan.application),
        due_date: daysAgo(plan.application),
        travel_date: plan.travel == null ? null : daysAgo(plan.travel),
        destination_country: plan.country,
        visa_type: plan.type,
        applicant_name: plan.applicant,
        nationality: plan.nationality,
        passport_number: plan.passport,
        passport_expiry: plan.expiryDays ? addDays(todayISO(), plan.expiryDays) : null,
        date_of_birth: plan.birthDays ? addDays(todayISO(), -plan.birthDays) : null,
        reference: plan.ref,
        notes: 'Visa application managed by Skyline Travels.',
        sale_items: plan.sale.map(([description, quantity, unitPrice, account]) => ({
          description, quantity, unit_price_cents: unitPrice, account_id: account,
        })),
        cost_items: plan.cost.map(([description, quantity, unitPrice, account, vendor]) => ({
          description, quantity, unit_price_cents: unitPrice, account_id: account, vendor_id: vendors[vendor],
        })),
      });

      if (plan.status === 'draft') continue;

      const submitted = visaService.submitVisa(db, visa.id);

      if (plan.pay === 'full' || plan.pay === 'partial') {
        const fresh = db.prepare('SELECT * FROM invoices WHERE id = ?').get(submitted.invoice_id);
        const balance = fresh.total_cents - fresh.amount_paid_cents - (fresh.credit_applied_cents || 0);
        const amount = plan.pay === 'full' ? balance : Math.round(balance / 2);
        if (amount > 0) {
          invoiceService.recordInvoicePayment(db, submitted.invoice_id, {
            amount_cents: amount,
            payment_date: daysAgo(Math.max(0, plan.application - 3)),
            method: 'Bank transfer',
            reference: `PAY-${submitted.invoice_id}`,
            deposit_account_id: bank,
          });
        }
      }

      if (plan.status === 'approved') visaService.approveVisa(db, visa.id);
      if (plan.status === 'issued') {
        visaService.approveVisa(db, visa.id);
        visaService.issueVisa(db, visa.id);
      }
      if (plan.status === 'rejected') visaService.rejectVisa(db, visa.id);
    }

    // Pay a few supplier bills so A/P and cash movement look realistic.
    const billRows = db.prepare("SELECT * FROM bills WHERE status = 'received' ORDER BY bill_date LIMIT 3").all();
    for (const bill of billRows) {
      const balance = bill.total_cents - bill.amount_paid_cents;
      if (balance > 0) {
        billService.recordBillPayment(db, bill.id, {
          amount_cents: balance,
          payment_date: daysAgo(2),
          method: 'Bank transfer',
          reference: `ACH-${bill.id}`,
          payment_account_id: bank,
        });
      }
    }

    return {
      customers: Object.keys(customers).length,
      vendors: Object.keys(vendors).length,
      bookings: plans.length,
      visas: visaPlans.length,
      portals: Object.keys(portals).length,
    };
  })();
}

function resetAll(db) {
  return db.transaction(() => {
    db.prepare('DELETE FROM bank_reconciliation_lines').run();
    db.prepare('DELETE FROM bank_reconciliations').run();
    db.prepare('DELETE FROM attachments').run();
    db.prepare('DELETE FROM credit_applications').run();
    db.prepare('DELETE FROM credit_notes').run();
    db.prepare('DELETE FROM cash_deposits').run();
    db.prepare('DELETE FROM post_dated_cheques').run();
    db.prepare('DELETE FROM compliance_logs').run();
    db.prepare('DELETE FROM compliance_items').run();
    db.prepare('DELETE FROM refunds').run();
    db.prepare('DELETE FROM payments').run();
    db.prepare('DELETE FROM bill_payments').run();
    db.prepare('DELETE FROM customer_advances').run();
    db.prepare('DELETE FROM portal_topups').run();
    db.prepare('DELETE FROM portal_refunds').run();
    db.prepare('DELETE FROM supplier_portals').run();
    db.prepare('DELETE FROM booking_items').run();
    db.prepare('DELETE FROM visa_items').run();
    db.prepare('DELETE FROM invoice_items').run();
    db.prepare('DELETE FROM bill_items').run();
    db.prepare('DELETE FROM invoices').run();
    db.prepare('DELETE FROM bills').run();
    db.prepare('DELETE FROM bookings').run();
    db.prepare('DELETE FROM visa_applications').run();
    db.prepare('DELETE FROM journal_lines').run();
    db.prepare('DELETE FROM journal_entries').run();
    db.prepare('DELETE FROM customers').run();
    db.prepare('DELETE FROM vendors').run();
    db.prepare(`
      UPDATE settings SET next_invoice_number = 1, next_bill_number = 1, next_payment_number = 1,
        next_booking_number = 1, next_visa_number = 1, next_advance_number = 1, next_topup_number = 1,
        next_refund_number = 1, next_deposit_number = 1, next_credit_number = 1,
        updated_at = datetime('now') WHERE id = 1
    `).run();
    db.prepare(`DELETE FROM sqlite_sequence WHERE name IN
      ('bank_reconciliations', 'bank_reconciliation_lines', 'attachments', 'credit_notes', 'credit_applications',
       'cash_deposits', 'post_dated_cheques', 'compliance_items', 'compliance_logs', 'refunds', 'payments', 'bill_payments', 'invoice_items', 'bill_items', 'invoices', 'bills',
       'bookings', 'booking_items', 'visa_applications', 'visa_items', 'customer_advances',
       'supplier_portals', 'portal_topups', 'portal_refunds', 'journal_lines', 'journal_entries',
       'customers', 'vendors')`).run();
    return { cleared: true };
  })();
}

module.exports = { assertLedgerEmpty, loadDemo, resetAll };
