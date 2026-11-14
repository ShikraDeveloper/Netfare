import { esc, icon, todayISO, watchPage } from './ui.js';

// Date fields: a box showing dd/mm/yyyy that opens a calendar on any click,
// with month and year lists (for a passport expiry years ahead) and quick
// choices. Typing a date works too. The real <input type="date"> stays in the
// form, hidden, and keeps the value as before. Phones keep their own picker.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
// Dates the server refuses after today (notFuture in server/util.js): future
// days are shown crossed out instead of failing on save.
// shortcut: matched by field id or name; a new money date field must be added here.
const NO_FUTURE = new Set([
  'payment_date', 'receipt_date', 'refund_date', 'applied_date', 'topup_date', 'settle_date', 'count_date',
  'payment-date', 'rp-date', 'ca-date', 'apply-date', 'sc-apply-date', 'refund-date', 'ref-date', 'cn-refund-date',
  'cancel-refund-date', 'sc-refund-date', 'settle-date', 'tu-date', 'pc-count-date',
]);
let next = 0;

const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromIso = (value) => (/^\d{4}-\d{2}-\d{2}$/.test(value || '') ? new Date(`${value}T00:00:00`) : null);
const shown = (value) => (value ? `${value.slice(8, 10)}/${value.slice(5, 7)}/${value.slice(0, 4)}` : '');
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const addMonths = (d, n) => {
  const target = new Date(d.getFullYear(), d.getMonth() + n, 1);
  return new Date(target.getFullYear(), target.getMonth(), Math.min(d.getDate(), new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate()));
};

// "12/3/2029", "12-03-29", "12.03.2029" or "2029-03-12" → "2029-03-12"; else null.
// A two-digit year more than 20 years ahead is the 1900s: "85" → 1985.
export function parseDate(text) {
  const value = String(text || '').trim();
  let y; let m; let d;
  let match = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) [, y, m, d] = match.map(Number);
  else if ((match = value.match(/^(\d{1,2})[/.\-\s](\d{1,2})[/.\-\s](\d{2}|\d{4})$/))) {
    [, d, m, y] = match.map(Number);
    if (y < 100) y += y > (new Date().getFullYear() % 100) + 20 ? 1900 : 2000;
  } else return null;
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d ? iso(date) : null;
}

