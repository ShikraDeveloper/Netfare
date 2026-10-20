'use strict';

const express = require('express');
const path = require('path');
const db = require('./db');
const { startAutoBackup } = require('./services/backup');

const app = express();
const PORT = Number(process.env.PORT) || 4173;
const HOST = process.env.HOST || '127.0.0.1';

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; '));
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    if (elapsedMs >= 1500 || res.statusCode >= 500) {
      console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${elapsedMs.toFixed(0)}ms`);
    }
  });
  next();
});

app.use('/api', require('./routes'));

const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Something went wrong on the server' : err.message });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`\n  Ledgerly is running at http://${HOST}:${PORT}\n`);
  startAutoBackup(db);
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close(() => {
    try { db.close(); } catch { /* already closed */ }
    process.exit(0);
  });
  setTimeout(() => {
    try { db.close(); } catch { /* already closed */ }
    process.exit(0);
  }, 1500).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', (error) => {
  console.error('Unhandled promise rejection:', error);
});
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  shutdown();
});
