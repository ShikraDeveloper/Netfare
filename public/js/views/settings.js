import { api } from '../api.js';
import { applyTheme, getTheme } from '../theme.js';
import { refreshMeta, store } from '../store.js';
import {
  confirmDialog,
  esc,
  icon,
  openModal,
  setHeader,
  toast,
} from '../ui.js';

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
    subtitle: 'Appearance, company profile, invoice defaults and data management',
    actions: '',
  });

  const theme = getTheme();

  container.innerHTML = `
    <div class="settings-grid">
      <div class="settings-stack">
        <div class="card appearance-card">
          <div class="card-head">
            <div class="card-title"><h2>Appearance</h2><p>Choose how Ledgerly looks on this device</p></div>
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
                  <small>Cream, navy &amp; gold</small>
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
                  <small>Deep navy &amp; gold</small>
                </span>
                <span class="theme-check" aria-hidden="true">${icon('check', 12)}</span>
              </button>
            </div>
            <div class="theme-note">${icon('print', 14)} Theme is saved on this device. Printing always uses light paper.</div>
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <div class="card-title"><h2>Company profile</h2><p>Shown on your invoices and bills</p></div>
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
              </div>
            </div>
            <div class="settings-actions">
              <button class="btn btn-primary" type="submit">Save profile</button>
            </div>
          </form>
        </div>

        <div class="card">
          <div class="card-head">
            <div class="card-title"><h2>Invoicing &amp; ledger defaults</h2><p>Applied to new documents</p></div>
          </div>
          <form id="defaults-form" class="settings-form" novalidate>
            <div class="card-body">
              <div class="form-grid">
                <div class="field">
                  <label>Currency</label>
                  <div class="readonly-box">
                    <strong>AED</strong>
                    <span>United Arab Emirates dirham. Ledgerly records every amount in AED.</span>
                  </div>
                </div>
                <div class="field">
                  <label for="terms-days">Payment terms (days)</label>
                  <input class="input" id="terms-days" name="payment_terms_days" type="number" min="0" max="365" step="1" value="${esc(settings.payment_terms_days)}">
                  <div class="hint">Used to pre-fill due dates.</div>
                </div>
                <div class="field">
                  <label for="fiscal-month">Fiscal year starts</label>
                  <select class="input" id="fiscal-month" name="fiscal_year_start_month">
                    ${MONTHS.map((month, index) => `<option value="${index + 1}" ${Number(settings.fiscal_year_start_month) === index + 1 ? 'selected' : ''}>${month}</option>`).join('')}
                  </select>
                </div>
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
                <div class="field full">
                  <div class="form-note">Document numbers look like <strong>${esc(settings.invoice_prefix)}-${new Date().getFullYear()}-0001</strong>, bookings like <strong>${esc(settings.booking_prefix || 'BK')}-${new Date().getFullYear()}-0001</strong>, visas like <strong>${esc(settings.visa_prefix || 'VIS')}-${new Date().getFullYear()}-0001</strong> and refunds like <strong>REF-${new Date().getFullYear()}-0001</strong>. Changing a prefix only affects new documents.</div>
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
        <div class="card">
          <div class="card-head">
            <div class="card-title"><h2>Data &amp; backup</h2><p>Your books live on this computer</p></div>
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
                <p>Stop Ledgerly first, then run the restore command. A safety backup of the current database is created automatically.</p>
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
            <div class="form-note" style="margin-top:10px">Local backups are stored under <strong>data/backups</strong>. The app also creates a safety backup before Clear all data and Load sample data.</div>
          </div>
        </div>

        <div class="card danger-card">
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
            <div class="card-title"><h2>About Ledgerly</h2><p>Local-first double-entry accounting</p></div>
          </div>
          <div class="card-body">
            <div class="about-list">
              <div><span>Version</span><strong>1.0.0</strong></div>
              <div><span>Storage</span><strong>Local SQLite</strong></div>
              <div><span>Accounting</span><strong>Double-entry</strong></div>
              <div><span>Currency</span><strong>AED</strong></div>
              <div><span>Server</span><strong>127.0.0.1</strong></div>
            </div>
            <div class="form-note" style="margin-top:16px">
              Every invoice, bill and payment posts a balanced journal entry. Reports are calculated directly from the general ledger.
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  const companyForm = container.querySelector('#company-form');
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
