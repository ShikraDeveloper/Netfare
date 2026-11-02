'use strict';

// Writes desktop/dist/latest.json for a release, the file Netfare's update
// check reads (server/services/updates.js). Upload it, with the .dmg, to the
// place the admin's "Update address" points at.
//
//   node scripts/release-feed.js --download-base https://example.com/netfare/ \
//     --note "Rights per user" --note "Office network mode" [--page https://example.com/download]
//
// The version comes from package.json; the .dmg name is electron-builder's.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const { version } = require(path.join(root, 'package.json'));

function args(argv) {
  const out = { notes: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const [name, value] = [argv[i], argv[i + 1]];
    if (name === '--note') { out.notes.push(value); i += 1; } else if (name === '--download-base') { out.base = value; i += 1; } else if (name === '--page') { out.page = value; i += 1; } else {
      throw new Error(`Unknown option ${name}`);
    }
  }
  return out;
}

function httpsUrl(value, label) {
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error(`${label} must start with https://`);
  return url.href;
}

function buildFeed(options, today = new Date().toISOString().slice(0, 10)) {
  if (!options.base) throw new Error('Give --download-base, the https:// folder the .dmg is uploaded to');
  const base = httpsUrl(options.base.endsWith('/') ? options.base : `${options.base}/`, '--download-base');
  if (!options.notes.length) throw new Error('Give at least one --note saying what changed');
  return {
    version,
    released: today,
    notes: options.notes,
    downloads: { 'mac-arm64': new URL(`Netfare-${version}-arm64.dmg`, base).href },
    ...(options.page ? { page: httpsUrl(options.page, '--page') } : {}),
  };
}

if (require.main === module) {
  try {
    const feed = buildFeed(args(process.argv.slice(2)));
    const out = path.join(root, 'desktop', 'dist', 'latest.json');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(feed, null, 2)}\n`);
    console.log(`\n  Wrote ${path.relative(root, out)} for Netfare ${version}.`);
    console.log(`  Upload it and ${feed.downloads['mac-arm64'].split('/').pop()} to ${new URL('.', feed.downloads['mac-arm64']).href}\n`);
  } catch (error) {
    console.error(`\n  ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { buildFeed };
