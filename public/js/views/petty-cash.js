import { bindCorrections, correctButtonHtml } from '../corrections.js';
import { api } from '../api.js';
import { cashAccounts } from '../store.js';
import {
  bindDateRange,
  centsToInput,
  currencySymbol,
  dateRangeHtml,
  emptyState,
  esc,
  fmtDate,
  fmtMoney,
  icon,
  openModal,
  optionsHtml,
  setHeader,
  summaryStripHtml,
  todayISO,
  toast,
  toCents,
  voidDialog,
} from '../ui.js';
import { openQuickExpenseModal } from './quick-expense.js';

// Petty cash: the office float (1020). Top it up from the bank, record
// small spends as quick expenses paid from it, and count it now and then.

const SOURCE_LABELS = {
  cash_deposit: 'Top-up',
  bill_payment: 'Expense',
  petty_cash_count: 'Count difference',
  void: 'Reversal',
  manual: 'Journal',
  opening_balance: 'Opening balance',
};

// note: shown after the label ("Amount · to the float of AED 500").
function moneyField(id, label, value = '', note = '') {
  return `
    <div class="field">
      <label for="${id}">${esc(label)}${note ? ` · ${esc(note)}` : ''}</label>
      <div class="money-input"><span>${esc(currencySymbol())}</span>
        <input class="input" id="${id}" type="number" min="0" step="0.01" inputmode="decimal" placeholder="0.00" value="${esc(value)}" required>
      </div>
    </div>`;
}

function openTopUp(data, refresh) {
  const sources = cashAccounts().filter((account) => account.id !== data.account.id).sort((a, b) => a.code.localeCompare(b.code));
  const preferred = sources.find((account) => account.code === '1010') || sources[0];
  openModal({
    title: 'Top up petty cash',
    body: `<div class="form-grid">
      ${moneyField('pc-amount', 'Amount', data.top_up_cents ? centsToInput(data.top_up_cents) : '', data.float_cents ? `to the float of ${fmtMoney(data.float_cents)}` : '')}
      <div class="field"><label for="pc-date">Date</label><input class="input" id="pc-date" type="date" value="${todayISO()}" required></div>
      <div class="field full"><label for="pc-from">Taken from</label>
        <select class="input" id="pc-from">${optionsHtml(sources, { selected: preferred?.id, labelKey: (a) => `${a.code} · ${a.name}` })}</select></div>
      <div class="field full"><label for="pc-ref">Reference <span class="muted">(optional)</span></label><input class="input" id="pc-ref" autocomplete="off" placeholder="e.g. ATM withdrawal, cheque no."></div>
    </div>`,
    submitLabel: 'Top up',
    async onSubmit(form) {
      const amount = toCents(form.querySelector('#pc-amount').value);
      if (amount <= 0) throw new Error('Enter the top-up amount');
      const deposit = await api.post('/petty-cash/top-up', {
        amount_cents: amount,
        date: form.querySelector('#pc-date').value,
        from_account_id: Number(form.querySelector('#pc-from').value),
        reference: form.querySelector('#pc-ref').value,
      });
      toast(`Petty cash topped up ${fmtMoney(amount)} (${deposit.number})`);
      refresh();
    },
  });
}

