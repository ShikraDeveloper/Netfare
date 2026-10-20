import { esc, fmtDate } from '../../ui.js';

// ---------------------------------------------------------------------------
// Statement parsing
//
// Portal statements arrive as CSV, TSV, or rows copied out of a web table, and
// the columns are never named the same way twice. Everything here is tolerant:
// detect the delimiter, detect the header, detect the columns, then let the
// user correct the mapping before comparing.
// ---------------------------------------------------------------------------

export const DELIMITERS = [',', '\t', ';', '|'];
export const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

export const COLUMN_HINTS = {
  date: ['date', 'txn date', 'transaction date', 'value date', 'posting date', 'booking date', 'created', 'time'],
  description: ['description', 'particulars', 'particular', 'details', 'detail', 'narration', 'transaction', 'activity', 'type', 'remark', 'memo', 'product'],
  reference: ['reference', 'ref', 'document', 'doc no', 'doc', 'ticket', 'invoice', 'voucher', 'pnr', 'order', 'receipt'],
  in: ['credit', 'deposit', 'top up', 'top-up', 'topup', 'paid in', 'received', 'money in', 'amount in', 'cr'],
  out: ['debit', 'usage', 'used', 'spent', 'paid out', 'money out', 'amount out', 'dr', 'charge', 'consumption', 'withdraw'],
  amount: ['amount', 'value', 'net', 'total'],
  balance: ['balance', 'available', 'running'],
};

export function parseDelimited(text, delimiter) {
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

export function detectDelimiter(text) {
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

export function isoFromParts(year, month, day) {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function monthFromWord(word) {
  const key = String(word || '').toLowerCase();
  return MONTHS[key.slice(0, 4)] || MONTHS[key.slice(0, 3)] || null;
}

export function parseDateCell(value, format = 'auto') {
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

export function parseAmountCell(value) {
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

export function isHeaderRow(row) {
  const hasDate = row.some((cell) => parseDateCell(cell) !== null);
  const hasAmount = row.some((cell) => cell !== '' && parseAmountCell(cell) !== null);
  const hasWord = row.some((cell) => /[a-z]{3,}/i.test(cell));
  return hasWord && !hasDate && !hasAmount;
}

export function parseStatement(text) {
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

export function hintMatches(text, word) {
  return word.length <= 3 ? text === word : text.includes(word);
}

export function detectMapping(parsed) {
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

export function columnLabel(parsed, index) {
  if (index == null) return '';
  const label = parsed.headerCells ? parsed.headerCells[index] : '';
  return label && String(label).trim() ? String(label).trim() : `Column ${index + 1}`;
}

export function interpretRow(cells, mapping) {
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

export function buildRows(parsed, mapping) {
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

export function columnOptions(parsed, selected, { allowNone = false, noneLabel = '— none —' } = {}) {
  const options = Array.from({ length: parsed.width }, (_, index) => `
    <option value="${index}" ${index === selected ? 'selected' : ''}>${esc(columnLabel(parsed, index))}</option>
  `).join('');
  return `${allowNone ? `<option value="" ${selected == null ? 'selected' : ''}>${esc(noneLabel)}</option>` : ''}${options}`;
}

export function selectField(label, field, parsed, selected, options = {}) {
  return `
    <div class="field">
      <label>${esc(label)}</label>
      <select class="input" data-map="${field}">
        ${columnOptions(parsed, selected, options)}
      </select>
    </div>
  `;
}

export function statementLine(row) {
  return `
    <div class="cell-main">${esc(row.description || '(no description)')}</div>
    ${row.reference ? `<div class="cell-sub">${esc(row.reference)}</div>` : ''}
  `;
}

export function matchBadge(days, referenceMatched) {
  if (referenceMatched) return '<span class="match-pill good">Reference</span>';
  if (days === 0) return '<span class="match-pill good">Same day</span>';
  return `<span class="match-pill">${days > 0 ? '+' : ''}${days}d</span>`;
}

export function suggestionText(entry) {
  const reason = entry.reason === 'reference'
    ? 'same reference'
    : entry.reason === 'outside-window'
      ? 'amount matches, outside the match window'
      : 'same date, different amount';
  return `Possible match: ${entry.ledger.reference || entry.ledger.description} on ${fmtDate(entry.ledger.date)} (${reason})`;
}

export function prefillLink(portalId, record, row, label) {
  const params = new URLSearchParams({
    record,
    date: row.date,
    amount: (row.amount_cents / 100).toFixed(2),
  });
  if (row.reference) params.set('reference', row.reference);
  return `<a class="btn btn-ghost btn-xs" href="#/portals/${portalId}?${params.toString()}">${esc(label)}</a>`;
}

export function periodText(from, to) {
  return from === to
    ? fmtDate(from, { long: true })
    : `${fmtDate(from, { long: true })} – ${fmtDate(to, { long: true })}`;
}

