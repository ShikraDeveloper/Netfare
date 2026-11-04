// Restore the theme and sidebar state before the first paint so they do not flash.
(function restoreAppearance() {
  try {
    const savedTheme = localStorage.getItem('ledgerly.theme');
    const theme = savedTheme === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    const themeMeta = document.querySelector('meta[name="theme-color"]');
    if (themeMeta) themeMeta.setAttribute('content', theme === 'dark' ? '#08121f' : '#f3f6fa');
  } catch {
    document.documentElement.dataset.theme = 'light';
  }

  try {
    if (localStorage.getItem('ledgerly.navCollapsed') === '1') {
      document.documentElement.classList.add('nav-collapsed');
    }
    // Side or top menu (Settings → Appearance), see menu.js.
    if (localStorage.getItem('netfare.menu') === 'top') {
      document.documentElement.classList.add('menu-top');
    }
  } catch {
    // Storage can be unavailable in private browsing modes.
  }
})();
