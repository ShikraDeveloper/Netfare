import { store } from './store.js';

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ESCAPE_MAP[char]);
}

const ICONS = {
  dashboard: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  invoice: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h5"/>',
  bill: '<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1z"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  cheque: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 10h5M6 14h8M16 14h2"/>',
  customers: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  vendors: '<path d="M3 21h18"/><path d="M5 21V7l8-4v18"/><path d="M19 21V11l-6-4"/><path d="M9 9h1M9 13h1M9 17h1"/>',
  journal: '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
  accounts: '<path d="m12 2 9 5-9 5-9-5 9-5z"/><path d="m3 12 9 5 9-5"/><path d="m3 17 9 5 9-5"/>',
  reports: '<path d="M3 3v18h18"/><rect x="7" y="12" width="3" height="6"/><rect x="12" y="8" width="3" height="10"/><rect x="17" y="4" width="3" height="14"/>',
  settings: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3"/><path d="M1 14h6M9 8h6M17 16h6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  trash: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  print: '<path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  arrowUp: '<path d="M7 17 17 7M7 7h10v10"/>',
  cash: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2"/><path d="M6 12h.01M18 12h.01"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  alert: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4M12 17h.01"/>',
  wallet: '<path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4z"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>',
  trendUp: '<path d="m22 7-8.5 8.5-5-5L2 17"/><path d="M16 7h6v6"/>',
  dollar: '<path d="M12 2v20"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>',
  filter: '<path d="M22 3H2l8 9.46V19l4 2v-8.54z"/>',
  more: '<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>',
  archive: '<rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  plane: '<path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/>',
  visa: '<rect x="4" y="2" width="16" height="20" rx="2"/><circle cx="12" cy="10" r="3.2"/><path d="M8.8 10h6.4M12 6.8v6.4M9 17.5h6M9 20h4"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.66 6.34l1.41-1.41"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 1 0 9.8 9.8z"/>',
};

