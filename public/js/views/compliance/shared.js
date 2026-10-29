import { esc, fmtDate, fmtMoney, icon, statusBadge } from '../../ui.js';

export const KIND_OPTIONS = [
  { value: 'recurring_bill', label: 'Recurring bill — rent, utilities, salaries' },
  { value: 'filing', label: 'Filing — corporate tax, payroll' },
  { value: 'renewal', label: 'Renewal — licence, lease, insurance' },
];

export const FREQUENCY_OPTIONS = [
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'yearly', label: 'Yearly' },
  { value: 'once', label: 'One-time' },
];

export const STATUS_OPTIONS = [
  { value: 'active', label: 'Active' },
  { value: 'paused', label: 'Paused' },
  { value: 'done', label: 'Done' },
];

export const PAYMENT_METHODS = ['Bank transfer', 'Cheque', 'Cash', 'Credit card', 'Other'];

export const CATEGORIES = {
  recurring_bill: ['Office rent', 'Utilities', 'Salaries', 'Internet & phone', 'Software', 'Insurance', 'Trade licence', 'Bank charges', 'Other'],
  filing: ['Corporate tax', 'Payroll', 'Other'],
  renewal: ['Trade licence', 'Lease', 'Insurance', 'Vehicle registration', 'Visa quota', 'Other'],
};

export const ACTION_LABELS = {
  created: 'Created',
  updated: 'Updated',
  bill_generated: 'Draft bill created',
  completed: 'Marked complete',
  skipped: 'Skipped period',
};

export function kindBadge(kind) {
  const cls = kind === 'recurring_bill' ? 'badge-sent' : kind === 'filing' ? 'badge-partial' : 'badge-issued';
  const label = kind === 'recurring_bill' ? 'Recurring' : kind === 'filing' ? 'Filing' : 'Renewal';
  return `<span class="badge ${cls}">${label}</span>`;
}

export function dueBadge(item) {
  if (item.status === 'paused') return '<span class="badge badge-paused">Paused</span>';
  if (item.status === 'done') return '<span class="badge badge-done">Done</span>';
  if (item.due_state === 'overdue') return `<span class="badge badge-overdue">${esc(item.due_label)}</span>`;
  if (['due', 'soon'].includes(item.due_state)) return `<span class="badge badge-partial">${esc(item.due_label)}</span>`;
  return `<span class="badge badge-sent">${esc(item.due_label)}</span>`;
}

export function categoryOptions(kind, selected) {
  const categories = CATEGORIES[kind] || CATEGORIES.recurring_bill;
  const list = selected && !categories.includes(selected) ? [selected, ...categories] : categories;
  return list.map((category) => `<option value="${esc(category)}" ${category === selected ? 'selected' : ''}>${esc(category)}</option>`).join('');
}

export function logsHtml(item) {
  if (!item?.logs?.length) return '';
  return `
    <div class="form-note" id="ci-activity">
      <strong>Recent activity</strong>
      <div style="display:grid;gap:5px;margin-top:6px">
        ${item.logs.slice(0, 6).map((log) => `
          <div><span class="muted">${esc(fmtDate(log.event_date))}</span> · ${esc(ACTION_LABELS[log.action] || log.action)}${log.detail ? ` · ${esc(log.detail)}` : ''}</div>
        `).join('')}
      </div>
    </div>
  `;
}


export function rowHtml(item) {
  const actions = [];
  if (item.status === 'active') {
    if (item.kind === 'recurring_bill') {
      actions.push(item.auto_debit_account_id
        ? `<button class="btn btn-secondary btn-sm" data-generate="${item.id}" title="Record this period's bank debit">${icon('bill', 14)}<span>Record debit</span></button>`
        : `<button class="btn btn-secondary btn-sm" data-generate="${item.id}" title="Create a draft bill">${icon('bill', 14)}<span>Create bill</span></button>`);
    } else {
      actions.push(`<button class="btn btn-success btn-sm" data-complete="${item.id}" title="Mark complete">${icon('check', 14)}<span>Mark done</span></button>`);
    }
    actions.push(`<button class="icon-btn" data-skip="${item.id}" title="Skip this period">${icon('refresh', 15)}</button>`);
  }
  actions.push(`<button class="icon-btn" data-edit="${item.id}" title="Edit item">${icon('edit', 15)}</button>`);
  actions.push(`<button class="icon-btn danger" data-delete="${item.id}" title="Delete item">${icon('trash', 15)}</button>`);
  return `
    <tr data-id="${item.id}">
      <td>
        <div class="cell-main">${esc(item.name)}</div>
        <div class="cell-sub">${esc(item.category)}${item.vendor_name ? ` · ${esc(item.vendor_name)}` : ''}</div>
        ${item.last_generated_date ? `<div class="cell-sub">Last bill ${esc(fmtDate(item.last_generated_date))}</div>` : ''}
        ${item.last_completed_date ? `<div class="cell-sub">Last completed ${esc(fmtDate(item.last_completed_date))}</div>` : ''}
      </td>
      <td>${kindBadge(item.kind)}</td>
      <td>
        <div class="cell-main">${esc(item.frequency_label)}</div>
        <div class="cell-sub">${item.auto_debit_account_id
          ? `Bank debit · ${esc(item.auto_debit_account_name || '')}${item.variable_amount ? ' · variable' : ''}`
          : item.variable_amount ? 'Variable amount' : item.auto_create_bill ? 'Auto draft' : item.kind === 'recurring_bill' ? 'Manual draft' : 'Reminder'}${!item.auto_debit_account_id && item.payment_method === 'Cheque' ? ' · Cheque' : ''}</div>
      </td>
      <td>
        <div class="cell-main nowrap">${esc(fmtDate(item.next_due_date))}</div>
        <div style="margin-top:4px">${dueBadge(item)}</div>
      </td>
      <td class="num">${item.amount_cents ? `${item.variable_amount ? '~' : ''}${fmtMoney(item.amount_cents)}` : '—'}</td>
      <td>${statusBadge(item.status)}</td>
      <td>
        <div class="row-actions">${actions.join('')}</div>
      </td>
    </tr>
  `;
}

export function kpi(label, value, meta, iconName, color) {
  return `
    <div class="kpi">
      <div class="kpi-top"><span class="kpi-label">${esc(label)}</span><span class="kpi-icon ${color}">${icon(iconName, 16)}</span></div>
      <div class="kpi-value">${esc(value)}</div>
      <div class="kpi-meta">${esc(meta)}</div>
    </div>
  `;
}

