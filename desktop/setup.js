'use strict';

// The first-run setup screen. The choices go to the app through preload.js.

const message = document.getElementById('message');
const buttons = Array.from(document.querySelectorAll('button'));

function show(text) {
  message.textContent = text || '';
  message.hidden = !text;
}

async function run(action) {
  show('');
  buttons.forEach((button) => { button.disabled = true; });
  try {
    const result = await action();
    if (result && result.error) show(result.error);
  } catch (error) {
    show(error.message || 'Something went wrong');
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
  }
}

// A message from the app, such as "the office computer did not answer".
show(new URLSearchParams(location.search).get('message'));

document.getElementById('use-main').addEventListener('click', () => run(() => window.netfareSetup.useThisComputer()));
document.getElementById('import').addEventListener('click', () => run(() => window.netfareSetup.importBackup()));
document.getElementById('connect-form').addEventListener('submit', (event) => {
  event.preventDefault();
  run(() => window.netfareSetup.connect(document.getElementById('address').value));
});
