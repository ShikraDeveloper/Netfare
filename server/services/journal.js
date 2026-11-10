'use strict';

const { bad, notFound, str, optionalStr } = require('../util');
const { postEntry, reverseEntry, assertManualEntryAccounts } = require('../accounting');
const audit = require('./audit');

// Posts a manual journal entry; the caller runs it in a transaction.
function createManualEntry(db, payload = {}) {
  const memo = str(payload.memo, 'Memo', { max: 500 });
  const lines = Array.isArray(payload.lines) ? payload.lines : [];
  assertManualEntryAccounts(db, lines);
  return postEntry(db, {
    entry_date: payload.entry_date,
    memo,
    reference: optionalStr(payload.reference, 'Reference', 100),
    source_type: 'manual',
    lines,
  });
}

function deleteManualEntry(db, id, payload = {}) {
  return db.transaction(() => {
    const entry = db.prepare('SELECT * FROM journal_entries WHERE id = ?').get(Number(id));
    if (!entry) throw notFound('Journal entry not found');
    if (entry.source_type !== 'manual') {
      throw bad('Only manual journal entries can be deleted. Void the source document instead.');
    }
    if (entry.voided_at) {
      throw bad('This journal entry is void and cannot be deleted.');
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
    const remarks = optionalStr(payload.remarks ?? payload.reason ?? '', 'Void remarks', 2000);
    const total = db.prepare(
      'SELECT COALESCE(SUM(debit_cents), 0) AS total FROM journal_lines WHERE entry_id = ?',
    ).get(entry.id).total;
    db.prepare('DELETE FROM journal_entries WHERE id = ?').run(entry.id);
    audit.record(db, {
      entity_type: 'journal_entry',
      entity_id: entry.id,
      entity_number: `#${entry.id}`,
      action: 'delete',
      remarks: remarks || `Deleted journal entry #${entry.id}`,
      amount_cents: total,
      metadata: { memo: entry.memo, source_type: entry.source_type },
    });
    return { deleted: true };
  })();
}

function voidManualEntry(db, id, payload = {}) {
  return db.transaction(() => {
    const entry = db.prepare('SELECT * FROM journal_entries WHERE id = ?').get(Number(id));
    if (!entry) throw notFound('Journal entry not found');
    if (entry.source_type !== 'manual') {
      throw bad('Only manual journal entries can be voided here. Void the source document instead.');
    }
    if (entry.voided_at) throw bad('This journal entry is already void');
    const reconciled = db.prepare(`
      SELECT 1
      FROM bank_reconciliation_lines rl
      JOIN journal_lines l ON l.id = rl.journal_line_id
      WHERE l.entry_id = ?
      LIMIT 1
    `).get(entry.id);
    if (reconciled) {
      throw bad('This entry is part of a bank reconciliation. Reopen the reconciliation before voiding it.');
    }
    const remarks = optionalStr(payload.remarks ?? payload.reason ?? '', 'Void remarks', 2000);
    const total = db.prepare(
      'SELECT COALESCE(SUM(debit_cents), 0) AS total FROM journal_lines WHERE entry_id = ?',
    ).get(entry.id).total;
    const voidEntryId = reverseEntry(db, entry.id, {
      entry_date: entry.entry_date,
      memo: audit.withRemarks(`Void journal entry #${entry.id}`, remarks),
      source_type: 'void',
    });
    db.prepare(`
      UPDATE journal_entries SET voided_at = datetime('now'), void_entry_id = ? WHERE id = ?
    `).run(voidEntryId, entry.id);
    audit.record(db, {
      entity_type: 'journal_entry',
      entity_id: entry.id,
      entity_number: `#${entry.id}`,
      action: 'void',
      remarks: remarks || `Voided journal entry #${entry.id}`,
      amount_cents: total,
      metadata: { memo: entry.memo, void_entry_id: voidEntryId },
    });
    return {
      voided: true,
      journal_entry_id: entry.id,
      void_entry_id: voidEntryId,
    };
  })();
}

module.exports = { createManualEntry, deleteManualEntry, voidManualEntry };
