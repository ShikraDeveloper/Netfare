'use strict';

// Staff logins, managed by the admin from Settings.

const router = require('express').Router();
const db = require('../db');
const auth = require('../services/auth');
const { AREAS } = require('../permissions');

// The rights checklist shown when adding or editing a user.
router.get('/areas', (req, res) => {
  res.json(AREAS.map(({ key, label, edit }) => ({ key, label, edit: edit !== false })));
});

router.get('/', (req, res) => {
  res.json(auth.listUsers(db));
});

router.post('/', (req, res) => {
  res.status(201).json(auth.createUser(db, req.body));
});

router.put('/:id', (req, res) => {
  res.json(auth.updateUser(db, Number(req.params.id), req.body));
});

router.post('/:id/password', (req, res) => {
  res.json(auth.setUserPassword(db, Number(req.params.id), req.body));
});

module.exports = router;
