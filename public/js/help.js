import { api } from './api.js';
import { HELP_TOPICS } from './help-topics.js';
import { can } from './store.js';
import { esc, icon } from './ui.js';

// The "?" button in the corner: answers for the screen or form in front of
// you, and a box to ask in your own words, in English. The search
// matches words, no AI. A question with no answer is saved for the admin
// (Settings → Help questions), so the next answers come from real questions.
// shortcut: word matching only; if saved questions show it missing often, add a small local model.

const STOP = new Set('a an and are can do does for from how i in is it me my of on or the this that to what when where which why with you'.split(' '));

const fold = (text) => String(text || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
const wordsOf = (text) => fold(text).split(/[^a-z0-9]+/).filter((word) => word.length > 1 && !STOP.has(word));
// "refund" finds "refunds" and "refunded"; very short words must match whole.
const sameWord = (a, b) => a === b || (a.length >= 3 && b.length >= 3 && (a.startsWith(b) || b.startsWith(a)));

// The screen and the form on top, if any.
function context() {
  const path = (location.hash.replace(/^#/, '') || '/dashboard').split('?')[0];
  const form = [...document.querySelectorAll('.modal-overlay:not(.is-closing) .modal-head h2')].at(-1)?.textContent.trim() || '';
  const title = form || document.getElementById('page-title')?.textContent.replace(/\s+/g, ' ').trim() || '';
  return { path, form, title };
}

const allowed = () => HELP_TOPICS.filter((topic) => can(topic.area));

export function topicsHere(ctx = context()) {
  const topics = allowed();
  const forForm = ctx.form ? topics.filter((topic) => topic.form?.test(ctx.form)) : [];
  return forForm.length ? forForm : topics.filter((topic) => topic.page?.test(ctx.path));
}

// Best answers first; topics for this screen win a tie.
export function searchTopics(query, ctx = context()) {
  const asked = wordsOf(query);
  if (!asked.length) return [];
  const here = new Set(topicsHere(ctx));
  const rows = allowed()
    .map((topic) => {
      const hay = wordsOf(`${topic.q} ${topic.words}`);
      const found = asked.filter((word) => hay.some((other) => sameWord(word, other))).length;
      return { topic, score: found + (found && here.has(topic) ? 1 : 0), found };
    })
    .filter((row) => row.found >= Math.ceil(asked.length / 2))
    .sort((a, b) => b.score - a.score);
  // Only the best: a weaker answer from another screen is left out.
  return rows.filter((row) => row.score >= rows[0].score - 0.5).slice(0, 5).map((row) => row.topic);
}

// On screen, or inside a folded section (Payments) that "Show me" opens.
const findOnPage = (selector) => [...document.querySelectorAll(selector)]
  .find((element) => element.offsetParent !== null || element.closest('details:not([open])')?.offsetParent);
const stepHtml = (step) => esc(step).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

// Show me only for this screen's own answers: another screen's would mark a look-alike button here.
function topicHtml(topic, open, here) {
  return `<details class="help-topic" ${open ? 'open' : ''}>
    <summary>${esc(topic.q)}</summary>
    <ol>${topic.steps.map((step) => `<li>${stepHtml(step)}</li>`).join('')}</ol>
    ${topic.go && here.has(topic) && findOnPage(topic.go) ? `<button type="button" class="btn btn-secondary btn-sm" data-help-go="${esc(topic.id)}">Show me on this page</button>` : ''}
  </details>`;
}

export function mountHelp() {
  if (document.querySelector('.help-fab')) return;
  document.body.insertAdjacentHTML('beforeend', `
    <button type="button" class="help-fab" aria-expanded="false" aria-controls="help-panel" title="Help">${icon('help', 22)}<span class="sr-only">Help</span></button>
    <aside class="help-panel" id="help-panel" aria-labelledby="help-title" hidden>
      <div class="help-head"><h2 id="help-title">${icon('help', 16)} Help</h2>
        <button type="button" class="icon-btn" data-help-close aria-label="Close help">${icon('x', 16)}</button></div>
      <div class="help-body" aria-live="polite"></div>
      <form class="help-ask" novalidate>
        <input class="input" type="text" maxlength="300" autocomplete="off" placeholder="Ask about this page" aria-label="Your question">
        <button type="submit" class="btn btn-primary btn-sm">Ask</button>
      </form>
    </aside>`);
  const fab = document.querySelector('.help-fab');
  const panel = document.getElementById('help-panel');
  const body = panel.querySelector('.help-body');
  const input = panel.querySelector('.help-ask input');
  let shown = [];

  const render = ({ query = '', note = '' } = {}) => {
    const ctx = context();
    const typed = query.trim();
    const here = new Set(topicsHere(ctx));
    shown = typed ? searchTopics(typed, ctx) : [...here];
    const head = typed
      ? (shown.length ? '<p class="help-label">Answers</p>' : '')
      : `<p class="help-where">You're on: <strong>${esc(ctx.title || 'this page')}</strong></p>${shown.length ? '<p class="help-label">Asked here</p>' : ''}`;
    const empty = typed
      ? '<p class="help-none">No answer for that yet. Press <strong>Ask</strong> to send it to the admin, so help for it gets written.</p>'
      : '<p class="help-none">No help for this screen yet. Type your question below.</p>';
    body.innerHTML = `${head}${note}${shown.length ? shown.map((topic, i) => topicHtml(topic, typed && i === 0, here)).join('') : (note ? '' : empty)}
      ${typed && shown.length ? '<button type="button" class="help-link" data-help-send>Not what you asked? Send the question to the admin</button>' : ''}`;
  };

  const send = async (question) => {
    try {
      await api.post('/help-questions', { question, page: context().title });
      render({ note: `<p class="help-sent">${icon('check', 14)} Sent to the admin: “${esc(question)}”. Help for it will be added.</p>` });
      input.value = '';
    } catch (error) {
      render({ query: question, note: `<p class="help-none">Could not send it: ${esc(error.message)}</p>` });
    }
  };

  const setOpen = (open) => {
    panel.hidden = !open;
    fab.setAttribute('aria-expanded', String(open));
    if (open) { render({ query: input.value }); input.focus(); } else fab.focus();
  };

  fab.addEventListener('click', () => setOpen(panel.hidden));
  panel.querySelector('[data-help-close]').addEventListener('click', () => setOpen(false));
  // Escape closes the help, not the form underneath it.
  panel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); }
  });
  input.addEventListener('input', () => render({ query: input.value }));
  panel.querySelector('.help-ask').addEventListener('submit', (event) => {
    event.preventDefault();
    const question = input.value.trim();
    if (!question) { input.focus(); return; }
    if (searchTopics(question).length) render({ query: question });
    else send(question);
  });
  body.addEventListener('click', (event) => {
    if (event.target.closest('[data-help-send]')) { send(input.value.trim()); return; }
    const go = event.target.closest('[data-help-go]');
    if (!go) return;
    const target = findOnPage(shown.find((topic) => topic.id === go.dataset.helpGo)?.go || '');
    if (!target) return;
    for (let fold = target.closest('details:not([open])'); fold; fold = fold.parentElement?.closest('details:not([open])')) fold.open = true;
    // The panel would cover the button; reopening shows the same answer.
    panel.hidden = true;
    fab.setAttribute('aria-expanded', 'false');
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    target.focus({ preventScroll: true });
    target.classList.remove('help-flash');
    void target.offsetWidth;
    target.classList.add('help-flash');
    setTimeout(() => target.classList.remove('help-flash'), 2600);
  });
  // Another screen or form came up while the help is open: show its answers.
  let place = '';
  const follow = () => {
    const ctx = context();
    const now = `${ctx.path}|${ctx.form}|${ctx.title}`;
    if (now === place) return;
    place = now;
    if (!panel.hidden) render({ query: input.value });
  };
  new MutationObserver(follow).observe(document.body, { childList: true });
  const title = document.getElementById('page-title');
  if (title) new MutationObserver(follow).observe(title, { childList: true, characterData: true, subtree: true });
}
