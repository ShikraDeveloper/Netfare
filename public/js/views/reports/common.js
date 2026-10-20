import { esc, fmtDate, fmtMoney } from '../../ui.js';

export function periodLabel(from, to) {
  if (from === to) return fmtDate(from, { long: true });
  return `${fmtDate(from, { long: true })} – ${fmtDate(to, { long: true })}`;
}

export function reportHeader(title, subtitle, company) {
  return `
    <div class="report-head">
      <div class="report-company">${esc(company)}</div>
      <div class="report-title">${esc(title)}</div>
      <div class="report-period">${esc(subtitle)}</div>
    </div>
  `;
}

export function sectionHead(label) {
  return `<div class="report-section-head"><span>${esc(label)}</span><span>Amount</span></div>`;
}

export function reportRow(label, code, amount) {
  return `
    <div class="report-row">
      <div class="row-label">${code ? `<span class="code">${esc(code)}</span>` : ''}${esc(label)}</div>
      <div class="amount">${fmtMoney(amount)}</div>
    </div>
  `;
}

