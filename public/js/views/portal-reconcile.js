import { api } from '../api.js';
import { store } from '../store.js';
import {
  esc,
  fmtDate,
  fmtMoney,
  icon,
  portalTypeLabel,
  setHeader,
  todayISO,
  toast,
} from '../ui.js';

// ---------------------------------------------------------------------------
// Statement parsing
//
// Portal statements arrive as CSV, TSV, or rows copied out of a web table, and
// the columns are never named the same way twice. Everything here is tolerant:
// detect the delimiter, detect the header, detect the columns, then let the
// user correct the mapping before comparing.
// ---------------------------------------------------------------------------

const DELIMITERS = [',', '\t', ';', '|'];
const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

const COLUMN_HINTS = {
  date: ['date', 'txn date', 'transaction date', 'value date', 'posting date', 'booking date', 'created', 'time'],
  description: ['description', 'particulars', 'particular', 'details', 'detail', 'narration', 'transaction', 'activity', 'type', 'remark', 'memo', 'product'],
  reference: ['reference', 'ref', 'document', 'doc no', 'doc', 'ticket', 'invoice', 'voucher', 'pnr', 'order', 'receipt'],
  in: ['credit', 'deposit', 'top up', 'top-up', 'topup', 'paid in', 'received', 'money in', 'amount in', 'cr'],
  out: ['debit', 'usage', 'used', 'spent', 'paid out', 'money out', 'amount out', 'dr', 'charge', 'consumption', 'withdraw'],
  amount: ['amount', 'value', 'net', 'total'],
  balance: ['balance', 'available', 'running'],
};

function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  row.push(field);
  rows.push(row);

  return rows
    .map((cells) => cells.map((cell) => String(cell).trim()))
    .filter((cells) => cells.some((cell) => cell !== ''));
}

function detectDelimiter(text) {
  let best = null;
  for (const delimiter of DELIMITERS) {
    const rows = parseDelimited(text, delimiter);
    if (rows.length < 2) continue;
    const widths = rows.slice(0, 14).map((cells) => cells.length);
    const counts = new Map();
    for (const width of widths) counts.set(width, (counts.get(width) || 0) + 1);
    let modeWidth = 1;
    let modeCount = 0;
    for (const [width, count] of counts) {
      if (count > modeCount || (count === modeCount && width > modeWidth)) {
        modeWidth = width;
        modeCount = count;
      }
    }
    if (modeWidth < 2) continue;
    const score = modeCount * 100 + modeWidth;
    if (!best || score > best.score) best = { delimiter, rows, score };
  }
  return best || { delimiter: ',', rows: parseDelimited(text, ','), score: 0 };
}

function isoFromParts(year, month, day) {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function monthFromWord(word) {
  const key = String(word || '').toLowerCase();
  return MONTHS[key.slice(0, 4)] || MONTHS[key.slice(0, 3)] || null;
}

function parseDateCell(value, format = 'auto') {
  const text = String(value ?? '').trim();
  if (!text) return null;

  let match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/);
  if (match) return isoFromParts(match[1], match[2], match[3]);

  match = text.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
  if (match) {
    const first = Number(match[1]);
    const second = Number(match[2]);
    let year = match[3];
    if (year.length === 2) year = `20${year}`;
    let day;
    let month;
    if (format === 'dmy') { day = first; month = second; }
    else if (format === 'mdy') { month = first; day = second; }
    else if (first > 12) { day = first; month = second; }
    else if (second > 12) { month = first; day = second; }
    else { day = first; month = second; }
    return isoFromParts(year, month, day);
  }

  match = text.match(/^(\d{1,2})[\s\-]([A-Za-z]{3,9})[\s\-,]+(\d{4})$/);
  if (match) {
    const month = monthFromWord(match[2]);
    if (month) return isoFromParts(match[3], month, match[1]);
  }

  match = text.match(/^([A-Za-z]{3,9})[\s\-](\d{1,2}),?[\s\-]+(\d{4})$/);
  if (match) {
    const month = monthFromWord(match[1]);
    if (month) return isoFromParts(match[3], month, match[2]);
  }

  // Excel serial date (statements exported straight from a spreadsheet).
  if (/^\d{5}(\.\d+)?$/.test(text)) {
    const serial = Number(text);
    if (serial > 20000 && serial < 80000) {
      const date = new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86400000);
      return isoFromParts(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
    }
  }

  return null;
}

