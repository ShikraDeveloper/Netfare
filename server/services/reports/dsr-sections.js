'use strict';

// The DSR laid out like a travel counter's daily report: sales by type with
// how each sale was settled, cancellations and refunds, money collected for
// older invoices, money paid out, and a cash and bank summary.

const FEE_CODES = new Set(['4300', '4310']);

// Payment methods as the counter counts them.
function modeOf(method) {
  const value = String(method || '').toLowerCase();
  if (value.includes('cash')) return 'cash';
  if (value.includes('card')) return 'card';
  if (value.includes('bank') || value.includes('cheque') || value.includes('check') || value.includes('transfer')) return 'bank';
  return 'other';
}

const emptySplit = () => ({ cash: 0, card: 0, bank: 0, other: 0, credit: 0 });

const FLOW_LABELS = {
  payment: 'Customer payments',
  advance: 'Customer advances',
  advance_refund: 'Advance refunds',
  bill_payment: 'Supplier payments',
  portal_topup: 'Portal top-ups',
  portal_refund: 'Portal withdrawals',
  cash_deposit: 'Cash deposited / transferred',
  customer_refund: 'Customer refunds',
  cancellation_refund: 'Cancellation refunds',
  credit_refund: 'Credit note refunds',
  supplier_refund: 'Supplier refunds',
  cheque: 'Cheques',
  manual: 'Journal entries and expenses',
  deposit_collect: 'Visa security deposits received',
  deposit_to_supplier: 'Visa deposits paid to suppliers',
  deposit_supplier_return: 'Visa deposits returned by suppliers',
  deposit_refund: 'Visa deposit refunds',
  opening_balance: 'Opening balances',
  void: 'Reversals (voids)',
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

  // How each sale was settled by the report's end date.
  const settled = new Map();
  for (const row of db.prepare(`
    SELECT invoice_id, method, advance_id, amount_cents FROM payments
    WHERE status = 'posted' AND payment_date <= ? AND invoice_id IN (${placeholders})
  `).all(end, ...saleIds)) {
    const split = settled.get(row.invoice_id) || emptySplit();
    split[row.advance_id ? 'other' : modeOf(row.method)] += row.amount_cents;
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

  // Security deposits received in the period, by visa.
  const depositRows = db.prepare(`
    SELECT d.id, d.number, d.visa_id, d.customer_id, e.event_date AS date, e.amount_cents, e.method,
           c.name AS customer_name, v.number AS visa_number, v.applicant_name
    FROM visa_deposit_events e
    JOIN visa_deposits d ON d.id = e.deposit_id
    JOIN customers c ON c.id = d.customer_id
    JOIN visa_applications v ON v.id = d.visa_id
    WHERE e.event_type = 'collect' AND e.voided_at IS NULL AND e.event_date >= ? AND e.event_date <= ?
    ORDER BY e.event_date, e.id
  `).all(start, end);
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
    const split = { ...(settled.get(invoice.id) || emptySplit()) };
    const cancelled = Boolean(item.cancelled_by);
    const received = split.cash + split.card + split.bank + split.other;
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
      cancelled_by: item.cancelled_by || null,
      remarks: invoice.notes || '',
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
    SELECT r.id, r.number, r.refund_date AS date, r.amount_cents, r.method,
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

  // Money received in the period that is not a sale of the period.
  const collections = [
    ...db.prepare(`
      SELECT p.id, p.number, p.payment_date AS date, p.amount_cents, p.method,
             c.name AS customer_name, i.number AS invoice_number, i.issue_date AS invoice_date
      FROM payments p
      JOIN invoices i ON i.id = p.invoice_id
      JOIN customers c ON c.id = p.customer_id
      WHERE p.status = 'posted' AND p.advance_id IS NULL
        AND p.payment_date >= ? AND p.payment_date <= ?
        ${saleIds.length ? `AND p.invoice_id NOT IN (${placeholders})` : ''}
    `).all(start, end, ...saleIds).map((row) => ({
      ...row, kind: 'payment', against: `Invoice ${row.invoice_number} · ${row.invoice_date}`,
    })),
    ...db.prepare(`
      SELECT a.id, a.number, a.advance_date AS date, a.amount_cents, a.method,
             c.name AS customer_name, b.number AS booking_number, v.number AS visa_number
      FROM customer_advances a
      JOIN customers c ON c.id = a.customer_id
      LEFT JOIN bookings b ON b.id = a.booking_id
      LEFT JOIN visa_applications v ON v.id = a.visa_id
      WHERE a.voided_at IS NULL AND a.advance_date >= ? AND a.advance_date <= ?
    `).all(start, end).map((row) => ({
      ...row, kind: 'advance', against: ['Advance', row.booking_number || row.visa_number].filter(Boolean).join(' · '),
    })),
    ...depositRows.filter((row) => !shownDeposits.has(row.id)).map((row) => ({
      ...row, kind: 'deposit', against: `Visa deposit · ${row.visa_number}${row.applicant_name ? ` (${row.applicant_name})` : ''}`,
    })),
  ].map((row) => ({ ...row, mode: modeOf(row.method) }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)
      || (a.kind === b.kind ? a.id - b.id : a.kind === 'payment' ? -1 : b.kind === 'payment' ? 1 : a.kind.localeCompare(b.kind)));

  // Cash (1000) and bank (1010) movements from the ledger, by what caused them.
  const cashAccounts = db.prepare("SELECT id, code, name FROM accounts WHERE code IN ('1000', '1010')").all();
  const balanceBefore = (code, date) => db.prepare(`
    SELECT COALESCE(SUM(l.debit_cents - l.credit_cents), 0) AS total
    FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
    WHERE a.code = ? AND e.entry_date < ?
  `).get(code, date).total;
  const flows = db.prepare(`
    SELECT a.code, e.source_type, COUNT(DISTINCT e.id) AS entries,
           COALESCE(SUM(l.debit_cents), 0) AS in_cents, COALESCE(SUM(l.credit_cents), 0) AS out_cents
    FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
    WHERE a.code IN ('1000', '1010') AND e.entry_date >= ? AND e.entry_date <= ?
    GROUP BY a.code, e.source_type
  `).all(start, end);
  const byType = new Map();
  const position = {};
  for (const account of cashAccounts) {
    const key = account.code === '1000' ? 'cash' : 'bank';
    position[key] = { label: account.name, opening_cents: balanceBefore(account.code, start), in_cents: 0, out_cents: 0 };
  }
  for (const flow of flows) {
    const key = flow.code === '1000' ? 'cash' : 'bank';
    position[key].in_cents += flow.in_cents;
    position[key].out_cents += flow.out_cents;
    const row = byType.get(flow.source_type) || {
      source_type: flow.source_type, label: flowLabel(flow.source_type),
      cash_in_cents: 0, cash_out_cents: 0, bank_in_cents: 0, bank_out_cents: 0,
    };
    row[`${key}_in_cents`] += flow.in_cents;
    row[`${key}_out_cents`] += flow.out_cents;
    byType.set(flow.source_type, row);
  }
  for (const key of Object.keys(position)) {
    position[key].closing_cents = position[key].opening_cents + position[key].in_cents - position[key].out_cents;
  }
  const flowRows = [...byType.values()];
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
