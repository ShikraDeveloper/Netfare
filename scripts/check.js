'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const roots = ['server', 'public/js', 'scripts', 'test', 'desktop'];
const SKIP = new Set(['node_modules', 'build', 'dist']);
const files = [];

function walk(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) { if (!SKIP.has(entry.name)) walk(full); }
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(full);
  }
}

for (const directory of roots) walk(path.join(root, directory));

let failed = 0;
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (error) {
    failed += 1;
    console.error(`\nSyntax error: ${path.relative(root, file)}`);
    console.error(error.stderr?.toString() || error.message);
  }
}

if (failed) {
  console.error(`\n${failed} file${failed === 1 ? '' : 's'} failed the syntax check.\n`);
  process.exit(1);
}
console.log(`Checked ${files.length} JavaScript files — syntax OK.`);
