import { esc, icon, watchPage } from './ui.js';

// Long dropdowns (customers, suppliers, accounts) become a box you type into:
// it shows the names that contain what you typed, by name or number. The real
// <select> stays in the form, hidden, and keeps the value, so saving, change
// events and code that reads or sets it work as before.
const LONG = 10;
let next = 0;

const fold = (text) => String(text || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');

function makePicker(select) {
  const id = `picker-${next += 1}`;
  select.dataset.picker = id;
  select.classList.add('picker-native');
  select.tabIndex = -1;
  const label = select.id ? document.querySelector(`label[for="${CSS.escape(select.id)}"]`) : null;
  if (label && !label.id) label.id = `${id}-label`;

  const wrap = document.createElement('div');
  wrap.className = 'picker';
  wrap.innerHTML = `
    <button type="button" class="input picker-button" aria-haspopup="listbox" aria-expanded="false"
      ${label ? `aria-labelledby="${label.id} ${id}-value"` : ''}>
      ${label ? '' : `<span class="sr-only">${esc(select.getAttribute('aria-label') || 'Choose')} </span>`}<span class="picker-value" id="${id}-value"></span>${icon('chevron', 14)}
    </button>
    <input class="input picker-search" type="text" role="combobox" aria-autocomplete="list" aria-expanded="true"
      aria-controls="${id}-list" autocomplete="off" spellcheck="false" placeholder="Type a name or number" hidden
      ${label ? `aria-labelledby="${label.id}"` : `aria-label="${esc(select.getAttribute('aria-label') || 'Choose')}"`}>
    <div class="picker-list" id="${id}-list" role="listbox" hidden></div>`;
  select.after(wrap);
  const button = wrap.querySelector('.picker-button');
  const search = wrap.querySelector('.picker-search');
  const list = wrap.querySelector('.picker-list');
  const value = wrap.querySelector('.picker-value');
  let shown = [];
  let active = 0;

  const sync = () => {
    const option = select.options[select.selectedIndex];
    value.textContent = option ? option.textContent : '';
    value.classList.toggle('is-empty', !option || option.value === '');
    button.disabled = select.disabled;
    if (select.getAttribute('aria-invalid') === 'true') button.setAttribute('aria-invalid', 'true');
    else button.removeAttribute('aria-invalid');
  };

  // Code that sets .value or .selectedIndex without a change event still
  // updates what the box shows.
  const proto = HTMLSelectElement.prototype;
  for (const key of ['value', 'selectedIndex']) {
    const field = Object.getOwnPropertyDescriptor(proto, key);
    Object.defineProperty(select, key, {
      configurable: true,
      get() { return field.get.call(this); },
      set(chosen) { field.set.call(this, chosen); sync(); },
    });
  }

  const highlight = (index) => {
    active = Math.max(0, Math.min(index, shown.length - 1));
    list.querySelectorAll('[role="option"]').forEach((row, i) => row.setAttribute('aria-selected', String(i === active)));
    const row = list.querySelector(`#${id}-o${active}`);
    if (row) { search.setAttribute('aria-activedescendant', row.id); row.scrollIntoView({ block: 'nearest' }); }
    else search.removeAttribute('aria-activedescendant');
  };

  const render = () => {
    const query = fold(search.value.trim());
    shown = [...select.options].filter((option) => !option.disabled
      && (query ? option.value !== '' && (fold(option.textContent).includes(query) || fold(option.dataset.search).includes(query)) : true));
    list.innerHTML = shown.length
      ? shown.map((option, i) => `<div class="picker-option${option.value === '' ? ' is-empty' : ''}" role="option" id="${id}-o${i}" aria-selected="false">${esc(option.textContent)}${option.dataset.search ? `<small>${esc(option.dataset.search)}</small>` : ''}</div>`).join('')
      : '<div class="picker-none">No match</div>';
    const current = shown.findIndex((option) => option.selected);
    highlight(query || current < 0 ? 0 : current);
  };

  const close = (focusButton) => {
    search.hidden = true;
    list.hidden = true;
    button.hidden = false;
    button.setAttribute('aria-expanded', 'false');
    if (focusButton) button.focus();
  };

  const open = (typed = '') => {
    if (select.disabled) return;
    button.hidden = true;
    button.setAttribute('aria-expanded', 'true');
    search.hidden = false;
    list.hidden = false;
    search.value = typed;
    render();
    search.focus();
  };

  const choose = (option) => {
    if (option && select.value !== option.value) {
      select.value = option.value;
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    close(true);
  };

  button.addEventListener('click', () => open());
  button.addEventListener('keydown', (event) => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) { event.preventDefault(); open(); }
    else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); open(event.key); }
  });
  search.addEventListener('input', render);
  search.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); highlight(active + 1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); highlight(active - 1); }
    else if (event.key === 'Enter') { event.preventDefault(); if (shown[active]) choose(shown[active]); }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
    else if (event.key === 'Tab') close(false);
  });
  search.addEventListener('blur', () => setTimeout(() => { if (!wrap.contains(document.activeElement)) close(false); }));
  list.addEventListener('mousedown', (event) => {
    event.preventDefault(); // keep the typing box focused until the choice is made
    const row = event.target.closest('[role="option"]');
    if (row) choose(shown[Number(row.id.slice(`${id}-o`.length))]);
  });
  // A label click or a form check focusing the hidden select lands on the box.
  select.addEventListener('focus', () => (search.hidden ? button : search).focus());
  select.addEventListener('change', sync);
  new MutationObserver(sync).observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'aria-invalid'] });
  sync();
}

function enhance(root) {
  root.querySelectorAll('select:not([multiple]):not([data-picker])').forEach((select) => {
    if (select.options.length > LONG) makePicker(select);
  });
}

// Every long dropdown on any screen or form, including ones added later.
export function watchSelects() {
  watchPage(() => enhance(document));
}
