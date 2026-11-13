'use strict';

// Every bank charge (6700 Bank Charges) and card / payment-link fee (6710) in
// a period, read from the ledger so none can be missed, each with what it was
// on. A charge undone in the same period (an entry and its reversal both in
// it) is left out; anything else stays, so the total is the ledger's.

const KIND_LABELS = {
  payment: 'Customer payment',
  receipt: 'Receipt / advance',
  bill_payment: 'Supplier payment',
  portal_topup: 'Portal top-up',
  refund: 'Refund',
  card_fee: 'Card & payment link fee',
  bank_fee: 'Bank fee (bank debit)',
  bill: 'Expense bill',
  journal: 'Journal entry',
};

const money = (cents) => (cents / 100).toFixed(2);

// What a charge was on, found from the entry that holds it (for an undoing,
// the entry it undoes).
function describe(db, entryId) {
  const advance = db.prepare(`
    SELECT a.id, a.number, a.is_receipt, a.customer_id, c.name AS party
    FROM customer_advances a JOIN customers c ON c.id = a.customer_id WHERE a.journal_entry_id = ?
  `).get(entryId);
  if (advance) {
    return {
      kind: 'receipt', party: advance.party,
      document: { number: advance.number, href: advance.is_receipt ? `#/customer-receipts/${advance.id}` : `#/customer-balances/${advance.customer_id}` },
    };
  }
  const payment = db.prepare(`
    SELECT p.number, i.id AS invoice_id, i.number AS invoice_number, c.name AS party
    FROM payments p JOIN invoices i ON i.id = p.invoice_id JOIN customers c ON c.id = p.customer_id WHERE p.journal_entry_id = ?
  `).get(entryId);
  if (payment) {
    return { kind: 'payment', party: payment.party, detail: payment.number, document: { number: payment.invoice_number, href: `#/invoices/${payment.invoice_id}` } };
  }
  const billPayment = db.prepare(`
    SELECT bp.number, b.id AS bill_id, b.number AS bill_number, v.name AS party
    FROM bill_payments bp JOIN bills b ON b.id = bp.bill_id JOIN vendors v ON v.id = b.vendor_id WHERE bp.journal_entry_id = ?
  `).get(entryId);
  if (billPayment) {
    return { kind: 'bill_payment', party: billPayment.party, detail: billPayment.number, document: { number: billPayment.bill_number, href: `#/bills/${billPayment.bill_id}` } };
  }
  const bill = db.prepare(`
    SELECT b.id, b.number, b.notes, v.name AS party FROM bills b JOIN vendors v ON v.id = b.vendor_id WHERE b.journal_entry_id = ?
  `).get(entryId);
  if (bill) {
    // Charges the bank takes itself are bills of the bank's own supplier.
    return {
      kind: / \(bank debits\)$/.test(bill.party) ? 'bank_fee' : 'bill', party: bill.party, detail: bill.notes || '',
      document: { number: bill.number, href: `#/bills/${bill.id}` },
    };
  }
  const topup = db.prepare(`
    SELECT t.number, t.portal_id, p.name AS party FROM portal_topups t JOIN supplier_portals p ON p.id = t.portal_id WHERE t.journal_entry_id = ?
  `).get(entryId);
  if (topup) return { kind: 'portal_topup', party: topup.party, document: { number: topup.number, href: `#/portals/${topup.portal_id}` } };
  const refund = db.prepare(`
    SELECT r.id, r.number, r.refund_type, r.party_id FROM refunds r WHERE r.journal_entry_id = ?
  `).get(entryId);
  if (refund) {
    const party = db.prepare(`SELECT name FROM ${refund.refund_type === 'supplier' ? 'vendors' : 'customers'} WHERE id = ?`).get(refund.party_id)?.name || '';
    return { kind: 'refund', party, document: { number: refund.number, href: `#/refunds/${refund.id}` } };
  }
  const settlement = db.prepare('SELECT id, number, gross_cents, fee_cents FROM card_settlements WHERE journal_entry_id = ?').get(entryId);
  if (settlement) {
    const count = db.prepare('SELECT COUNT(*) AS n FROM card_settlement_lines WHERE settlement_id = ?').get(settlement.id).n;
    const percent = settlement.gross_cents ? ((settlement.fee_cents / settlement.gross_cents) * 100).toFixed(2) : '0.00';
    return {
      kind: 'card_fee', party: '', detail: `${count} payment${count === 1 ? '' : 's'} · ${money(settlement.gross_cents)} in, fee ${percent}%`,
      document: { number: settlement.number, href: '#/card-settlements' },
    };
  }
  const entry = db.prepare('SELECT id, reference, memo FROM journal_entries WHERE id = ?').get(entryId);
  return { kind: 'journal', party: '', detail: entry.memo || '', document: { number: entry.reference || `Entry #${entry.id}`, href: `#/journal?focus=${entry.id}` } };
}

function bankChargesReport(db, from, to) {
  const lines = db.prepare(`
    SELECT l.id, l.debit_cents - l.credit_cents AS amount_cents, a.code AS account_code,
           e.id AS entry_id, e.entry_date, e.reversal_of_id,
           (SELECT r.id FROM journal_entries r WHERE r.reversal_of_id = e.id LIMIT 1) AS reversed_by,
           (SELECT ca.name FROM journal_lines x JOIN accounts ca ON ca.id = x.account_id
            WHERE x.entry_id = e.id AND ca.is_cash = 1 AND ca.code <> '1030' LIMIT 1) AS bank_account
    FROM journal_lines l
    JOIN journal_entries e ON e.id = l.entry_id
    JOIN accounts a ON a.id = l.account_id
    WHERE a.code IN ('6700', '6710') AND e.entry_date >= ? AND e.entry_date <= ?
    ORDER BY e.entry_date, e.id, l.id
  `).all(from, to);
  const inPeriod = new Set(lines.map((line) => line.entry_id));
  const rows = lines
    .filter((line) => !(line.reversed_by && inPeriod.has(line.reversed_by)) && !(line.reversal_of_id && inPeriod.has(line.reversal_of_id)))
    .map((line) => {
      const about = describe(db, line.reversal_of_id || line.entry_id);
      return {
        id: line.id,
        date: line.entry_date,
        account_code: line.account_code,
        kind: about.kind,
        kind_label: KIND_LABELS[about.kind],
        document: about.document,
        party: about.party,
        detail: line.reversal_of_id ? `Undone · ${about.detail || ''}`.replace(/ · $/, '') : (about.detail || ''),
        bank_account: line.bank_account || '',
        amount_cents: line.amount_cents,
      };
    });
  const byKind = {};
  const byMonth = {};
  for (const row of rows) {
    byKind[row.kind] = (byKind[row.kind] || 0) + row.amount_cents;
    const month = row.date.slice(0, 7);
    byMonth[month] = (byMonth[month] || 0) + row.amount_cents;
  }
  return {
    from,
    to,
    rows,
    kind_labels: KIND_LABELS,
    totals: {
      total_cents: rows.reduce((sum, row) => sum + row.amount_cents, 0),
      bank_charges_cents: rows.filter((row) => row.account_code === '6700').reduce((sum, row) => sum + row.amount_cents, 0),
      card_fees_cents: rows.filter((row) => row.account_code === '6710').reduce((sum, row) => sum + row.amount_cents, 0),
      by_kind: byKind,
      by_month: byMonth,
    },
  };
}

module.exports = { bankChargesReport };
