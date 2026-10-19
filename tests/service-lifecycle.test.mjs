import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const context = vm.createContext({ window: {} });
vm.runInContext(readFileSync(new URL('../planner.js', import.meta.url), 'utf8'), context);
const { serviceLifecycle, localDate: localCalendarDate } = context.window.GatherPlanner;
// Set the full year explicitly: Date's numeric constructor otherwise maps 1–99 to 1901–1999.
function localDate(year, month, day, hour = 0, minute = 0, second = 0, millisecond = 0) {
  const date = new Date(2000, month - 1, day, hour, minute, second, millisecond);
  date.setFullYear(year);
  return date;
}
const lifecycle = (date, now) => ({ ...serviceLifecycle({ date }, now) });

test('the local calendar key follows local midnight and safely rejects unusable clocks', () => {
  assert.equal(localCalendarDate(localDate(2026, 10, 18, 23, 59, 59, 999)), '2026-10-18');
  assert.equal(localCalendarDate(localDate(2026, 10, 19)), '2026-10-19');
  assert.equal(localCalendarDate(localDate(1, 1, 1)), '0001-01-01');
  for (const now of [new Date(NaN), null, {}, '2026-10-19', localDate(0, 1, 1), localDate(10000, 1, 1)]) {
    assert.equal(localCalendarDate(now), null);
  }
});

test('services finish on the next local calendar day and ignore their start time', () => {
  assert.deepEqual({ ...serviceLifecycle({ date: '2026-10-19', time: '00:01' }, localDate(2026, 10, 19, 23, 59, 59, 999)) }, {
    finished: false, archived: false, archiveDate: '2026-11-19'
  });
  assert.deepEqual(lifecycle('2026-10-19', localDate(2026, 10, 20)), {
    finished: true, archived: false, archiveDate: '2026-11-19'
  });
  assert.equal(lifecycle('2026-10-20', localDate(2026, 10, 19, 23)).finished, false);
});

test('a service archives exactly at local midnight one calendar month after its date', () => {
  assert.deepEqual(lifecycle('2026-09-19', localDate(2026, 10, 18, 23, 59, 59, 999)), {
    finished: true, archived: false, archiveDate: '2026-10-19'
  });
  assert.deepEqual(lifecycle('2026-09-19', localDate(2026, 10, 19)), {
    finished: true, archived: true, archiveDate: '2026-10-19'
  });
  assert.equal(lifecycle('2026-09-19', localDate(2026, 12, 1)).archived, true);
});

test('month-end services clamp to the final calendar day including leap years', () => {
  for (const [date, year, month, day, expected] of [
    ['2026-01-31', 2026, 2, 28, '2026-02-28'],
    ['2024-01-31', 2024, 2, 29, '2024-02-29'],
    ['1900-01-31', 1900, 2, 28, '1900-02-28'],
    ['2000-01-31', 2000, 2, 29, '2000-02-29'],
    ['2024-02-29', 2024, 3, 29, '2024-03-29'],
    ['2026-03-31', 2026, 4, 30, '2026-04-30'],
    ['2026-08-31', 2026, 9, 30, '2026-09-30']
  ]) {
    const atBoundary = localDate(year, month, day);
    assert.deepEqual(lifecycle(date, atBoundary), { finished: true, archived: true, archiveDate: expected }, date);
    assert.equal(lifecycle(date, new Date(atBoundary.getTime() - 1)).archived, false, date);
  }
});

test('calendar anniversaries preserve early years and December year rollovers', () => {
  for (const [date, year, month, day, expected] of [
    ['2026-12-31', 2027, 1, 31, '2027-01-31'],
    ['0001-12-31', 2, 1, 31, '0002-01-31'],
    ['0099-12-31', 100, 1, 31, '0100-01-31'],
    ['0999-12-31', 1000, 1, 31, '1000-01-31'],
    ['9999-12-31', 10000, 1, 31, '10000-01-31']
  ]) {
    const atBoundary = localDate(year, month, day);
    assert.deepEqual(lifecycle(date, atBoundary), { finished: true, archived: true, archiveDate: expected }, date);
    assert.equal(lifecycle(date, new Date(atBoundary.getTime() - 1)).archived, false, date);
  }
});

test('invalid service dates and invalid clocks never mark a service finished or archived', () => {
  const unchanged = { finished: false, archived: false, archiveDate: null };
  for (const service of [null, undefined, {}, { date: '' }, { date: '2026-02-29' }, { date: '2026-04-31' }, { date: '0000-01-01' }, { date: '2026-1-19' }, { date: 123 }]) {
    assert.deepEqual({ ...serviceLifecycle(service, localDate(2026, 10, 19)) }, unchanged);
  }
  for (const now of [new Date(NaN), null, {}, '2026-10-19', 1792368000000]) {
    assert.deepEqual(lifecycle('2026-09-19', now), unchanged);
  }
});

test('computing lifecycle never changes stored services, program items, or visibility', () => {
  const item = Object.freeze({ title: 'Welcome', person: 'Reader', minutes: '5', public_assignment: false });
  const service = Object.freeze({ id: 'service-1', date: '2026-09-19', time: '09:00', title: 'Worship', notes: 'Private note', is_public: true, program: Object.freeze([item]) });
  const before = JSON.stringify(service);
  assert.equal(serviceLifecycle(service, localDate(2026, 10, 19)).archived, true);
  assert.equal(JSON.stringify(service), before);
  assert.equal(service.program[0], item);
});
