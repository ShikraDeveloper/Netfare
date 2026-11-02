'use strict';

// Office network mode. Off: Netfare listens on this computer only. On: other
// computers on the office network or the agency's Tailscale network may open
// it (everyone still signs in). Addresses from the internet are always
// refused, so a forwarded router port does not expose the books.

const net = require('net');
const os = require('os');

function ipv4Parts(ip) {
  const parts = String(ip).split('.').map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) ? parts : null;
}

function isLoopback(address) {
  const ip = String(address || '').replace(/^::ffff:/i, '');
  return ip === '::1' || ipv4Parts(ip)?.[0] === 127;
}

// Loopback, private LAN ranges, Tailscale (100.64.0.0/10 and fd7a:…) and
// link-local addresses.
function isOfficeAddress(address) {
  const ip = String(address || '').replace(/^::ffff:/i, '').replace(/^\[|\]$/g, '').toLowerCase();
  const v4 = ipv4Parts(ip);
  if (v4) {
    const [a, b] = v4;
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254);
  }
  if (net.isIPv6(ip)) return ip === '::1' || /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip);
  return false;
}

function isTailscaleAddress(ip) {
  const v4 = ipv4Parts(ip);
  return Boolean(v4 && v4[0] === 100 && v4[1] >= 64 && v4[1] <= 127) || /^fd7a:115c:a1e0:/i.test(ip);
}

// This computer's own names: "office-mac" and "office-mac.local".
function ownHostnames() {
  const name = os.hostname().toLowerCase().replace(/\.local$/, '');
  return name ? [name, `${name}.local`] : [];
}

function cleanHostList(value) {
  return String(value || '')
    .split(/[\s,]+/)
    .map((host) => host.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[:/].*$/, ''))
    .filter((host) => /^[a-z0-9.-]{1,253}$/.test(host));
}

function readSettings(db) {
  const row = db.prepare('SELECT lan_enabled, lan_hosts FROM settings WHERE id = 1').get() || {};
  return { lan_enabled: Boolean(row.lan_enabled), lan_hosts: cleanHostList(row.lan_hosts) };
}

// What the running server listens on; set once it starts.
const running = { host: '127.0.0.1', port: 4173 };

function setRunning(host, port) {
  running.host = host;
  running.port = Number(port);
}

function listensOnNetwork() {
  return !isLoopback(running.host) && running.host !== 'localhost';
}

// A Host or Origin name the browser used. In office mode, an office IP,
// this computer's name or a name the admin added (a Tailscale name) also
// counts; other names are still refused against DNS rebinding.
function isOfficeHostname(db, hostname) {
  if (!listensOnNetwork()) return false;
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return isOfficeAddress(host);
  return ownHostnames().includes(host) || readSettings(db).lan_hosts.includes(host);
}

// The links staff type on other computers.
function connectAddresses(db) {
  const port = running.port;
  const addresses = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.internal || entry.family !== 'IPv4' || !isOfficeAddress(entry.address)) continue;
      if (entry.address.startsWith('169.254.')) continue;
      addresses.push({
        kind: isTailscaleAddress(entry.address) ? 'Tailscale' : 'Office network',
        url: `http://${entry.address}:${port}`,
        interface: name,
      });
    }
  }
  const [, dotLocal] = ownHostnames();
  if (dotLocal) addresses.push({ kind: 'Computer name', url: `http://${dotLocal}:${port}` });
  for (const host of readSettings(db).lan_hosts) addresses.push({ kind: 'Added name', url: `http://${host}:${port}` });
  return addresses;
}

module.exports = {
  isLoopback,
  isOfficeAddress,
  isOfficeHostname,
  cleanHostList,
  readSettings,
  setRunning,
  listensOnNetwork,
  connectAddresses,
};
