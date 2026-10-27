import { api } from '../api.js';
import {
  esc,
  fmtDate,
  fmtMoney,
  icon,
  setHeader,
  statusBadge,
} from '../ui.js';

// A read-only view of one job or settlement document: every linked document,
// the journal entries and reversals behind them, and any void remarks.

function documentRow(doc, rootKey) {
  const isRoot = doc.key === rootKey;
  return `
    <tr class="${isRoot ? 'chain-root' : ''}" data-chain-doc="${esc(doc.key)}">
      <td>${esc(doc.type_label)}${isRoot ? ' <span class="badge badge-draft">Opened from</span>' : ''}</td>
      <td>${doc.href ? `<a href="${esc(doc.href)}">${esc(doc.number || '—')}</a>` : esc(doc.number || '—')}</td>
      <td class="nowrap">${esc(doc.date ? fmtDate(doc.date) : '—')}</td>
      <td>${esc(doc.party || '—')}</td>
      <td class="muted">${esc(doc.detail || '')}</td>
      <td class="num">${fmtMoney(doc.amount_cents)}</td>
      <td>${doc.status ? statusBadge(doc.status) : '—'}</td>
    </tr>
  `;
}

function linesHtml(entry) {
  return `
    <ul class="chain-lines">
      ${entry.lines.map((line) => `
        <li>
          <span>${esc(line.account_code)} ${esc(line.account_name)}</span>
          <span>${line.debit_cents ? `Dr ${fmtMoney(line.debit_cents)}` : `Cr ${fmtMoney(line.credit_cents)}`}</span>
        </li>
      `).join('')}
    </ul>
  `;
}

function timelineRow(item, entriesById) {
  if (item.kind === 'status') {
    return `
      <tr class="chain-status">
        <td class="nowrap">${esc(fmtDate(item.date))}</td>
        <td>
          <span class="badge badge-draft">${esc(item.title)}</span>
          ${item.remarks ? `<div class="chain-remarks">${esc(item.remarks)}</div>` : ''}
        </td>
        <td>${esc(item.owner_label || '—')}</td>
        <td class="num">—</td>
        <td>Status history</td>
      </tr>
    `;
  }
  if (item.kind === 'audit') {
    return `
      <tr class="chain-audit">
        <td class="nowrap">${esc(fmtDate(item.date))}</td>
        <td>
          <span class="badge badge-rejected">${esc(item.title)}</span>
          ${item.remarks ? `<div class="chain-remarks">“${esc(item.remarks)}”</div>` : ''}
        </td>
        <td>${esc(item.owner_label || '—')}</td>
        <td class="num">${item.amount_cents == null ? '—' : fmtMoney(item.amount_cents)}</td>
        <td>Audit log</td>
      </tr>
    `;
  }
  const entry = entriesById.get(item.journal_entry_id);
  return `
    <tr class="${item.is_reversal ? 'chain-reversal' : ''}">
      <td class="nowrap">${esc(fmtDate(item.date))}</td>
      <td>
        ${item.is_reversal ? '<span class="badge badge-void">Reversal</span> ' : ''}${esc(item.title)}
        ${entry ? linesHtml(entry) : ''}
      </td>
      <td>${esc(item.owner_label || '—')}</td>
      <td class="num">${fmtMoney(item.amount_cents)}</td>
      <td><a href="#/journal?focus=${item.journal_entry_id}">Entry #${item.journal_entry_id}</a></td>
    </tr>
  `;
}

