'use strict';

const router = require('express').Router();
const db = require('../db');
const service = require('../services/bookings');

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

router.post('/:id/cancel', (req, res) => {
  res.json(service.cancelBooking(db, Number(req.params.id), req.body || {}));
});

module.exports = router;
