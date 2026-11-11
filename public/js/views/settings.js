import { api } from '../api.js';
import { applyTheme, getTheme } from '../theme.js';
import { getMenuMode, setMenuMode } from '../menu.js';
import { can, refreshMeta, store } from '../store.js';
import {
  confirmDialog,
  esc,
  icon,
  openModal,
  setHeader,
  toast,
  todayISO,
} from '../ui.js';
import { bindUsersCard, usersCardHtml } from './account.js';
import { bindNetworkCard, networkCardHtml } from './network.js';
import { bindUpdatesCard, updatesCardHtml } from './updates-card.js';
import { bindRecoveryKeyCard, recoveryKeyCardHtml } from './recovery-key-card.js';
import { backupMirrorCardHtml, bindBackupMirrorCard } from './backup-mirror-card.js';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function syncThemeButtons(theme = getTheme()) {
  document.querySelectorAll('[data-theme-choice]').forEach((button) => {
    const active = button.dataset.themeChoice === theme;
    button.classList.toggle('is-selected', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

window.addEventListener('theme-changed', (event) => {
  if (!document.querySelector('.theme-picker')) return;
  syncThemeButtons(event.detail?.theme || getTheme());
});

export async function render(container) {
  const settings = store.settings || await api.get('/settings');
  store.settings = settings;

  setHeader({
    title: 'Settings',
    actions: '',
  });

  const theme = getTheme();
  const menuMode = getMenuMode();

  container.innerHTML = `
    <div class="settings-grid">
      <div class="settings-stack">
        <div class="card appearance-card">
          <div class="card-head">
            <div class="card-title"><h2>Appearance</h2></div>
          </div>
          <div class="card-body">
            <div class="theme-picker" role="group" aria-label="Theme">
              <button type="button" class="theme-option ${theme === 'light' ? 'is-selected' : ''}" data-theme-choice="light" aria-pressed="${theme === 'light'}">
                <span class="theme-swatch theme-swatch-light" aria-hidden="true">
                  <span class="sw-side"></span>
                  <span class="sw-main">
                    <span class="sw-line gold"></span>
                    <span class="sw-card"></span>
                    <span class="sw-line"></span>
                  </span>
                </span>
                <span class="theme-option-copy">
                  <strong>${icon('sun', 14)} Light</strong>
                </span>
                <span class="theme-check" aria-hidden="true">${icon('check', 12)}</span>
              </button>
              <button type="button" class="theme-option ${theme === 'dark' ? 'is-selected' : ''}" data-theme-choice="dark" aria-pressed="${theme === 'dark'}">
                <span class="theme-swatch theme-swatch-dark" aria-hidden="true">
                  <span class="sw-side"></span>
                  <span class="sw-main">
                    <span class="sw-line gold"></span>
                    <span class="sw-card"></span>
                    <span class="sw-line"></span>
                  </span>
                </span>
                <span class="theme-option-copy">
                  <strong>${icon('moon', 14)} Dark</strong>
                </span>
                <span class="theme-check" aria-hidden="true">${icon('check', 12)}</span>
              </button>
            </div>
            <div class="menu-picker-label">Menu</div>
            <div class="theme-picker menu-picker" role="group" aria-label="Menu position">
              ${[['side', 'sidebar', 'Side', 'Menu down the left'], ['top', 'topbar', 'Top', 'Menu across the top, more room for pages']].map(([value, iconName, label, hint]) => `
              <button type="button" class="theme-option ${menuMode === value ? 'is-selected' : ''}" data-menu-choice="${value}" aria-pressed="${menuMode === value}">
                <span class="theme-swatch menu-swatch menu-swatch-${value}" aria-hidden="true">
                  <span class="sw-side"></span>
                  <span class="sw-main"><span class="sw-line gold"></span><span class="sw-card"></span><span class="sw-line"></span></span>
                </span>
                <span class="theme-option-copy"><strong>${icon(iconName, 14)} ${label}</strong></span>
                <span class="theme-check" aria-hidden="true">${icon('check', 12)}</span>
              </button>`).join('')}
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <div class="card-title"><h2>Company profile</h2></div>
          </div>
          <form id="company-form" class="settings-form" novalidate>
            <div class="card-body">
              <div class="form-grid">
                <div class="field full">
                  <label for="company-name">Company name</label>
                  <input class="input" id="company-name" name="company_name" value="${esc(settings.company_name)}" required>
                </div>
                <div class="field">
                  <label for="company-email">Email</label>
                  <input class="input" id="company-email" name="company_email" type="email" value="${esc(settings.company_email)}" placeholder="hello@company.com">
                </div>
                <div class="field">
                  <label for="company-phone">Phone</label>
                  <input class="input" id="company-phone" name="company_phone" value="${esc(settings.company_phone)}" placeholder="(555) 555-0100">
                </div>
                <div class="field full">
                  <label for="company-address">Address</label>
                  <textarea class="input" id="company-address" name="company_address" rows="3" placeholder="Street address&#10;City, State ZIP">${esc(settings.company_address)}</textarea>
                </div>
                <div class="field full">
                  <label for="company-logo">Logo on invoices and receipts <span class="label-note">· best: PNG, transparent background, 480 × 160 px (3 : 1), under 300 KB</span></label>
                  <div class="logo-field">
                    <img class="logo-preview" data-logo-preview alt="Company logo" ${settings.company_logo ? `src="${esc(settings.company_logo)}"` : 'hidden'}>
                    <input class="input" id="company-logo" type="file" accept="image/png,image/jpeg,image/webp">
                    <button type="button" class="btn btn-ghost btn-sm" data-logo-remove ${settings.company_logo ? '' : 'hidden'}>Remove</button>
                  </div>
                </div>
                <div class="field">
                  <label for="bank-name">Bank</label>
                  <input class="input" id="bank-name" name="bank_name" ${store.user?.is_admin ? '' : 'disabled title="Only the admin can change the bank details"'} value="${esc(settings.bank_name || '')}" placeholder="Emirates NBD" maxlength="120">
                </div>
                <div class="field">
                  <label for="bank-account-name">Account name</label>
                  <input class="input" id="bank-account-name" name="bank_account_name" ${store.user?.is_admin ? '' : 'disabled title="Only the admin can change the bank details"'} value="${esc(settings.bank_account_name || '')}" placeholder="Skyline Travels LLC" maxlength="160">
                </div>
                <div class="field full">
                  <label for="bank-iban">IBAN</label>
                  <input class="input" id="bank-iban" name="bank_iban" ${store.user?.is_admin ? '' : 'disabled title="Only the admin can change the bank details"'} value="${esc(settings.bank_iban || '')}" placeholder="AE07 0331 2345 6789 0123 456" maxlength="42" autocomplete="off">
                </div>
                <div class="field full">
                  <label for="invoice-terms-ticket">Terms under ticket invoices</label>
                  <textarea class="input" id="invoice-terms-ticket" name="invoice_terms_ticket" rows="2" maxlength="1000" placeholder="Tickets follow the airline's fare rules; changes and refunds carry airline and service charges.">${esc(settings.invoice_terms_ticket || '')}</textarea>
                </div>
                <div class="field full">
                  <label for="invoice-terms-visa">Terms under visa invoices</label>
                  <textarea class="input" id="invoice-terms-visa" name="invoice_terms_visa" rows="2" maxlength="1000" placeholder="Visa approval is decided by the authorities. Visa fees are not refundable once submitted.">${esc(settings.invoice_terms_visa || '')}</textarea>
                </div>
                <div class="field full">
                  <label for="invoice-terms">Terms under other invoices <span class="label-note">· also used when the two above are empty</span></label>
                  <textarea class="input" id="invoice-terms" name="invoice_terms" rows="2" maxlength="1000" placeholder="Services once delivered are not refundable.">${esc(settings.invoice_terms || '')}</textarea>
                </div>
              </div>
            </div>
            <div class="settings-actions">
              <button class="btn btn-primary" type="submit">Save profile</button>
            </div>
          </form>
        </div>

        <div class="card">
          <div class="card-head">
            <div class="card-title"><h2>Invoicing &amp; ledger defaults</h2></div>
          </div>
          <form id="defaults-form" class="settings-form" novalidate>
            <div class="card-body">
              <div class="form-grid">
                <div class="field">
                  <label>Currency</label>
                  <div class="readonly-box">
                    <strong>AED</strong>
                    <span>United Arab Emirates dirham. Netfare records every amount in AED.</span>
                  </div>
                </div>
                <div class="field">
                  <label for="terms-days">Payment terms (days)</label>
                  <input class="input" id="terms-days" name="payment_terms_days" type="number" min="0" max="365" step="1" value="${esc(settings.payment_terms_days)}">
                </div>
                <div class="field">
                  <label for="fiscal-month">Fiscal year starts</label>
                  <select class="input" id="fiscal-month" name="fiscal_year_start_month">
                    ${MONTHS.map((month, index) => `<option value="${index + 1}" ${Number(settings.fiscal_year_start_month) === index + 1 ? 'selected' : ''}>${month}</option>`).join('')}
                  </select>
                </div>
                ${store.user?.is_admin ? `
                <div class="field">
                  <label for="books-closed">Books closed through</label>
                  <input class="input" id="books-closed" name="books_closed_through" type="date" max="${todayISO()}" value="${esc(settings.books_closed_through || '')}"
                    title="Nothing can be posted on or before this date. Leave empty to keep every period open.">
                </div>` : ''}
                <div class="field">
                  <label for="invoice-prefix">Invoice prefix</label>
                  <input class="input" id="invoice-prefix" name="invoice_prefix" value="${esc(settings.invoice_prefix)}" maxlength="12">
                </div>
                <div class="field">
                  <label for="bill-prefix">Bill prefix</label>
                  <input class="input" id="bill-prefix" name="bill_prefix" value="${esc(settings.bill_prefix)}" maxlength="12">
                </div>
                <div class="field">
                  <label for="booking-prefix">Booking prefix</label>
                  <input class="input" id="booking-prefix" name="booking_prefix" value="${esc(settings.booking_prefix || 'BK')}" maxlength="12">
                </div>
                <div class="field">
                  <label for="visa-prefix">Visa prefix</label>
                  <input class="input" id="visa-prefix" name="visa_prefix" value="${esc(settings.visa_prefix || 'VIS')}" maxlength="12">
                </div>
                <div class="field">
                  <label for="receipt-prefix">Receipt prefix</label>
                  <input class="input" id="receipt-prefix" name="receipt_prefix" value="${esc(settings.receipt_prefix || 'RCP')}" maxlength="12">
                </div>
                <div class="field full">
                  <label class="checkbox-row">
                    <input type="checkbox" name="print_prepared_by" ${settings.print_prepared_by === 0 ? '' : 'checked'}>
                    <span><strong>Print "Prepared by"</strong> on invoices, receipts, credit notes and refunds: the name of the staff member who made it, small, at the bottom.</span>
                  </label>
                </div>
              </div>
            </div>
            <div class="settings-actions">
              <button class="btn btn-primary" type="submit">Save defaults</button>
            </div>
          </form>
        </div>
      </div>

      <div class="settings-stack">
        ${store.user?.is_admin ? usersCardHtml() + recoveryKeyCardHtml() + networkCardHtml() + updatesCardHtml() : ''}
        <div class="card admin-only">
          <div class="card-head">
            <div class="card-title"><h2>Data &amp; backup</h2></div>
          </div>
          <div class="card-body">
            <div class="danger-row" style="border-color:var(--border)">
              <div>
                <h4>Full database backup</h4>
                <p>Download a complete, consistent SQLite backup of the whole ledger. This is the file to use for restore.</p>
              </div>
              <div style="display:flex;gap:6px;flex-wrap:wrap">
                <a class="btn btn-secondary btn-sm" href="/api/admin/backup/database" download>${icon('download', 15)} Download .db</a>
                <button class="btn btn-secondary btn-sm" id="local-backup">${icon('file', 15)} Save locally</button>
              </div>
            </div>
            <div class="danger-row" style="border-color:var(--border)">
              <div>
                <h4>Restore a backup</h4>
                <p>In the Netfare app, on the main computer: <strong>Netfare → Restore from backup…</strong> Without the app, stop Netfare and run the command below. The current books are saved as a backup first.</p>
                <p class="hint" style="margin-top:4px"><code>npm run restore -- data/backups/&lt;file&gt;.db</code></p>
              </div>
            </div>
            <div class="danger-row" style="border-color:var(--border)">
              <div>
                <h4>JSON data export</h4>
                <p>Export every table as readable JSON for inspection or migration. Use the full .db backup for recovery.</p>
              </div>
              <a class="btn btn-ghost btn-sm" href="/api/admin/backup" download>${icon('download', 15)} Export JSON</a>
            </div>
            <div class="danger-row" style="border-color:var(--border)">
              <div>
                <h4>Load sample data</h4>
                <p>A demo studio with invoices, bills, payments and six months of history. Only available in an empty ledger.</p>
              </div>
              <button class="btn btn-secondary btn-sm" id="load-demo">${icon('refresh', 15)} Load</button>
            </div>
            <div class="form-note" style="margin-top:10px">A safety backup is made before Clear all data and Load sample data.</div>
          </div>
        </div>

        ${store.user?.is_admin ? backupMirrorCardHtml() : ''}

        <div class="card danger-card admin-only">
          <div class="card-head">
            <div class="card-title"><h2>Danger zone</h2><p>These actions cannot be undone</p></div>
          </div>
          <div class="card-body">
            <div class="danger-row">
              <div>
                <h4>Clear all data</h4>
                <p>Delete every customer, supplier, invoice, bill, payment and journal entry. Your chart of accounts and settings are kept.</p>
              </div>
              <button class="btn btn-danger btn-sm" id="reset-data">${icon('trash', 15)} Clear</button>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <div class="card-title"><h2>About Netfare</h2></div>
          </div>
          <div class="card-body">
            <img class="about-logo about-logo-light" src="/brand/netfare-logo.svg" alt="Netfare — Invoicing &amp; Books" width="276" height="96">
            <img class="about-logo about-logo-dark" src="/brand/netfare-logo-white.svg" alt="" width="276" height="96">
            <div class="about-list">
              <div><span>Version</span><strong>${esc(store.version || '')}</strong></div>
              <div><span>Storage</span><strong>Local SQLite</strong></div>
              <div><span>Accounting</span><strong>Double-entry</strong></div>
              <div><span>Currency</span><strong>AED</strong></div>
              <div><span>Server</span><strong>127.0.0.1</strong></div>
              <div><span>Website</span><strong><a href="https://shikragroup.com/netfare/" target="_blank" rel="noopener">shikragroup.com/netfare</a></strong></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  const companyForm = container.querySelector('#company-form');
  // The logo is made small (at most 480 px wide) before it is saved.
  let logo = settings.company_logo || '';
  const preview = companyForm.querySelector('[data-logo-preview]');
  const removeLogo = companyForm.querySelector('[data-logo-remove]');
  const showLogo = () => {
    preview.hidden = !logo;
    removeLogo.hidden = !logo;
    if (logo) preview.src = logo; else preview.removeAttribute('src');
  };
  companyForm.querySelector('#company-logo').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      logo = await shrinkImage(file, 480);
      showLogo();
    } catch {
      toast('That picture could not be read. Use a PNG or JPG.', 'error');
    }
  });
  removeLogo.addEventListener('click', () => { logo = ''; companyForm.querySelector('#company-logo').value = ''; showLogo(); });

  companyForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = companyForm.querySelector('button[type="submit"]');
    const values = new FormData(companyForm);
    button.disabled = true;
    try {
      const updated = await api.put('/settings', {
        company_name: values.get('company_name'),
        company_email: values.get('company_email'),
        company_phone: values.get('company_phone'),
        company_address: values.get('company_address'),
        company_logo: logo,
        bank_name: values.get('bank_name'),
        bank_account_name: values.get('bank_account_name'),
        bank_iban: values.get('bank_iban'),
        invoice_terms: values.get('invoice_terms'),
        invoice_terms_ticket: values.get('invoice_terms_ticket'),
        invoice_terms_visa: values.get('invoice_terms_visa'),
      });
      store.settings = updated;
      window.dispatchEvent(new Event('meta-changed'));
      toast('Company profile saved');
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      button.disabled = false;
    }
  });

  const defaultsForm = container.querySelector('#defaults-form');
  defaultsForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = defaultsForm.querySelector('button[type="submit"]');
    const values = new FormData(defaultsForm);
    button.disabled = true;
    try {
      const updated = await api.put('/settings', {
        payment_terms_days: Number(values.get('payment_terms_days')) || 0,
        fiscal_year_start_month: Number(values.get('fiscal_year_start_month')) || 1,
        invoice_prefix: values.get('invoice_prefix'),
        bill_prefix: values.get('bill_prefix'),
        booking_prefix: values.get('booking_prefix'),
        visa_prefix: values.get('visa_prefix'),
        receipt_prefix: values.get('receipt_prefix'),
        print_prepared_by: values.get('print_prepared_by') === 'on',
        ...(store.user?.is_admin ? { books_closed_through: values.get('books_closed_through') || '' } : {}),
      });
      store.settings = updated;
      window.dispatchEvent(new Event('meta-changed'));
      toast('Defaults saved');
      render(container);
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      button.disabled = false;
    }
  });

  if (store.user?.is_admin) {
    bindUsersCard(container);
    bindRecoveryKeyCard(container);
    bindNetworkCard(container);
    bindUpdatesCard(container);
    bindBackupMirrorCard(container);
  }
  // Without Edit rights for company settings the forms are read-only.
  if (!can('settings', 'edit')) {
    container.querySelectorAll('#company-form, #defaults-form').forEach((form) => {
      form.querySelectorAll('input, select, textarea, button[type="submit"]').forEach((field) => { field.disabled = true; });
    });
  }

  container.querySelector('#local-backup').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const backup = await api.post('/admin/backup', {});
      toast(`Backup saved: ${backup.name}`);
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      button.disabled = false;
    }
  });

  container.querySelector('#load-demo').addEventListener('click', async () => {
    const confirmed = await confirmDialog({
      title: 'Load sample data?',
      message: 'This fills an empty ledger with a demo studio, invoices, bills and payments. It cannot be loaded if you already have transactions.',
      confirmLabel: 'Load sample data',
      danger: false,
    });
    if (!confirmed) return;
    try {
      await api.post('/admin/demo', {});
      await refreshMeta();
      window.dispatchEvent(new Event('meta-changed'));
      toast('Sample data loaded');
      location.hash = '#/dashboard';
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  container.querySelectorAll('[data-theme-choice]').forEach((button) => {
    button.addEventListener('click', () => {
      const next = button.dataset.themeChoice === 'dark' ? 'dark' : 'light';
      applyTheme(next);
      toast(`${next === 'dark' ? 'Dark' : 'Light'} mode on`);
    });
  });

  container.querySelectorAll('[data-menu-choice]').forEach((button) => {
    button.addEventListener('click', () => {
      const next = setMenuMode(button.dataset.menuChoice);
      container.querySelectorAll('[data-menu-choice]').forEach((choice) => {
        const active = choice.dataset.menuChoice === next;
        choice.classList.toggle('is-selected', active);
        choice.setAttribute('aria-pressed', String(active));
      });
      toast(next === 'top' ? 'Menu moved to the top' : 'Menu moved to the side');
    });
  });

  container.querySelector('#reset-data').addEventListener('click', () => {
    openModal({
      title: 'Clear all data?',
      subtitle: 'This permanently removes your transactions.',
      size: 'modal-sm',
      danger: true,
      submitLabel: 'Clear all data',
      body: `
        <p class="confirm-text">Every customer, supplier, invoice, bill, payment and journal entry will be deleted. Your chart of accounts and settings stay in place.</p>
        <div class="field" style="margin-top:16px">
          <label for="reset-confirm">Type <strong>RESET</strong> to confirm</label>
          <input class="input" id="reset-confirm" name="confirm" autocomplete="off" placeholder="RESET">
        </div>
      `,
      async onSubmit(form) {
        const values = new FormData(form);
        if (values.get('confirm') !== 'RESET') throw new Error('Type RESET exactly to confirm');
        await api.post('/admin/reset', { confirm: 'RESET' });
        await refreshMeta();
        window.dispatchEvent(new Event('meta-changed'));
        toast('All transaction data cleared');
        location.hash = '#/dashboard';
      },
    });
  });

  return () => {};
}

function shrinkImage(file, maxWidth) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const scale = Math.min(1, maxWidth / image.width);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(image.width * scale);
      canvas.height = Math.round(image.height * scale);
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(image.src);
      const png = canvas.toDataURL('image/png');
      // A photo saved as PNG can be large; JPG keeps it under the limit.
      resolve(png.length < 390_000 ? png : canvas.toDataURL('image/jpeg', 0.85));
    };
    image.onerror = reject;
    image.src = URL.createObjectURL(file);
  });
}
