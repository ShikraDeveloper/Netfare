import { api } from '../api.js';
import { store } from '../store.js';
import {
  companyMark,
  emptyState,
  esc,
  fmtDate,
  fmtMoney,
  icon,
  portalTypeLabel,
  setHeader,
  statusBadge,
  todayISO,
  pageRecord,
  moreMenuHtml,
  numberCardHtml,
  entryTimeHtml,
} from '../ui.js';
import { bindCorrections, correctButtonHtml } from '../corrections.js';
import { openPortalModal } from './portals.js';
import { bindPortalActions } from './portal-detail/actions.js';

function visaApplicantLine(row) {
  if (!row.visa_id) return '';
  return [
    row.visa_number ? `Visa ${row.visa_number}` : '',
    row.visa_applicant_name ? `Applicant: ${row.visa_applicant_name}` : '',
    row.visa_nationality,
    row.visa_passport_number ? `Passport ${row.visa_passport_number}` : '',
  ].filter(Boolean).join(' · ');
}

export async function render(container, { params, query } = {}) {
  const id = Number(params?.[0]);
  const portal = await api.get(`/portals/${id}`);
  const isCredit = portal.settlement === 'credit';

  // Credit accounts are supplier subledgers, not deposit wallets: fetch their
  // bill/payment activity from the same ledger endpoint used by the Ledger view.
  const creditLedger = isCredit
    ? await api.get(`/portals/${id}/ledger`, {
      from: query?.get('from') || undefined,
      to: query?.get('to') || undefined,
    })
    : null;

  const creditRefundCount = isCredit ? Number(creditLedger.counts.period_refunds || 0) : 0;
  const hasCreditRefunds = isCredit && creditRefundCount > 0;
  const settings = store.settings || {};
  const company = settings.company_name || 'My Company';
  const canWithdraw = portal.balance_cents > 0;

  // Statement period. With no query the whole history is used, so the printed
  // document is complete by default.
  let defaultFrom;
  let defaultTo;
  let from;
  let to;
  if (isCredit) {
    defaultFrom = creditLedger.default_from;
    defaultTo = creditLedger.default_to;
    from = creditLedger.from;
    to = creditLedger.to;
  } else {
    const activityDates = [
      ...portal.topups.map((topup) => topup.topup_date),
      ...portal.refunds.map((refund) => refund.refund_date),
      ...portal.settlements.map((settlement) => settlement.payment_date),
    ].filter(Boolean).sort();
    defaultFrom = activityDates[0] || todayISO();
    const lastActivity = activityDates[activityDates.length - 1] || todayISO();
    defaultTo = lastActivity > todayISO() ? lastActivity : todayISO();
    from = query?.get('from') || defaultFrom;
    to = query?.get('to') || defaultTo;
    if (from > to) [from, to] = [to, from];
  }
  const periodText = from === to
    ? fmtDate(from, { long: true })
    : `${fmtDate(from, { long: true })} – ${fmtDate(to, { long: true })}`;

  // One main action (Top up); everything else is in the More menu.
  const actions = [];
  const menu = [];
  menu.push(`<a class="btn btn-ghost" href="#/portals/${id}/ledger">${icon('journal', 15)}<span>Ledger</span></a>`);
  if (!isCredit) menu.push(`<a class="btn btn-ghost" href="#/portals/${id}/reconcile">${icon('check', 15)}<span>Reconcile</span></a>`);
  menu.push(`<button class="btn btn-ghost" data-action="print">${icon('print', 15)}<span>Print / PDF</span></button>`);
  menu.push(`<button class="btn btn-ghost" data-action="edit">${icon('edit', 15)}<span>Edit</span></button>`);
  if (portal.is_active) {
    menu.push(`<button class="btn btn-ghost" data-action="archive">${icon('archive', 15)}<span>Archive</span></button>`);
  } else {
    menu.push(`<button class="btn btn-ghost" data-action="restore">${icon('refresh', 15)}<span>Restore</span></button>`);
  }
  menu.push(`<a class="btn btn-ghost" href="#/portals"><span>All portals</span></a>`);
  if (portal.is_active) actions.push(`<button class="btn btn-primary" data-action="topup">${icon('plus', 15)}<span>Top up</span></button>`);

  pageRecord(portal);
  setHeader({
    title: portal.name,
    actions: actions.join('') + moreMenuHtml(menu),
  });

  const movements = [
    ...portal.topups.map((topup) => ({
      date: topup.topup_date,
      created_at: topup.created_at || '',
      order: 0,
      ref: topup.number,
      label: `Top-up ${topup.number}`,
      detail: `${topup.method || 'Top-up'}${topup.deposit_account_name ? ` · ${topup.deposit_account_name}` : ''}${topup.reference ? ` · ${topup.reference}` : ''}${topup.bank_charges_cents ? ` · bank charges ${fmtMoney(topup.bank_charges_cents)}` : ''}`,
      inCents: topup.amount_cents,
      outCents: 0,
      source: 'portal_topup',
      voidKind: 'topup',
      voidId: topup.id,
      correct: ['topup', topup],
    })),
    ...portal.credits.map((credit) => ({
      date: credit.credit_date,
      created_at: credit.created_at || '',
      order: 1,
      ref: credit.number,
      label: `Supplier credit${credit.supplier_credit_number ? ` ${credit.supplier_credit_number}` : ''}`,
      detail: [
        credit.bill_number ? `Bill ${credit.bill_number}` : '',
        credit.notes || 'Credited to this wallet',
      ].filter(Boolean).join(' · '),
      inCents: credit.amount_cents,
      outCents: 0,
      source: 'portal_credit',
      voidKind: 'credit',
      voidId: credit.id,
      correct: ['portal_credit', credit],
    })),
    ...portal.refunds.map((refund) => ({
      date: refund.refund_date,
      created_at: refund.created_at || '',
      order: 2,
      ref: '',
      label: 'Withdrawal to bank',
      detail: `${refund.method || 'Withdrawal'}${refund.payment_account_name ? ` · ${refund.payment_account_name}` : ''}${refund.reference ? ` · ${refund.reference}` : ''}`,
      inCents: 0,
      outCents: refund.amount_cents,
      source: 'portal_refund',
      voidKind: 'refund',
      voidId: refund.id,
      correct: ['portal_refund', refund],
    })),
    ...portal.settlements.map((settlement) => ({
      date: settlement.payment_date,
      created_at: settlement.created_at || '',
      order: 3,
      ref: settlement.number,
      label: `${settlement.bill_number} · ${settlement.vendor_name}`,
      detail: settlement.booking_id
        ? `Booking cost settled from wallet`
        : settlement.visa_id
          ? `Visa cost settled from wallet`
          : 'Bill settled from wallet',
      inCents: 0,
      outCents: settlement.amount_cents,
      source: 'portal_settle',
      billId: settlement.bill_id,
      deleteId: settlement.id,
      deletable: true,
      visa_id: settlement.visa_id,
      visa_number: settlement.visa_number,
      visa_applicant_name: settlement.visa_applicant_name,
      visa_nationality: settlement.visa_nationality,
      visa_passport_number: settlement.visa_passport_number,
    })),
  ].sort((a, b) => {
    // By date, then by when each was entered.
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
    return a.order - b.order;
  });

  // Running balance over the full history, so a period statement can show the
  // opening balance and a balance after every movement.
  let runningCents = 0;
  const ledger = movements.map((movement) => {
    runningCents += movement.inCents - movement.outCents;
    return { ...movement, balanceCents: runningCents };
  });

  let openingCents;
  let periodRows;
  let periodInCents;
  let periodOutCents;
  let periodInCount;
  let periodOutCount;
  let closingCents;

  if (isCredit) {
    openingCents = creditLedger.opening_cents;
    periodRows = creditLedger.rows.map((row) => ({
      ...row,
      ref: row.reference,
      label: row.description,
      inCents: row.credit_cents,
      outCents: row.debit_cents,
      balanceCents: row.balance_cents,
    }));
    periodInCents = creditLedger.total_credit_cents;
    periodOutCents = creditLedger.total_debit_cents;
    periodInCount = creditLedger.counts.period_bills + creditRefundCount;
    periodOutCount = creditLedger.counts.period_payments;
    closingCents = creditLedger.closing_cents;
  } else {
    openingCents = ledger
      .filter((movement) => movement.date < from)
      .reduce((sum, movement) => sum + movement.inCents - movement.outCents, 0);
    periodRows = ledger.filter((movement) => movement.date >= from && movement.date <= to);
    periodInCents = periodRows.reduce((sum, movement) => sum + movement.inCents, 0);
    periodOutCents = periodRows.reduce((sum, movement) => sum + movement.outCents, 0);
    periodInCount = periodRows.filter((movement) => movement.inCents > 0).length;
    periodOutCount = periodRows.filter((movement) => movement.outCents > 0).length;
    closingCents = openingCents + periodInCents - periodOutCents;
  }

  const statementRows = periodRows.length
    ? periodRows.map((row) => `
        <tr>
          <td class="nowrap">${esc(fmtDate(row.date))}${entryTimeHtml(row.date, row.created_at)}</td>
          <td class="ref">${esc(row.ref || '—')}</td>
          <td>
            <div>${esc(row.label)}</div>
            <div class="cell-sub">${esc(row.detail)}</div>
            ${row.visa_id ? `<div class="cell-sub">${esc(visaApplicantLine(row))}</div>` : ''}
          </td>
          <td class="num">${row.inCents ? fmtMoney(row.inCents) : ''}</td>
          <td class="num">${row.outCents ? fmtMoney(row.outCents) : ''}</td>
          <td class="num balance-cell">${fmtMoney(row.balanceCents)}</td>
        </tr>
      `).join('')
    : `<tr><td colspan="6" class="muted">${isCredit ? 'No bills or payments in this period.' : 'No wallet activity in this period.'}</td></tr>`;

  const walletHistory = ledger
    .slice()
    .reverse()
    .filter((row) => ['portal_topup', 'portal_credit', 'portal_refund'].includes(row.source))
    .map((row) => `
      <div class="payment-item">
        <div class="payment-icon">${icon(row.source === 'portal_topup' ? 'wallet' : row.source === 'portal_credit' ? 'bill' : 'arrowUp', 15)}</div>
        <div class="payment-main">
          <strong>${esc(row.label)}</strong>
          <span>${esc(fmtDate(row.date))} · ${esc(row.detail)}</span>
        </div>
        <div class="payment-amount ${row.inCents ? 'margin-positive' : ''}">${row.inCents ? `+${fmtMoney(row.inCents)}` : `−${fmtMoney(row.outCents)}`}</div>
        ${row.correct ? correctButtonHtml(...row.correct) : ''}
        ${row.voidKind ? `<button class="icon-btn danger" data-void-portal="${row.voidId}" data-void-kind="${row.voidKind}" title="Void ${row.voidKind === 'topup' ? 'top-up' : row.voidKind}">${icon('trash', 16)}</button>` : ''}
      </div>
    `).join('');

  const settlementRows = portal.settlements.length
    ? portal.settlements.map((settlement) => `
        <div class="payment-item">
          <div class="payment-icon">${icon('bill', 15)}</div>
          <div class="payment-main">
            <strong>${esc(settlement.bill_number)} · ${esc(settlement.vendor_name)}</strong>
            <span>${esc(fmtDate(settlement.payment_date))} · ${esc(settlement.number)}${settlement.booking_id ? ' · from a booking' : settlement.visa_id ? ' · from a visa' : ''}</span>
            ${settlement.visa_id ? `<span>${esc(visaApplicantLine(settlement))}</span>` : ''}
          </div>
          <div class="payment-amount">${fmtMoney(settlement.amount_cents)}</div>
          <button class="icon-btn danger" data-void-settlement="${settlement.id}" title="Void this wallet settlement">${icon('trash', 16)}</button>
          <a class="icon-btn" href="#/bills/${settlement.bill_id}" title="Open bill">${icon('chevron', 16)}</a>
        </div>
      `).join('')
    : `<div class="muted" style="font-size:12.5px;padding:6px 0">No settlements yet</div>`;

  const openBillRows = portal.open_bills.length
    ? portal.open_bills.map((bill) => `
        <div class="payment-item">
          <div class="payment-icon">${icon('bill', 15)}</div>
          <div class="payment-main">
            <strong>${esc(bill.number)} · ${esc(fmtDate(bill.bill_date))}</strong>
            <span>Total ${fmtMoney(bill.total_cents)} · Paid ${fmtMoney(bill.amount_paid_cents)}${bill.booking_id ? ' · from a booking' : bill.visa_id ? ' · from a visa' : ''}</span>
            ${bill.visa_id ? `<span>${esc(visaApplicantLine(bill))}</span>` : ''}
          </div>
          <div class="payment-amount">${fmtMoney(bill.balance_cents)} <small class="muted">due</small></div>
          <a class="icon-btn" href="#/bills/${bill.id}" title="Open bill">${icon('chevron', 16)}</a>
        </div>
      `).join('')
    : `<div class="muted" style="font-size:12.5px;padding:6px 0">${portal.vendor_name ? 'No open bills for this supplier.' : 'Link a supplier to see their payable bills here.'}</div>`;

  const creditPaymentRows = isCredit
    ? periodRows
      .filter((row) => row.kind === 'bill_payment' || row.kind === 'supplier_refund')
      .slice()
      .reverse()
      .map((row) => {
        const isRefund = row.kind === 'supplier_refund';
        return `
          <div class="payment-item">
            <div class="payment-icon">${icon(isRefund ? 'arrowUp' : 'check', 15)}</div>
            <div class="payment-main">
              <strong>${esc(row.ref)} · ${esc(row.label)}</strong>
              <span>${esc(fmtDate(row.date))}${row.detail ? ` · ${esc(row.detail)}` : ''}</span>
            </div>
            <div class="payment-amount margin-positive">${isRefund ? `+${fmtMoney(row.inCents)}` : fmtMoney(row.outCents)}</div>
            <a class="icon-btn" href="#/bills/${row.bill_id}" title="Open bill">${icon('chevron', 16)}</a>
          </div>
        `;
      }).join('')
    : '';

  const creditPaymentCard = isCredit ? `
    <div class="card">
      <div class="card-head">
        <div class="card-title"><h2>${hasCreditRefunds ? 'Payments & refunds' : 'Bill payments'}</h2></div>
      </div>
      <div class="card-body" ${creditPaymentRows ? 'style="padding:4px 20px"' : ''}>
        ${creditPaymentRows || emptyState({
    iconName: 'check',
    title: 'No payments in this period',
  })}
      </div>
    </div>
  ` : '';

  // A credit account can be topped up too: the money pays its oldest open
  // bills, and whatever is left waits as an advance for the next ones.
  const creditTopupCard = isCredit ? `
    <div class="card">
      <div class="card-head">
        <div class="card-title"><h2>Top-ups</h2></div>
        <div style="display:flex;gap:6px">
          ${canWithdraw ? `<button class="btn btn-secondary btn-sm" data-action="withdraw">${icon('arrowUp', 14)} Withdraw</button>` : ''}
        </div>
      </div>
      <div class="card-body" ${walletHistory ? 'style="padding:4px 20px"' : ''}>
        ${walletHistory || emptyState({
    iconName: 'wallet',
    title: 'No top-ups yet',
  })}
      </div>
    </div>
  ` : '';

  const walletCards = isCredit ? '' : `
    <div class="card">
      <div class="card-head">
        <div class="card-title"><h2>Wallet movements</h2></div>
        <div style="display:flex;gap:6px">
          ${canWithdraw ? `<button class="btn btn-secondary btn-sm" data-action="withdraw">${icon('arrowUp', 14)} Withdraw</button>` : ''}
          ${portal.is_active ? `<button class="btn btn-primary btn-sm" data-action="topup">${icon('plus', 14)} Top up</button>` : ''}
        </div>
      </div>
      <div class="card-body" ${walletHistory ? 'style="padding:4px 20px"' : ''}>
        ${walletHistory || emptyState({
    iconName: 'wallet',
    title: 'No money moved yet',
  })}
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <div class="card-title"><h2>Settled bills</h2></div>
      </div>
      <div class="card-body" ${portal.settlements.length ? 'style="padding:4px 20px"' : ''}>${settlementRows}</div>
    </div>
  `;

  const kpiCards = isCredit
    ? [
      numberCardHtml({ label: 'Balance due', cents: portal.outstanding_ap_cents }),
      numberCardHtml({ label: hasCreditRefunds ? 'Billed / refunded' : 'Billed', cents: creditLedger.total_credit_cents }),
      numberCardHtml({ label: 'Paid', cents: creditLedger.total_debit_cents }),
      portal.credit_limit_cents ? numberCardHtml({ label: 'Credit available', cents: portal.credit_available_cents }) : '',
    ].join('')
    : [
      numberCardHtml({ label: 'Wallet', cents: portal.balance_cents }),
      numberCardHtml({ label: 'Topped up', cents: portal.topup_total_cents }),
      numberCardHtml({ label: 'Used on bookings', cents: portal.consumed_total_cents }),
      numberCardHtml({ label: 'Supplier payable', cents: portal.outstanding_ap_cents }),
    ].join('');

  container.innerHTML = `
    <div class="kpi-grid no-print">
      ${kpiCards}
    </div>

    <div class="stmt-toolbar no-print">
      <div class="field">
        <label for="stmt-from">Statement from</label>
        <input class="input" id="stmt-from" type="date" value="${esc(from)}">
      </div>
      <div class="field">
        <label for="stmt-to">to</label>
        <input class="input" id="stmt-to" type="date" value="${esc(to)}">
      </div>
      <button class="btn btn-secondary btn-sm" data-action="apply-range">${icon('refresh', 14)}<span>Apply</span></button>
      <div class="stmt-presets">
        <button class="btn btn-ghost btn-sm" data-preset="month">This month</button>
        <button class="btn btn-ghost btn-sm" data-preset="year">This year</button>
        <button class="btn btn-ghost btn-sm" data-preset="all">All time</button>
      </div>
    </div>


    <div class="doc-wrap">
      <div class="doc">
        <div class="doc-head">
          <div class="doc-brand">
            ${companyMark(company)}
            <div>
              <div class="doc-company-name">${esc(company)}</div>
              <div class="doc-company-detail">${esc([settings.company_address, settings.company_email, settings.company_phone].filter(Boolean).join('\n'))}</div>
            </div>
          </div>
          <div class="doc-meta">
            <div class="doc-kind">${isCredit ? 'Supplier account statement' : 'Supplier portal statement'}</div>
            <div class="doc-number">${esc(portal.name)}</div>
            <div class="doc-status">${statusBadge(portal.settlement)}</div>
            <dl class="doc-meta-grid">
              <dt>Period</dt><dd>${esc(periodText)}</dd>
              <dt>Type</dt><dd>${esc(portalTypeLabel(portal.portal_type))}</dd>
              <dt>Supplier</dt><dd>${esc(portal.vendor_name || '—')}</dd>
              <dt>Generated</dt><dd>${esc(fmtDate(todayISO(), { long: true }))}</dd>
            </dl>
          </div>
        </div>

        <div class="doc-parties">
          <div>
            <div class="doc-label">Portal account</div>
            <div class="doc-party-name">${esc(portal.name)}</div>
            <div class="doc-party-detail">${esc([
      portalTypeLabel(portal.portal_type),
      portal.settlement === 'prepaid' ? 'Prepaid wallet' : 'Credit account',
      portal.login_ref ? `Login: ${portal.login_ref}` : '',
    ].filter(Boolean).join('\n'))}</div>
          </div>
          <div>
            <div class="doc-label">Supplier</div>
            <div class="doc-party-name">${esc(portal.vendor_name || 'Not linked')}</div>
            <div class="doc-party-detail">${esc([
      portal.credit_limit_cents ? `Credit limit: ${fmtMoney(portal.credit_limit_cents)}` : '',
      portal.notes || '',
    ].filter(Boolean).join('\n'))}</div>
          </div>
        </div>

        <div class="doc-items-wrap" tabindex="0" role="region" aria-label="Line items">
          <div class="doc-label" style="margin-bottom:8px">${isCredit ? (hasCreditRefunds ? 'Bills, payments & refunds' : 'Bills & payments') : 'Wallet activity'}</div>
          <table class="doc-items stmt-items"><caption class="sr-only">${esc(portal.name)} statement</caption>
            <thead>
              <tr>
                <th scope="col" style="width:13%">Date</th>
                <th scope="col" style="width:18%">Reference</th>
                <th scope="col">Description</th>
                <th scope="col" class="num" style="width:12%">${isCredit ? (hasCreditRefunds ? 'Billed / refunded' : 'Billed') : 'In'}</th>
                <th scope="col" class="num" style="width:12%">${isCredit ? 'Paid' : 'Out'}</th>
                <th scope="col" class="num" style="width:15%">Balance</th>
              </tr>
            </thead>
            <tbody>${statementRows}</tbody>
          </table>
        </div>

        <div class="doc-total-area">
          <div class="doc-notes">
            <strong>Notes</strong>
            ${isCredit
    ? `This statement covers bills, payments and supplier refunds with ${esc(portal.vendor_name || 'the supplier')}. Bills and supplier refunds increase the amount payable; payments reduce it.`
    : `This statement covers the deposit held with ${esc(portal.vendor_name || 'the supplier')}. Opening, movement and closing balances are derived from posted top-ups, withdrawals and bill settlements.`}
            ${portal.outstanding_ap_cents ? `\n${isCredit ? 'Amount payable not settled yet' : 'Supplier payable not settled yet'}: ${fmtMoney(portal.outstanding_ap_cents)} across ${portal.open_bills.length} open bill${portal.open_bills.length === 1 ? '' : 's'}.` : ''}
          </div>
          <div class="doc-totals">
            <div class="totals-row"><span>Opening balance</span><span>${fmtMoney(openingCents)}</span></div>
            <div class="totals-row"><span>${isCredit ? (hasCreditRefunds ? 'Total billed / refunded' : 'Total billed') : 'Total in'} (${periodInCount})</span><span>${fmtMoney(periodInCents)}</span></div>
            <div class="totals-row"><span>${isCredit ? 'Total paid' : 'Total out'} (${periodOutCount})</span><span>${fmtMoney(periodOutCents)}</span></div>
            <div class="totals-row total"><span>Closing balance</span><span>${fmtMoney(closingCents)}</span></div>
            ${closingCents !== (isCredit ? portal.outstanding_ap_cents : portal.balance_cents)
    ? `<div class="totals-row balance"><span>${isCredit ? 'Current payable' : 'Current wallet balance'}</span><span>${fmtMoney(isCredit ? portal.outstanding_ap_cents : portal.balance_cents)}</span></div>`
    : ''}
          </div>
        </div>

        <div class="doc-foot">
          <div class="doc-foot-meta">${esc(company)} · Netfare</div>
          <div class="doc-foot-meta">Generated ${esc(fmtDate(todayISO(), { long: true }))}</div>
        </div>
      </div>
    </div>

    <div class="detail-grid no-print">
      ${walletCards}${creditTopupCard}${creditPaymentCard}

      <div class="card">
        <div class="card-head">
          <div class="card-title"><h2>Supplier payable</h2></div>
          ${portal.is_active && portal.balance_cents > 0 && portal.open_bills.length
    ? `<button class="btn btn-primary btn-sm" data-action="settle">${icon('check', 14)} Settle</button>` : ''}
        </div>
        <div class="card-body" ${portal.open_bills.length ? 'style="padding:4px 20px"' : ''}>${openBillRows}</div>
      </div>

      <div class="card">
        <div class="card-head">
          <div class="card-title"><h2>Portal details</h2></div>
          <div style="display:flex;gap:6px">
            <button class="btn btn-secondary btn-sm" data-action="edit">${icon('edit', 14)} Edit</button>
            <button class="icon-btn danger" data-action="delete" title="Delete portal">${icon('trash', 16)}</button>
          </div>
        </div>
        <div class="card-body">
          <dl class="doc-meta-grid" style="grid-template-columns:120px 1fr">
            <dt>Type</dt><dd>${esc(portalTypeLabel(portal.portal_type))}</dd>
            <dt>Terms</dt><dd>${statusBadge(portal.settlement)}</dd>
            <dt>Supplier</dt><dd>${portal.vendor_name ? esc(portal.vendor_name) : '<span class="muted">Not linked</span>'}</dd>
            <dt>Credit limit</dt><dd>${portal.credit_limit_cents ? fmtMoney(portal.credit_limit_cents) : '—'}</dd>
            <dt>Login / URL</dt><dd>${esc(portal.login_ref || '—')}</dd>
            <dt>Notes</dt><dd>${esc(portal.notes || '—')}</dd>
          </dl>
        </div>
      </div>
    </div>
  `;

  function rangeHash(nextFrom, nextTo) {
    const params = new URLSearchParams();
    if (nextFrom !== defaultFrom) params.set('from', nextFrom);
    if (nextTo !== defaultTo) params.set('to', nextTo);
    const qs = params.toString();
    return `#/portals/${id}${qs ? `?${qs}` : ''}`;
  }

  function goRange(nextFrom, nextTo) {
    location.hash = rangeHash(nextFrom, nextTo);
  }

  function refresh() {
    return render(container, { params: [String(id)], query });
  }
  bindCorrections(container, refresh);

  // After a movement, keep the chosen statement period but widen it when the
  // new movement falls outside, so the user can see what they just recorded.
  function refreshIncluding(dateISO) {
    const nextFrom = dateISO && dateISO < from ? dateISO : from;
    const nextTo = dateISO && dateISO > to ? dateISO : to;
    if (nextFrom !== from || nextTo !== to) {
      goRange(nextFrom, nextTo);
    } else {
      refresh();
    }
  }

  function on(selector, handler) {
    document.querySelectorAll(selector).forEach((element) => element.addEventListener('click', handler));
  }

  on('[data-action="print"]', () => {
    const previousTitle = document.title;
    const range = from === to ? from : `${from} to ${to}`;
    document.title = `${portal.name} statement ${range}`;
    const restore = () => { document.title = previousTitle; };
    window.addEventListener('afterprint', restore, { once: true });
    window.print();
    setTimeout(restore, 2000);
  });

  const fromInput = container.querySelector('#stmt-from');
  const toInput = container.querySelector('#stmt-to');
  const applyRange = () => {
    let nextFrom = fromInput?.value || defaultFrom;
    let nextTo = toInput?.value || defaultTo;
    if (nextFrom > nextTo) [nextFrom, nextTo] = [nextTo, nextFrom];
    goRange(nextFrom, nextTo);
  };
  container.querySelector('[data-action="apply-range"]')?.addEventListener('click', applyRange);
  container.querySelectorAll('[data-preset]').forEach((button) => {
    button.addEventListener('click', () => {
      const preset = button.dataset.preset;
      if (preset === 'all') {
        goRange(defaultFrom, defaultTo);
      } else if (preset === 'month') {
        goRange(`${todayISO().slice(0, 7)}-01`, todayISO());
      } else if (preset === 'year') {
        goRange(`${todayISO().slice(0, 4)}-01-01`, todayISO());
      }
    });
  });
  [fromInput, toInput].filter(Boolean).forEach((input) => {
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        applyRange();
      }
    });
  });

  on('[data-action="edit"]', () => openPortalModal({ portal, onSaved: () => refresh() }));

  bindPortalActions({ portal, id, refresh, refreshIncluding });

  // Reconciliation links arrive as #/portals/:id?record=topup&date=…&amount=…
  // Open the matching modal with the imported values filled in, then strip the
  // params so a refresh (or a save) does not reopen it.
  const record = query?.get('record');
  if (record === 'topup' || record === 'withdraw' || record === 'settle') {
    const trigger = container.querySelector(`[data-action="${record}"]`);
    if (trigger) {
      const date = query.get('date');
      const amount = query.get('amount');
      const reference = query.get('reference');

      ['record', 'date', 'amount', 'reference'].forEach((key) => query.delete(key));
      const rest = query.toString();
      history.replaceState(null, '', `#/portals/${id}${rest ? `?${rest}` : ''}`);

      trigger.click();

      const fill = (elementId, value) => {
        const input = document.getElementById(elementId);
        if (input && value) input.value = value;
      };
      if (record === 'topup') {
        fill('tu-date', date);
        fill('tu-amount', amount);
        fill('tu-ref', reference);
      } else if (record === 'withdraw') {
        fill('wd-date', date);
        fill('wd-amount', amount);
        fill('wd-ref', reference);
      } else {
        fill('st-date', date);
        fill('st-amount', amount);
      }
    }
  }

  return () => {};
}
