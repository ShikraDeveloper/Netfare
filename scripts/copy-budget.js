'use strict';

// Helper text may only go down. Counts the taglines, hints and subtitles in
// each browser file and fails when a file has more than scripts/copy-budget.json
// allows (see DESIGN.md). After removing some, lower the budget with
//   node scripts/copy-budget.js --write

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const BUDGET_FILE = path.join(__dirname, 'copy-budget.json');
const PATTERNS = {
  hint: /class="hint"/g,
  note: /class="(?:form-note|stmt-hint|recon-intro|theme-note)\b/g,
  tagline: /<div class="card-title">\s*<h2>[^<]*<\/h2>\s*<p>/g,
  subtitle: /\bsubtitle:\s*[`'"]/g,
  menu: /\bdesc: '/g,
};

function browserFiles(directory = path.join(root, 'public/js'), list = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) browserFiles(full, list);
    else if (entry.name.endsWith('.js')) list.push(full);
  }
  return list;
}

function countCopy() {
  const counts = {};
  for (const file of browserFiles().sort()) {
    const text = fs.readFileSync(file, 'utf8');
    const total = Object.values(PATTERNS).reduce((sum, pattern) => sum + (text.match(pattern) || []).length, 0);
    if (total) counts[path.relative(root, file)] = total;
  }
  return counts;
}

function checkCopyBudget({ write = false } = {}) {
  const counts = countCopy();
  if (write) {
    fs.writeFileSync(BUDGET_FILE, `${JSON.stringify(counts, null, 2)}\n`);
    return { ok: true, total: Object.values(counts).reduce((a, b) => a + b, 0), over: [] };
  }
  const budget = fs.existsSync(BUDGET_FILE) ? JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf8')) : {};
  const over = Object.entries(counts)
    .filter(([file, count]) => count > (budget[file] || 0))
    .map(([file, count]) => `${file}: ${count} (budget ${budget[file] || 0})`);
  return { ok: over.length === 0, total: Object.values(counts).reduce((a, b) => a + b, 0), over };
}

if (require.main === module) {
  const result = checkCopyBudget({ write: process.argv.includes('--write') });
  if (!result.ok) {
    console.error(`More helper text than allowed. Fix the layout instead (DESIGN.md):\n  ${result.over.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`Helper text: ${result.total} (within budget).`);
}

module.exports = { checkCopyBudget };