function openCount(data, refresh) {
  openModal({
    title: 'Count petty cash',
    body: `<div class="form-grid">
      ${moneyField('pc-counted', 'Cash counted in the box', '')}
      <div class="field"><label for="pc-count-date">Count date</label><input class="input" id="pc-count-date" type="date" value="${todayISO()}" max="${todayISO()}" required></div>
      <div class="field full"><div class="form-note" data-count-diff></div></div>
      <div class="field full"><label for="pc-count-notes">Notes <span class="muted">(optional)</span></label><input class="input" id="pc-count-notes" autocomplete="off" placeholder="e.g. counted by Sara"></div>
    </div>`,
    submitLabel: 'Save count',
    onMount(overlay) {
      const input = overlay.querySelector('#pc-counted');
      const date = overlay.querySelector('#pc-count-date');
      const note = overlay.querySelector('[data-count-diff]');
      // The count is checked against the books on its own date (as the server
      // does), not today's balance: a later top-up must not change it.
      let book = null;
      const show = () => {
        if (book === null) { note.textContent = ''; return; }
        const onDate = `In the books on ${fmtDate(date.value)}: ${fmtMoney(book)}.`;
        if (input.value === '') { note.textContent = onDate; return; }
        const difference = toCents(input.value) - book;
        note.textContent = `${onDate} ${difference === 0
          ? 'Matches the books. Nothing is posted.'
          : difference < 0
            ? `Short by ${fmtMoney(-difference)}. Posted as an expense (Dr 6900 Other Expenses · Cr Petty Cash).`
            : `Over by ${fmtMoney(difference)}. Posted back (Dr Petty Cash · Cr 6900 Other Expenses).`}`;
      };
      const loadBook = async () => {
        const asked = date.value;
        book = null;
        show();
        if (!asked) return;
        const result = await api.get('/petty-cash', { to: asked }).catch(() => null);
        if (result && date.value === asked) { book = result.closing_cents; show(); }
      };
      input.addEventListener('input', show);
      date.addEventListener('change', loadBook);
      loadBook();
    },
    async onSubmit(form) {
      const value = form.querySelector('#pc-counted').value;
      if (value === '') throw new Error('Enter the cash counted');
      const count = await api.post('/petty-cash/counts', {
        counted_cents: toCents(value),
        count_date: form.querySelector('#pc-count-date').value,
        notes: form.querySelector('#pc-count-notes').value,
      });
      toast(count.difference_cents ? `Count saved · ${count.difference_cents < 0 ? 'short' : 'over'} ${fmtMoney(Math.abs(count.difference_cents))}` : 'Count saved · matches the books');
      refresh();
    },
  });
}

function openFloat(data, refresh) {
  openModal({
    title: 'Petty cash float',
    body: `<div class="form-grid">
      ${moneyField('pc-float', 'Float (topped back up to)', data.float_cents ? centsToInput(data.float_cents) : '')}
    </div>`,
    submitLabel: 'Save float',
    async onSubmit(form) {
      await api.put('/petty-cash/float', { float_cents: toCents(form.querySelector('#pc-float').value || 0) });
      toast('Float saved');
      refresh();
    },
  });
}

function lineRow(line) {
  return `
    <tr>
      <td class="nowrap">${esc(fmtDate(line.entry_date))}</td>
      <td><div class="cell-main">${esc(line.memo || line.description || '')}</div>
        <div class="cell-sub">${esc(SOURCE_LABELS[line.source_type] || line.source_type)}${line.reference ? ` · ${esc(line.reference)}` : ''}</div></td>
      <td class="num">${line.debit_cents ? fmtMoney(line.debit_cents) : '—'}</td>
      <td class="num">${line.credit_cents ? fmtMoney(line.credit_cents) : '—'}</td>
      <td class="num">${fmtMoney(line.balance_cents)}</td>
    </tr>`;
}

function countRow(count) {
  const tone = count.difference_cents < 0 ? 'red' : count.difference_cents > 0 ? 'amber' : 'green';
  return `
    <tr data-count="${count.id}">
      <td class="nowrap">${esc(fmtDate(count.count_date))}</td>
      <td class="num">${fmtMoney(count.counted_cents)}</td>
      <td class="num">${fmtMoney(count.book_cents)}</td>
      <td class="num"><span style="color:var(--${tone})">${count.difference_cents ? fmtMoney(count.difference_cents) : 'Matched'}</span></td>
      <td>${esc(count.notes || '')}${count.status === 'void' ? ' <span class="muted">(void)</span>' : ''}</td>
      <td>${count.status === 'posted' ? correctButtonHtml('petty_cash_count', count) : ''}${count.status === 'posted' && count.difference_cents ? `<button class="icon-btn danger" data-void-count="${count.id}" title="Void count" aria-label="Void count">${icon('x', 15)}</button>` : ''}</td>
    </tr>`;
}

