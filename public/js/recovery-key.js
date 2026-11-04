// Showing the admin's recovery key once, with Copy, Print and an "I saved
// it" tick. Used after sign-in, after a reset and from Settings.

import { esc, icon, toast } from './ui.js';

export function keyPanelHtml(key) {
  return `
    <div class="recovery-key" data-recovery-key>
      <output class="recovery-key-value" aria-label="Recovery key">${esc(key)}</output>
      <div class="recovery-key-actions">
        <button type="button" class="btn btn-secondary btn-sm" data-key-copy>${icon('copy', 15)} Copy</button>
        <button type="button" class="btn btn-secondary btn-sm" data-key-print>${icon('print', 15)} Print</button>
      </div>
      <label class="checkbox-row recovery-key-saved">
        <input type="checkbox" data-key-saved>
        <span>I saved the key somewhere safe</span>
      </label>
    </div>`;
}

async function copyKey(panel, key) {
  try {
    await navigator.clipboard.writeText(key);
  } catch {
    // Plain http on the office network has no clipboard API: select the key
    // so Ctrl+C works.
    const range = document.createRange();
    range.selectNodeContents(panel.querySelector('.recovery-key-value'));
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    if (!document.execCommand('copy')) {
      toast('Press Ctrl+C (⌘C on a Mac) to copy the selected key', 'error');
      return;
    }
  }
  toast('Recovery key copied');
}

// Prints only a sheet with the key, not the screen behind it.
function printKey(key) {
  const sheet = document.createElement('div');
  sheet.className = 'recovery-print';
  sheet.innerHTML = `
    <h1>Netfare admin recovery key</h1>
    <p class="recovery-print-key">${esc(key)}</p>
    <p>If you forget the admin password: on the main computer, open Netfare and choose
      Help → Reset admin password, then enter this key.</p>
    <p>Keep this paper somewhere safe and away from the computer. Printed ${esc(new Date().toLocaleDateString())}.</p>`;
  document.body.appendChild(sheet);
  document.body.classList.add('printing-recovery');
  const done = () => {
    sheet.remove();
    document.body.classList.remove('printing-recovery');
    window.removeEventListener('afterprint', done);
  };
  window.addEventListener('afterprint', done);
  window.print();
  setTimeout(done, 1000);
}

// Calls onSaved(checked) whenever the tick changes.
export function bindKeyPanel(root, key, onSaved = () => {}) {
  const panel = root.querySelector('[data-recovery-key]');
  panel.querySelector('[data-key-copy]').addEventListener('click', () => copyKey(panel, key));
  panel.querySelector('[data-key-print]').addEventListener('click', () => printKey(key));
  const tick = panel.querySelector('[data-key-saved]');
  tick.addEventListener('change', () => onSaved(tick.checked));
  return tick;
}
