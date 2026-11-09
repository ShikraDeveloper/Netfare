'use strict';

const router = require('express').Router();
const db = require('../db');
const service = require('../services/reminders');

router.get('/', (req, res) => {
  res.json(service.listReminders(db, req.user, req.query));
});

router.post('/', (req, res) => {
  res.status(201).json(service.createReminder(db, req.user, req.body || {}));
});

router.put('/:id', (req, res) => {
  res.json(service.updateReminder(db, req.user, Number(req.params.id), req.body || {}));
});

router.post('/:id/done', (req, res) => {
  res.json(service.doneReminder(db, req.user, Number(req.params.id), req.body || {}));
});

router.post('/:id/snooze', (req, res) => {
  res.json(service.snoozeReminder(db, req.user, Number(req.params.id), req.body || {}));
});

router.post('/:id/reopen', (req, res) => {
  res.json(service.reopenReminder(db, req.user, Number(req.params.id)));
});

router.delete('/:id', (req, res) => {
  res.json(service.deleteReminder(db, req.user, Number(req.params.id)));
});

module.exports = router;
