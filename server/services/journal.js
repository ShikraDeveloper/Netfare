'use strict';

const { bad, notFound } = require('../util');

function deleteManualEntry(db, id) {
  const entry = db.prepare('SELECT * FROM journal_entries WHERE id = ?').get(Number(id));
  if (!entry) throw notFound('Journal entry not found');
  if (entry.source_type !== 'manual') {
    throw bad('Only manual journal entries can be deleted. Void the source document instead.');
  }
  const reconciled = db.prepare(`
    SELECT 1
    FROM bank_reconciliation_lines rl
    JOIN journal_lines l ON l.id = rl.journal_line_id
    WHERE l.entry_id = ?
    LIMIT 1
  `).get(entry.id);
  if (reconciled) {
    throw bad('This entry is part of a bank reconciliation. Reopen the reconciliation before deleting it.');
  }
  db.prepare('DELETE FROM journal_entries WHERE id = ?').run(entry.id);
  return { deleted: true };
}

module.exports = { deleteManualEntry };