function parseAmountCell(value) {
  const original = String(value ?? '').trim();
  if (!original) return null;

  let text = original;
  let negative = false;
  let marker = 0;

  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }
  if (/\bcr\b|\bcredit\b/i.test(text)) marker = 1;
  else if (/\bdr\b|\bdebit\b/i.test(text)) marker = -1;

  text = text.replace(/\b(cr|credit|dr|debit)\b/gi, '');
  text = text.replace(/[A-Za-z]{2,}/g, '');
  text = text.replace(/[^0-9.,+-]/g, '');
  if (!text) return null;

  if (text.endsWith('-')) {
    negative = true;
    text = text.replace(/-/g, '');
  } else if (text.indexOf('-') > 0) {
    negative = true;
    text = text.replace(/-/g, '');
  }
  text = text.replace(/\+/g, '');

  const hasDot = text.includes('.');
  const hasComma = text.includes(',');
  if (hasDot && hasComma) {
    if (text.lastIndexOf(',') > text.lastIndexOf('.')) {
      text = text.replace(/\./g, '').replace(',', '.');
    } else {
      text = text.replace(/,/g, '');
    }
  } else if (hasComma) {
    const parts = text.split(',');
    if (parts.length === 2 && parts[1].length !== 3) text = parts.join('.');
    else text = text.replace(/,/g, '');
  }

  const n = Number(text);
  if (!Number.isFinite(n)) return null;

  let cents = Math.round(n * 100);
  if (negative) cents = -Math.abs(cents);
  if (marker === -1) cents = -Math.abs(cents);
  if (marker === 1) cents = Math.abs(cents);
  return cents;
}

function isHeaderRow(row) {
  const hasDate = row.some((cell) => parseDateCell(cell) !== null);
  const hasAmount = row.some((cell) => cell !== '' && parseAmountCell(cell) !== null);
  const hasWord = row.some((cell) => /[a-z]{3,}/i.test(cell));
  return hasWord && !hasDate && !hasAmount;
}

function parseStatement(text) {
  const detected = detectDelimiter(text);
  const rows = detected.rows;
  const header = rows.length > 0 && isHeaderRow(rows[0]);
  const width = rows.reduce((max, cells) => Math.max(max, cells.length), 0);
  return {
    rows,
    width,
    header,
    headerCells: header ? rows[0] : null,
    delimiter: detected.delimiter,
  };
}

function hintMatches(text, word) {
  return word.length <= 3 ? text === word : text.includes(word);
}

function detectMapping(parsed) {
  const scores = Array.from({ length: parsed.width }, () => ({
    date: 0, description: 0, reference: 0, in: 0, out: 0, amount: 0, balance: 0,
  }));

  if (parsed.headerCells) {
    parsed.headerCells.forEach((cell, index) => {
      const text = String(cell).toLowerCase().trim();
      for (const [field, words] of Object.entries(COLUMN_HINTS)) {
        for (const word of words) {
          if (hintMatches(text, word)) scores[index][field] += word.length;
        }
      }
    });
  }

  const dataRows = (parsed.header ? parsed.rows.slice(1) : parsed.rows).slice(0, 25);
  for (let column = 0; column < parsed.width; column += 1) {
    const values = dataRows.map((cells) => cells[column]).filter((value) => value != null && value !== '');
    if (!values.length) continue;
    const dateRatio = values.filter((value) => parseDateCell(value) !== null).length / values.length;
    const amountRatio = values.filter((value) => parseAmountCell(value) !== null).length / values.length;
    const textRatio = values.filter((value) => /[a-z]{3,}/i.test(value) && parseAmountCell(value) === null).length / values.length;
    if (dateRatio > 0.7) scores[column].date += 60;
    if (amountRatio > 0.7) scores[column].amount += 20;
    if (textRatio > 0.7) scores[column].description += 5;
  }

  const pick = (field, exclude = []) => {
    let best = null;
    let bestScore = 0;
    scores.forEach((score, index) => {
      if (exclude.includes(index)) return;
      if (score[field] > bestScore) {
        bestScore = score[field];
        best = index;
      }
    });
    return best;
  };

  const date = pick('date');
  const balance = pick('balance', [date].filter((value) => value !== null));
  const inColumn = pick('in', [date, balance].filter((value) => value !== null));
  const outColumn = pick('out', [date, balance, inColumn].filter((value) => value !== null));
  const reference = pick('reference', [date, balance].filter((value) => value !== null));
  const description = pick('description', [date, balance, reference, inColumn, outColumn].filter((value) => value !== null));
  const amount = pick('amount', [date, balance, inColumn, outColumn].filter((value) => value !== null));

  const separate = inColumn !== null || outColumn !== null;

  return {
    date: date === null ? 0 : date,
    description,
    reference,
    layout: separate ? 'separate' : 'single',
    in: separate ? inColumn : null,
    out: separate ? outColumn : null,
    amount: separate ? null : amount,
    balance,
    sign: 'positive_in',
    dateFormat: 'auto',
  };
}

