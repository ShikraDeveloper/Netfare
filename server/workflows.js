'use strict';

// Every move a booking, visa, invoice, bill or customer advance can make, in
// one place: which statuses allow it and what to say when it is not allowed.
// The services check the status with assertCan; each record carries
// allowed_actions, so the screens (and anyone reading the API) never repeat
// these rules. A void record allows nothing more (isVoid).
// `when` narrows a move by the record's own fields (who owns the document,
// money still due), and `condition` says the same in words for the API; it
// shapes allowed_actions, and the service keeps the matching check with its
// own message. Checks that need other records (the
// travel date, a cancellation note, a security deposit) stay in the service.

const { bad, todayISO } = require('./util');

const BOOKING_OPEN = ['confirmed', 'travelled'];
const VISA_OPEN = ['submitted', 'approved', 'issued', 'rejected'];
const due = (row) => row.total_cents - (row.amount_paid_cents || 0) - (row.credit_applied_cents || 0) > 0;
// Booking, visa and cancellation documents are changed through their job.
const ownedByJob = (row) => Boolean(row.booking_id || row.visa_id || row.cancellation_id);

const WORKFLOWS = {
  booking: {
    label: 'booking',
    states: ['draft', 'confirmed', 'travelled', 'cancelled'],
    actions: {
      edit: { from: ['draft'], message: 'Only draft bookings can be edited' },
      delete: { from: ['draft'], message: 'Only draft bookings can be deleted. Cancel it instead.' },
      confirm: { from: ['draft'], to: 'confirmed', message: 'Only draft bookings can be confirmed' },
      travel: { from: ['confirmed'], to: 'travelled', when: (row) => !row.travel_date || row.travel_date <= todayISO(), condition: 'on or after the travel date', message: 'Only confirmed bookings can be marked as travelled' },
      cancel: { from: ['draft', 'confirmed', 'travelled'], to: 'cancelled', message: 'Booking is already cancelled' },
      edit_details: { from: ['confirmed', 'travelled', 'cancelled'], message: 'A draft booking is edited in full' },
      correct: { from: BOOKING_OPEN, message: 'This booking cannot be corrected' },
      void: { from: BOOKING_OPEN, to: 'cancelled', message: 'This booking cannot be voided' },
    },
  },
  visa: {
    label: 'visa application',
    states: ['draft', 'submitted', 'approved', 'issued', 'rejected', 'cancelled'],
    actions: {
      edit: { from: ['draft'], message: 'Only draft visa applications can be edited' },
      delete: { from: ['draft'], message: 'Only draft visa applications can be deleted. Cancel it instead.' },
      submit: { from: ['draft'], to: 'submitted', message: 'Only draft visa applications can be submitted' },
      approve: { from: ['submitted'], to: 'approved', message: 'Only submitted applications can be approved' },
      issue: { from: ['approved'], to: 'issued', message: 'Only approved applications can be marked as issued' },
      reject: { from: ['submitted', 'approved'], to: 'rejected', message: 'Only submitted or approved applications can be rejected' },
      cancel: { from: ['draft', 'submitted', 'approved', 'issued'], to: 'cancelled', message: 'Visa application is already cancelled or rejected' },
      edit_details: { from: ['submitted', 'approved', 'issued', 'rejected', 'cancelled'], message: 'A draft visa application is edited in full' },
      correct: { from: VISA_OPEN, message: 'This visa application cannot be corrected' },
      void: { from: VISA_OPEN, to: 'cancelled', when: (row) => !row.holds_deposit, condition: 'no security deposit belongs to it (settle or void the deposit first)', message: 'This visa application cannot be voided' },
    },
  },
  invoice: {
    label: 'invoice',
    states: ['draft', 'sent', 'void'],
    actions: {
      edit: { from: ['draft'], message: 'Only draft invoices can be edited' },
      delete: { from: ['draft'], message: 'Only draft invoices can be deleted. Void it instead.' },
      finalize: { from: ['draft'], to: 'sent', message: 'Only draft invoices can be finalized' },
      record_payment: { from: ['sent'], when: due, condition: 'money is still due', message: 'Payments can only be recorded against sent invoices' },
      payment_link: { from: ['draft', 'sent'], message: 'This invoice is void' },
      correct: { from: ['sent'], when: (row) => !ownedByJob(row) && !row.is_opening, condition: 'not owned by a booking, visa or cancellation, and not an opening balance', message: 'Only a posted invoice can be corrected; a draft is edited' },
      void: { from: ['sent'], to: 'void', when: (row) => !ownedByJob(row), condition: 'not owned by a booking, visa or cancellation', message: 'Invoice is already void' },
    },
  },
  bill: {
    label: 'bill',
    states: ['draft', 'received', 'void'],
    actions: {
      edit: { from: ['draft'], message: 'Only draft bills can be edited' },
      delete: { from: ['draft'], message: 'Only draft bills can be deleted. Void it instead.' },
      finalize: { from: ['draft'], to: 'received', message: 'Only draft bills can be finalized' },
      record_payment: { from: ['received'], when: due, condition: 'money is still due', message: 'Payments can only be recorded against received bills' },
      correct: { from: ['received'], when: (row) => !ownedByJob(row) && !row.is_opening, condition: 'not owned by a booking or visa, and not an opening balance', message: 'Only a posted bill can be corrected; a draft is edited' },
      void: { from: ['received'], to: 'void', when: (row) => !ownedByJob(row), condition: 'not owned by a booking or visa', message: 'Bill is already void' },
    },
  },
  // open: money left (advanceStatus in services/advances.js).
  advance: {
    label: 'advance',
    states: ['open', 'applied', 'refunded'],
    actions: {
      apply: { from: ['open'], message: 'This advance has already been applied or refunded' },
      refund: { from: ['open'], message: 'This advance has already been applied or refunded' },
      correct: { from: ['open'], when: (row) => !row.applied_cents && !row.refunded_cents && !row.is_receipt, condition: 'nothing used or refunded yet, and not a customer receipt', message: 'This advance has been used or refunded. Void it and record it again.' },
      void: { from: ['open', 'applied', 'refunded'], message: 'This advance is already void' },
    },
  },
};

