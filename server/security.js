'use strict';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const DEFAULT_HOSTS = ['127.0.0.1', 'localhost', '[::1]'];

function splitList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function configuredHosts(env = process.env) {
  return new Set([...DEFAULT_HOSTS, ...splitList(env.LEDGERLY_ALLOWED_HOSTS)]);
}

function configuredOrigins(env = process.env) {
  return new Set(splitList(env.LEDGERLY_ALLOWED_ORIGINS));
}

function hostnameFromHost(host) {
  const value = String(host || '').trim().toLowerCase();
  if (!value) return '';
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end === -1 ? '' : value.slice(0, end + 1);
  }
  const colon = value.lastIndexOf(':');
  if (colon !== -1 && value.indexOf(':') === colon) return value.slice(0, colon);
  return value;
}

function isAllowedHost(host, allowed = configuredHosts()) {
  return allowed.has(hostnameFromHost(host));
}

function isAllowedOrigin(origin, { port = process.env.PORT || 4173, hosts = configuredHosts(), origins = configuredOrigins() } = {}) {
  if (origin == null || origin === '') return true;
  if (String(origin).toLowerCase() === 'null') return false;
  if (origins.has(String(origin).toLowerCase())) return true;

  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return false;
  if (!hosts.has(parsed.hostname.toLowerCase())) return false;
  const actualPort = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
  return actualPort === String(port);
}

function hasRequestBody(req) {
  return Boolean(req.headers['transfer-encoding']) || Number(req.headers['content-length'] || 0) > 0;
}

function hostGuard({ hosts = configuredHosts() } = {}) {
  return (req, res, next) => {
    if (isAllowedHost(req.get('host'), hosts)) return next();
    if (req.path.startsWith('/api/')) return res.status(421).json({ error: 'Misdirected request' });
    return res.status(421).type('text/plain').send('Misdirected request');
  };
}

// Browsers say where a request came from. Only the app's own pages
// (same-origin) and the user typing or bookmarking a URL (none) may reach the
// API, so another site or local port cannot pull downloads, backups or
// attachments. Clients without the header (scripts, curl) are unaffected.
const ALLOWED_FETCH_SITES = new Set(['same-origin', 'none']);

function isAllowedFetchSite(req, origins = configuredOrigins()) {
  const site = req.get('sec-fetch-site');
  if (!site || ALLOWED_FETCH_SITES.has(site.toLowerCase())) return true;
  const origin = String(req.get('origin') || '').toLowerCase();
  return Boolean(origin) && origins.has(origin);
}

function apiGuard({ port = process.env.PORT || 4173, hosts = configuredHosts(), origins = configuredOrigins() } = {}) {
  return (req, res, next) => {
    if (!isAllowedFetchSite(req, origins)) {
      return res.status(403).json({ error: 'Cross-site request blocked' });
    }
    if (SAFE_METHODS.has(req.method)) return next();
    if (!isAllowedOrigin(req.get('origin'), { port, hosts, origins })) {
      return res.status(403).json({ error: 'Cross-origin request blocked' });
    }
    // The UI always sends JSON. Raw uploads use octet-stream. A bodyless DELETE is safe.
    if (req.method === 'DELETE' && !hasRequestBody(req)) return next();
    if (!req.is('application/json') && !req.is('application/octet-stream')) {
      return res.status(415).json({ error: 'Send JSON or binary data' });
    }
    next();
  };
}

module.exports = {
  DEFAULT_HOSTS,
  configuredHosts,
  configuredOrigins,
  hostnameFromHost,
  isAllowedHost,
  isAllowedOrigin,
  isAllowedFetchSite,
  hostGuard,
  apiGuard,
};
