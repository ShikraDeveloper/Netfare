'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const roots = ['server', 'public/js', 'scripts', 'test', 'desktop', 'website'];
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
    // `node --check file.js` passes any file with import/export without parsing
    // it, so browser modules go in on stdin as a module.
    const source = fs.readFileSync(file, 'utf8');
    if (/^(import|export) /m.test(source)) {
      execFileSync(process.execPath, ['--input-type=module', '--check'], { input: source, stdio: 'pipe' });
    } else {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    }
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

// Helper text may only go down (DESIGN.md).
const copy = require('./copy-budget').checkCopyBudget();
if (!copy.ok) {
  console.error(`\nMore helper text than allowed. Fix the layout instead (DESIGN.md):\n  ${copy.over.join('\n  ')}\n`);
  process.exit(1);
}
console.log(`Helper text: ${copy.total} (within budget).`);

// Types (tsconfig.json): only files with "// @ts-check" at the top are checked.
const checked = files.filter((file) => fs.readFileSync(file, 'utf8').startsWith('// @ts-check'));
try {
  execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', root], { stdio: 'pipe' });
} catch (error) {
  const out = error.stdout?.toString() || error.message;
  const count = (out.match(/error TS/g) || []).length;
  console.error(`\nTypes: ${count} error${count === 1 ? '' : 's'}\n${out}`);
  process.exit(1);
}
console.log(`Types: 0 errors (${checked.length} files checked: ${checked.map((file) => path.basename(file)).join(', ')}).`);
