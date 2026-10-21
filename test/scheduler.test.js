const test = require('node:test');
const assert = require('node:assert');
const sch = require('../src/main/scheduler');

const at = (y, mo, d, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s);
// 2026-10-21 is a Wednesday.
const base = { id: 'a', name: 'A', active: true, start: '09:00:00', end: '10:00:00' };

test('daily window: waiting, recording, then next day', () => {
  const s = { ...base, type: 'daily' };
  assert.equal(sch.status(s, at(2026, 10, 21, 8)), 'Waiting');
  assert.equal(sch.status(s, at(2026, 10, 21, 9, 30)), 'Recording');
  assert.deepEqual(sch.nextWindow(s, at(2026, 10, 21, 10, 0, 1)).start, at(2026, 10, 22, 9));
});

test('end before start means the day after', () => {
  const s = { ...base, type: 'daily', start: '23:30:00', end: '00:30:00' };
  assert.equal(sch.durationMs(s), 60 * 60 * 1000);
  const w = sch.due([s], at(2026, 10, 22, 0, 10));
  assert.ok(w, 'window that started yesterday is still due');
  assert.deepEqual(w.window.end, at(2026, 10, 22, 0, 30));
});

test('weekly days and one-time schedules', () => {
  const weekly = { ...base, type: 'weekly', days: [5] }; // Friday
  assert.deepEqual(sch.nextWindow(weekly, at(2026, 10, 21, 12)).start, at(2026, 10, 23, 9));
  const once = { ...base, type: 'once', date: '2026-10-20' };
  assert.equal(sch.status(once, at(2026, 10, 21)), 'Passed');
  assert.equal(sch.status({ ...once, active: false }, at(2026, 10, 19)), 'Inactive');
});

test('duration mode and validation', () => {
  assert.equal(sch.durationMs({ ...base, durationSec: 90 }), 90000);
  assert.match(sch.validate({ ...base, type: 'weekly', days: [] }), /day must be selected/);
  assert.match(sch.validate({ ...base, type: 'daily', start: '09:00:00', end: '09:00:00' }), /duration/);
  assert.equal(sch.validate({ ...base, type: 'daily' }), null);
});

test('overlap detection', () => {
  const a = { ...base, type: 'daily' };
  const b = { ...base, id: 'b', name: 'B', type: 'weekly', days: [4], start: '09:30:00', end: '11:00:00' };
  const c = { ...base, id: 'c', name: 'C', type: 'daily', start: '10:00:00', end: '11:00:00' };
  assert.equal(sch.overlapping(b, [a], at(2026, 10, 21)), 'A');
  assert.equal(sch.overlapping(c, [a], at(2026, 10, 21)), null, 'back-to-back windows do not overlap');
});
