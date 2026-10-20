import { api } from '../api.js';
import { activeVendors } from '../store.js';
import {
  avatar,
  centsToInput,
  currencySymbol,
  emptyState,
  esc,
  fmtMoney,
  icon,
  openModal,
  optionsHtml,
  PORTAL_TYPES,
  portalTypeLabel,
  setHeader,
  statusBadge,
  toast,
  toCents,
} from '../ui.js';

export function portalSubtitle(portal) {
  return `${portalTypeLabel(portal.portal_type)}${portal.vendor_name ? ` · ${portal.vendor_name}` : ''}`;
}

function portalRow(portal) {
  const wallet = portal.settlement === 'prepaid'
    ? `
      <div class="cell-main">${fmtMoney(portal.balance_cents)}</div>
      <div class="cell-sub">${fmtMoney(portal.topup_total_cents)} topped up</div>
    `
    : `
      <div class="cell-main">${portal.credit_limit_cents ? fmtMoney(portal.credit_available_cents) : '—'}</div>
      <div class="cell-sub">of ${portal.credit_limit_cents ? fmtMoney(portal.credit_limit_cents) : 'no limit'}</div>
    `;

  return `
    <tr class="clickable" data-id="${portal.id}">
      <td>
        <div class="party-cell">
          ${avatar(portal.name, 32)}
          <div class="party-info">
            <div class="cell-main">${esc(portal.name)}${portal.is_active ? '' : ' <span class="badge badge-void">Archived</span>'}</div>
            <div class="cell-sub">${esc(portalTypeLabel(portal.portal_type))}${portal.login_ref ? ` · ${esc(portal.login_ref)}` : ''}</div>
          </div>
        </div>
      </td>
      <td>${portal.vendor_name ? esc(portal.vendor_name) : '<span class="muted">Not linked</span>'}</td>
      <td>${statusBadge(portal.settlement)}</td>
      <td class="num">${wallet}</td>
      <td class="num">${portal.outstanding_ap_cents ? fmtMoney(portal.outstanding_ap_cents) : '<span class="muted">—</span>'}</td>
      <td class="right muted">${icon('chevron', 16)}</td>
    </tr>
  `;
}

