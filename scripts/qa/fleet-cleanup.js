'use strict';

/* Removes only the temporary QA rows created by the Fleet Desk smoke test.
   Departments, employees and users are common masters, so this script also
   clears the additive driver profile and QA employee created by the test. */
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');

const dbPath = process.env.ABMDAS_DB || 'C:/abmdas-data/abmdas.db';
const db = new DatabaseSync(path.resolve(dbPath));
db.prepare('DELETE FROM fleet_trips WHERE purpose LIKE ?').run('QA %');
db.prepare('DELETE FROM fleet_bookings WHERE purpose LIKE ?').run('QA %');
db.prepare('DELETE FROM fleet_areas WHERE name LIKE ?').run('QA %');
db.prepare('DELETE FROM fleet_vehicles WHERE reg_no LIKE ?').run('QA-%');
db.prepare(
  `DELETE FROM employee_driver_profiles WHERE employee_id IN
     (SELECT id FROM employees WHERE name LIKE 'QA %' OR employee_code LIKE 'QA-%')`
).run();
db.prepare(
  `DELETE FROM employee_units WHERE employee_id IN
     (SELECT id FROM employees WHERE name LIKE 'QA %' OR employee_code LIKE 'QA-%')`
).run();
db.prepare("DELETE FROM employees WHERE name LIKE 'QA %' OR employee_code LIKE 'QA-%'").run();
db.prepare('DELETE FROM sequences WHERE key = ?').run('fleet_booking');
for (const table of [
  'fleet_trips', 'fleet_areas', 'fleet_vehicles',
]) {
  db.prepare('DELETE FROM sqlite_sequence WHERE name = ?').run(table);
}
console.log('Fleet QA rows removed.');
db.close();
