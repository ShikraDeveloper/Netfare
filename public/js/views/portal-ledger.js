import { api } from '../api.js';
import { store } from '../store.js';
import {
  esc,
  fmtDate,
  fmtMoney,
  icon,
  portalTypeLabel,
  setHeader,
  statusBadge,
  todayISO,
} from '../ui.js';

function periodText(from, to) {
  return from === to
    ? fmtDate(from, { long: true })
    : `${fmtDate(from, { long: true })} – ${fmtDate(to, { long: true })}`;
}

function ledgerLines(lines) {
  return `
    <div class="ledger-lines">
      ${lines.map((line) => `
        <div class="ledger-line ${line.account_code === '1400' ? 'is-portal' : ''}">
          <span class="code">${esc(line.account_code)}</span>
          <span class="name">${esc(line.account_name)}</span>
          <span class="amt">${line.debit_cents ? `Dr ${fmtMoney(line.debit_cents)}` : `Cr ${fmtMoney(line.credit_cents)}`}</span>
        </div>
      `).join('')}
    </div>
  `;
}

function ledgerRow(row) {
  const hasLines = row.lines.length > 0;
  return `
    <tr class="ledger-row" data-row="${esc(row.key)}">
      <td class="nowrap">${esc(fmtDate(row.date))}</td>
      <td class="ref">${esc(row.reference)}</td>
      <td>
        <div>${esc(row.description)}</div>
        <div class="cell-sub">${esc(row.detail)}</div>
      </td>
      <td class="num">${row.debit_cents ? fmtMoney(row.debit_cents) : ''}</td>
      <td class="num">${row.credit_cents ? fmtMoney(row.credit_cents) : ''}</td>
      <td class="num balance-cell">${fmtMoney(row.balance_cents)}</td>
      <td class="ledger-toggle-col">
        ${hasLines ? `<button type="button" class="icon-btn ledger-toggle" data-toggle="${esc(row.key)}" title="Show journal entry">${icon('chevron', 15)}</button>` : ''}
      </td>
    </tr>
    ${hasLines ? `
      <tr class="ledger-detail" data-detail="${esc(row.key)}">
        <td></td>
        <td colspan="6">
          ${ledgerLines(row.lines)}
          <div class="ledger-entry-meta">Journal entry #${row.entry_id}${row.bill_id ? ` · Bill #${row.bill_id}` : ''}${row.booking_id ? ` · Booking #${row.booking_id}` : ''}${row.visa_id ? ` · Visa #${row.visa_id}` : ''}</div>
        </td>
      </tr>
    ` : ''}
  `;
}

function kpiCard(label, valueCents, meta, iconName, color) {
  return `
    <div class="kpi">
      <div class="kpi-top"><span class="kpi-label">${esc(label)}</span><span class="kpi-icon ${color}">${icon(iconName, 16)}</span></div>
      <div class="kpi-value">${fmtMoney(valueCents)}</div>
      <div class="kpi-meta">${meta}</div>
    </div>
  `;
}