export function icon(name, size = 18) {
  return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.file}</svg>`;
}

function currencyCode() {
  return 'AED';
}

export function fmtMoney(cents, { compact = false, showCents = true } = {}) {
  const value = (Number(cents) || 0) / 100;
  try {
    const options = compact && Math.abs(value) >= 10_000
      ? { style: 'currency', currency: currencyCode(), notation: 'compact', maximumFractionDigits: 1 }
      : {
        style: 'currency',
        currency: currencyCode(),
        minimumFractionDigits: showCents ? 2 : 0,
        maximumFractionDigits: showCents ? 2 : 0,
      };
    return new Intl.NumberFormat(undefined, options).format(value);
  } catch {
    return `AED ${value.toFixed(2)}`;
  }
}

export function fmtNumber(value) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(Number(value) || 0);
}

export function currencySymbol() {
  try {
    const parts = new Intl.NumberFormat(undefined, { style: 'currency', currency: currencyCode() }).formatToParts(0);
    const part = parts.find((item) => item.type === 'currency');
    return part ? part.value : 'AED';
  } catch {
    return 'AED';
  }
}

export function centsToInput(cents) {
  return ((Number(cents) || 0) / 100).toFixed(2);
}

export function toCents(value) {
  if (typeof value === 'number') return Math.round(value * 100);
  const cleaned = String(value ?? '').replace(/,/g, '').trim();
  if (!cleaned) return 0;
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

export function todayISO() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function addDaysISO(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d + days));
  const pad = (n) => String(n).padStart(2, '0');
  return `${utc.getUTCFullYear()}-${pad(utc.getUTCMonth() + 1)}-${pad(utc.getUTCDate())}`;
}

export function monthStart(iso = todayISO()) {
  return `${iso.slice(0, 7)}-01`;
}

export function fmtDate(iso, { short = false, long = false } = {}) {
  if (!iso) return '—';
  const date = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(date.getTime())) return iso;
  if (long) {
    return date.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
  }
  if (short) return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function monthLabel(ym) {
  const [y, m] = ym.split('-').map(Number);
  const date = new Date(y, m - 1, 1);
  return date.toLocaleDateString(undefined, { month: 'short' });
}

export function longMonth(iso = todayISO()) {
  const date = new Date(`${iso.slice(0, 7)}-01T00:00:00`);
  return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

const STATUS_LABELS = {
  draft: 'Draft',
  sent: 'Sent',
  partial: 'Partial',
  paid: 'Paid',
  overdue: 'Overdue',
  received: 'Received',
  void: 'Void',
  confirmed: 'Confirmed',
  travelled: 'Travelled',
  cancelled: 'Cancelled',
  submitted: 'Submitted',
  approved: 'Approved',
  issued: 'Issued',
  rejected: 'Rejected',
  prepaid: 'Prepaid wallet',
  credit: 'Credit account',
  active: 'Active',
  paused: 'Paused',
  done: 'Done',
  planned: 'Planned',
  cleared: 'Cleared',
  bounced: 'Bounced',
  posted: 'Posted',
  cancellation: 'Cancellation',
  open: 'Open',
  used: 'Used',
  refunded: 'Refunded',
  applied: 'Applied',
};

export const PORTAL_TYPES = [
  ['airline', 'Airline / BSP'],
  ['iata_agency', 'IATA agency'],
  ['consolidator', 'Consolidator'],
  ['gds', 'GDS'],
  ['visa_agent', 'Visa Agent'],
  ['other', 'Other'],
];

export function portalTypeLabel(type) {
  const found = PORTAL_TYPES.find(([value]) => value === String(type || ''));
  return found ? found[1] : 'Other';
}

export function statusBadge(status) {
  const key = String(status || '').toLowerCase();
  return `<span class="badge badge-${esc(key)}">${esc(STATUS_LABELS[key] || key || '—')}</span>`;
}

const SOURCE_LABELS = {
  invoice: 'Invoice',
  payment: 'Payment',
  bill: 'Bill',
  bill_payment: 'Bill payment',
  booking: 'Booking',
  advance: 'Customer advance',
  advance_apply: 'Advance applied',
  advance_refund: 'Advance refund',
  portal_topup: 'Portal top-up',
  portal_refund: 'Portal withdrawal',
  portal_settle: 'Paid from portal',
  customer_refund: 'Customer refund',
  supplier_refund: 'Supplier refund',
  credit_note: 'Credit note',
  credit_applied: 'Credit applied',
  cancellation: 'Cancellation',
  cancellation_received: 'Cancellation money held',
  cancellation_charge: 'Cancellation charge',
  cancellation_refund: 'Cancellation refund',
  supplier_credit: 'Supplier credit',
  supplier_credit_applied: 'Supplier credit applied',
  portal_credit: 'Portal credit',
  cash_deposit: 'Cash deposit',
  manual: 'Manual',
  opening: 'Opening',
  void: 'Reversal',
};

export function sourceLabel(type) {
  return SOURCE_LABELS[type] || type || '—';
}

export function sourceBadge(type) {
  return `<span class="source source-${esc(type)}">${esc(sourceLabel(type))}</span>`;
}

export function initials(name) {
  return String(name || '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('') || '?';
}

const AVATAR_COLORS = ['#0b1b2e', '#25638f', '#1c7a5a', '#8d5a00', '#b85c3d', '#6d5bb5', '#0e7490', '#8a5a00'];

export function avatar(name, size = 36) {
  const text = initials(name);
  let hash = 0;
  for (let i = 0; i < String(name || '').length; i += 1) hash = (hash * 31 + String(name).charCodeAt(i)) % 9973;
  const color = AVATAR_COLORS[hash % AVATAR_COLORS.length];
  return `<span class="avatar" style="width:${size}px;height:${size}px;background:${color}">${esc(text)}</span>`;
}

export function setHeader({ title, subtitle = '', actions = '' }) {
  const titleEl = document.getElementById('page-title');
  const subtitleEl = document.getElementById('page-subtitle');
  const actionsEl = document.getElementById('page-actions');
  if (titleEl) titleEl.textContent = title;
  if (subtitleEl) subtitleEl.textContent = subtitle;
  if (actionsEl) actionsEl.innerHTML = actions;
  document.title = title ? `${title} · Ledgerly` : 'Ledgerly — Invoicing & Accounting';
}

export function emptyState({ iconName = 'file', title, message = '', action = '' }) {
  return `
    <div class="empty-state">
      <div class="empty-icon">${icon(iconName, 24)}</div>
      <h3>${esc(title)}</h3>
      ${message ? `<p>${esc(message)}</p>` : ''}
      ${action ? `<div class="empty-action">${action}</div>` : ''}
    </div>
  `;
}

let toastRoot = null;

export function toast(message, type = 'success') {
  toastRoot = toastRoot || document.getElementById('toast-root');
  if (!toastRoot) return;
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.innerHTML = `${icon(type === 'error' ? 'alert' : 'check', 18)}<span>${esc(message)}</span>`;
  toastRoot.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 220);
  }, 4000);
}

/*
 * openModal options:
 *   title, subtitle, body, size, submitLabel, cancelLabel, danger,
 *   hideFooter, footer (HTML), onSubmit(form, event) -> Promise,
 *   onMount(overlay, close), onClose()
 */
let modalId = 0;

export function openModal(options) {
  const {
    title,
    subtitle = '',
    body = '',
    size = '',
    submitLabel = 'Save',
    cancelLabel = 'Cancel',
    danger = false,
    hideFooter = false,
    footer = '',
    onSubmit = null,
    onMount = null,
    onClose = null,
  } = options;

  const titleId = `modal-title-${++modalId}`;
  const previousFocus = document.activeElement;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  const footerHtml = hideFooter
    ? footer
    : `<div class="modal-foot">
        <div class="modal-error" hidden></div>
        <button type="button" class="btn btn-ghost" data-close>${esc(cancelLabel)}</button>
        <button type="submit" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-submit>${esc(submitLabel)}</button>
      </div>`;

  overlay.innerHTML = `
    <div class="modal ${size}" role="dialog" aria-modal="true" aria-labelledby="${titleId}">
      <div class="modal-head">
        <div>
          <h2 id="${titleId}">${esc(title)}</h2>
          ${subtitle ? `<p>${esc(subtitle)}</p>` : ''}
        </div>
        <button type="button" class="icon-btn" data-close aria-label="Close">${icon('x', 18)}</button>
      </div>
      <form class="modal-form" novalidate>
        <div class="modal-body">${body}</div>
        ${footerHtml}
      </form>
    </div>
  `;

  document.body.appendChild(overlay);
  document.body.classList.add('modal-open');
  requestAnimationFrame(() => overlay.classList.add('visible'));

  let closed = false;
  let submitting = false;

  const focusableSelector = [
    'a[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
  ].join(', ');

  const onKeydown = (event) => {
    if (event.key === 'Escape' && !document.body.classList.contains('modal-locked')) {
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...overlay.querySelectorAll(focusableSelector)].filter((element) => element.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  document.addEventListener('keydown', onKeydown);

  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKeydown);
    overlay.classList.remove('visible');
    document.body.classList.remove('modal-open');
    setTimeout(() => {
      overlay.remove();
      if (previousFocus && document.body.contains(previousFocus)) previousFocus.focus();
      if (onClose) onClose();
    }, 160);
  }

  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) close();
  });
  overlay.querySelectorAll('[data-close]').forEach((button) => {
    button.addEventListener('click', close);
  });

  const form = overlay.querySelector('form');
  const errorBox = overlay.querySelector('.modal-error');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!onSubmit || submitting) return;
    const submitButton = event.submitter || form.querySelector('[data-submit]');
    submitting = true;
    if (errorBox) errorBox.hidden = true;
    if (submitButton) {
      submitButton.disabled = true;
      submitButton.classList.add('is-loading');
    }
    try {
      await onSubmit(form, event);
      close();
    } catch (error) {
      if (errorBox) {
        errorBox.textContent = error.message || 'Something went wrong';
        errorBox.hidden = false;
      } else {
        toast(error.message || 'Something went wrong', 'error');
      }
    } finally {
      submitting = false;
      if (submitButton && !closed) {
        submitButton.disabled = false;
        submitButton.classList.remove('is-loading');
      }
    }
  });

  if (onMount) onMount(overlay, close);
  setTimeout(() => {
    const focusable = overlay.querySelector('.modal-body input:not([type="hidden"]), .modal-body select, .modal-body textarea, .modal-body button')
      || overlay.querySelector('[data-close]');
    if (focusable) focusable.focus();
  }, 80);

  return { overlay, form, close };
}

export function confirmDialog({ title = 'Are you sure?', message = '', confirmLabel = 'Confirm', danger = true }) {
  return new Promise((resolve) => {
    let confirmed = false;
    openModal({
      title,
      body: `<p class="confirm-text">${esc(message)}</p>`,
      size: 'modal-sm',
      submitLabel: confirmLabel,
      danger,
      onSubmit: async () => {
        confirmed = true;
      },
      onClose: () => resolve(confirmed),
    });
  });
}

function voidPreviewHtml(preview) {
  if (!preview) return '';
  const items = Array.isArray(preview.items) ? preview.items.filter(Boolean) : [];
  const total = preview.total || null;
  if (!items.length && !total && !preview.note) return '';
  return `
    <div class="void-preview" aria-label="Void preview">
      <div class="void-preview-head">${icon('alert', 14)}<span>${esc(preview.heading || 'Void preview')}</span></div>
      ${items.length ? `<div class="void-preview-rows">
        ${items.map((item) => `
          <div class="void-preview-row">
            <div class="void-preview-label">
              <span>${esc(item.label || '')}</span>
              ${item.note ? `<small>${esc(item.note)}</small>` : ''}
            </div>
            <div class="void-preview-value">${esc(item.value || '')}</div>
          </div>
        `).join('')}
      </div>` : ''}
      ${total ? `<div class="void-preview-total"><span>${esc(total.label || 'Total')}</span><strong>${esc(total.value || '')}</strong></div>` : ''}
      ${preview.note ? `<p class="void-preview-note">${esc(preview.note)}</p>` : ''}
    </div>
  `;
}

export function voidDialog({
  title = 'Void this record?',
  message = '',
  confirmLabel = 'Void',
  warning = '',
  preview = null,
} = {}) {
  return new Promise((resolve) => {
    let result = { confirmed: false, remarks: '' };
    openModal({
      title,
      body: `
        ${message ? `<p class="confirm-text">${esc(message)}</p>` : ''}
        ${warning ? `<div class="form-note" style="border-color:var(--red);color:var(--red)">${esc(warning)}</div>` : ''}
        ${voidPreviewHtml(preview)}
        <div class="field" style="margin-top:16px">
          <label for="void-remarks">Remarks <span class="muted">(required)</span></label>
          <textarea class="input" id="void-remarks" name="remarks" rows="3" maxlength="2000"
            placeholder="Why is this being voided?" required></textarea>
          <div class="hint">This reason is saved in the audit log. Posted amounts are reversed and the original record is kept for the audit trail.</div>
        </div>
      `,
      size: 'modal-sm',
      submitLabel: confirmLabel,
      danger: true,
      onSubmit: async (form) => {
        const remarks = String(new FormData(form).get('remarks') || '').trim();
        if (!remarks) throw new Error('Enter remarks before voiding');
        result = { confirmed: true, remarks };
      },
      onClose: () => resolve(result),
    });
  });
}

export function formValues(form) {
  const values = {};
  new FormData(form).forEach((value, key) => {
    values[key] = value;
  });
  return values;
}

export function debounce(fn, wait = 250) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

export function printPage() {
  window.print();
}

export function optionsHtml(items, { selected = '', placeholder = 'Select…', valueKey = 'id', labelKey = 'name' } = {}) {
  const options = items.map((item) => {
    const value = item[valueKey];
    const label = typeof labelKey === 'function' ? labelKey(item) : item[labelKey];
    return `<option value="${esc(value)}" ${String(value) === String(selected) ? 'selected' : ''}>${esc(label)}</option>`;
  });
  return `${placeholder ? `<option value="">${esc(placeholder)}</option>` : ''}${options.join('')}`;
}

export function dateRangeHtml({ from = '', to = '', label = 'Date' } = {}) {
  return `
    <div class="date-range" role="group" aria-label="${esc(label)} range">
      <span class="date-range-label">${esc(label)}</span>
      <input class="input" id="date-from" type="date" value="${esc(from)}" aria-label="${esc(label)} from" title="From date">
      <span class="date-sep">→</span>
      <input class="input" id="date-to" type="date" value="${esc(to)}" aria-label="${esc(label)} to" title="To date">
      <div class="date-actions">
        <button type="button" class="btn btn-secondary btn-sm date-apply" data-date-apply title="Apply date filter" aria-label="Apply date filter">${icon('search', 15)}</button>
        <button type="button" class="icon-btn date-clear" data-date-clear title="Clear dates" aria-label="Clear dates" disabled>${icon('x', 14)}</button>
      </div>
    </div>
  `;
}

export function bindDateRange(container, onChange = () => {}) {
  const from = container.querySelector('#date-from');
  const to = container.querySelector('#date-to');
  const apply = container.querySelector('[data-date-apply]');
  const clear = container.querySelector('[data-date-clear]');
  if (!from || !to) return { values: () => ({ from: '', to: '' }) };

  const syncClear = () => {
    if (clear) clear.disabled = !from.value && !to.value;
  };

  const values = () => {
    let start = from.value;
    let end = to.value;
    if (start && end && start > end) {
      [start, end] = [end, start];
      from.value = start;
      to.value = end;
    }
    syncClear();
    return { from: start, to: end };
  };

  const trigger = () => onChange(values());
  from.addEventListener('change', syncClear);
  to.addEventListener('change', syncClear);
  from.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      trigger();
    }
  });
  to.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      trigger();
    }
  });
  if (apply) apply.addEventListener('click', trigger);
  if (clear) {
    clear.addEventListener('click', () => {
      from.value = '';
      to.value = '';
      trigger();
    });
  }
  syncClear();
  return { values };
}

export function inDateRange(date, from, to) {
  if (!from && !to) return true;
  if (!date) return false;
  if (from && date < from) return false;
  if (to && date > to) return false;
  return true;
}

export function dot(color) {
  return `<span class="dot" style="background:${color}"></span>`;
}
