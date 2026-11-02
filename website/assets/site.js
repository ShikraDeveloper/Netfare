// Netfare website: point the main Download button at this computer's
// installer, and show the latest version and its notes from GitHub.
// Everything still works without JavaScript (the buttons link to #download).

(function () {
  'use strict';

  var REPO = 'ShikraDeveloper/Netfare';
  var BASE = 'https://github.com/' + REPO + '/releases/latest/download/';
  var FILES = {
    'mac-arm64': { file: 'Netfare-mac-arm64.dmg', label: 'Download for Mac', note: 'Apple Silicon · not your Mac? Choose Intel below' },
    'mac-x64': { file: 'Netfare-mac-x64.dmg', label: 'Download for Mac (Intel)', note: 'Intel Mac · for Apple Silicon choose below' },
    'windows-x64': { file: 'Netfare-windows-x64.exe', label: 'Download for Windows', note: 'Windows 10 and 11, 64-bit' }
  };

  function guessMacChip() {
    // Chrome and Edge can tell the chip; Safari cannot, where the graphics
    // name ("Apple M1") gives it away. Apple Silicon is the default.
    try {
      var canvas = document.createElement('canvas');
      var gl = canvas.getContext('webgl');
      var info = gl && gl.getExtension('WEBGL_debug_renderer_info');
      var renderer = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : '';
      if (/Intel/i.test(renderer)) return 'mac-x64';
    } catch (e) { /* no WebGL */ }
    return 'mac-arm64';
  }

  function detect() {
    var ua = navigator.userAgent || '';
    if (/iPhone|iPad|Android/i.test(ua)) return Promise.resolve(null);
    if (/Windows/i.test(ua)) return Promise.resolve('windows-x64');
    if (!/Mac/i.test(ua)) return Promise.resolve(null);
    var data = navigator.userAgentData;
    if (data && data.getHighEntropyValues) {
      return data.getHighEntropyValues(['architecture']).then(function (values) {
        if (values.architecture === 'arm') return 'mac-arm64';
        if (values.architecture === 'x86') return guessMacChip();
        return guessMacChip();
      }, guessMacChip);
    }
    return Promise.resolve(guessMacChip());
  }

  function setPrimary(platform) {
    var choice = FILES[platform];
    var button = document.querySelector('[data-download-primary]');
    if (!choice || !button) return;
    button.href = BASE + choice.file;
    button.querySelector('[data-download-label]').textContent = choice.label;
    var note = document.querySelector('[data-download-note]');
    if (note) note.textContent = choice.note + ' · Free forever';
    var card = document.querySelector('.dl[data-platform="' + platform + '"]');
    if (card) card.classList.add('is-yours');
  }

  function formatDate(iso) {
    try {
      return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
    } catch (e) {
      return iso.slice(0, 10);
    }
  }

  // Release notes are the "- " lines of the release text; only text is
  // shown, never HTML from the response.
  function showRelease(release) {
    var version = String(release.tag_name || '').replace(/^v/, '');
    if (!/^\d+\.\d+\.\d+$/.test(version)) return;
    var date = release.published_at ? formatDate(release.published_at) : '';
    document.querySelectorAll('[data-version]').forEach(function (el) { el.textContent = 'Version ' + version; });
    document.querySelectorAll('[data-version-long]').forEach(function (el) {
      el.textContent = 'Netfare ' + version + (date ? ', released ' + date + ',' : '');
    });
    var title = document.querySelector('[data-news-title]');
    if (title) title.textContent = 'Netfare ' + version;
    var notes = String(release.body || '').split('\n')
      .filter(function (line) { return /^\s*[-*]\s+/.test(line); })
      .map(function (line) { return line.replace(/^\s*[-*]\s+/, '').replace(/\*\*/g, '').trim(); })
      .filter(Boolean)
      .slice(0, 12);
    var list = document.querySelector('[data-news]');
    if (list && notes.length) {
      list.textContent = '';
      notes.forEach(function (note) {
        var item = document.createElement('li');
        item.textContent = note;
        list.appendChild(item);
      });
    }
  }

  detect().then(setPrimary);
  if (window.fetch) {
    fetch('https://api.github.com/repos/' + REPO + '/releases/latest', { headers: { Accept: 'application/vnd.github+json' } })
      .then(function (response) { return response.ok ? response.json() : null; })
      .then(function (release) { if (release) showRelease(release); })
      .catch(function () { /* offline or rate-limited: keep the built-in text */ });
  }
})();