export async function render(container, { query = new URLSearchParams() } = {}) {
  const data = await api.get('/petty-cash', { from: query.get('from') || '', to: query.get('to') || '' });
  const refresh = () => render(container, { query });

  setHeader({
    title: 'Petty cash',
    actions: `
      <button class="btn btn-secondary" data-action="pc-count">${icon('check', 15)}<span>Count cash</span></button>
      <button class="btn btn-secondary" data-action="pc-top-up">${icon('plus', 15)}<span>Top up</span></button>
      <button class="btn btn-primary" data-action="pc-spend">${icon('bill', 15)}<span>Record spend</span></button>
    `,
  });

  container.innerHTML = `
    ${summaryStripHtml([
      { label: 'In the box (books)', value: fmtMoney(data.balance_cents) },
      { label: 'Float', html: data.float_cents ? esc(fmtMoney(data.float_cents)) : '<button type="button" class="btn btn-ghost btn-sm" data-action="pc-float">Set float</button>' },
      { label: 'To top up', value: data.float_cents ? fmtMoney(data.top_up_cents) : '—', tone: data.top_up_cents ? 'due' : '' },
      { label: 'Last count', value: data.last_count ? `${fmtDate(data.last_count.count_date)} · ${data.last_count.difference_cents ? fmtMoney(data.last_count.difference_cents) : 'matched'}` : 'Never' },
    ])}
    <div class="toolbar no-print">
      ${dateRangeHtml({ from: data.period.from, to: data.period.to, label: 'Period' })}
      ${data.float_cents ? '<button type="button" class="btn btn-ghost btn-sm" data-action="pc-float">Change float</button>' : ''}
    </div>
    <div class="card">
      <div class="card-head"><div class="card-title"><h2>Activity</h2></div></div>
      ${data.lines.length ? `<div class="table-wrap"><table class="data" data-petty-lines><caption class="sr-only">Petty cash activity</caption>
        <thead><tr><th scope="col">Date</th><th scope="col">Description</th><th scope="col" class="num">In</th><th scope="col" class="num">Out</th><th scope="col" class="num">Balance</th></tr></thead>
        <tbody>${data.lines.map(lineRow).join('')}</tbody></table></div>`
        : emptyState({ iconName: 'cash', title: 'No petty cash activity in this period' })}
    </div>
    ${data.counts.length ? `<div class="card" style="margin-top:16px">
      <div class="card-head"><div class="card-title"><h2>Cash counts</h2></div></div>
      <div class="table-wrap"><table class="data" data-petty-counts><caption class="sr-only">Petty cash counts</caption>
        <thead><tr><th scope="col">Date</th><th scope="col" class="num">Counted</th><th scope="col" class="num">Books</th><th scope="col" class="num">Difference</th><th scope="col">Notes</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
        <tbody>${data.counts.map(countRow).join('')}</tbody></table></div>
    </div>` : ''}
  `;

  bindDateRange(container, ({ from, to }) => {
    const next = new URLSearchParams();
    if (from) next.set('from', from);
    if (to) next.set('to', to);
    location.hash = `#/petty-cash${next.toString() ? `?${next}` : ''}`;
  });
  document.querySelector('[data-action="pc-top-up"]')?.addEventListener('click', () => openTopUp(data, refresh));
  document.querySelector('[data-action="pc-count"]')?.addEventListener('click', () => openCount(data, refresh));
  document.querySelector('[data-action="pc-spend"]')?.addEventListener('click', () => openQuickExpenseModal({ paidFromCode: '1020', onSaved: refresh }));
  container.querySelectorAll('[data-action="pc-float"]').forEach((button) => button.addEventListener('click', () => openFloat(data, refresh)));
  bindCorrections(container, refresh);
  container.querySelectorAll('[data-void-count]').forEach((button) => button.addEventListener('click', async () => {
    const count = data.counts.find((row) => row.id === Number(button.dataset.voidCount));
    const result = await voidDialog({
      title: 'Void this count?',
      message: `The ${fmtMoney(Math.abs(count.difference_cents))} ${count.difference_cents < 0 ? 'shortage' : 'overage'} entry is reversed. The count stays in history as void.`,
      confirmLabel: 'Void count',
    });
    if (!result.confirmed) return;
    try {
      await api.post(`/petty-cash/counts/${count.id}/void`, { remarks: result.remarks });
      toast('Count voided');
      refresh();
    } catch (error) {
      toast(error.message, 'error');
    }
  }));
}
