import { api } from '../api.js';
import { store } from '../store.js';
import {
  esc,
  fmtDate,
  fmtMoney,
  icon,
  portalTypeLabel,
  setHeader,
  todayISO,
  toast,
} from '../ui.js';

import {
  buildRows,
  detectMapping,
  matchBadge,
  parseStatement,
  periodText,
  prefillLink,
  selectField,
  statementLine,
  suggestionText,
} from './portal-reconcile/parse.js';

export async function render(container, { params, query } = {}) {
  const id = Number(params?.[0]);
  const [ledger, detail] = await Promise.all([
    api.get(`/portals/${id}/ledger`),
    api.get(`/portals/${id}`),
  ]);
  const portal = ledger.portal;
  if (ledger.mode === 'credit') {
    toast('Credit accounts use the supplier ledger. Reconciliation is for prepaid wallets.');
    location.hash = `#/portals/${id}/ledger`;
    return;
  }
  const openBills = detail.open_bills || [];
  const company = store.settings?.company_name || 'My Company';
  const stashKey = `ledgerly:reconcile:${id}`;

  const state = {
    parsed: null,
    mapping: null,
    built: { rows: [], skipped: 0 },
    result: null,
    from: ledger.from,
    to: ledger.to,
    tolerance: 7,
  };

  setHeader({
    title: `Reconcile ${portal.name}`,
    actions: [
      `<a class="btn btn-ghost" href="#/portals/${id}"><span>Statement</span></a>`,
      `<a class="btn btn-ghost" href="#/portals/${id}/ledger"><span>Ledger</span></a>`,
      `<button class="btn btn-secondary" data-action="print">${icon('print', 15)}<span>Print / PDF</span></button>`,
    ].join(''),
  });

  container.innerHTML = `
    <div class="card no-print" id="rc-import">
      <div class="card-head">
        <div class="card-title"><h2>1 · Import the statement</h2></div>
      </div>
      <div class="card-body">
        <div class="form-grid">
          <div class="field">
            <label for="rc-from">Compare from</label>
            <input class="input" id="rc-from" type="date" value="${esc(ledger.from)}">
          </div>
          <div class="field">
            <label for="rc-to">to</label>
            <input class="input" id="rc-to" type="date" value="${esc(ledger.to)}">
          </div>
          <div class="field">
            <label for="rc-window">Match window (days)</label>
            <input class="input" id="rc-window" type="number" min="0" max="31" step="1" value="7">
          </div>
          <div class="field">
            <label for="rc-file">Statement file</label>
            <input class="input" id="rc-file" type="file" accept=".csv,.tsv,.txt,text/csv,text/plain">
          </div>
          <div class="field full">
            <label for="rc-text">Or paste the rows</label>
            <textarea class="input code-area" id="rc-text" rows="9" spellcheck="false" placeholder="Date,Description,Reference,Credit,Debit,Balance&#10;2026-08-01,Wallet top-up,TOP-102,12000.00,,12000.00&#10;2026-08-10,Ticket DXB-LHR,PNR7XQ,,2900.00,9100.00"></textarea>
          </div>
        </div>
        <div class="recon-actions">
          <button class="btn btn-ghost" data-action="clear-statement">Clear</button>
          <button class="btn btn-primary" data-action="parse">${icon('link', 15)}<span>Parse statement</span></button>
        </div>
      </div>
    </div>

    <div class="card no-print" id="rc-map" hidden></div>
    <div id="rc-results"></div>
  `;

  const textarea = container.querySelector('#rc-text');
  const fileInput = container.querySelector('#rc-file');
  const mapCard = container.querySelector('#rc-map');
  const resultsEl = container.querySelector('#rc-results');

  // Keep a pasted statement around while the user moves between pages.
  try {
    const stashed = sessionStorage.getItem(stashKey);
    if (stashed) textarea.value = stashed;
  } catch { /* storage may be unavailable */ }

  function stash() {
    try {
      if (textarea.value.trim()) sessionStorage.setItem(stashKey, textarea.value);
      else sessionStorage.removeItem(stashKey);
    } catch { /* ignore */ }
  }

  textarea.addEventListener('input', stash);

  function readRange() {
    const from = container.querySelector('#rc-from')?.value || ledger.from;
    const to = container.querySelector('#rc-to')?.value || ledger.to;
    const tolerance = Math.max(0, Math.min(31, Math.round(Number(container.querySelector('#rc-window')?.value) || 0)));
    state.from = from <= to ? from : to;
    state.to = from <= to ? to : from;
    state.tolerance = tolerance;
  }

  function parseNow() {
    readRange();
    const text = textarea.value.trim();
    if (!text) {
      toast('Paste or load the portal statement first', 'error');
      return;
    }
    const parsed = parseStatement(text);
    if (!parsed.rows.length) {
      toast('Could not read any rows from that statement', 'error');
      return;
    }
    state.parsed = parsed;
    state.mapping = detectMapping(parsed);
    renderMapping();
    mapCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  container.querySelector('[data-action="parse"]')?.addEventListener('click', parseNow);

  // Delegated once: re-rendering the mapping card must not stack handlers.
  mapCard.addEventListener('change', (event) => {
    const target = event.target.closest('[data-map]');
    if (!target || !state.mapping) return;
    const field = target.dataset.map;
    if (field === 'layout' || field === 'sign' || field === 'dateFormat') {
      state.mapping[field] = target.value;
    } else {
      state.mapping[field] = target.value === '' ? null : Number(target.value);
    }
    if (field === 'layout') renderMapping();
    else renderPreview();
  });

  container.querySelector('[data-action="clear-statement"]')?.addEventListener('click', () => {
    textarea.value = '';
    stash();
    state.parsed = null;
    state.mapping = null;
    state.result = null;
    mapCard.hidden = true;
    mapCard.innerHTML = '';
    resultsEl.innerHTML = '';
  });

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      textarea.value = text;
      stash();
      parseNow();
    } catch (error) {
      toast(error.message || 'Could not read that file', 'error');
    }
  });

  function renderMapping() {
    const parsed = state.parsed;
    const mapping = state.mapping;
    if (!parsed || !mapping) return;

    const delimiterName = parsed.delimiter === '\t' ? 'tab separated' : `"${parsed.delimiter}" separated`;

    mapCard.hidden = false;
    mapCard.innerHTML = `
      <div class="card-head">
        <div class="card-title">
          <h2>2 · Map the columns</h2>
          <p>${parsed.rows.length} row${parsed.rows.length === 1 ? '' : 's'} read · ${esc(delimiterName)}${parsed.header ? ' · header row detected' : ''}</p>
        </div>
        <button class="btn btn-ghost btn-sm" data-action="reset-import">${icon('refresh', 14)}<span>Start over</span></button>
      </div>
      <div class="card-body">
        <div class="form-grid">
          ${selectField('Date column', 'date', parsed, mapping.date)}
          ${selectField('Description column', 'description', parsed, mapping.description, { allowNone: true })}
          ${selectField('Reference column', 'reference', parsed, mapping.reference, { allowNone: true })}
          ${selectField('Balance column', 'balance', parsed, mapping.balance, { allowNone: true, noneLabel: '— statement has no balance —' })}

          <div class="field">
            <label for="map-layout">Amount layout</label>
            <select class="input" id="map-layout" data-map="layout">
              <option value="separate" ${mapping.layout === 'separate' ? 'selected' : ''}>Separate money in / money out columns</option>
              <option value="single" ${mapping.layout === 'single' ? 'selected' : ''}>One signed amount column</option>
            </select>
          </div>

          ${mapping.layout === 'separate' ? `
            ${selectField('Money in column (credit / top-up)', 'in', parsed, mapping.in, { allowNone: true })}
            ${selectField('Money out column (debit / usage)', 'out', parsed, mapping.out, { allowNone: true })}
          ` : `
            ${selectField('Amount column', 'amount', parsed, mapping.amount, { allowNone: true })}
            <div class="field">
              <label for="map-sign">Positive amounts mean</label>
              <select class="input" id="map-sign" data-map="sign">
                <option value="positive_in" ${mapping.sign === 'positive_in' ? 'selected' : ''}>Money in (top-up)</option>
                <option value="positive_out" ${mapping.sign === 'positive_out' ? 'selected' : ''}>Money out (usage)</option>
              </select>
            </div>
          `}

          <div class="field">
            <label for="map-dateFormat">Date format</label>
            <select class="input" id="map-dateFormat" data-map="dateFormat">
              <option value="auto" ${mapping.dateFormat === 'auto' ? 'selected' : ''}>Auto detect</option>
              <option value="dmy" ${mapping.dateFormat === 'dmy' ? 'selected' : ''}>DD/MM/YYYY</option>
              <option value="mdy" ${mapping.dateFormat === 'mdy' ? 'selected' : ''}>MM/DD/YYYY</option>
              <option value="ymd" ${mapping.dateFormat === 'ymd' ? 'selected' : ''}>YYYY-MM-DD</option>
            </select>
          </div>
        </div>

        <div class="recon-preview-wrap">
          <div class="doc-label">Preview</div>
          <div class="table-wrap"><table class="data recon-preview" id="rc-preview"><caption class="sr-only">Statement preview</caption></table></div>
          <div class="hint" id="rc-preview-note"></div>
        </div>

        <div class="recon-actions">
          <button class="btn btn-primary" data-action="compare">${icon('check', 15)}<span>Compare with ledger</span></button>
        </div>
      </div>
    `;

    mapCard.querySelector('[data-action="reset-import"]')?.addEventListener('click', () => {
      mapCard.hidden = true;
      mapCard.innerHTML = '';
      resultsEl.innerHTML = '';
      state.parsed = null;
      state.mapping = null;
      state.built = { rows: [], skipped: 0 };
    });

    mapCard.querySelector('[data-action="compare"]')?.addEventListener('click', compareNow);

    renderPreview();
  }

  function renderPreview() {
    const note = mapCard.querySelector('#rc-preview-note');
    const table = mapCard.querySelector('#rc-preview');
    const compareButton = mapCard.querySelector('[data-action="compare"]');
    if (!table || !state.parsed || !state.mapping) return;

    const built = buildRows(state.parsed, state.mapping);
    state.built = built;

    const previewRows = built.rows.slice(0, 8);
    table.innerHTML = `
      <thead>
        <tr>
          <th scope="col">Date</th>
          <th scope="col">Description</th>
          <th scope="col">Reference</th>
          <th scope="col" class="num">Money in</th>
          <th scope="col" class="num">Money out</th>
          <th scope="col" class="num">Balance</th>
        </tr>
      </thead>
      <tbody>
        ${previewRows.length
    ? previewRows.map((row) => `
          <tr>
            <td class="nowrap">${esc(fmtDate(row.date))}</td>
            <td>${esc(row.description || '—')}</td>
            <td>${esc(row.reference || '—')}</td>
            <td class="num">${row.in_cents ? fmtMoney(row.in_cents) : ''}</td>
            <td class="num">${row.out_cents ? fmtMoney(row.out_cents) : ''}</td>
            <td class="num">${row.balance_cents == null ? '' : fmtMoney(row.balance_cents)}</td>
          </tr>
        `).join('')
    : '<tr><td colspan="6" class="muted">No valid rows. Check the date and amount columns.</td></tr>'}
      </tbody>
    `;

    if (note) {
      note.textContent = built.rows.length
        ? `${built.rows.length} row${built.rows.length === 1 ? '' : 's'} ready to compare${built.skipped ? ` · ${built.skipped} skipped (no date or amount)` : ''}. Showing the first ${Math.min(8, built.rows.length)}.`
        : 'No valid rows. Pick the column that holds the date and the columns that hold the amounts.';
    }
    if (compareButton) compareButton.disabled = built.rows.length === 0;
  }

  async function compareNow() {
    const button = mapCard.querySelector('[data-action="compare"]');
    if (!state.parsed || !state.mapping) return;
    const built = buildRows(state.parsed, state.mapping);
    if (!built.rows.length) {
      toast('No valid statement rows to compare', 'error');
      return;
    }

    readRange();
    const payload = {
      from: state.from,
      to: state.to,
      tolerance_days: state.tolerance,
      rows: built.rows.map((row) => ({
        date: row.date,
        description: row.description,
        reference: row.reference,
        in_cents: row.in_cents,
        out_cents: row.out_cents,
        balance_cents: row.balance_cents,
      })),
    };

    if (button) {
      button.disabled = true;
      button.classList.add('is-loading');
    }
    try {
      const result = await api.post(`/portals/${id}/reconcile`, payload);
      state.result = result;
      renderResults(result);
      resultsEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) {
      toast(error.message || 'Could not compare the statement', 'error');
    } finally {
      if (button) {
        button.disabled = false;
        button.classList.remove('is-loading');
      }
    }
  }

  function renderResults(result) {
    const { summary, balance } = result;
    const closingDifference = balance.closing_difference_cents;
    const fullyReconciled = summary.missing_in_books === 0
      && summary.missing_on_statement === 0
      && (closingDifference == null || closingDifference === 0);

    const bannerText = fullyReconciled
      ? `All ${summary.matched} statement line${summary.matched === 1 ? '' : 's'} match your ledger${closingDifference == null ? '.' : ', and the closing balance agrees.'}`
      : [
        summary.missing_in_books ? `${summary.missing_in_books} statement line${summary.missing_in_books === 1 ? '' : 's'} missing from your books` : '',
        summary.missing_on_statement ? `${summary.missing_on_statement} ledger movement${summary.missing_on_statement === 1 ? '' : 's'} not on the statement` : '',
        closingDifference ? `closing balance differs by ${fmtMoney(closingDifference)}` : '',
      ].filter(Boolean).join(' · ');

    const stats = [
      {
        label: 'Statement closing',
        value: balance.statement_closing_cents == null ? '—' : fmtMoney(balance.statement_closing_cents),
        meta: balance.statement_closing_cents == null ? 'No balance column in the import' : `as printed on the statement`,
      },
      {
        label: 'Ledger closing',
        value: fmtMoney(balance.ledger_closing_cents),
        meta: `at ${fmtDate(result.to)}`,
      },
      {
        label: 'Difference',
        value: closingDifference == null ? '—' : fmtMoney(closingDifference),
        meta: closingDifference == null ? 'Add a balance column to check' : (closingDifference === 0 ? 'Balances agree' : 'Investigate before closing'),
        tone: closingDifference == null || closingDifference === 0 ? '' : 'bad',
      },
      {
        label: 'Matched lines',
        value: `${summary.matched} / ${summary.statement_rows}`,
        meta: `${summary.missing_in_books} missing here · ${summary.missing_on_statement} missing on statement`,
      },
    ];

    resultsEl.innerHTML = `
      <div class="recon-print-head print-only">
        <div>
          <h2>${esc(company)} · Supplier reconciliation</h2>
          <p>${esc(result.portal.name)}${result.portal.vendor_name ? ` · ${esc(result.portal.vendor_name)}` : ''} · ${esc(periodText(result.from, result.to))}</p>
        </div>
        <div class="recon-print-meta">
          <div>Generated ${esc(fmtDate(todayISO(), { long: true }))}</div>
          <div>Match window ${result.tolerance_days} day${result.tolerance_days === 1 ? '' : 's'}</div>
        </div>
      </div>

      <div class="recon-banner ${fullyReconciled ? 'ok' : 'warn'}">
        <div class="recon-banner-icon">${icon(fullyReconciled ? 'check' : 'alert', 20)}</div>
        <div>
          <strong>${fullyReconciled ? 'Statement matches the ledger' : 'Differences found'}</strong>
          <span>${esc(bannerText)}</span>
        </div>
      </div>

      <div class="recon-stats">
        ${stats.map((stat) => `
          <div class="recon-stat">
            <span class="recon-stat-label">${esc(stat.label)}</span>
            <strong class="recon-stat-value ${stat.tone || ''}">${esc(stat.value)}</strong>
            <span class="recon-stat-meta">${esc(stat.meta)}</span>
          </div>
        `).join('')}
      </div>

      <div class="card recon-section">
        <div class="card-head">
          <div class="card-title"><h2>Matched lines</h2></div>
          <span class="badge badge-paid">${summary.matched}</span>
        </div>
        <div class="table-wrap">
          ${result.matched.length ? `
            <table class="data recon-table"><caption class="sr-only">Matched statement lines</caption>
              <thead>
                <tr>
                  <th scope="col">Statement date</th>
                  <th scope="col">Statement line</th>
                  <th scope="col" class="num">In</th>
                  <th scope="col" class="num">Out</th>
                  <th scope="col">Ledger entry</th>
                  <th scope="col">Match</th>
                </tr>
              </thead>
              <tbody>
                ${result.matched.map((pair) => `
                  <tr>
                    <td class="nowrap">${esc(fmtDate(pair.statement.date))}</td>
                    <td>${statementLine(pair.statement)}</td>
                    <td class="num">${pair.statement.in_cents ? fmtMoney(pair.statement.in_cents) : ''}</td>
                    <td class="num">${pair.statement.out_cents ? fmtMoney(pair.statement.out_cents) : ''}</td>
                    <td>
                      <div class="cell-main">${esc(pair.ledger.reference || '—')}</div>
                      <div class="cell-sub">${esc(fmtDate(pair.ledger.date))} · ${esc(pair.ledger.description)}</div>
                    </td>
                    <td>${matchBadge(pair.days_diff, pair.reference_matched)}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          ` : '<div class="recon-empty">Nothing matched yet.</div>'}
        </div>
      </div>

      <div class="card recon-section">
        <div class="card-head">
          <div class="card-title"><h2>On the statement, missing in Netfare</h2></div>
          <span class="badge ${summary.missing_in_books ? 'badge-overdue' : 'badge-paid'}">${summary.missing_in_books}</span>
        </div>
        <div class="table-wrap">
          ${result.missing_in_books.length ? `
            <table class="data recon-table"><caption class="sr-only">Unmatched statement lines</caption>
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Statement line</th>
                  <th scope="col" class="num">In</th>
                  <th scope="col" class="num">Out</th>
                  <th scope="col">Action</th>
                </tr>
              </thead>
              <tbody>
                ${result.missing_in_books.map((row) => `
                  <tr>
                    <td class="nowrap">${esc(fmtDate(row.date))}</td>
                    <td>
                      ${statementLine(row)}
                      ${row.suggestions && row.suggestions.length ? `<div class="cell-sub recon-suggest">${esc(suggestionText(row.suggestions[0]))}</div>` : ''}
                    </td>
                    <td class="num">${row.in_cents ? fmtMoney(row.in_cents) : ''}</td>
                    <td class="num">${row.out_cents ? fmtMoney(row.out_cents) : ''}</td>
                    <td>
                      <div class="recon-row-actions">
                        ${row.in_cents ? prefillLink(id, 'topup', row, 'Record top-up') : ''}
                        ${row.out_cents && openBills.length ? prefillLink(id, 'settle', row, 'Settle bill') : ''}
                        ${row.out_cents ? prefillLink(id, 'withdraw', row, 'Withdraw') : ''}
                      </div>
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          ` : '<div class="recon-empty ok">Every statement line has a matching ledger movement.</div>'}
        </div>
      </div>

      <div class="card recon-section">
        <div class="card-head">
          <div class="card-title"><h2>In Netfare, not on the statement</h2></div>
          <span class="badge ${summary.missing_on_statement ? 'badge-overdue' : 'badge-paid'}">${summary.missing_on_statement}</span>
        </div>
        <div class="table-wrap">
          ${result.missing_on_statement.length ? `
            <table class="data recon-table"><caption class="sr-only">Ledger movements for matching</caption>
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Reference</th>
                  <th scope="col">Ledger movement</th>
                  <th scope="col" class="num">In</th>
                  <th scope="col" class="num">Out</th>
                  <th scope="col"></th>
                </tr>
              </thead>
              <tbody>
                ${result.missing_on_statement.map((row) => `
                  <tr>
                    <td class="nowrap">${esc(fmtDate(row.date))}</td>
                    <td>${esc(row.reference || '—')}</td>
                    <td>
                      <div class="cell-main">${esc(row.description)}</div>
                      <div class="cell-sub">${esc(row.detail || '')}</div>
                    </td>
                    <td class="num">${row.in_cents ? fmtMoney(row.in_cents) : ''}</td>
                    <td class="num">${row.out_cents ? fmtMoney(row.out_cents) : ''}</td>
                    <td class="right">
                      ${row.bill_id
    ? `<a class="btn btn-ghost btn-xs" href="#/bills/${row.bill_id}">Bill</a>`
    : `<a class="btn btn-ghost btn-xs" href="#/portals/${id}/ledger">Ledger</a>`}
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          ` : '<div class="recon-empty ok">Every ledger movement appears on the statement.</div>'}
        </div>
      </div>

      <div class="recon-foot print-only">
        ${esc(company)} · prepared with Netfare · portal balance ${fmtMoney(result.portal.balance_cents)}
      </div>
    `;
  }

  container.querySelector('[data-action="print"]')?.addEventListener('click', () => {
    const previousTitle = document.title;
    document.title = `${portal.name} reconciliation ${state.from} to ${state.to}`;
    const restore = () => { document.title = previousTitle; };
    window.addEventListener('afterprint', restore, { once: true });
    window.print();
    setTimeout(restore, 2000);
  });

  return () => {};
}
