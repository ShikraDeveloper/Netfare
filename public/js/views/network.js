// Settings card (admin only): let other computers in the office, or on the
// agency's Tailscale network, open Netfare from their browser.

import { api } from '../api.js';
import { esc, icon, toast } from '../ui.js';

function addressesHtml(status) {
  if (!status.running_on_network) {
    return `<p class="muted network-state">${icon('lock', 14)} Running for <strong>this computer only</strong>.</p>`;
  }
  const rows = status.addresses.map((address) => `
    <li><span class="chip">${esc(address.kind)}</span> <code>${esc(address.url)}</code></li>`).join('');
  // Only Tailscale is encrypted; other addresses carry passwords as plain text.
  const plain = status.addresses.some((address) => address.kind !== 'Tailscale');
  const warning = plain ? `
    <div class="callout network-warning" role="alert" style="margin-top:10px">
      <strong>Not encrypted.</strong> Over the office network or Wi-Fi, passwords and sign-ins can be read by anyone else on that network. Use these only on a wired or trusted network, and use the <strong>Tailscale</strong> address for Wi-Fi or working from home.
    </div>` : '';
  return `
    <p class="network-state">${icon('check', 14)} Running for the <strong>office network</strong>. On another computer, open one of these in the browser:</p>
    <ul class="network-addresses">${rows || '<li class="muted">No network connection found on this computer.</li>'}</ul>${warning}`;
}

export function networkCardHtml() {
  return `
    <div class="card" id="network-card">
      <div class="card-head">
        <div class="card-title"><h2>Office network</h2></div>
      </div>
      <form id="network-form" class="settings-form" novalidate>
        <div class="card-body">
          <div id="network-addresses"><p class="muted">Loading…</p></div>
          <label class="checkbox-row" style="margin-top:12px">
            <input type="checkbox" name="lan_enabled" id="network-enabled">
            <span><strong>Allow other computers</strong> on the office network or Tailscale. Everyone still signs in with their own user. Computers on the internet are always refused.</span>
          </label>
          <div class="field" style="margin-top:12px">
            <label for="network-hosts">Extra names (Tailscale)</label>
            <input class="input" id="network-hosts" name="lan_hosts" autocomplete="off" autocapitalize="none" spellcheck="false"
              placeholder="office-mac.tail1234.ts.net">
          </div>
          <div class="form-note" style="margin-top:12px">
            Takes effect after Netfare restarts. Only Tailscale is encrypted. Office Wi-Fi and the office network are not, so anyone on them could read passwords: prefer Tailscale for everyone.
          </div>
        </div>
        <div class="settings-actions">
          <button class="btn btn-primary" type="submit">Save network settings</button>
        </div>
      </form>
    </div>`;
}

export function bindNetworkCard(container) {
  const form = container.querySelector('#network-form');
  const addresses = container.querySelector('#network-addresses');
  let saved = null;

  function show(status) {
    saved = status;
    addresses.innerHTML = addressesHtml(status);
    form.elements.lan_enabled.checked = status.lan_enabled;
    form.elements.lan_hosts.value = status.lan_hosts.join(' ');
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      const before = saved?.lan_enabled;
      const status = await api.put('/admin/network', {
        lan_enabled: form.elements.lan_enabled.checked,
        lan_hosts: form.elements.lan_hosts.value,
      });
      show(status);
      toast(status.lan_enabled !== before
        ? 'Saved. Restart Netfare to apply the change.'
        : 'Network settings saved');
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      button.disabled = false;
    }
  });

  api.get('/admin/network').then(show).catch((error) => {
    addresses.innerHTML = `<p class="muted">${esc(error.message)}</p>`;
  });
}
