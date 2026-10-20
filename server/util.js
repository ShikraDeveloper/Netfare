'use strict';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const bad = (message) => new HttpError(400, message);
const notFound = (message = 'Not found') => new HttpError(404, message);
const conflict = (message) => new HttpError(409, message);

function str(value, field, { required = true, max = 500, fallback = '' } = {}) {
  if (value == null || value === '') {
    if (required) throw bad(`${field} is required`);
    return fallback;
  }
  if (typeof value !== 'string') throw bad(`${field} must be text`);
  const trimmed = value.trim();
  if (required && !trimmed) throw bad(`${field} is required`);
  if (trimmed.length > max) throw bad(`${field} must be ${max} characters or fewer`);
  return trimmed;
}

function optionalStr(value, field, max = 500) {
  return str(value, field, { required: false, max });
}

function num(value, field, { min = -Infinity, max = Infinity, fallback } = {}) {
  if (value == null || value === '') {
    if (fallback !== undefined) return fallback;
    throw bad(`${field} is required`);
  }
  const n = Number(value);
  if (!Number.isFinite(n)) throw bad(`${field} must be a number`);
  if (n < min) throw bad(`${field} must be at least ${min}`);
  if (n > max) throw bad(`${field} must be at most ${max}`);
  return n;
}

function cents(value, field, { min = 0, max = 1_000_000_000_00 } = {}) {
  const n = Math.round(num(value, field, { min, max }));
  return n;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function dateISO(value, field) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw bad(`${field} must be a date (YYYY-MM-DD)`);
  }
  const [y, m, d] = value.split('-').map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d));
  if (utc.getUTCFullYear() !== y || utc.getUTCMonth() !== m - 1 || utc.getUTCDate() !== d) {
    throw bad(`${field} is not a valid date`);
  }
  return value;
}

function todayISO(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d + days));
  return `${utc.getUTCFullYear()}-${pad2(utc.getUTCMonth() + 1)}-${pad2(utc.getUTCDate())}`;
}

function monthRange(dateStr) {
  const [y, m] = dateStr.split('-').map(Number);
  const start = `${y}-${pad2(m)}-01`;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start, end: `${y}-${pad2(m)}-${pad2(lastDay)}` };
}

function shiftMonth(dateStr, delta) {
  const [y, m] = dateStr.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

function isTruthy(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

module.exports = {
  HttpError,
  bad,
  notFound,
  conflict,
  str,
  optionalStr,
  num,
  cents,
  dateISO,
  todayISO,
  addDays,
  monthRange,
  shiftMonth,
  isTruthy,
};
