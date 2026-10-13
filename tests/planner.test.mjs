import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const context = vm.createContext({ window: {} });
vm.runInContext(readFileSync(new URL('../planner.js', import.meta.url), 'utf8'), context);
context.GatherPlanner = context.window.GatherPlanner;
vm.runInContext(readFileSync(new URL('../render.js', import.meta.url), 'utf8'), context);
const planner = context.GatherPlanner, view = context.window.GatherView;
const service = (date = '2026-10-18', time = '09:00') => ({ id: 'service-1', title: 'Worship', date, time, program: [] });
const document = () => ({ services: [service()], team: [], songs: [] });

test('loaded data, imports and public responses reject impossible calendar dates and times', () => {
  for (const date of ['2026-02-29', '2026-02-30', '2026-04-31', '0000-10-18', '2026-13-01', '1900-02-29']) {
    const data = document(); data.services[0].date = date;
    assert.throws(() => planner.validate(data), /valid calendar date/);
    assert.throws(() => planner.validatePublic({ services: [{ ...service(date), theme: '', location: '' }], songs: [] }));
  }
  for (const date of ['2024-02-29', '2000-02-29', '2026-04-30', '0001-01-01']) {
    const data = document(); data.services[0].date = date;
    assert.equal(planner.validate(data), data);
  }
  for (const time of ['24:00', '23:60', '99:99']) {
    const data = document(); data.services[0].time = time;
    assert.throws(() => planner.validate(data), /valid service time/);
  }
});

test('malicious backups cannot introduce reserved properties at any nested level', () => {
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const data = document();
    data.services[0].program = [JSON.parse(`{"title":"Reading","person":"Reader","minutes":5,"${key}":{"polluted":true}}`)];
    assert.throws(() => planner.validate(data), /unsafe property/);
  }
  const circular = document(); circular.metadata = circular;
  assert.throws(() => planner.validate(circular), /circular/);
  const deep = document(); let nested = deep;
  for (let i = 0; i < 30; i++) nested = nested.child = {};
  assert.throws(() => planner.validate(deep), /deeply nested/);
  assert.equal({}.polluted, undefined);
});

test('legacy whole-number durations and optional string fields remain intact', () => {
  const data = document();
  data.services[0].legacy_label = 'Preserve this value';
  data.services[0].program = [{ title: 'Reading', person: 'Reader', minutes: '5.0', public_assignment: false }];
  const before = JSON.stringify(data);
  planner.validate(data);
  assert.equal(JSON.stringify(data), before);
  for (const value of [0, 301, 3.5, 'NaN', {}, null]) assert.throws(() => planner.duration(value));
});

test('next worship excludes finished services today without deleting past calendar entries', () => {
  const model = { planner: { services: [service('2026-10-18', '09:00'), { ...service('2026-10-19', '11:00'), id: 'next-service', title: 'Tomorrow' }], team: [], songs: [] }, privateAccess: true, canEdit: false, publicReady: true, view: 'overview', now: new Date(2026, 9, 18, 12) };
  const html = view.page(model).html;
  assert.match(html, /COMING TOGETHER NEXT<\/span><h2>Tomorrow/);
  assert.match(html, /data-open="service-1"/);
  model.now = new Date(2026, 9, 20, 12);
  assert.doesNotMatch(view.page(model).html, /COMING TOGETHER NEXT/);
});

test('private volunteer, assignment, notes and attribute text cannot become executable markup', () => {
  const payload = '\"><img src=x onerror=alert(1)>';
  const data = document();
  data.services[0].title = payload;
  data.services[0].theme = payload;
  data.services[0].notes = payload;
  data.services[0].program = [{ title: payload, person: payload, minutes: 5 }];
  const model = { planner: data, privateAccess: true, canEdit: true, publicReady: true, view: 'program', selected: 'service-1' };
  const html = view.page(model).html;
  assert.doesNotMatch(html, /<img|style=/);
  assert.match(html, /&lt;img/);
});