function columnLabel(parsed, index) {
  if (index == null) return '';
  const label = parsed.headerCells ? parsed.headerCells[index] : '';
  return label && String(label).trim() ? String(label).trim() : `Column ${index + 1}`;
}

function interpretRow(cells, mapping) {
  const cell = (index) => (index == null ? '' : String(cells[index] ?? ''));
  const date = parseDateCell(cell(mapping.date), mapping.dateFormat);
  const balance = mapping.balance == null ? null : parseAmountCell(cell(mapping.balance));

  let inCents = 0;
  let outCents = 0;
  if (mapping.layout === 'separate') {
    const inValue = mapping.in == null ? 0 : (parseAmountCell(cell(mapping.in)) || 0);
    const outValue = mapping.out == null ? 0 : (parseAmountCell(cell(mapping.out)) || 0);
    inCents = Math.max(0, inValue);
    outCents = Math.max(0, outValue);
  } else {
    const value = mapping.amount == null ? 0 : (parseAmountCell(cell(mapping.amount)) || 0);
    const positiveIn = mapping.sign !== 'positive_out';
    if (value >= 0) {
      if (positiveIn) inCents = value;
      else outCents = value;
    } else if (positiveIn) {
      outCents = -value;
    } else {
      inCents = -value;
    }
  }

  return {
    date,
    description: cell(mapping.description).slice(0, 300),
    reference: cell(mapping.reference).slice(0, 120),
    in_cents: inCents,
    out_cents: outCents,
    balance_cents: balance,
  };
}

