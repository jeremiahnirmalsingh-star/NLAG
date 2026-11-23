'use strict';

/* Guards PO 0058 against the item-name/master mismatch and the wrong item link
 * that mapped the Groove Bell line to the Media Tray Stand master item. */

const { DatabaseSync } = require('node:sqlite');
const DB_PATH = process.env.ABMDAS_DB || 'C:/abmdas-data/abmdas.db';

const EXPECTED = [
  { lineId: 13, itemId: 18, itemCode: 'ITM-00021', name: 'Groove Bell Artist Series 7.75" MJGB' },
  { lineId: 14, itemId: 20, itemCode: 'ITM-00023', name: 'Basket Stand LP Matador' },
  { lineId: 15, itemId: 21, itemCode: 'ITM-00024', name: 'Compact Media Tray Stand GFW-UTL-MEDIATRAY1' },
];

const db = new DatabaseSync(DB_PATH, { readOnly: true });
const rows = db.prepare(`
  SELECT pi.id AS lineId, pi.item_id AS itemId, i.item_code AS itemCode,
         i.name AS masterName, pi.item_name AS poName
    FROM po_items pi
    LEFT JOIN items i ON i.id = pi.item_id
   WHERE pi.po_id = 8
   ORDER BY pi.id
`).all();
db.close();

const failures = [];
for (const expected of EXPECTED) {
  const row = rows.find((r) => Number(r.lineId) === expected.lineId);
  const ok = row
    && Number(row.itemId) === expected.itemId
    && row.itemCode === expected.itemCode
    && row.masterName === expected.name
    && row.poName === expected.name;
  console.log(`${ok ? 'PASS' : 'FAIL'} line ${expected.lineId} :: ${JSON.stringify(row || null)}`);
  if (!ok) failures.push(expected.lineId);
}

console.log(JSON.stringify({ failures }, null, 2));
if (failures.length) process.exitCode = 1;