export function openPortalModal({ portal = null, onSaved = () => {} } = {}) {
  const isEdit = Boolean(portal);
  const vendors = activeVendors();

  const body = `
    <div class="form-grid">
      <div class="field full">
        <label for="pt-name">Portal name</label>
        <input class="input" id="pt-name" name="name" value="${esc(portal?.name || '')}" placeholder="e.g. Emirates Trade, Amadeus via XYZ" required autocomplete="off">
      </div>
      <div class="field">
        <label for="pt-type">Type</label>
        <select class="input" id="pt-type" name="portal_type">
          ${PORTAL_TYPES.map(([value, label]) => `<option value="${value}" ${portal?.portal_type === value ? 'selected' : ''}>${esc(label)}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label for="pt-settlement">How you settle</label>
        <select class="input" id="pt-settlement" name="settlement">
          <option value="prepaid" ${portal && portal.settlement === 'credit' ? '' : 'selected'}>Prepaid wallet — top up first</option>
          <option value="credit" ${portal?.settlement === 'credit' ? 'selected' : ''}>Credit account — pay later</option>
        </select>
      </div>
      <div class="field full">
        <label for="pt-vendor">Linked supplier</label>
        <select class="input" id="pt-vendor" name="vendor_id">
          ${optionsHtml(vendors, { selected: portal?.vendor_id, placeholder: 'No supplier linked' })}
        </select>
        <div class="hint">Link the supplier you bill for this portal. When you confirm a booking, that supplier's bill settles from the wallet automatically.</div>
      </div>
      <div class="field">
        <label for="pt-credit">Credit limit</label>
        <div class="money-input">
          <span>${esc(currencySymbol())}</span>
          <input class="input" id="pt-credit" name="credit_limit" type="number" min="0" step="0.01" value="${esc(centsToInput(portal?.credit_limit_cents || 0))}">
        </div>
        <div class="hint">Used for credit accounts only.</div>
      </div>
      <div class="field">
        <label for="pt-ref">Login / URL reference</label>
        <input class="input" id="pt-ref" name="login_ref" value="${esc(portal?.login_ref || '')}" placeholder="Portal URL and username" autocomplete="off">
        <div class="hint">Never store passwords here.</div>
      </div>
      <div class="field full">
        <label for="pt-notes">Notes</label>
        <textarea class="input" id="pt-notes" name="notes" rows="2" placeholder="Internal note">${esc(portal?.notes || '')}</textarea>
      </div>
    </div>
  `;

  return openModal({
    title: isEdit ? `Edit ${portal.name}` : 'New supplier portal',
    subtitle: 'Track the money you hold with airline logins and agency portals.',
    body,
    submitLabel: isEdit ? 'Save portal' : 'Create portal',
    async onSubmit(form) {
      const values = new FormData(form);
      const name = String(values.get('name') || '').trim();
      if (!name) throw new Error('Enter a portal name');
      const payload = {
        name,
        portal_type: values.get('portal_type'),
        settlement: values.get('settlement'),
        vendor_id: values.get('vendor_id') ? Number(values.get('vendor_id')) : null,
        credit_limit_cents: toCents(values.get('credit_limit')),
        login_ref: values.get('login_ref'),
        notes: values.get('notes'),
      };
      const saved = isEdit
        ? await api.put(`/portals/${portal.id}`, payload)
        : await api.post('/portals', payload);
      toast(isEdit ? 'Portal updated' : `Portal ${saved.name} created`);
      onSaved(saved);
    },
  });
}

export async function render(container, { query } = {}) {
  const portals = await api.get('/portals');
  const active = portals.filter((portal) => portal.is_active);
  const walletTotal = active
    .filter((portal) => portal.settlement === 'prepaid')
    .reduce((sum, portal) => sum + portal.balance_cents, 0);
  const payableTotal = active.reduce((sum, portal) => sum + portal.outstanding_ap_cents, 0);

  setHeader({
    title: 'Supplier portals',
    subtitle: `${active.length} active · ${fmtMoney(walletTotal)} held in wallets${payableTotal ? ` · ${fmtMoney(payableTotal)} payable` : ''}`,
    actions: `<button class="btn btn-primary" data-action="new-portal">${icon('plus', 16)}<span>New portal</span></button>`,
  });

  function bindNew() {
    document.querySelectorAll('[data-action="new-portal"]').forEach((button) => {
      button.addEventListener('click', () => openPortalModal({
        onSaved: (portal) => { location.hash = `#/portals/${portal.id}`; },
      }));
    });
  }

  if (!portals.length) {
    container.innerHTML = `
      <div class="card">
        ${emptyState({
    iconName: 'wallet',
    title: 'No portals yet',
    message: 'Add the airline logins and IATA agency portals you use, then top them up. Confirming a booking spends the linked supplier\'s wallet automatically.',
    action: '<button class="btn btn-primary" data-action="new-portal">Add your first portal</button>',
  })}
      </div>
    `;
    bindNew();
    maybeOpenNew(query, true);
    return;
  }

  container.innerHTML = `
    <div class="toolbar">
      <div class="search-box">
        ${icon('search', 17)}
        <input class="input" id="portal-search" type="search" placeholder="Search portals, suppliers, references…" autocomplete="off">
      </div>
      <select class="input" id="portal-settlement" style="max-width:180px">
        <option value="all">All terms</option>
        <option value="prepaid">Prepaid wallets</option>
        <option value="credit">Credit accounts</option>
      </select>
      <select class="input" id="portal-status" style="max-width:170px">
        <option value="all">All portals</option>
        <option value="active">Active only</option>
        <option value="archived">Archived</option>
      </select>
      <div class="spacer"></div>
      <span class="muted" style="font-size:12px">Wallets ${fmtMoney(walletTotal)}</span>
      <span class="muted" id="portal-count" style="font-size:12px"></span>
    </div>
    <div class="card">
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              <th>Portal</th>
              <th>Supplier</th>
              <th>Terms</th>
              <th class="num">Available</th>
              <th class="num">Payable</th>
              <th></th>
            </tr>
          </thead>
          <tbody id="portal-body"></tbody>
        </table>
      </div>
    </div>
  `;

  const searchInput = container.querySelector('#portal-search');
  const settlementSelect = container.querySelector('#portal-settlement');
  const statusSelect = container.querySelector('#portal-status');
  const body = container.querySelector('#portal-body');
  const countEl = container.querySelector('#portal-count');

  function applyFilters() {
    const term = searchInput.value.trim().toLowerCase();
    const settlement = settlementSelect.value;
    const status = statusSelect.value;
    const filtered = portals.filter((portal) => {
      if (settlement !== 'all' && portal.settlement !== settlement) return false;
      if (status === 'active' && !portal.is_active) return false;
      if (status === 'archived' && portal.is_active) return false;
      if (!term) return true;
      return [portal.name, portal.vendor_name, portal.login_ref, portalTypeLabel(portal.portal_type)]
        .some((value) => String(value || '').toLowerCase().includes(term));
    });
    countEl.textContent = `${filtered.length} shown`;
    if (!filtered.length) {
      body.innerHTML = `<tr><td colspan="6">${emptyState({
    iconName: 'search',
    title: 'No matching portals',
    message: 'Try a different search term or filter.',
  })}</td></tr>`;
      return;
    }
    body.innerHTML = filtered.map(portalRow).join('');
  }

  searchInput.addEventListener('input', applyFilters);
  settlementSelect.addEventListener('change', applyFilters);
  statusSelect.addEventListener('change', applyFilters);
  body.addEventListener('click', (event) => {
    const row = event.target.closest('tr[data-id]');
    if (row) location.hash = `#/portals/${row.dataset.id}`;
  });

  bindNew();
  applyFilters();
  maybeOpenNew(query, false);
}

function maybeOpenNew(query, alreadyBound) {
  if (!query || !query.get('new')) return;
  history.replaceState(null, '', '#/portals');
  if (alreadyBound) {
    setTimeout(() => document.querySelector('[data-action="new-portal"]')?.click(), 40);
  } else {
    openPortalModal({ onSaved: (portal) => { location.hash = `#/portals/${portal.id}`; } });
  }
}