function buildRows(parsed, mapping) {
  const dataRows = parsed.header ? parsed.rows.slice(1) : parsed.rows;
  const rows = [];
  let skipped = 0;
  for (const cells of dataRows) {
    const row = interpretRow(cells, mapping);
    if (!row.date || (!row.in_cents && !row.out_cents)) {
      skipped += 1;
      continue;
    }
    rows.push(row);
  }
  return { rows, skipped };
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

function columnOptions(parsed, selected, { allowNone = false, noneLabel = '— none —' } = {}) {
  const options = Array.from({ length: parsed.width }, (_, index) => `
    <option value="${index}" ${index === selected ? 'selected' : ''}>${esc(columnLabel(parsed, index))}</option>
  `).join('');
  return `${allowNone ? `<option value="" ${selected == null ? 'selected' : ''}>${esc(noneLabel)}</option>` : ''}${options}`;
}

function selectField(label, field, parsed, selected, options = {}) {
  return `
    <div class="field">
      <label>${esc(label)}</label>
      <select class="input" data-map="${field}">
        ${columnOptions(parsed, selected, options)}
      </select>
    </div>
  `;
}

function statementLine(row) {
  return `
    <div class="cell-main">${esc(row.description || '(no description)')}</div>
    ${row.reference ? `<div class="cell-sub">${esc(row.reference)}</div>` : ''}
  `;
}

function matchBadge(days, referenceMatched) {
  if (referenceMatched) return '<span class="match-pill good">Reference</span>';
  if (days === 0) return '<span class="match-pill good">Same day</span>';
  return `<span class="match-pill">${days > 0 ? '+' : ''}${days}d</span>`;
}

function suggestionText(entry) {
  const reason = entry.reason === 'reference'
    ? 'same reference'
    : entry.reason === 'outside-window'
      ? 'amount matches, outside the match window'
      : 'same date, different amount';
  return `Possible match: ${entry.ledger.reference || entry.ledger.description} on ${fmtDate(entry.ledger.date)} (${reason})`;
}

function prefillLink(portalId, record, row, label) {
  const params = new URLSearchParams({
    record,
    date: row.date,
    amount: (row.amount_cents / 100).toFixed(2),
  });
  if (row.reference) params.set('reference', row.reference);
  return `<a class="btn btn-ghost btn-xs" href="#/portals/${portalId}?${params.toString()}">${esc(label)}</a>`;
}

function periodText(from, to) {
  return from === to
    ? fmtDate(from, { long: true })
    : `${fmtDate(from, { long: true })} – ${fmtDate(to, { long: true })}`;
}

export async function render(container, { params, query } = {}) {
  const id = Number(params?.[0]);
  const [ledger, detail] = await Promise.all([
    api.get(`/portals/${id}/ledger`),
    api.get(`/portals/${id}`),
  ]);
  const portal = ledger.portal;
  if (ledger.mode === 'credit') {
    toast('Credit accounts use the supplier ledger. Reconciliation is for prepaid wallets.');
    location.hash = `#/portals/${id}/ledger`;
    return;
  }
  const openBills = detail.open_bills || [];
  const company = store.settings?.company_name || 'My Company';
  const stashKey = `ledgerly:reconcile:${id}`;

  const state = {
    parsed: null,
    mapping: null,
    built: { rows: [], skipped: 0 },
    result: null,
    from: ledger.from,
    to: ledger.to,
    tolerance: 7,
  };

  setHeader({
    title: `Reconcile ${portal.name}`,
    subtitle: `${portalTypeLabel(portal.portal_type)} · ${portal.vendor_name || 'No supplier linked'} · match the portal's own statement against your ledger`,
    actions: [
      `<a class="btn btn-ghost" href="#/portals/${id}"><span>Statement</span></a>`,
      `<a class="btn btn-ghost" href="#/portals/${id}/ledger"><span>Ledger</span></a>`,
      `<button class="btn btn-secondary" data-action="print">${icon('print', 15)}<span>Print / PDF</span></button>`,
    ].join(''),
  });

  container.innerHTML = `
    <div class="recon-intro no-print">
      <span class="recon-intro-icon">${icon('link', 18)}</span>
      <div>
        <strong>Import the statement from ${esc(portal.name)}.</strong>
        Every line is matched to a top-up, withdrawal or bill settlement by direction, amount and date. Lines that only exist on one side are listed so you can fix them.
      </div>
    </div>

    <div class="card no-print" id="rc-import">
      <div class="card-head">
        <div class="card-title"><h2>1 · Import the statement</h2><p>CSV, TSV or rows copied from the portal</p></div>
      </div>
      <div class="card-body">
        <div class="form-grid">
          <div class="field">
            <label for="rc-from">Compare from</label>
            <input class="input" id="rc-from" type="date" value="${esc(ledger.from)}">
          </div>
          <div class="field">
            <label for="rc-to">to</label>
            <input class="input" id="rc-to" type="date" value="${esc(ledger.to)}">
          </div>
          <div class="field">
            <label for="rc-window">Match window</label>
            <input class="input" id="rc-window" type="number" min="0" max="31" step="1" value="7">
            <div class="hint">Allow this many days between the portal date and your date.</div>
          </div>
          <div class="field">
            <label for="rc-file">Statement file</label>
            <input class="input" id="rc-file" type="file" accept=".csv,.tsv,.txt,text/csv,text/plain">
            <div class="hint">Or paste the rows into the box below.</div>
          </div>
          <div class="field full">
            <label for="rc-text">Statement rows</label>
            <textarea class="input code-area" id="rc-text" rows="9" spellcheck="false" placeholder="Date,Description,Reference,Credit,Debit,Balance&#10;2026-08-01,Wallet top-up,TOP-102,12000.00,,12000.00&#10;2026-08-10,Ticket DXB-LHR,PNR7XQ,,2900.00,9100.00"></textarea>
            <div class="hint">Header row optional. Debit/credit columns and a single signed amount both work. Parentheses and CR/DR suffixes are understood.</div>
          </div>
        </div>
        <div class="recon-actions">
          <button class="btn btn-ghost" data-action="clear-statement">Clear</button>
          <button class="btn btn-primary" data-action="parse">${icon('link', 15)}<span>Parse statement</span></button>
        </div>
      </div>
    </div>

    <div class="card no-print" id="rc-map" hidden></div>
    <div id="rc-results"></div>
  `;

  const textarea = container.querySelector('#rc-text');
  const fileInput = container.querySelector('#rc-file');
  const mapCard = container.querySelector('#rc-map');
  const resultsEl = container.querySelector('#rc-results');

  // Keep a pasted statement around while the user moves between pages.
  try {
    const stashed = sessionStorage.getItem(stashKey);
    if (stashed) textarea.value = stashed;
  } catch { /* storage may be unavailable */ }

  function stash() {
    try {
      if (textarea.value.trim()) sessionStorage.setItem(stashKey, textarea.value);
      else sessionStorage.removeItem(stashKey);
    } catch { /* ignore */ }
  }

  textarea.addEventListener('input', stash);

  function readRange() {
    const from = container.querySelector('#rc-from')?.value || ledger.from;
    const to = container.querySelector('#rc-to')?.value || ledger.to;
    const tolerance = Math.max(0, Math.min(31, Math.round(Number(container.querySelector('#rc-window')?.value) || 0)));
    state.from = from <= to ? from : to;
    state.to = from <= to ? to : from;
    state.tolerance = tolerance;
  }

  function parseNow() {
    readRange();
    const text = textarea.value.trim();
    if (!text) {
      toast('Paste or load the portal statement first', 'error');
      return;
    }
    const parsed = parseStatement(text);
    if (!parsed.rows.length) {
      toast('Could not read any rows from that statement', 'error');
      return;
    }
    state.parsed = parsed;
    state.mapping = detectMapping(parsed);
    renderMapping();
    mapCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  container.querySelector('[data-action="parse"]')?.addEventListener('click', parseNow);

  // Delegated once: re-rendering the mapping card must not stack handlers.
  mapCard.addEventListener('change', (event) => {
    const target = event.target.closest('[data-map]');
    if (!target || !state.mapping) return;
    const field = target.dataset.map;
    if (field === 'layout' || field === 'sign' || field === 'dateFormat') {
      state.mapping[field] = target.value;
    } else {
      state.mapping[field] = target.value === '' ? null : Number(target.value);
    }
    if (field === 'layout') renderMapping();
    else renderPreview();
  });

  container.querySelector('[data-action="clear-statement"]')?.addEventListener('click', () => {
    textarea.value = '';
    stash();
    state.parsed = null;
    state.mapping = null;
    state.result = null;
    mapCard.hidden = true;
    mapCard.innerHTML = '';
    resultsEl.innerHTML = '';
  });

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      textarea.value = text;
      stash();
      parseNow();
    } catch (error) {
      toast(error.message || 'Could not read that file', 'error');
    }
  });

  function renderMapping() {
    const parsed = state.parsed;
    const mapping = state.mapping;
    if (!parsed || !mapping) return;

    const delimiterName = parsed.delimiter === '\t' ? 'tab separated' : `"${parsed.delimiter}" separated`;

    mapCard.hidden = false;
    mapCard.innerHTML = `
      <div class="card-head">
        <div class="card-title">
          <h2>2 · Map the columns</h2>
          <p>${parsed.rows.length} row${parsed.rows.length === 1 ? '' : 's'} read · ${esc(delimiterName)}${parsed.header ? ' · header row detected' : ''}</p>
        </div>
        <button class="btn btn-ghost btn-sm" data-action="reset-import">${icon('refresh', 14)}<span>Start over</span></button>
      </div>
      <div class="card-body">
        <div class="form-grid">
          ${selectField('Date column', 'date', parsed, mapping.date)}
          ${selectField('Description column', 'description', parsed, mapping.description, { allowNone: true })}
          ${selectField('Reference column', 'reference', parsed, mapping.reference, { allowNone: true })}
          ${selectField('Balance column', 'balance', parsed, mapping.balance, { allowNone: true, noneLabel: '— statement has no balance —' })}

          <div class="field">
            <label>Amount layout</label>
            <select class="input" data-map="layout">
              <option value="separate" ${mapping.layout === 'separate' ? 'selected' : ''}>Separate money in / money out columns</option>
              <option value="single" ${mapping.layout === 'single' ? 'selected' : ''}>One signed amount column</option>
            </select>
          </div>

          ${mapping.layout === 'separate' ? `
            ${selectField('Money in column (credit / top-up)', 'in', parsed, mapping.in, { allowNone: true })}
            ${selectField('Money out column (debit / usage)', 'out', parsed, mapping.out, { allowNone: true })}
          ` : `
            ${selectField('Amount column', 'amount', parsed, mapping.amount, { allowNone: true })}
            <div class="field">
              <label>Positive amounts mean</label>
              <select class="input" data-map="sign">
                <option value="positive_in" ${mapping.sign === 'positive_in' ? 'selected' : ''}>Money in (top-up)</option>
                <option value="positive_out" ${mapping.sign === 'positive_out' ? 'selected' : ''}>Money out (usage)</option>
              </select>
            </div>
          `}

          <div class="field">
            <label>Date format</label>
            <select class="input" data-map="dateFormat">
              <option value="auto" ${mapping.dateFormat === 'auto' ? 'selected' : ''}>Auto detect</option>
              <option value="dmy" ${mapping.dateFormat === 'dmy' ? 'selected' : ''}>DD/MM/YYYY</option>
              <option value="mdy" ${mapping.dateFormat === 'mdy' ? 'selected' : ''}>MM/DD/YYYY</option>
              <option value="ymd" ${mapping.dateFormat === 'ymd' ? 'selected' : ''}>YYYY-MM-DD</option>
            </select>
          </div>
        </div>

        <div class="recon-preview-wrap">
          <div class="doc-label">Preview</div>
          <div class="table-wrap"><table class="data recon-preview" id="rc-preview"></table></div>
          <div class="hint" id="rc-preview-note"></div>
        </div>

        <div class="recon-actions">
          <span class="hint">Matching is by direction and amount, allowing the match window, then prefers a matching reference.</span>
          <button class="btn btn-primary" data-action="compare">${icon('check', 15)}<span>Compare with ledger</span></button>
        </div>
      </div>
    `;

    mapCard.querySelector('[data-action="reset-import"]')?.addEventListener('click', () => {
      mapCard.hidden = true;
      mapCard.innerHTML = '';
      resultsEl.innerHTML = '';
      state.parsed = null;
      state.mapping = null;
      state.built = { rows: [], skipped: 0 };
    });

    mapCard.querySelector('[data-action="compare"]')?.addEventListener('click', compareNow);

    renderPreview();
  }

  function renderPreview() {
    const note = mapCard.querySelector('#rc-preview-note');
    const table = mapCard.querySelector('#rc-preview');
    const compareButton = mapCard.querySelector('[data-action="compare"]');
    if (!table || !state.parsed || !state.mapping) return;

    const built = buildRows(state.parsed, state.mapping);
    state.built = built;

    const previewRows = built.rows.slice(0, 8);
    table.innerHTML = `
      <thead>
        <tr>
          <th>Date</th>
          <th>Description</th>
          <th>Reference</th>
          <th class="num">Money in</th>
          <th class="num">Money out</th>
          <th class="num">Balance</th>
        </tr>
      </thead>
      <tbody>
        ${previewRows.length
    ? previewRows.map((row) => `
          <tr>
            <td class="nowrap">${esc(fmtDate(row.date))}</td>
            <td>${esc(row.description || '—')}</td>
            <td>${esc(row.reference || '—')}</td>
            <td class="num">${row.in_cents ? fmtMoney(row.in_cents) : ''}</td>
            <td class="num">${row.out_cents ? fmtMoney(row.out_cents) : ''}</td>
            <td class="num">${row.balance_cents == null ? '' : fmtMoney(row.balance_cents)}</td>
          </tr>
        `).join('')
    : '<tr><td colspan="6" class="muted">No valid rows. Check the date and amount columns.</td></tr>'}
      </tbody>
    `;

    if (note) {
      note.textContent = built.rows.length
        ? `${built.rows.length} row${built.rows.length === 1 ? '' : 's'} ready to compare${built.skipped ? ` · ${built.skipped} skipped (no date or amount)` : ''}. Showing the first ${Math.min(8, built.rows.length)}.`
        : 'No valid rows. Pick the column that holds the date and the columns that hold the amounts.';
    }
    if (compareButton) compareButton.disabled = built.rows.length === 0;
  }

  async function compareNow() {
    const button = mapCard.querySelector('[data-action="compare"]');
    if (!state.parsed || !state.mapping) return;
    const built = buildRows(state.parsed, state.mapping);
    if (!built.rows.length) {
      toast('No valid statement rows to compare', 'error');
      return;
    }

    readRange();
    const payload = {
      from: state.from,
      to: state.to,
      tolerance_days: state.tolerance,
      rows: built.rows.map((row) => ({
        date: row.date,
        description: row.description,
        reference: row.reference,
        in_cents: row.in_cents,
        out_cents: row.out_cents,
        balance_cents: row.balance_cents,
      })),
    };

    if (button) {
      button.disabled = true;
      button.classList.add('is-loading');
    }
    try {
      const result = await api.post(`/portals/${id}/reconcile`, payload);
      state.result = result;
      renderResults(result);
      resultsEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) {
      toast(error.message || 'Could not compare the statement', 'error');
    } finally {
      if (button) {
        button.disabled = false;
        button.classList.remove('is-loading');
      }
    }
  }

  function renderResults(result) {
    const { summary, balance } = result;
    const closingDifference = balance.closing_difference_cents;
    const fullyReconciled = summary.missing_in_books === 0
      && summary.missing_on_statement === 0
      && (closingDifference == null || closingDifference === 0);

    const bannerText = fullyReconciled
      ? `All ${summary.matched} statement line${summary.matched === 1 ? '' : 's'} match your ledger${closingDifference == null ? '.' : ', and the closing balance agrees.'}`
      : [
        summary.missing_in_books ? `${summary.missing_in_books} statement line${summary.missing_in_books === 1 ? '' : 's'} missing from your books` : '',
        summary.missing_on_statement ? `${summary.missing_on_statement} ledger movement${summary.missing_on_statement === 1 ? '' : 's'} not on the statement` : '',
        closingDifference ? `closing balance differs by ${fmtMoney(closingDifference)}` : '',
      ].filter(Boolean).join(' · ');

    const stats = [
      {
        label: 'Statement closing',
        value: balance.statement_closing_cents == null ? '—' : fmtMoney(balance.statement_closing_cents),
        meta: balance.statement_closing_cents == null ? 'No balance column in the import' : `as printed on the statement`,
      },
      {
        label: 'Ledger closing',
        value: fmtMoney(balance.ledger_closing_cents),
        meta: `at ${fmtDate(result.to)}`,
      },
      {
        label: 'Difference',
        value: closingDifference == null ? '—' : fmtMoney(closingDifference),
        meta: closingDifference == null ? 'Add a balance column to check' : (closingDifference === 0 ? 'Balances agree' : 'Investigate before closing'),
        tone: closingDifference == null || closingDifference === 0 ? '' : 'bad',
      },
      {
        label: 'Matched lines',
        value: `${summary.matched} / ${summary.statement_rows}`,
        meta: `${summary.missing_in_books} missing here · ${summary.missing_on_statement} missing on statement`,
      },
    ];

    resultsEl.innerHTML = `
      <div class="recon-print-head print-only">
        <div>
          <h2>${esc(company)} · Supplier reconciliation</h2>
          <p>${esc(result.portal.name)}${result.portal.vendor_name ? ` · ${esc(result.portal.vendor_name)}` : ''} · ${esc(periodText(result.from, result.to))}</p>
        </div>
        <div class="recon-print-meta">
          <div>Generated ${esc(fmtDate(todayISO(), { long: true }))}</div>
          <div>Match window ${result.tolerance_days} day${result.tolerance_days === 1 ? '' : 's'}</div>
        </div>
      </div>

      <div class="recon-banner ${fullyReconciled ? 'ok' : 'warn'}">
        <div class="recon-banner-icon">${icon(fullyReconciled ? 'check' : 'alert', 20)}</div>
        <div>
          <strong>${fullyReconciled ? 'Statement matches the ledger' : 'Differences found'}</strong>
          <span>${esc(bannerText)}</span>
        </div>
      </div>

      <div class="recon-stats">
        ${stats.map((stat) => `
          <div class="recon-stat">
            <span class="recon-stat-label">${esc(stat.label)}</span>
            <strong class="recon-stat-value ${stat.tone || ''}">${esc(stat.value)}</strong>
            <span class="recon-stat-meta">${esc(stat.meta)}</span>
          </div>
        `).join('')}
      </div>

      <div class="card recon-section">
        <div class="card-head">
          <div class="card-title"><h2>Matched lines</h2><p>${summary.matched} paired movement${summary.matched === 1 ? '' : 's'}</p></div>
          <span class="badge badge-paid">${summary.matched}</span>
        </div>
        <div class="table-wrap">
          ${result.matched.length ? `
            <table class="data recon-table">
              <thead>
                <tr>
                  <th>Statement date</th>
                  <th>Statement line</th>
                  <th class="num">In</th>
                  <th class="num">Out</th>
                  <th>Ledger entry</th>
                  <th>Match</th>
                </tr>
              </thead>
              <tbody>
                ${result.matched.map((pair) => `
                  <tr>
                    <td class="nowrap">${esc(fmtDate(pair.statement.date))}</td>
                    <td>${statementLine(pair.statement)}</td>
                    <td class="num">${pair.statement.in_cents ? fmtMoney(pair.statement.in_cents) : ''}</td>
                    <td class="num">${pair.statement.out_cents ? fmtMoney(pair.statement.out_cents) : ''}</td>
                    <td>
                      <div class="cell-main">${esc(pair.ledger.reference || '—')}</div>
                      <div class="cell-sub">${esc(fmtDate(pair.ledger.date))} · ${esc(pair.ledger.description)}</div>
                    </td>
                    <td>${matchBadge(pair.days_diff, pair.reference_matched)}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          ` : '<div class="recon-empty">Nothing matched yet.</div>'}
        </div>
      </div>

      <div class="card recon-section">
        <div class="card-head">
          <div class="card-title"><h2>On the statement, missing in Ledgerly</h2><p>Record these so your books catch up</p></div>
          <span class="badge ${summary.missing_in_books ? 'badge-overdue' : 'badge-paid'}">${summary.missing_in_books}</span>
        </div>
        <div class="table-wrap">
          ${result.missing_in_books.length ? `
            <table class="data recon-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Statement line</th>
                  <th class="num">In</th>
                  <th class="num">Out</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                ${result.missing_in_books.map((row) => `
                  <tr>
                    <td class="nowrap">${esc(fmtDate(row.date))}</td>
                    <td>
                      ${statementLine(row)}
                      ${row.suggestions && row.suggestions.length ? `<div class="cell-sub recon-suggest">${esc(suggestionText(row.suggestions[0]))}</div>` : ''}
                    </td>
                    <td class="num">${row.in_cents ? fmtMoney(row.in_cents) : ''}</td>
                    <td class="num">${row.out_cents ? fmtMoney(row.out_cents) : ''}</td>
                    <td>
                      <div class="recon-row-actions">
                        ${row.in_cents ? prefillLink(id, 'topup', row, 'Record top-up') : ''}
                        ${row.out_cents && openBills.length ? prefillLink(id, 'settle', row, 'Settle bill') : ''}
                        ${row.out_cents ? prefillLink(id, 'withdraw', row, 'Withdraw') : ''}
                      </div>
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          ` : '<div class="recon-empty ok">Every statement line has a matching ledger movement.</div>'}
        </div>
      </div>

      <div class="card recon-section">
        <div class="card-head">
          <div class="card-title"><h2>In Ledgerly, not on the statement</h2><p>Check whether these were recorded on the portal</p></div>
          <span class="badge ${summary.missing_on_statement ? 'badge-overdue' : 'badge-paid'}">${summary.missing_on_statement}</span>
        </div>
        <div class="table-wrap">
          ${result.missing_on_statement.length ? `
            <table class="data recon-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Reference</th>
                  <th>Ledger movement</th>
                  <th class="num">In</th>
                  <th class="num">Out</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                ${result.missing_on_statement.map((row) => `
                  <tr>
                    <td class="nowrap">${esc(fmtDate(row.date))}</td>
                    <td>${esc(row.reference || '—')}</td>
                    <td>
                      <div class="cell-main">${esc(row.description)}</div>
                      <div class="cell-sub">${esc(row.detail || '')}</div>
                    </td>
                    <td class="num">${row.in_cents ? fmtMoney(row.in_cents) : ''}</td>
                    <td class="num">${row.out_cents ? fmtMoney(row.out_cents) : ''}</td>
                    <td class="right">
                      ${row.bill_id
    ? `<a class="btn btn-ghost btn-xs" href="#/bills/${row.bill_id}">Bill</a>`
    : `<a class="btn btn-ghost btn-xs" href="#/portals/${id}/ledger">Ledger</a>`}
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          ` : '<div class="recon-empty ok">Every ledger movement appears on the statement.</div>'}
        </div>
      </div>

      <div class="recon-foot print-only">
        ${esc(company)} · prepared with Ledgerly · portal balance ${fmtMoney(result.portal.balance_cents)}
      </div>
    `;
  }

  container.querySelector('[data-action="print"]')?.addEventListener('click', () => {
    const previousTitle = document.title;
    document.title = `${portal.name} reconciliation ${state.from} to ${state.to}`;
    const restore = () => { document.title = previousTitle; };
    window.addEventListener('afterprint', restore, { once: true });
    window.print();
    setTimeout(restore, 2000);
  });

  return () => {};
}
