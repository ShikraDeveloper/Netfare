'use strict';

// The DSR laid out like a travel counter's daily report: sales by type with
// how each sale was settled, cancellations and refunds, money collected for
// older invoices, money paid out, and a cash and bank summary.

const FEE_CODES = new Set(['4300', '4310']);

// Payment methods as the counter counts them.
function modeOf(method) {
  const value = String(method || '').toLowerCase();
  if (value.includes('cash')) return 'cash';
  if (value.includes('card') || value.includes('payment link')) return 'card';
  if (value.includes('bank') || value.includes('cheque') || value.includes('check') || value.includes('transfer')) return 'bank';
  return 'other';
}

const emptySplit = () => ({ cash: 0, card: 0, bank: 0, other: 0, credit: 0 });

const FLOW_LABELS = {
  payment: 'Customer payments',
  advance: 'Customer advances',
  receipt: 'Customer receipts',
  advance_refund: 'Advance refunds',
  bill_payment: 'Supplier payments',
  portal_topup: 'Portal top-ups',
  portal_refund: 'Portal withdrawals',
  cash_deposit: 'Cash deposited / transferred',
  customer_refund: 'Customer refunds',
  cancellation_refund: 'Cancellation refunds',
  credit_refund: 'Credit note refunds',
  supplier_refund: 'Supplier refunds',
  refund: 'Supplier refunds received',
  customer_credit_refund: 'Credit note refunds',
  cheque: 'Cheques',
  manual: 'Journal entries and expenses',
  deposit_collect: 'Visa security deposits received',
  deposit_to_supplier: 'Visa deposits paid to suppliers',
  deposit_supplier_return: 'Visa deposits returned by suppliers',
  deposit_refund: 'Visa deposit refunds',
  opening_balance: 'Opening balances',
  petty_cash_count: 'Petty cash count differences',
  card_settlement: 'Card & payment link settlements',
  void: 'Reversals (voids)',
  bank_charges: 'Bank charges',
};

