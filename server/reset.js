'use strict';

/**
 * Resets the application database and uploaded files.
 * Usage: npm run reset
 */
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const dataDir = process.env.ABMDAS_DATA_DIR || path.join(__dirname, '..', 'data');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question(`This will permanently delete all ABMDAS data in:\n  ${dataDir}\nType RESET to continue: `, (answer) => {
  rl.close();
  if (answer.trim() !== 'RESET') {
    console.log('Cancelled.');
    return;
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log('Data removed. Run "npm start" to create a fresh database.');
});