export async function render(container, { params } = {}) {
  const type = String(params?.[0] || '');
  const id = Number(params?.[1]);
  const chain = await api.get(`/audit-chain/${encodeURIComponent(type)}/${id}`);
  const root = chain.root;
  const totals = chain.totals;
  const entriesById = new Map(chain.journal_entries.map((entry) => [entry.id, entry]));

  setHeader({
    title: `Audit chain · ${root.number || root.type_label}`,
    subtitle: [root.type_label, root.party, root.date ? fmtDate(root.date, { long: true }) : ''].filter(Boolean).join(' · '),
    actions: `
      ${root.href ? `<a class="btn btn-ghost" href="${esc(root.href)}"><span>Open ${esc(root.type_label.toLowerCase())}</span></a>` : ''}
      <button class="btn btn-secondary" data-action="print">${icon('print', 15)}<span>Print</span></button>
    `,
  });

  container.innerHTML = `
    <div class="credit-summary chain-summary">
      <div><span>Documents</span><strong>${totals.document_count}</strong></div>
      <div><span>Journal entries</span><strong>${totals.journal_entry_count}</strong></div>
      <div><span>Reversals</span><strong>${totals.reversal_count}</strong></div>
      <div><span>Voids with remarks</span><strong>${totals.void_count}</strong></div>
      <div><span>Ledger</span><strong>${totals.balanced
        ? '<span class="badge badge-paid">Balanced</span>'
        : '<span class="badge badge-overdue">Not balanced</span>'}</strong></div>
    </div>
    ${chain.truncated ? '<div class="callout"><div class="callout-text"><p>This chain is very large; only the first 400 linked documents are shown.</p></div></div>' : ''}

    <div class="card" style="margin-top:16px">
      <div class="card-head"><div class="card-title"><h2>Linked documents</h2><p>Everything connected to ${esc(root.type_label.toLowerCase())} ${esc(root.number || '')}</p></div></div>
      <div class="table-wrap" tabindex="0" aria-label="Linked documents">
        <table class="data">
          <caption class="sr-only">Linked documents in this audit chain</caption>
          <thead><tr>
            <th scope="col">Document</th><th scope="col">Number</th><th scope="col">Date</th>
            <th scope="col">Party</th><th scope="col">Detail</th><th scope="col" class="num">Amount</th><th scope="col">Status</th>
          </tr></thead>
          <tbody>${chain.documents.map((doc) => documentRow(doc, root.key)).join('')}</tbody>
        </table>
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="card-head"><div class="card-title"><h2>Timeline</h2><p>Status changes, journal postings, reversals and void remarks in date order</p></div></div>
      <div class="table-wrap" tabindex="0" aria-label="Audit timeline">
        <table class="data">
          <caption class="sr-only">Audit timeline of postings, reversals and voids</caption>
          <thead><tr>
            <th scope="col">Date</th><th scope="col">Event</th><th scope="col">Document</th>
            <th scope="col" class="num">Amount</th><th scope="col">Record</th>
          </tr></thead>
          <tbody>
            ${chain.timeline.length
              ? chain.timeline.map((item) => timelineRow(item, entriesById)).join('')
              : '<tr><td colspan="5" class="muted">Nothing has been posted to the ledger for this chain yet.</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="card-head"><div class="card-title"><h2>Net ledger effect</h2><p>What this whole chain leaves in each account after reversals</p></div></div>
      <div class="table-wrap" tabindex="0" aria-label="Net ledger effect">
        <table class="data">
          <caption class="sr-only">Net ledger effect by account</caption>
          <thead><tr>
            <th scope="col">Account</th><th scope="col" class="num">Debits</th>
            <th scope="col" class="num">Credits</th><th scope="col" class="num">Net (Dr − Cr)</th>
          </tr></thead>
          <tbody>
            ${chain.account_effect.length
              ? chain.account_effect.map((row) => `
                <tr>
                  <td>${esc(row.account_code)} ${esc(row.account_name)}</td>
                  <td class="num">${fmtMoney(row.debit_cents)}</td>
                  <td class="num">${fmtMoney(row.credit_cents)}</td>
                  <td class="num${row.net_cents ? '' : ' muted'}">${fmtMoney(row.net_cents)}</td>
                </tr>
              `).join('')
              : '<tr><td colspan="4" class="muted">No postings.</td></tr>'}
          </tbody>
          <tfoot><tr>
            <th scope="row">Total</th>
            <td class="num">${fmtMoney(totals.debit_cents)}</td>
            <td class="num">${fmtMoney(totals.credit_cents)}</td>
            <td class="num">${fmtMoney(totals.debit_cents - totals.credit_cents)}</td>
          </tr></tfoot>
        </table>
      </div>
    </div>
  `;

  document.querySelectorAll('[data-action="print"]').forEach((button) => {
    button.addEventListener('click', () => window.print());
  });
}