function flowLabel(type) {
  return FLOW_LABELS[type] || type.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

function dsrSections(db, start, end, items) {
  const itemById = new Map(items.filter((item) => !item.is_cancellation).map((item) => [item.id, item]));
  const saleIds = [...itemById.keys()];
  const placeholders = saleIds.map(() => '?').join(',') || 'NULL';

  const invoices = db.prepare(`
    SELECT i.id, i.number, i.issue_date, i.created_at, i.status, i.total_cents, i.notes,
           i.booking_id, i.visa_id, c.name AS customer_name,
           b.number AS booking_number, b.pnr, b.destination,
           v.number AS visa_number, v.applicant_name, v.destination_country, v.visa_type
    FROM invoices i
    JOIN customers c ON c.id = i.customer_id
    LEFT JOIN bookings b ON b.id = i.booking_id
    LEFT JOIN visa_applications v ON v.id = i.visa_id
    WHERE i.id IN (${placeholders})
    ORDER BY i.issue_date, i.created_at, i.id
  `).all(...saleIds);

  const lines = new Map();
  for (const row of db.prepare(`
    SELECT ii.invoice_id, ii.description, ii.amount_cents, a.code
    FROM invoice_items ii JOIN accounts a ON a.id = ii.account_id
    WHERE ii.invoice_id IN (${placeholders})
    ORDER BY ii.sort_order, ii.id
  `).all(...saleIds)) {
    if (!lines.has(row.invoice_id)) lines.set(row.invoice_id, []);
    lines.get(row.invoice_id).push(row);
  }

  const passengers = new Map();
  for (const row of db.prepare(`
    SELECT bi.booking_id, bi.passenger_name, bi.line_group, bi.item_type, bi.supplier_ref
    FROM booking_items bi
    WHERE bi.passenger_name <> '' AND bi.booking_id IN (
      SELECT booking_id FROM invoices WHERE id IN (${placeholders}) AND booking_id IS NOT NULL)
    ORDER BY bi.sort_order, bi.id
  `).all(...saleIds)) {
    if (!passengers.has(row.booking_id)) passengers.set(row.booking_id, new Map());
    const byName = passengers.get(row.booking_id);
    const entry = byName.get(row.passenger_name) || { name: row.passenger_name, ticket_no: '' };
    if (row.item_type === 'cost' && row.supplier_ref) {
      entry.ticket_no = [entry.ticket_no, row.supplier_ref].filter(Boolean).join(', ');
    }
    byName.set(row.passenger_name, entry);
  }

  // Security deposits received in the period, by visa.
  const depositRows = db.prepare(`
    SELECT d.id, d.number, d.visa_id, d.customer_id, e.event_date AS date, e.created_at, e.amount_cents, e.method,
           c.name AS customer_name, v.number AS visa_number, v.applicant_name
    FROM visa_deposit_events e
    JOIN visa_deposits d ON d.id = e.deposit_id
    JOIN customers c ON c.id = d.customer_id
    JOIN visa_applications v ON v.id = d.visa_id
    WHERE e.event_type = 'collect' AND e.voided_at IS NULL AND e.event_date >= ? AND e.event_date <= ?
    ORDER BY e.event_date, e.id
  `).all(start, end);
  const depositIds = new Set(depositRows.map((row) => row.id));

  // How each sale was settled by the report's end date.
  const settled = new Map();
  for (const row of db.prepare(`
    SELECT invoice_id, method, advance_id, from_receipt, deposit_id, amount_cents FROM payments
    WHERE status = 'posted' AND payment_date <= ? AND invoice_id IN (${placeholders})
  `).all(end, ...saleIds)) {
    const split = settled.get(row.invoice_id) || emptySplit();
    // A deposit received in this period is already counted where it came in
    // (its visa's row or Money collected), so paying from it adds nothing:
    // it only keeps the invoice off "On credit".
    if (row.deposit_id && depositIds.has(row.deposit_id)) split.from_deposit = (split.from_deposit || 0) + row.amount_cents;
    else split[row.advance_id && !row.from_receipt ? 'other' : modeOf(row.method)] += row.amount_cents;
    settled.set(row.invoice_id, split);
  }
  for (const row of db.prepare(`
    SELECT invoice_id, SUM(amount_cents) AS total FROM credit_applications
    WHERE applied_date <= ? AND invoice_id IN (${placeholders}) GROUP BY invoice_id
  `).all(end, ...saleIds)) {
    const split = settled.get(row.invoice_id) || emptySplit();
    split.other += row.total;
    settled.set(row.invoice_id, split);
  }

  const depositsByVisa = new Map();
  for (const row of depositRows) {
    if (!depositsByVisa.has(row.visa_id)) depositsByVisa.set(row.visa_id, []);
    depositsByVisa.get(row.visa_id).push(row);
  }
  const shownDeposits = new Set();

  const tickets = [];
  const visas = [];
  const services = [];
  for (const invoice of invoices) {
    const item = itemById.get(invoice.id);
    const invoiceLines = lines.get(invoice.id) || [];
    const fee = invoiceLines.filter((line) => FEE_CODES.has(line.code)).reduce((sum, line) => sum + line.amount_cents, 0);
    const { from_deposit: fromDeposit = 0, ...split } = settled.get(invoice.id) || emptySplit();
    const cancelled = Boolean(item.cancelled_by);
    const received = split.cash + split.card + split.bank + split.other + fromDeposit;
    split.credit = cancelled ? 0 : Math.max(0, invoice.total_cents - received);
    const row = {
      id: invoice.id,
      number: invoice.number,
      date: invoice.issue_date,
      created_at: invoice.created_at,
      customer_name: invoice.customer_name,
      reference: item.reference,
      reference_id: item.reference_id,
      particulars: item.particulars,
      fare_cents: invoice.total_cents - fee,
      fee_cents: fee,
      total_cents: invoice.total_cents,
      cost_cents: item.cost_cents,
      margin_cents: item.margin_cents,
      split,
      // Not in any column: paid from a visa deposit, or cancelled before it was paid.
      from_deposit_cents: fromDeposit,
      unpaid_cancelled_cents: cancelled ? Math.max(0, invoice.total_cents - received) : 0,
      cancelled_by: item.cancelled_by || null,
      remarks: invoice.notes || '',
      staff: item.staff,
    };
    if (invoice.booking_id) {
      tickets.push({
        ...row,
        pnr: invoice.pnr || '',
        route: invoice.destination || '',
        passengers: [...(passengers.get(invoice.booking_id)?.values() || [])],
      });
    } else if (invoice.visa_id) {
      // A deposit taken in the period shows on the visa's row, and the money
      // received for it is added to the cash / card / bank columns.
      const deposits = depositsByVisa.get(invoice.visa_id) || [];
      for (const deposit of deposits) {
        row.split[modeOf(deposit.method)] += deposit.amount_cents;
        shownDeposits.add(deposit.id);
      }
      visas.push({
        ...row,
        deposit_cents: deposits.reduce((sum, deposit) => sum + deposit.amount_cents, 0),
        deposit_cash_cents: deposits.filter((deposit) => modeOf(deposit.method) === 'cash').reduce((sum, deposit) => sum + deposit.amount_cents, 0),
        deposit_numbers: deposits.map((deposit) => deposit.number),
        applicant_name: invoice.applicant_name || invoice.customer_name,
        country: invoice.destination_country || '',
        visa_type: invoice.visa_type || '',
      });
    } else {
      services.push({ ...row, description: invoiceLines[0]?.description || '' });
    }
  }

  const cancellations = items.filter((item) => item.is_cancellation);

  const refunds = db.prepare(`
    SELECT r.id, r.number, r.refund_date AS date, r.created_at, r.amount_cents, r.method,
           c.name AS customer_name,
           x.number AS cancellation_number, i.number AS invoice_number,
           a.number AS advance_number, cn.number AS credit_number, dp.number AS deposit_number
    FROM refunds r
    JOIN customers c ON c.id = r.party_id
    LEFT JOIN cancellations x ON x.id = r.cancellation_id
    LEFT JOIN invoices i ON i.id = r.invoice_id
    LEFT JOIN customer_advances a ON a.id = r.advance_id
    LEFT JOIN credit_notes cn ON cn.id = r.credit_note_id
    LEFT JOIN visa_deposits dp ON dp.id = r.deposit_id
    WHERE r.refund_type = 'customer' AND r.status = 'paid' AND r.refund_date >= ? AND r.refund_date <= ?
    ORDER BY r.refund_date, r.id
  `).all(start, end).map((row) => ({
    ...row,
    mode: modeOf(row.method),
    against: row.deposit_number
      ? `Visa deposit ${row.deposit_number}`
      : row.cancellation_number ? `Cancellation ${row.cancellation_number}`
      : row.advance_number ? `Advance ${row.advance_number}`
        : row.credit_number ? `Credit note ${row.credit_number}`
          : row.invoice_number ? `Invoice ${row.invoice_number}` : '',
  }));

  // Money received in the period that is not a sale of the period. A payment
  // voided after the period still came in then (the money flows count it), so
  // it stays; only a void inside the period takes it out.
  const voidDate = (alias) => `(SELECT entry_date FROM journal_entries WHERE id = COALESCE(${alias}.void_entry_id,
      (SELECT void_entry_id FROM customer_advances WHERE id = ${alias}.advance_id)))`;
  const livePayment = (alias) => `(${alias}.status = 'posted' OR ${voidDate(alias)} > ?)`;
  const collections = [
    ...db.prepare(`
      SELECT p.id, p.number, p.payment_date AS date, p.created_at, p.amount_cents, p.method,
             c.name AS customer_name, i.number AS invoice_number, i.issue_date AS invoice_date
      FROM payments p
      JOIN invoices i ON i.id = p.invoice_id
      JOIN customers c ON c.id = p.customer_id
      WHERE ${livePayment('p')} AND (p.advance_id IS NULL OR p.from_receipt = 1)
        AND p.payment_date >= ? AND p.payment_date <= ?
        ${saleIds.length ? `AND p.invoice_id NOT IN (${placeholders})` : ''}
    `).all(end, start, end, ...saleIds).map((row) => ({
      ...row, kind: 'payment', against: `Invoice ${row.invoice_number} · ${row.invoice_date}`,
    })),
    ...db.prepare(`
      SELECT * FROM (
        SELECT a.id, a.number, a.advance_date AS date, a.created_at, a.method, a.is_receipt,
               a.amount_cents - COALESCE((SELECT SUM(p.amount_cents) FROM payments p
                 WHERE p.advance_id = a.id AND p.from_receipt = 1 AND ${livePayment('p')}), 0) AS amount_cents,
               c.name AS customer_name, b.number AS booking_number, v.number AS visa_number
        FROM customer_advances a
        JOIN customers c ON c.id = a.customer_id
        LEFT JOIN bookings b ON b.id = a.booking_id
        LEFT JOIN visa_applications v ON v.id = a.visa_id
        WHERE (a.voided_at IS NULL OR (SELECT entry_date FROM journal_entries WHERE id = a.void_entry_id) > ?)
          AND a.advance_date >= ? AND a.advance_date <= ?
      ) WHERE amount_cents > 0
    `).all(end, end, start, end).map((row) => ({
      ...row,
      kind: 'advance',
      against: row.is_receipt ? `Advance · left from receipt ${row.number}` : ['Advance', row.booking_number || row.visa_number].filter(Boolean).join(' · '),
    })),
    ...depositRows.filter((row) => !shownDeposits.has(row.id)).map((row) => ({
      ...row, kind: 'deposit', against: `Visa deposit · ${row.visa_number}${row.applicant_name ? ` (${row.applicant_name})` : ''}`,
    })),
  ].map((row) => ({ ...row, mode: modeOf(row.method) }))
    // By date, then by when each was entered.
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)
      || ((a.created_at || '') < (b.created_at || '') ? -1 : (a.created_at || '') > (b.created_at || '') ? 1 : 0)
      || (a.kind === b.kind ? a.id - b.id : a.kind === 'payment' ? -1 : b.kind === 'payment' ? 1 : a.kind.localeCompare(b.kind)));

  // Cash (1000), petty cash (1020) and the bank movements from the ledger,
  // by what caused them. Every bank account counts in Bank (a second bank
  // too); card clearing (1030) has its own page.
  const cashAccounts = db.prepare(`
    SELECT id, code, name FROM accounts
    WHERE is_cash = 1 AND code <> '1030' ORDER BY code
  `).all();
  const keyOf = (code) => (code === '1000' ? 'cash' : code === '1020' ? 'petty' : 'bank');
  const codes = cashAccounts.map((account) => account.code);
  const marks = codes.map(() => '?').join(', ') || "''";
  const balanceBefore = (code, date) => db.prepare(`
    SELECT COALESCE(SUM(l.debit_cents - l.credit_cents), 0) AS total
    FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
    WHERE a.code = ? AND e.entry_date < ?
  `).get(code, date).total;
  // An entry and its void both in the period cancel out, so neither is
  // counted (a mistake made and voided the same day). Bank charges get their
  // own line, and each top-up names its portal.
  const flows = db.prepare(`
    SELECT a.code,
           CASE WHEN l.description LIKE 'Bank charges ·%' THEN 'bank_charges'
                -- The void of a cash deposit is a move back, not a general reversal.
                WHEN e.id IN (SELECT void_entry_id FROM cash_deposits WHERE void_entry_id IS NOT NULL) THEN 'cash_deposit'
                ELSE e.source_type END AS source_type,
           CASE WHEN e.source_type = 'portal_topup' AND l.description NOT LIKE 'Bank charges ·%'
                THEN (SELECT p.name FROM portal_topups t JOIN supplier_portals p ON p.id = t.portal_id WHERE t.id = e.source_id) END AS detail,
           COUNT(DISTINCT e.id) AS entries,
           COALESCE(SUM(l.debit_cents), 0) AS in_cents, COALESCE(SUM(l.credit_cents), 0) AS out_cents
    FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
    WHERE a.code IN (${marks}) AND e.entry_date >= ? AND e.entry_date <= ?
      AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reversal_of_id = e.id AND r.entry_date >= ? AND r.entry_date <= ?)
      AND NOT EXISTS (SELECT 1 FROM journal_entries o WHERE o.id = e.reversal_of_id AND o.entry_date >= ? AND o.entry_date <= ?)
    GROUP BY 1, 2, 3
  `).all(...codes, start, end, start, end, start, end);
  const byType = new Map();
  const position = {};
  for (const account of cashAccounts) {
    const key = keyOf(account.code);
    const existing = position[key];
    position[key] = existing
      ? { ...existing, label: key === 'bank' ? 'Bank accounts' : existing.label, opening_cents: existing.opening_cents + balanceBefore(account.code, start) }
      : { label: account.name, opening_cents: balanceBefore(account.code, start), in_cents: 0, out_cents: 0 };
  }
  for (const flow of flows) {
    const key = keyOf(flow.code);
    position[key].in_cents += flow.in_cents;
    position[key].out_cents += flow.out_cents;
    const rowKey = `${flow.source_type}:${flow.detail || ''}`;
    const row = byType.get(rowKey) || {
      source_type: flow.source_type, label: flow.detail ? `Top-up · ${flow.detail}` : flowLabel(flow.source_type),
      cash_in_cents: 0, cash_out_cents: 0, bank_in_cents: 0, bank_out_cents: 0, petty_in_cents: 0, petty_out_cents: 0,
    };
    row[`${key}_in_cents`] += flow.in_cents;
    row[`${key}_out_cents`] += flow.out_cents;
    byType.set(rowKey, row);
  }
  for (const key of Object.keys(position)) {
    position[key].closing_cents = position[key].opening_cents + position[key].in_cents - position[key].out_cents;
  }
  const flowRows = [...byType.values()];
  // Money moved between our own accounts (cash to bank, cash to petty cash),
  // and each void of one as a move back on its own date, so the list matches
  // the cash_deposit flows above: a move and its void both in the period are left out.
  const transfers = db.prepare(`
    SELECT d.id, d.number, d.deposit_date AS date, d.amount_cents, d.status, 0 AS reversal,
           f.code AS from_code, f.name AS from_name, t.code AS to_code, t.name AS to_name
    FROM cash_deposits d JOIN accounts f ON f.id = d.from_account_id JOIN accounts t ON t.id = d.to_account_id
    LEFT JOIN journal_entries v ON v.id = d.void_entry_id
    WHERE d.deposit_date >= ? AND d.deposit_date <= ? AND NOT COALESCE(v.entry_date >= ? AND v.entry_date <= ?, 0)
    UNION ALL
    SELECT d.id, d.number, v.entry_date AS date, d.amount_cents, d.status, 1 AS reversal,
           t.code AS from_code, t.name AS from_name, f.code AS to_code, f.name AS to_name
    FROM cash_deposits d JOIN journal_entries v ON v.id = d.void_entry_id
    JOIN accounts f ON f.id = d.from_account_id JOIN accounts t ON t.id = d.to_account_id
    WHERE v.entry_date >= ? AND v.entry_date <= ? AND NOT (d.deposit_date >= ? AND d.deposit_date <= ?)
    ORDER BY 3, 1, 6
  `).all(start, end, start, end, start, end, start, end);
  const cashOut = flowRows.filter((row) => row.cash_out_cents || row.bank_out_cents)
    .sort((a, b) => (b.cash_out_cents + b.bank_out_cents) - (a.cash_out_cents + a.bank_out_cents));
  const cashIn = flowRows.filter((row) => row.cash_in_cents || row.bank_in_cents)
    .sort((a, b) => (b.cash_in_cents + b.bank_in_cents) - (a.cash_in_cents + a.bank_in_cents));

  // Deposit money kept: forfeits and supplier deductions in the period.
  const depositKept = db.prepare(`
    SELECT e.id, e.event_type, e.event_date AS date, e.forfeit_to, e.notes,
           CASE WHEN e.event_type = 'forfeit' THEN e.amount_cents ELSE e.deduction_cents END AS amount_cents,
           d.number, c.name AS customer_name, v.number AS visa_number
    FROM visa_deposit_events e
    JOIN visa_deposits d ON d.id = e.deposit_id
    JOIN customers c ON c.id = d.customer_id
    JOIN visa_applications v ON v.id = d.visa_id
    WHERE e.voided_at IS NULL AND e.event_date >= ? AND e.event_date <= ?
      AND (e.event_type = 'forfeit' OR (e.event_type = 'supplier_return' AND e.deduction_cents > 0))
    ORDER BY e.event_date, e.id
  `).all(start, end).map((row) => ({
    ...row,
    kept_by: row.event_type === 'forfeit' && row.forfeit_to === 'agency' ? 'agency' : 'supplier',
  }));
  const heldAtEnd = db.prepare(`
    SELECT COALESCE(SUM(l.credit_cents - l.debit_cents), 0) AS total
    FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
    WHERE a.code = '2600' AND e.entry_date <= ?
  `).get(end).total;

  const sum = (rows, pick) => rows.reduce((total, row) => total + pick(row), 0);
  const settlement = emptySplit();
  for (const row of [...tickets, ...visas, ...services]) {
    for (const key of Object.keys(settlement)) settlement[key] += row.split[key];
  }
  const collected = emptySplit();
  for (const row of collections) collected[row.mode] += row.amount_cents;

  return {
    tickets,
    visas,
    services,
    cancellations,
    refunds,
    deposit_kept: depositKept,
    collections,
    cash_out: cashOut,
    cash_in: cashIn,
    transfers,
    summary: {
      sales: {
        tickets_cents: sum(tickets, (row) => row.total_cents),
        visas_cents: sum(visas, (row) => row.total_cents),
        services_cents: sum(services, (row) => row.total_cents),
        cancellations_cents: sum(cancellations, (row) => row.sale_cents),
      },
      settlement,
      collected,
      refunds_cents: sum(refunds, (row) => row.amount_cents),
      deposits: {
        received_cents: sum(depositRows, (row) => row.amount_cents),
        refunded_cents: sum(refunds.filter((row) => row.deposit_number), (row) => row.amount_cents),
        kept_cents: sum(depositKept, (row) => row.amount_cents),
        held_at_end_cents: heldAtEnd,
      },
      position,
    },
  };
}

module.exports = { dsrSections, modeOf };
