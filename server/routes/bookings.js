'use strict';

const router = require('express').Router();
const db = require('../db');
const service = require('../services/bookings');
const jobRefunds = require('../services/job-refunds');
const { voidJob } = require('../services/job-void');
const { correctJob } = require('../services/job-correct');
const { updateJobDetails } = require('../services/job-details');

router.get('/', (req, res) => {
  res.json(service.listBookings(db, req.query));
});

router.post('/', (req, res) => {
  res.status(201).json(service.createBooking(db, req.body || {}));
});

router.get('/:id', (req, res) => {
  res.json(service.getBooking(db, Number(req.params.id)));
});

router.put('/:id', (req, res) => {
  res.json(service.updateBooking(db, Number(req.params.id), req.body || {}));
});

router.delete('/:id', (req, res) => {
  res.json(service.deleteBooking(db, Number(req.params.id)));
});

router.post('/:id/confirm', (req, res) => {
  res.json(service.confirmBooking(db, Number(req.params.id), req.body || {}));
});

router.post('/:id/travel', (req, res) => {
  res.json(service.markTravelled(db, Number(req.params.id)));
});

router.post('/:id/refund-customer', (req, res) => {
  res.status(201).json(jobRefunds.refundCustomer(db, 'booking', Number(req.params.id), req.body || {}));
});

router.post('/:id/supplier-refund', (req, res) => {
  res.status(201).json(jobRefunds.supplierRefund(db, 'booking', Number(req.params.id), req.body || {}));
});

// Details that do not touch money (dates, PNR, notes, passengers): Edit rights.
router.post('/:id/details', (req, res) => {
  updateJobDetails(db, 'booking', Number(req.params.id), req.body || {});
  res.json(service.getBooking(db, Number(req.params.id)));
});

// Admin only (permissions.js): correct the lines of a posted booking.
router.post('/:id/correct', (req, res) => {
  res.json(correctJob(db, 'booking', Number(req.params.id), req.body || {}));
});

// Admin only (permissions.js): undo a booking entered by mistake.
router.post('/:id/void', (req, res) => {
  voidJob(db, 'booking', Number(req.params.id), req.body || {});
  res.json(service.getBooking(db, Number(req.params.id)));
});

router.post('/:id/cancel', (req, res) => {
  res.json(service.cancelBooking(db, Number(req.params.id), req.body || {}));
});

module.exports = router;