function actionOf(kind, action) {
  const rule = WORKFLOWS[kind]?.actions[action];
  if (!rule) throw new Error(`Unknown workflow action ${kind}.${action}`);
  return rule;
}

// A void is stored two ways: status 'void' (invoices, bills, payments…) or a
// voided_at date (bookings, visas, advances, deposits, cancellations).
function isVoid(record) {
  return record.status === 'void' || Boolean(record.voided_at);
}

function statusAllows(kind, action, record) {
  return !isVoid(record) && actionOf(kind, action).from.includes(record.status);
}

function can(kind, action, record) {
  const { when } = actionOf(kind, action);
  return statusAllows(kind, action, record) && (!when || when(record));
}

// The status part only: the service checks `when` itself, with its own message.
function assertCan(kind, action, record) {
  if (!statusAllows(kind, action, record)) throw bad(actionOf(kind, action).message);
}

function allowedActions(kind, record) {
  return Object.keys(WORKFLOWS[kind].actions).filter((action) => can(kind, action, record));
}

// The table as plain data (GET /api/workflows): `when` is code, so only its
// words (`condition`) go out.
function publicWorkflows() {
  return Object.fromEntries(Object.entries(WORKFLOWS).map(([kind, flow]) => [kind, {
    label: flow.label,
    states: flow.states,
    actions: Object.fromEntries(Object.entries(flow.actions).map(([name, { when, ...rule }]) => [name, rule])),
  }]));
}

module.exports = { WORKFLOWS, can, assertCan, allowedActions, isVoid, publicWorkflows };
