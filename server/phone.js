'use strict';

// One way to save a phone number, however it was typed: "+971 50 806 7050".
// The country comes from a leading + or 00, else from the country chosen
// beside the field (UAE when none). A leading 0 (the local trunk prefix) is
// dropped. The digits after the code are grouped from the end: 4, then 3s.
// The country list is shared with the phone field (public/js/countries.json).

const { bad } = require('./util');

// Digits after the code. The UAE is checked closely (7 for 800 numbers, 8
// landline, 9 mobile); elsewhere landlines and mobiles differ too much, so
// any 6 to 12 digits (the most a number may have) are taken.
const LENGTHS = { AE: [7, 9] };
const COUNTRIES = require('../public/js/countries.json').map(([iso, name, dial]) => {
  const [min, max] = LENGTHS[iso] || [6, 12];
  return { iso, name, dial, min, max };
});
// Where several countries share a code, the first one here wins.
const PREFERRED = new Set(['US', 'RU']);
const byDial = new Map();
for (const country of [...COUNTRIES].sort((a, b) => Number(PREFERRED.has(b.iso)) - Number(PREFERRED.has(a.iso)))) {
  if (!byDial.has(country.dial)) byDial.set(country.dial, country);
}
const byIso = new Map(COUNTRIES.map((country) => [country.iso, country]));
const DEFAULT = byIso.get('AE');

// Invisible marks copied with numbers (direction marks, zero-width spaces).
const INVISIBLE = /[​-‏‪-‮⁦-⁩﻿]/g;

function countryOf(digits) {
  for (let length = 4; length >= 1; length -= 1) {
    const country = byDial.get(digits.slice(0, length));
    if (country) return country;
  }
  return null;
}

function group(national) {
  const parts = [];
  let rest = national;
  if (rest.length > 4) { parts.unshift(rest.slice(-4)); rest = rest.slice(0, -4); }
  while (rest.length > 3) { parts.unshift(rest.slice(-3)); rest = rest.slice(0, -3); }
  if (rest) parts.unshift(rest);
  return parts.join(' ');
}

// Returns '' for an empty value, the saved form otherwise; refuses a number
// whose length does not fit its country.
function normalizePhone(value, field = 'Phone', defaultIso = 'AE') {
  const raw = String(value ?? '').replace(INVISIBLE, '').trim();
  if (!raw) return '';
  if (/[^\d\s+().\-/]/.test(raw)) throw bad(`${field}: use digits only`);
  let digits = raw.replace(/[^\d+]/g, '');
  let country;
  if (digits.startsWith('00')) digits = `+${digits.slice(2)}`;
  if (digits.startsWith('+')) {
    digits = digits.slice(1).replace(/\+/g, '');
    country = countryOf(digits);
    if (!country) throw bad(`${field}: the country code is not known`);
    digits = digits.slice(country.dial.length);
  } else {
    digits = digits.replace(/\+/g, '');
    country = byIso.get(defaultIso) || DEFAULT;
    // Typed with the code but without + (971 50 …): too long to be local.
    if (digits.startsWith(country.dial) && digits.length - country.dial.length >= country.min && digits.length > country.max + 1) {
      digits = digits.slice(country.dial.length);
    }
  }
  if (country.iso !== 'IT') digits = digits.replace(/^0/, '');
  if (digits.length < country.min || digits.length > country.max) {
    const lengths = country.min === country.max ? `${country.min}` : `${country.min} to ${country.max}`;
    throw bad(`${field}: a ${country.name} number has ${lengths} digits after +${country.dial}`);
  }
  // North American area codes (+1 242 Bahamas…) print after +1, as they are dialled.
  const code = country.dial.length === 4 && country.dial.startsWith('1') ? `1 ${country.dial.slice(1)}` : country.dial;
  return `+${code} ${group(digits)}`;
}

// The saved form, or the value as it was when it cannot be read (used to
// tidy numbers saved before this rule, without losing any).
function tidyPhone(value) {
  try { return normalizePhone(value); } catch { return String(value ?? ''); }
}

module.exports = { COUNTRIES, normalizePhone, tidyPhone };
