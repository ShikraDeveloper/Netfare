import { watchPage } from './ui.js';

// A phone field (input[data-phone]) becomes a country list with flags and
// codes beside the number. The original input stays in the form, hidden, and
// holds "+971 50 806 7050"-style text; the server tidies it into one form on
// save (server/phone.js). A number typed with + or 00 picks its country.
const POPULAR = ['AE', 'PK', 'IN', 'BD', 'SA', 'OM', 'QA', 'BH', 'KW', 'EG', 'PH', 'LK', 'NP', 'GB', 'US'];
// Where several countries share a code, this one is chosen when reading a number.
const PREFERRED = ['US', 'RU'];
let loading = null;

const flag = (iso) => String.fromCodePoint(...[...iso].map((letter) => 127397 + letter.charCodeAt(0)));
// The digits after the code grouped from the end (… 806 7050), as saved.
function group(digits) {
  const parts = [];
  let rest = digits;
  if (rest.length > 4) { parts.unshift(rest.slice(-4)); rest = rest.slice(0, -4); }
  while (rest.length > 3) { parts.unshift(rest.slice(-3)); rest = rest.slice(0, -3); }
  if (rest) parts.unshift(rest);
  return parts.join(' ');
}

const shownCode = (dial) => (dial.length === 4 && dial.startsWith('1') ? `1 ${dial.slice(1)}` : dial);

function countries() {
  loading ||= fetch('/js/countries.json').then((response) => response.json())
    .then((rows) => rows.map(([iso, name, dial]) => ({ iso, name, dial })));
  return loading;
}

// "+971 50 806 7050" → UAE and "50 806 7050"; anything else stays as typed.
function split(value, list) {
  const text = String(value || '').trim();
  const international = text.replace(/^00/, '+');
  const digits = international.startsWith('+') ? international.replace(/\D/g, '') : '';
  if (!digits) return { iso: 'AE', number: text };
  for (let length = 4; length >= 1; length -= 1) {
    const matches = list.filter((country) => country.dial === digits.slice(0, length));
    if (matches.length) {
      const country = matches.find((c) => PREFERRED.includes(c.iso)) || matches[0];
      const rest = digits.slice(length);
      return { iso: country.iso, number: group(rest) };
    }
  }
  return { iso: 'AE', number: text };
}

async function enhance(input) {
  input.dataset.phoneReady = '1';
  const list = await countries();
  const ordered = [...POPULAR.map((iso) => list.find((c) => c.iso === iso)).filter(Boolean),
    ...list.filter((c) => !POPULAR.includes(c.iso)).sort((a, b) => a.name.localeCompare(b.name))];
  const start = split(input.value, list);

  const wrap = document.createElement('div');
  wrap.className = 'phone-field';
  const select = document.createElement('select');
  select.className = 'input phone-cc';
  select.setAttribute('aria-label', 'Country code');
  for (const country of ordered) {
    const option = new Option(`${flag(country.iso)} +${shownCode(country.dial)}`, country.iso);
    option.dataset.search = country.name;
    select.add(option);
  }
  select.value = start.iso;
  const number = document.createElement('input');
  number.className = 'input phone-number';
  number.type = 'tel';
  number.inputMode = 'tel';
  number.autocomplete = 'off';
  number.id = `${input.id || 'phone'}-number`;
  number.value = start.number;
  number.placeholder = '50 123 4567';
  const label = input.id ? document.querySelector(`label[for="${CSS.escape(input.id)}"]`) : null;
  if (label) label.htmlFor = number.id;
  wrap.append(select, number);
  input.type = 'hidden';
  input.after(wrap);

  const write = () => {
    const typed = number.value.trim();
    // Typed or pasted with + or 00: that number's own country.
    if (/^(\+|00)/.test(typed)) {
      const found = split(typed, list);
      if (found.iso !== select.value || found.number !== typed) {
        select.value = found.iso;
        number.value = found.number;
      }
    }
    const country = list.find((c) => c.iso === select.value);
    input.value = number.value.trim() ? `+${country.dial} ${number.value.trim()}` : '';
  };
  number.addEventListener('input', write);
  select.addEventListener('change', write);
  write();
}

export function watchPhones() {
  watchPage(() => document.querySelectorAll('input[data-phone]:not([data-phone-ready])').forEach(enhance));
}
