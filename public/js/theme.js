const THEME_KEY = 'ledgerly.theme';
const THEME_COLORS = { light: '#f7f1e5', dark: '#08121f' };

export function getTheme() {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

function paintMeta(theme) {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_COLORS[theme] || THEME_COLORS.light);
}

export function applyTheme(theme, { persist = true } = {}) {
  const next = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  document.documentElement.style.colorScheme = next;
  paintMeta(next);
  if (persist) {
    try { localStorage.setItem(THEME_KEY, next); } catch (error) { /* storage unavailable */ }
  }
  window.dispatchEvent(new CustomEvent('theme-changed', { detail: { theme: next } }));
  return next;
}

export function initTheme() {
  let theme = 'light';
  try {
    theme = localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light';
  } catch (error) { /* storage unavailable */ }
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  paintMeta(theme);
  return theme;
}

// Keep a second tab in sync if the theme is changed in another window.
window.addEventListener('storage', (event) => {
  if (event.key !== THEME_KEY) return;
  applyTheme(event.newValue === 'dark' ? 'dark' : 'light', { persist: false });
});
