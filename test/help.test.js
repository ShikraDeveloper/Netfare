'use strict';

// The help panel: questions with no answer are saved for the admin, and every
// "Show me" button in the help topics points at a button the screens draw.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-help-test-'));
process.env.LEDGERLY_DATA_DIR = tempDir;

const express = require('express');
const db = require('../server/db');
const { refusal } = require('../server/permissions');

let server;
after(() => {
  server?.close();
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function start() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = req.get('x-admin') ? { is_admin: 1, full_name: 'Boss' } : { is_admin: 0, full_name: 'Sara', permissions: '{}' };
    next();
  });
  app.use('/help-questions', require('../server/routes/help-questions'));
  app.use((error, req, res, next) => res.status(error.status || 500).json({ error: error.message })); // eslint-disable-line no-unused-vars
  return new Promise((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)); });
}

test('staff send a help question; only the admin reads and clears them', async () => {
  const staff = { is_admin: 0, permissions: '{}' };
  assert.equal(refusal(db, staff, { method: 'POST', path: '/help-questions', query: {}, body: {} }), null, 'staff with no rights may still ask');

  const base = await start();
  const call = (method, url, body, admin) => fetch(`${base}${url}`, {
    method, headers: { 'content-type': 'application/json', ...(admin ? { 'x-admin': '1' } : {}) }, body: body && JSON.stringify(body),
  });
  assert.equal((await call('POST', '/help-questions', { question: '  how do I return a visa deposit  ', page: 'VIS-2026-0004' })).status, 201);
  assert.equal((await call('POST', '/help-questions', { question: '' })).status, 400);
  assert.equal((await call('POST', '/help-questions', { question: 'x'.repeat(301) })).status, 400);
  assert.equal((await call('GET', '/help-questions')).status, 403);

  const [row] = await (await call('GET', '/help-questions', null, true)).json();
  assert.deepEqual([row.question, row.page, row.asked_by], ['how do I return a visa deposit', 'VIS-2026-0004', 'Sara']);
  assert.equal((await call('DELETE', `/help-questions/${row.id}`)).status, 403);
  assert.equal((await call('DELETE', `/help-questions/${row.id}`, null, true)).status, 200);
  assert.deepEqual(await (await call('GET', '/help-questions', null, true)).json(), []);
});

test('every "Show me" in the help topics names a button the screens draw', () => {
  const views = path.join(__dirname, '../public/js/views');
  const source = fs.readdirSync(views, { recursive: true })
    .filter((file) => file.endsWith('.js'))
    .map((file) => fs.readFileSync(path.join(views, file), 'utf8'))
    .join('\n');
  const topics = fs.readFileSync(path.join(__dirname, '../public/js/help-topics.js'), 'utf8');
  const selectors = [...topics.matchAll(/go: '([^']+)'/g)].flatMap((match) => match[1].split(','));
  assert.ok(selectors.length > 20);
  for (const selector of selectors) {
    const [, attribute, value] = selector.trim().match(/^\[([a-z-]+)(?:="([^"]+)")?\]$/) || [];
    assert.ok(attribute, `${selector} is a plain [data-…] selector`);
    assert.ok(source.includes(value ? `${attribute}="${value}"` : `${attribute}=`), `${selector} is drawn by a screen`);
  }
});
