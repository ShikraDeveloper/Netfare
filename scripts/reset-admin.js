'use strict';

// Forgotten admin password: run on the main computer to get a one-time
// password. Netfare asks for a new one at the next sign-in.

const db = require('../server/db');
const { resetAdminPassword } = require('../server/services/auth');

try {
  const result = resetAdminPassword(db);
  if (!result) {
    console.log('\n  There is no admin yet. Open Netfare to create the admin account.\n');
  } else {
    console.log(`\n  Admin username: ${result.username}`);
    console.log(`  One-time password: ${result.password}`);
    console.log('  Sign in with it; Netfare will ask you to choose a new password.\n');
  }
} finally {
  db.close();
}
