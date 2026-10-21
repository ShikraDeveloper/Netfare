import { api } from '../api.js';
import { DEFAULT_PAGE_SIZE, bindPagination, paginationHtml } from '../pagination.js';
import {
  confirmDialog,
  emptyState,
  esc,
  fmtMoney,
  icon,
  setHeader,
  toast,
} from '../ui.js';
import { kpi, rowHtml } from './compliance/shared.js';
import { openComplianceModal, openGenerateBillModal } from './compliance/modal.js';

export async function render(container, { query } = {}) {
  const data = await api.get('/compliance');
  const summary = data.summary;
  const items = data.items;

  if (data.generated?.length) {
    toast(`${data.generated.length} draft bill${data.generated.length === 1 ? '' : 's'} created from compliance`);
  }
  if (data.errors?.length) {
    toast(`${data.errors.length} compliance item${data.errors.length === 1 ? '' : 's'} could not generate a bill`, 'error');
  }

  setHeader({
    title: 'Compliance',
    subtitle: `${summary.active_count} active · ${summary.overdue_count} overdue · ${summary.due_soon_count} due soon`,
    actions: `
      <a class="btn btn-secondary" href="#/cheques">${icon('cheque', 16)}<span>Cheques</span></a>
      <button class="btn btn-secondary" data-action="run-due">${icon('refresh', 16)}<span>Run due bills</span></button>
      <button class="btn btn-primary" data-action="new-compliance">${icon('plus', 16)}<span>New item</span></button>
    `,
  });

  function bindNewItem() {
    document.querySelectorAll('[data-action="new-compliance"]').forEach((button) => {
      button.addEventListener('click', () => openComplianceModal({
        defaults: button.dataset.kind ? { kind: button.dataset.kind, category: button.dataset.category } : {},
        onSaved: () => render(container),
      }));
    });
  }

  if (!items.length && !summary.active_count && !summary.overdue_count) {
    container.innerHTML = `
      <div class="card">
        ${emptyState({
          iconName: 'check',
          title: 'No compliance items yet',
          message: 'Track office rent and utilities as recurring bills, and keep corporate tax, licence, lease and insurance deadlines in one calendar.',
          action: `
            <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap">
              <button class="btn btn-primary" data-action="new-compliance" data-kind="recurring_bill" data-category="Office rent">${icon('plus', 15)} Add office rent</button>
              <button class="btn btn-secondary" data-action="new-compliance" data-kind="filing" data-category="Corporate tax">${icon('check', 15)} Add corporate tax reminder</button>
            </div>
          `,
        })}
      </div>
    `;
    bindNewItem();
    return;
  }

  const notice = data.generated?.length
    ? `<div class="callout" style="border-color:var(--green-soft);background:var(--green-soft)">
        <div class="callout-icon" style="background:var(--surface);color:var(--green)">${icon('check', 20)}</div>
        <div class="callout-text"><h3>Draft bills created</h3><p>${data.generated.map((row) => `<a href="#/bills/${row.bill_id}">${esc(row.bill_number)}</a>`).join(' · ')}</p></div>
      </div>`
    : '';
  const errorNotice = data.errors?.length
    ? `<div class="callout" style="border-color:var(--red-soft);background:var(--red-soft)">
        <div class="callout-icon" style="background:var(--surface);color:var(--red)">${icon('alert', 20)}</div>
        <div class="callout-text"><h3>Some bills could not be generated</h3><p>${data.errors.map((row) => `${esc(row.name)}: ${esc(row.error)}`).join(' · ')}</p></div>
      </div>`
    : '';

  container.innerHTML = `
    ${notice}
    ${errorNotice}
    <div class="kpi-grid">
      ${kpi('Overdue', String(summary.overdue_count), 'Needs attention now', 'alert', summary.overdue_count ? 'red' : 'green')}
      ${kpi('Due soon', String(summary.due_soon_count), 'Within the reminder window', 'clock', 'amber')}
      ${kpi('Monthly recurring', fmtMoney(summary.recurring_monthly_cents), `${summary.recurring_count} recurring item${summary.recurring_count === 1 ? '' : 's'}${summary.variable_count ? ` · ${summary.variable_count} variable` : ''}`, 'bill', 'blue')}
      ${kpi('Calendar', String(summary.calendar_count), `${summary.calendar_count} active filing${summary.calendar_count === 1 ? '' : 's'} / renewal${summary.calendar_count === 1 ? '' : 's'}`, 'check', 'indigo')}
    </div>

    <div class="toolbar">
      <div class="search-box">
        ${icon('search', 17)}
        <input class="input" id="compliance-search" type="search" placeholder="Search compliance items…" aria-label="Search compliance items" autocomplete="off">
      </div>
      <select class="input" id="compliance-kind" aria-label="Filter compliance items by type" style="max-width:190px">
        <option value="all">All types</option>
        <option value="recurring_bill">Recurring bills</option>
        <option value="filing">Filings</option>
        <option value="renewal">Renewals</option>
      </select>
      <select class="input" id="compliance-due" aria-label="Filter compliance items by due date" style="max-width:160px">
        <option value="all">All due dates</option>
        <option value="attention">Needs attention</option>
        <option value="overdue">Overdue</option>
        <option value="soon">Due soon</option>
      </select>
      <select class="input" id="compliance-status" aria-label="Filter compliance items by status" style="max-width:150px">
        <option value="all">All statuses</option>
        <option value="active">Active</option>
        <option value="paused">Paused</option>
        <option value="done">Done</option>
      </select>
      <div class="spacer"></div>
      <span class="muted" id="compliance-count" style="font-size:12px"></span>
    </div>

    <div class="card">
      <div class="table-wrap">
        <table class="data"><caption class="sr-only">Compliance calendar items</caption>
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col">Type</th>
              <th scope="col">Schedule</th>
              <th scope="col">Next due</th>
              <th scope="col" class="num">Amount</th>
              <th scope="col">Status</th>
              <th scope="col"></th>
            </tr>
          </thead>
          <tbody id="compliance-body"></tbody>
        </table>
      </div>
      <div id="compliance-pagination"></div>
    </div>
  `;

  const searchInput = container.querySelector('#compliance-search');
  const kindSelect = container.querySelector('#compliance-kind');
  const dueSelect = container.querySelector('#compliance-due');
  const statusSelect = container.querySelector('#compliance-status');
  const body = container.querySelector('#compliance-body');
  const countEl = container.querySelector('#compliance-count');
  const paginationEl = container.querySelector('#compliance-pagination');
  let page = 1;
  let pageSize = DEFAULT_PAGE_SIZE;
  let filtered = [];

  function renderPage() {
    const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
    page = Math.min(Math.max(1, page), pages);
    const start = (page - 1) * pageSize;
    const rows = filtered.slice(start, start + pageSize);
    if (!rows.length) {
      body.innerHTML = `<tr><td colspan="7">${emptyState({
        iconName: 'search',
        title: 'No matching compliance items',
        message: 'Try a different search, type, status or due filter.',
      })}</td></tr>`;
    } else {
      body.innerHTML = rows.map(rowHtml).join('');
    }
    paginationEl.innerHTML = paginationHtml({ total: filtered.length, page, pageSize });
    bindPagination(paginationEl.querySelector('[data-pagination]'), ({ page: nextPage, pageSize: nextSize }) => {
      page = nextPage;
      pageSize = nextSize;
      renderPage();
    });
  }

  function applyFilters() {
    page = 1;
    const term = searchInput.value.trim().toLowerCase();
    const kind = kindSelect.value;
    const due = dueSelect.value;
    const status = statusSelect.value;
    filtered = items.filter((item) => {
      if (kind !== 'all' && item.kind !== kind) return false;
      if (status !== 'all' && item.status !== status) return false;
      if (due === 'overdue' && item.due_state !== 'overdue') return false;
      if (due === 'soon' && !['due', 'soon'].includes(item.due_state)) return false;
      if (due === 'attention' && !['overdue', 'due', 'soon'].includes(item.due_state)) return false;
      if (!term) return true;
      return [item.name, item.category, item.vendor_name, item.notes, item.kind_label, item.frequency_label]
        .some((value) => String(value || '').toLowerCase().includes(term));
    });
    countEl.textContent = `${filtered.length} shown`;
    renderPage();
  }

  searchInput.addEventListener('input', applyFilters);
  kindSelect.addEventListener('change', applyFilters);
  dueSelect.addEventListener('change', applyFilters);
  statusSelect.addEventListener('change', applyFilters);

  bindNewItem();

  const runDue = document.querySelector('[data-action="run-due"]');
  if (runDue) {
    runDue.addEventListener('click', async () => {
      try {
        const result = await api.post('/compliance/run-due', {});
        if (result.generated?.length) {
          toast(`${result.generated.length} draft bill${result.generated.length === 1 ? '' : 's'} created`);
        } else {
          toast('No auto due bills to create');
        }
        if (result.errors?.length) toast(`${result.errors.length} item${result.errors.length === 1 ? '' : 's'} failed`, 'error');
        await render(container);
      } catch (error) {
        toast(error.message, 'error');
      }
    });
  }

  body.addEventListener('click', async (event) => {
    const edit = event.target.closest('[data-edit]');
    if (edit) {
      const item = items.find((row) => row.id === Number(edit.dataset.edit));
      if (!item) return;
      try {
        await openComplianceModal({ item, onSaved: () => render(container) });
      } catch (error) {
        toast(error.message, 'error');
      }
      return;
    }
    const generate = event.target.closest('[data-generate]');
    if (generate) {
      const item = items.find((row) => row.id === Number(generate.dataset.generate));
      if (!item) return;
      try {
        await openGenerateBillModal(item, () => render(container));
      } catch (error) {
        toast(error.message, 'error');
      }
      return;
    }
    const complete = event.target.closest('[data-complete]');
    if (complete) {
      const item = items.find((row) => row.id === Number(complete.dataset.complete));
      if (!item) return;
      const confirmed = await confirmDialog({
        title: 'Mark this item complete?',
        message: `${item.name} will be marked complete and the next due date will move forward.`,
        confirmLabel: 'Mark complete',
        danger: false,
      });
      if (!confirmed) return;
      try {
        await api.post(`/compliance/${item.id}/complete`, {});
        toast(`${item.name} marked complete`);
        await render(container);
      } catch (error) {
        toast(error.message, 'error');
      }
      return;
    }
    const skip = event.target.closest('[data-skip]');
    if (skip) {
      const item = items.find((row) => row.id === Number(skip.dataset.skip));
      if (!item) return;
      const confirmed = await confirmDialog({
        title: 'Skip this period?',
        message: `${item.name} will move to its next scheduled date without creating a bill or changing the ledger.`,
        confirmLabel: 'Skip period',
        danger: false,
      });
      if (!confirmed) return;
      try {
        await api.post(`/compliance/${item.id}/skip`, {});
        toast(`${item.name} skipped to the next period`);
        await render(container);
      } catch (error) {
        toast(error.message, 'error');
      }
      return;
    }
    const del = event.target.closest('[data-delete]');
    if (del) {
      const item = items.find((row) => row.id === Number(del.dataset.delete));
      if (!item) return;
      const confirmed = await confirmDialog({
        title: `Delete ${item.name}?`,
        message: 'The compliance item and its activity log will be deleted. Bills already generated stay in the ledger.',
        confirmLabel: 'Delete item',
      });
      if (!confirmed) return;
      try {
        await api.del(`/compliance/${item.id}`);
        toast(`${item.name} deleted`);
        await render(container);
      } catch (error) {
        toast(error.message, 'error');
      }
    }
  });

  applyFilters();
}
