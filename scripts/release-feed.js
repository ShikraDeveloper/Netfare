'use strict';

// Writes desktop/dist/latest.json for a release, the file Netfare's update
// check reads (server/services/updates.js). The release workflow uploads it
// with the installers to the GitHub release.
//
//   node scripts/release-feed.js --notes-from-tag v1.1.0
//   node scripts/release-feed.js --note "Rights per user" --note "Office network"
//     [--download-base https://example.com/netfare/] [--page https://…]
//
// The version comes from package.json. Without --download-base the links
// point at this version's GitHub release.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const { version } = require(path.join(root, 'package.json'));
const REPO = 'https://github.com/ShikraDeveloper/Netfare';
const FILES = {
  'mac-arm64': 'Netfare-mac-arm64.dmg',
  'mac-x64': 'Netfare-mac-x64.dmg',
  'windows-x64': 'Netfare-windows-x64.exe',
};

function args(argv) {
  const out = { notes: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const name = argv[i];
    const value = argv[i + 1];
    i += 1;
    if (name === '--note') out.notes.push(value);
    else if (name === '--notes-from-tag') out.tag = value;
    else if (name === '--download-base') out.base = value;
    else if (name === '--page') out.page = value;
    else throw new Error(`Unknown option ${name}`);
  }
  return out;
}

// The lines of an annotated tag's message (`git tag -a v1.1.0 -m "…" -m "…"`).
function tagNotes(tag) {
  const text = execFileSync('git', ['tag', '-l', '--format=%(contents)', tag], { cwd: root, encoding: 'utf8' });
  return text.split('\n')
    .map((line) => line.replace(/^[-*•]\s*/, '').trim())
    .filter((line) => line && !line.startsWith('-----BEGIN'));
}

function httpsUrl(value, label) {
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error(`${label} must start with https://`);
  return url.href;
}

function buildFeed(options, today = new Date().toISOString().slice(0, 10)) {
  const base = httpsUrl(options.base
    ? (options.base.endsWith('/') ? options.base : `${options.base}/`)
    : `${REPO}/releases/download/v${version}/`, '--download-base');
  if (!options.notes.length) throw new Error('Give at least one --note, or --notes-from-tag, saying what changed');
  const downloads = {};
  for (const [key, file] of Object.entries(FILES)) downloads[key] = new URL(file, base).href;
  return {
    version,
    released: today,
    notes: options.notes,
    downloads,
    page: httpsUrl(options.page || `${REPO}/releases/tag/v${version}`, '--page'),
  };
}

if (require.main === module) {
  try {
    const options = args(process.argv.slice(2));
    if (options.tag) options.notes.push(...tagNotes(options.tag));
    const feed = buildFeed(options);
    const out = path.join(root, 'desktop', 'dist', 'latest.json');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(feed, null, 2)}\n`);
    console.log(`\n  Wrote ${path.relative(root, out)} for Netfare ${version} (${feed.notes.length} notes).\n`);
  } catch (error) {
    console.error(`\n  ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { FILES, buildFeed, tagNotes };
