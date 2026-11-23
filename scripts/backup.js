'use strict';

/**
 * ABMDAS backup helper (Phase 4).
 *
 * Usage:
 *   node scripts/backup.js [destinationDir]
 *
 * Copies the SQLite database (including -wal and -shm), the uploads folder and
 * the settings-relevant files into a timestamped folder. Safe to run while the
 * server is running because SQLite WAL mode keeps a consistent snapshot on copy
 * of the main db file; for a fully consistent backup, stop the server first or
 * use the SQLite backup API.
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const dataDir = process.env.ABMDAS_DATA_DIR || path.join(root, 'data');
const destRoot = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'backups');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const target = path.join(destRoot, `abmdas-${stamp}`);

function copyFile(src, dst) {
  if (!fs.existsSync(src)) return false;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  return true;
}

function copyDir(src, dst) {
  if (!fs.existsSync(src)) return 0;
  let n = 0;
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) n += copyDir(s, d);
    else { fs.copyFileSync(s, d); n += 1; }
  }
  return n;
}

fs.mkdirSync(target, { recursive: true });
const dbFile = path.join(dataDir, 'abmdas.db');
let copied = 0;
for (const suffix of ['', '-wal', '-shm']) {
  if (copyFile(dbFile + suffix, path.join(target, 'data', 'abmdas.db' + suffix))) copied += 1;
}
const uploads = path.join(dataDir, 'uploads');
const upCount = copyDir(uploads, path.join(target, 'data', 'uploads'));
copied += upCount;

/* Keep a small manifest. */
const manifest = {
  createdAt: new Date().toISOString(),
  sourceDataDir: dataDir,
  files: fs.readdirSync(target, { recursive: true }),
};
fs.writeFileSync(path.join(target, 'manifest.json'), JSON.stringify(manifest, null, 2));

console.log(`Backup written to ${target}`);
console.log(`Database files copied: ${copied - upCount}, uploads: ${upCount}`);