export async function render(container, { params, query } = {}) {
  const id = Number(params?.[0]);
  const data = await api.get(`/portals/${id}/ledger`, {
    from: query?.get('from') || undefined,
    to: query?.get('to') || undefined,
  });

  const { portal, reconciliation } = data;
  const isCredit = portal.settlement === 'credit';
  const hasCreditRefunds = isCredit && Number(data.counts.period_refunds || 0) > 0;
  const settings = store.settings || {};
  const company = settings.company_name || 'My Company';
  const debitCount = data.rows.filter((row) => row.debit_cents > 0).length;
  const creditCount = data.rows.filter((row) => row.credit_cents > 0).length;
  const reconciled = reconciliation ? reconciliation.difference_cents === 0 : false;

  setHeader({
    title: `${portal.name} — Supplier ledger`,
    subtitle: isCredit
      ? `${portalTypeLabel(portal.portal_type)} · ${portal.vendor_name || 'No supplier linked'} · running balance of bills, payments and refunds`
      : `${portalTypeLabel(portal.portal_type)} · ${portal.vendor_name || 'No supplier linked'} · running balance of top-ups and consumption`,
    actions: [
      `<a class="btn btn-ghost" href="#/portals/${id}"><span>Statement</span></a>`,
      isCredit ? '' : `<a class="btn btn-secondary" href="#/portals/${id}/reconcile">${icon('check', 15)}<span>Reconcile</span></a>`,
      `<button class="btn btn-secondary" data-action="print">${icon('print', 15)}<span>Print / PDF</span></button>`,
    ].filter(Boolean).join(''),
  });

  const kpiCards = isCredit
    ? [
      kpiCard('Opening payable', data.opening_cents, fmtDate(data.from), 'bill', 'amber'),
      kpiCard(
        hasCreditRefunds ? 'Billed / refunded' : 'Billed',
        data.total_credit_cents,
        `${data.counts.period_bills} bill${data.counts.period_bills === 1 ? '' : 's'}${hasCreditRefunds ? ` · ${data.counts.period_refunds} refund${data.counts.period_refunds === 1 ? '' : 's'}` : ''} in period`,
        'plus',
        'green',
      ),
      kpiCard('Paid', data.total_debit_cents, `${data.counts.period_payments} payment${data.counts.period_payments === 1 ? '' : 's'} in period`, 'check', 'blue'),
      kpiCard(
        'Closing payable',
        data.closing_cents,
        data.closing_cents === data.current_balance_cents ? 'Matches open bills' : `Current ${fmtMoney(data.current_balance_cents)}`,
        'bill',
        'amber',
      ),
    ].join('')
    : [
      kpiCard('Opening balance', data.opening_cents, esc(fmtDate(data.from)), 'wallet', 'indigo'),
      kpiCard('Top-ups in', data.total_debit_cents, `${debitCount} debit${debitCount === 1 ? '' : 's'} to 1400`, 'plus', 'green'),
      kpiCard('Consumption out', data.total_credit_cents, `${creditCount} credit${creditCount === 1 ? '' : 's'} to 1400`, 'plane', 'amber'),
      kpiCard('Closing balance', data.closing_cents, data.closing_cents === data.current_balance_cents ? 'Matches the wallet' : `Current ${fmtMoney(data.current_balance_cents)}`, 'wallet', 'blue'),
    ].join('');

  const rowsHtml = data.rows.length
    ? data.rows.map(ledgerRow).join('')
    : `<tr><td colspan="7" class="muted">${isCredit ? 'No bills or payments in this period.' : 'No movements in this period.'}</td></tr>`;

  const reconciliationCard = reconciliation ? `
    <div class="card no-print" style="max-width:920px;margin:16px auto 0">
      <div class="card-head">
        <div class="card-title"><h2>Ledger reconciliation</h2><p>Portal subledger vs the general ledger</p></div>
        <span class="badge ${reconciled ? 'badge-paid' : 'badge-overdue'}">${reconciled ? 'Reconciled' : 'Check needed'}</span>
      </div>
      <div class="card-body">
        <div class="recon-grid">
          <div>
            <span class="recon-label">GL ${esc(reconciliation.account_code)} · ${esc(reconciliation.account_name)}</span>
            <span class="recon-value">${fmtMoney(reconciliation.gl_balance_cents)}</span>
          </div>
          <div>
            <span class="recon-label">Sum of all portal balances</span>
            <span class="recon-value">${fmtMoney(reconciliation.portal_total_cents)}</span>
          </div>
          <div>
            <span class="recon-label">Difference</span>
            <span class="recon-value ${reconciled ? '' : 'negative'}">${fmtMoney(reconciliation.difference_cents)}</span>
          </div>
        </div>
        <p class="hint" style="margin-top:12px">
          ${reconciled
    ? `Every portal movement reconciles to account ${esc(reconciliation.account_code)}. A manual journal entry that touches this account would show up here as a difference.`
    : 'A manual journal entry or an untagged movement may have touched this account. Review the general journal before closing the period.'}
        </p>
      </div>
    </div>
  ` : '';

  container.innerHTML = `
    <div class="kpi-grid no-print">
      ${kpiCards}
    </div>

    <div class="stmt-toolbar no-print">
      <div class="field">
        <label for="lg-from">Ledger from</label>
        <input class="input" id="lg-from" type="date" value="${esc(data.from)}">
      </div>
      <div class="field">
        <label for="lg-to">to</label>
        <input class="input" id="lg-to" type="date" value="${esc(data.to)}">
      </div>
      <button class="btn btn-secondary btn-sm" data-action="apply-range">${icon('refresh', 14)}<span>Apply</span></button>
      <div class="stmt-presets">
        <button class="btn btn-ghost btn-sm" data-preset="month">This month</button>
        <button class="btn btn-ghost btn-sm" data-preset="year">This year</button>
        <button class="btn btn-ghost btn-sm" data-preset="all">All time</button>
      </div>
    </div>
    <div class="stmt-hint no-print">${isCredit
    ? 'Every bill, payment and supplier refund is a posted journal entry. Bills and supplier refunds credit Accounts Payable; payments debit it. Open a row to see the double-entry lines.'
    : 'Every movement is a posted journal entry. Debits increase the wallet, credits consume it. Open a row to see the double-entry lines.'}</div>

    <div class="doc-wrap">
      <div class="doc">
        <div class="doc-head">
          <div class="doc-brand">
            <span class="brand-mark">L</span>
            <div>
              <div class="doc-company-name">${esc(company)}</div>
              <div class="doc-company-detail">${esc([settings.company_address, settings.company_email, settings.company_phone].filter(Boolean).join('\n'))}</div>
            </div>
          </div>
          <div class="doc-meta">
            <div class="doc-kind">${isCredit ? 'Supplier account ledger' : 'Supplier ledger'}</div>
            <div class="doc-number">${esc(portal.name)}</div>
            <div class="doc-status">${statusBadge(portal.settlement)}</div>
            <dl class="doc-meta-grid">
              <dt>Period</dt><dd>${esc(periodText(data.from, data.to))}</dd>
              <dt>Account</dt><dd>${esc(data.account_code)} · ${esc(data.account_name)}</dd>
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
            <div class="doc-label">${isCredit ? 'Account summary' : 'Movement summary'}</div>
            <div class="doc-party-detail">${esc(isCredit
      ? [
        `${data.counts.period_bills} bill${data.counts.period_bills === 1 ? '' : 's'} in period`,
        `${data.counts.period_payments} payment${data.counts.period_payments === 1 ? '' : 's'} in period`,
        hasCreditRefunds ? `${data.counts.period_refunds} refund${data.counts.period_refunds === 1 ? '' : 's'} in period` : '',
        portal.credit_limit_cents ? `Credit limit ${fmtMoney(portal.credit_limit_cents)}` : 'No credit limit set',
      ].join('\n')
      : [
        `${data.counts.topups} top-up${data.counts.topups === 1 ? '' : 's'}`,
        `${data.counts.settlements} bill settlement${data.counts.settlements === 1 ? '' : 's'}`,
        `${data.counts.refunds} withdrawal${data.counts.refunds === 1 ? '' : 's'}`,
      ].join('\n'))}</div>
          </div>
        </div>

        <div class="doc-items-wrap">
          <div class="doc-label" style="margin-bottom:8px">${isCredit ? (hasCreditRefunds ? 'Bills, payments & refunds' : 'Bills & payments') : 'Ledger movements'}</div>
          <table class="doc-items ledger-table">
            <thead>
              <tr>
                <th style="width:12%">Date</th>
                <th style="width:15%">Reference</th>
                <th>Description</th>
                <th class="num" style="width:12%">${isCredit ? 'Paid' : 'Debit'}</th>
                <th class="num" style="width:12%">${isCredit ? (hasCreditRefunds ? 'Billed / refunded' : 'Billed') : 'Credit'}</th>
                <th class="num" style="width:13%">Balance</th>
                <th class="ledger-toggle-col"></th>
              </tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
            <tfoot>
              <tr>
                <td colspan="3">Period totals</td>
                <td class="num">${fmtMoney(data.total_debit_cents)}</td>
                <td class="num">${fmtMoney(data.total_credit_cents)}</td>
                <td class="num balance-cell">${fmtMoney(data.closing_cents)}</td>
                <td class="ledger-toggle-col"></td>
              </tr>
            </tfoot>
          </table>
        </div>

        <div class="doc-total-area">
          <div class="doc-notes">
            <strong>Notes</strong>
            ${isCredit
    ? `Bills and supplier refunds increase what you owe to ${esc(portal.vendor_name || 'the supplier')}; payments reduce it. The running balance is the supplier payable after each entry.`
    : 'Wallet top-ups debit Supplier Advances and withdrawals or bill settlements credit it. The running balance is the portal\'s position in that account after each entry.'}
            ${portal.outstanding_ap_cents ? `\nSupplier payable not settled yet: ${fmtMoney(portal.outstanding_ap_cents)}.` : ''}
          </div>
          <div class="doc-totals">
            <div class="totals-row"><span>Opening balance</span><span>${fmtMoney(data.opening_cents)}</span></div>
            <div class="totals-row"><span>${isCredit ? (hasCreditRefunds ? 'Total billed / refunded' : 'Total billed') : 'Total debits'}</span><span>${fmtMoney(data.total_credit_cents)}</span></div>
            <div class="totals-row"><span>${isCredit ? 'Total paid' : 'Total credits'}</span><span>${fmtMoney(data.total_debit_cents)}</span></div>
            <div class="totals-row total"><span>Closing balance</span><span>${fmtMoney(data.closing_cents)}</span></div>
            ${data.closing_cents !== data.current_balance_cents ? `<div class="totals-row balance"><span>${isCredit ? 'Current payable' : 'Current wallet balance'}</span><span>${fmtMoney(data.current_balance_cents)}</span></div>` : ''}
          </div>
        </div>

        <div class="doc-foot">
          <div class="doc-foot-meta">${esc(company)} · Ledgerly</div>
          <div class="doc-foot-meta">Generated ${esc(fmtDate(todayISO(), { long: true }))}</div>
        </div>
      </div>
    </div>

    ${reconciliationCard}
  `;

  function ledgerHash(nextFrom, nextTo) {
    const search = new URLSearchParams();
    if (nextFrom !== data.default_from) search.set('from', nextFrom);
    if (nextTo !== data.default_to) search.set('to', nextTo);
    const qs = search.toString();
    return `#/portals/${id}/ledger${qs ? `?${qs}` : ''}`;
  }

  function goRange(nextFrom, nextTo) {
    location.hash = ledgerHash(nextFrom, nextTo);
  }

  container.querySelectorAll('[data-toggle]').forEach((button) => {
    button.addEventListener('click', () => {
      const key = button.dataset.toggle;
      const detail = container.querySelector(`[data-detail="${key}"]`);
      const row = button.closest('tr');
      if (!detail) return;
      const isOpen = detail.classList.toggle('open');
      row.classList.toggle('is-open', isOpen);
      button.setAttribute('title', isOpen ? 'Hide journal entry' : 'Show journal entry');
    });
  });

  const fromInput = container.querySelector('#lg-from');
  const toInput = container.querySelector('#lg-to');
  const applyRange = () => {
    let nextFrom = fromInput?.value || data.default_from;
    let nextTo = toInput?.value || data.default_to;
    if (nextFrom > nextTo) [nextFrom, nextTo] = [nextTo, nextFrom];
    goRange(nextFrom, nextTo);
  };
  container.querySelector('[data-action="apply-range"]')?.addEventListener('click', applyRange);
  container.querySelectorAll('[data-preset]').forEach((button) => {
    button.addEventListener('click', () => {
      const preset = button.dataset.preset;
      if (preset === 'all') {
        goRange(data.default_from, data.default_to);
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

  container.querySelector('[data-action="print"]')?.addEventListener('click', () => {
    const previousTitle = document.title;
    const range = data.from === data.to ? data.from : `${data.from} to ${data.to}`;
    document.title = `${portal.name} supplier ledger ${range}`;
    const restore = () => { document.title = previousTitle; };
    window.addEventListener('afterprint', restore, { once: true });
    window.print();
    setTimeout(restore, 2000);
  });

  return () => {};
}