function makeDatePicker(input) {
  const id = `dp-${next += 1}`;
  input.dataset.datepicker = id;
  // A birth date cannot be ahead either.
  if (!input.max && (NO_FUTURE.has(input.id) || NO_FUTURE.has(input.name) || /birth|dob/i.test(`${input.id} ${input.name} ${input.className}`))) input.max = todayISO();
  const label = input.id ? document.querySelector(`label[for="${CSS.escape(input.id)}"]`) : null;
  if (label && !label.id) label.id = `${id}-label`;
  const expiry = /expiry/i.test(`${input.id} ${input.name} ${input.className}`);

  const wrap = document.createElement('div');
  wrap.className = 'dp';
  wrap.innerHTML = `
    <input class="input dp-text" type="text" inputmode="numeric" autocomplete="off" spellcheck="false" placeholder="dd/mm/yyyy"
      role="combobox" aria-haspopup="dialog" aria-expanded="false" aria-autocomplete="none"
      ${label ? `aria-labelledby="${label.id}"` : `aria-label="${esc(input.getAttribute('aria-label') || input.title || 'Date')}"`}>
    <span class="dp-icon" aria-hidden="true">${icon('calendar', 15)}</span>`;
  input.classList.add('picker-native');
  input.tabIndex = -1;
  input.after(wrap);
  const text = wrap.querySelector('.dp-text');
  let pop = null;
  let view = null;
  let active = null;
  let typed = false; // the person typed in the box since it last showed the field's date

  const bounds = () => ({ min: fromIso(input.min), max: fromIso(input.max) });
  const allowed = (d) => { const { min, max } = bounds(); return (!min || d >= min) && (!max || d <= max); };

  const sync = () => {
    if (!typed) text.value = shown(input.value);
    text.disabled = input.disabled;
    text.required = input.required;
    if (input.getAttribute('aria-invalid') === 'true') text.setAttribute('aria-invalid', 'true');
    else text.removeAttribute('aria-invalid');
  };
  const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  Object.defineProperty(input, 'value', {
    configurable: true,
    get() { return proto.get.call(this); },
    set(value) { proto.set.call(this, value); sync(); },
  });

  const commit = (value) => {
    if (value !== input.value) {
      proto.set.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    typed = false;
    text.value = shown(input.value);
  };

  const quick = () => {
    const today = fromIso(todayISO());
    const { max } = bounds();
    if (expiry) return [['+6 months', addMonths(today, 6)], ['+1 year', addMonths(today, 12)], ['+5 years', addMonths(today, 60)]];
    if (max && max <= today) return [['Today', today], ['Yesterday', addDays(today, -1)]];
    return [['Today', today]];
  };

  const render = () => {
    const { min, max } = bounds();
    const thisYear = new Date().getFullYear();
    const fromYear = Math.min(min ? min.getFullYear() : thisYear - 100, view.getFullYear());
    const toYear = Math.max(max ? max.getFullYear() : thisYear + 20, view.getFullYear());
    const years = [];
    for (let y = toYear; y >= fromYear; y -= 1) years.push(`<option value="${y}" ${y === view.getFullYear() ? 'selected' : ''}>${y}</option>`);
    const first = new Date(view.getFullYear(), view.getMonth(), 1);
    const start = addDays(first, -((first.getDay() + 6) % 7));
    const chosen = input.value;
    const today = todayISO();
    let days = '';
    for (let i = 0; i < 42; i += 1) {
      const d = addDays(start, i);
      const value = iso(d);
      const cls = ['dp-day', d.getMonth() !== view.getMonth() ? 'is-out' : '', value === today ? 'is-today' : '',
        value === chosen ? 'is-chosen' : '', active && value === iso(active) ? 'is-active' : ''].filter(Boolean).join(' ');
      days += `<button type="button" class="${cls}" data-day="${value}" ${allowed(d) ? '' : 'disabled'}
        aria-label="${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}"${value === chosen ? ' aria-pressed="true"' : ''}>${d.getDate()}</button>`;
    }
    pop.innerHTML = `
      <div class="dp-top">
        <button type="button" class="icon-btn dp-nav" data-month="-1" aria-label="Previous month">${icon('chevronLeft', 15)}</button>
        <select class="input dp-month" aria-label="Month" data-picker="none">${MONTHS.map((name, i) => `<option value="${i}" ${i === view.getMonth() ? 'selected' : ''}>${name.slice(0, 3)}</option>`).join('')}</select>
        <select class="input dp-year" aria-label="Year" data-picker="none">${years.join('')}</select>
        <button type="button" class="icon-btn dp-nav" data-month="1" aria-label="Next month">${icon('chevron', 15)}</button>
      </div>
      <div class="dp-grid">${['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map((day) => `<span class="dp-wd" aria-hidden="true">${day}</span>`).join('')}${days}</div>
      <div class="dp-quick">${quick().map(([name, d]) => `<button type="button" class="btn btn-ghost btn-sm" data-day="${iso(d)}" ${allowed(d) ? '' : 'disabled'}>${name}</button>`).join('')}</div>`;
  };

  const place = () => {
    if (!pop) return;
    const box = text.getBoundingClientRect();
    const height = pop.offsetHeight;
    const below = window.innerHeight - box.bottom;
    pop.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - pop.offsetWidth - 8))}px`;
    // Below the box, else above it, else as near as fits on the screen.
    const top = below >= height + 8 ? box.bottom + 4 : box.top >= height + 8 ? box.top - height - 4 : window.innerHeight - height - 8;
    pop.style.top = `${Math.max(8, top)}px`;
  };

  const close = () => {
    if (!pop) return;
    pop.remove();
    pop = null;
    text.setAttribute('aria-expanded', 'false');
    text.removeAttribute('aria-controls');
    document.removeEventListener('pointerdown', outside, true);
    window.removeEventListener('scroll', place, true);
    window.removeEventListener('resize', close);
  };

  function outside(event) {
    if (!wrap.contains(event.target) && !pop?.contains(event.target)) close();
  }

  const open = () => {
    if (pop || input.disabled) return;
    const typed = parseDate(text.value) || input.value || todayISO();
    active = fromIso(typed);
    view = new Date(active.getFullYear(), active.getMonth(), 1);
    pop = document.createElement('div');
    pop.className = 'dp-pop';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'Choose a date');
    pop.id = `${id}-pop`;
    document.body.appendChild(pop);
    render();
    place();
    text.setAttribute('aria-expanded', 'true');
    text.setAttribute('aria-controls', pop.id);
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', close);
    pop.addEventListener('mousedown', (event) => { if (!event.target.closest('select')) event.preventDefault(); });
    pop.addEventListener('click', (event) => {
      const button = event.target.closest('button');
      if (!button || button.disabled) return;
      if (button.dataset.month) {
        view = new Date(view.getFullYear(), view.getMonth() + Number(button.dataset.month), 1);
        render();
      } else if (button.dataset.day) {
        commit(button.dataset.day);
        close();
        text.focus();
      }
    });
    pop.addEventListener('change', (event) => {
      if (event.target.classList.contains('dp-month')) view = new Date(view.getFullYear(), Number(event.target.value), 1);
      if (event.target.classList.contains('dp-year')) view = new Date(Number(event.target.value), view.getMonth(), 1);
      render();
      place();
      text.focus();
    });
  };

  const move = (days, months = 0) => {
    active = months ? addMonths(active, months) : addDays(active, days);
    view = new Date(active.getFullYear(), active.getMonth(), 1);
    render();
  };

  text.addEventListener('click', open);
  text.addEventListener('input', () => {
    typed = true;
    const entered = parseDate(text.value);
    if (entered && pop) { active = fromIso(entered); view = new Date(active.getFullYear(), active.getMonth(), 1); render(); }
  });
  text.addEventListener('keydown', (event) => {
    const keys = { ArrowLeft: [-1], ArrowRight: [1], ArrowUp: [-7], ArrowDown: [7], PageUp: [0, -1], PageDown: [0, 1] };
    if (event.key === 'ArrowDown' && !pop) { event.preventDefault(); open(); return; }
    // Left and right move the cursor while a date is being typed.
    const typing = text.value !== shown(input.value);
    if (pop && keys[event.key] && !(typing && (event.key === 'ArrowLeft' || event.key === 'ArrowRight'))) {
      event.preventDefault();
      move(...keys[event.key]);
      return;
    }
    if (event.key === 'Escape' && pop) { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key === 'Enter') {
      event.preventDefault();
      const entered = typed ? parseDate(text.value) : null;
      if (pop && active && !entered && !(typed && !text.value.trim())) { if (allowed(active)) commit(iso(active)); }
      else if (entered && allowed(fromIso(entered))) commit(entered);
      else if (typed && !text.value.trim() && !input.required) commit('');
      else commit(input.value);
      close();
      // Date filters apply on Enter in their own field.
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    }
    if (event.key === 'Tab') close();
  });
  text.addEventListener('blur', () => {
    if (!typed) return;
    const entered = parseDate(text.value);
    if (entered && allowed(fromIso(entered))) commit(entered);
    else if (!text.value.trim() && !input.required) commit('');
    else commit(input.value); // not a date (or out of range): show the field's date again
  });
  input.addEventListener('focus', () => text.focus());
  input.addEventListener('change', sync);
  input.addEventListener('input', sync);
  new MutationObserver(sync).observe(input, { attributes: true, attributeFilter: ['disabled', 'aria-invalid', 'required'] });
  sync();
}

function enhance(root) {
  root.querySelectorAll('input[type="date"]:not([data-datepicker])').forEach(makeDatePicker);
}

// Every date field on any screen or form, including ones added later; not on
// touch screens, where the phone's own date picker is easier.
export function watchDates() {
  if (window.matchMedia?.('(pointer: coarse)').matches) return;
  watchPage(() => enhance(document));
}
