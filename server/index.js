'use strict';

const express = require('express');
const path = require('path');
const db = require('./db');
const { startAutoBackup } = require('./services/backup');
const { hostGuard, apiGuard } = require('./security');
const network = require('./network');

const app = express();
const PORT = Number(process.env.PORT) || 4173;
// Office network mode (Settings) listens on every interface; otherwise this
// computer only. HOST still overrides both.
const HOST = process.env.HOST || (network.readSettings(db).lan_enabled ? '0.0.0.0' : '127.0.0.1');
network.setRunning(HOST, PORT);
const officeName = (hostname) => network.isOfficeHostname(db, hostname);

app.disable('x-powered-by');
// Only this computer and, in office mode, the office network or Tailscale.
app.use((req, res, next) => {
  const address = req.socket.remoteAddress;
  if (network.isLoopback(address) || (network.listensOnNetwork() && network.isOfficeAddress(address))) return next();
  return res.status(403).type('text/plain').send('Netfare accepts connections only from this computer and the office network.');
});
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // Other sites may not load anything from here, not even an image.
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; '));
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(hostGuard({ extra: officeName }));
app.use('/api', apiGuard({ port: PORT, extra: officeName }));
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

const server = app.listen(PORT, HOST);
// Resolves once Netfare is listening; the desktop app waits on it.
const ready = new Promise((resolve, reject) => {
  server.once('listening', resolve);
  server.once('error', reject);
});
ready.then(() => {
  console.log(`\n  Netfare is running at http://${network.listensOnNetwork() ? '127.0.0.1' : HOST}:${PORT}`);
  if (network.listensOnNetwork()) {
    console.log('  Office network mode is on. Other computers can open:');
    for (const address of network.connectAddresses(db)) console.log(`    ${address.url}  (${address.kind})`);
  }
  console.log('');
  startAutoBackup(db);
}, (error) => {
  if (require.main !== module) return;
  console.error(error.code === 'EADDRINUSE'
    ? `\n  Port ${PORT} is already in use. Is Netfare already running?\n`
    : `\n  Netfare could not start: ${error.message}\n`);
  process.exitCode = 1;
  try { db.close(); } catch { /* already closed */ }
});

let shuttingDown = false;
function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close(() => {
    try { db.close(); } catch { /* already closed */ }
    process.exit(exitCode);
  });
  setTimeout(() => {
    try { db.close(); } catch { /* already closed */ }
    process.exit(exitCode);
  }, 1500).unref();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('unhandledRejection', (error) => {
  console.error('Unhandled promise rejection:', error);
  process.exitCode = 1;
});
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  process.exitCode = 1;
  shutdown(1);
});

module.exports = { app, server, ready, shutdown };
