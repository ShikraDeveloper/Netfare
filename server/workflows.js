'use strict';

// Every move a booking or visa application can make, in one place: which
// statuses allow it and what to say when it is not allowed. The services
// check moves with assertCan; each record carries allowed_actions, so the
// screens (and anyone reading the API) never repeat these rules.
// A void job is cancelled and has voided_at; it allows nothing more.
// Checks that need more than the status (the travel date, a cancellation
// note, a security deposit) stay in the service that does the move.

const { bad } = require('./util');

const BOOKING_OPEN = ['confirmed', 'travelled'];
const VISA_OPEN = ['submitted', 'approved', 'issued', 'rejected'];

const WORKFLOWS = {
  booking: {
    label: 'booking',
    states: ['draft', 'confirmed', 'travelled', 'cancelled'],
    actions: {
      edit: { from: ['draft'], message: 'Only draft bookings can be edited' },
      delete: { from: ['draft'], message: 'Only draft bookings can be deleted. Cancel it instead.' },
      confirm: { from: ['draft'], to: 'confirmed', message: 'Only draft bookings can be confirmed' },
      travel: { from: ['confirmed'], to: 'travelled', message: 'Only confirmed bookings can be marked as travelled' },
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
      void: { from: VISA_OPEN, to: 'cancelled', message: 'This visa application cannot be voided' },
    },
  },
};

function actionOf(kind, action) {
  const rule = WORKFLOWS[kind]?.actions[action];
  if (!rule) throw new Error(`Unknown workflow action ${kind}.${action}`);
  return rule;
}

function can(kind, action, record) {
  return !record.voided_at && actionOf(kind, action).from.includes(record.status);
}

function assertCan(kind, action, record) {
  if (!can(kind, action, record)) throw bad(actionOf(kind, action).message);
}

function allowedActions(kind, record) {
  return Object.keys(WORKFLOWS[kind].actions).filter((action) => can(kind, action, record));
}

module.exports = { WORKFLOWS, can, assertCan, allowedActions };
