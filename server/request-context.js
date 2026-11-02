'use strict';

// The logged-in user for the request being handled, so services such as the
// audit log can record who did something without every call passing it on.

const { AsyncLocalStorage } = require('async_hooks');

const storage = new AsyncLocalStorage();

function runWithUser(user, callback) {
  return storage.run({ user }, callback);
}

function currentUser() {
  return storage.getStore()?.user || null;
}

module.exports = { runWithUser, currentUser };
