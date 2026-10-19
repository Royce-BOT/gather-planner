import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const context = vm.createContext({ window: {} });
vm.runInContext(readFileSync(new URL('../planner.js', import.meta.url), 'utf8'), context);
context.GatherPlanner = context.window.GatherPlanner;
vm.runInContext(readFileSync(new URL('../render.js', import.meta.url), 'utf8'), context);
const view = context.window.GatherView;
const now = new Date(2026, 9, 19, 12);
const service = (id, date) => ({ id, title: id, date, time: '09:00', theme: 'Worship together', location: 'Public hall', program: [] });
const services = () => [
  service('upcoming', '2026-10-20'),
  service('older-archive', '2026-09-01'),
  service('recent-finished', '2026-10-18'),
  service('archive-anniversary', '2026-09-19'),
  service('today', '2026-10-19'),
  service('not-yet-archived', '2026-09-20')
];
const model = overrides => ({
  planner: { services: services(), team: [], songs: [] },
  privateAccess: true, canEdit: false, publicReady: true,
  view: 'services', now, ...overrides
});
const opened = html => [...html.matchAll(/data-open="([^"]+)"/g)].map(match => match[1]);

test('service lists default to current schedules and retain recent finished programs', () => {
  const html = view.page(model()).html;
  assert.deepEqual(opened(html), ['not-yet-archived', 'recent-finished', 'today', 'upcoming']);
  assert.match(html, /Program finished/);
  assert.match(html, /data-service-range="current"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*data-service-range="current"/);
  assert.match(html, /data-service-range="past"[^>]*aria-pressed="false"|aria-pressed="false"[^>]*data-service-range="past"/);
});

test('Past programs contains archived plans in newest-first order without deleting records', () => {
  const state = model({ serviceRange: 'past', canEdit: true });
  const before = JSON.stringify(state.planner);
  const html = view.page(state).html;
  assert.match(html, /Past programs/);
  assert.deepEqual(opened(html), ['archive-anniversary', 'older-archive']);
  assert.match(html, /data-service-range="past"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*data-service-range="past"/);
  assert.match(html, /data-edit="archive-anniversary"/);
  assert.equal(JSON.stringify(state.planner), before);
});

test('overview counts and calendar omit archived plans while showing the next service', () => {
  const html = view.page(model({ view: 'overview' })).html;
  assert.match(html, /COMING TOGETHER NEXT<\/span><h2>upcoming/);
  assert.match(html, /PLANNED SERVICES<\/span><b>4<\/b>/);
  assert.deepEqual(opened(html).filter(id => id !== 'upcoming'), ['not-yet-archived', 'recent-finished', 'today']);
  assert.doesNotMatch(html, /data-open="(?:archive-anniversary|older-archive)"/);
  assert.match(html, /Program finished/);
});

test('archived program links remain usable and retain the selected service list on return', () => {
  for (const serviceRange of ['current', 'past']) {
    const html = view.page(model({ view: 'program', selected: 'older-archive', serviceRange })).html;
    assert.match(html, /<h1>older-archive<\/h1>/);
    assert.match(html, /Program finished/);
    assert.match(html, /data-print/);
    const back = [...html.matchAll(/<button\b[^>]*>/g)].map(match => match[0]).find(tag => /data-view="services"/.test(tag));
    assert.ok(back, 'The program has a return button');
    assert.match(back, new RegExp(`data-service-range="${serviceRange}"`));
  }
});

test('finished status follows the service date, leaving today and future programs unmarked', () => {
  for (const selected of ['recent-finished', 'archive-anniversary']) {
    assert.match(view.page(model({ view: 'program', selected })).html, /Program finished/);
  }
  for (const selected of ['today', 'upcoming']) {
    assert.doesNotMatch(view.page(model({ view: 'program', selected })).html, /Program finished/);
  }
});

test('empty current and Past programs lists offer a visible hint and keep navigation available', () => {
  for (const serviceRange of ['current', 'past']) {
    const html = view.page(model({ serviceRange, planner: { services: [], team: [], songs: [] } })).html;
    assert.match(html, /class="empty"/);
    assert.match(html, /data-service-range="current"/);
    assert.match(html, /data-service-range="past"/);
    assert.deepEqual(opened(html), []);
    assert.match(html, /class="empty"[^>]*>[^<]*\S/);
  }
});

test('public and approved-viewer archives remain read-only and projected public fields stay private', () => {
  for (const privateAccess of [false, true]) {
    const state = model({ privateAccess, serviceRange: 'past' });
    if (privateAccess) {
      state.planner.services[1].notes = 'Private preparation note';
      state.planner.services[1].program = [{ title: 'Reading', person: 'Private volunteer', minutes: 5 }];
      state.planner.team = [{ id: 'person-1', name: 'Private volunteer', role: 'Reader', ministry: 'Worship', contact: 'private@example.test' }];
    }
    const html = view.page(state).html;
    assert.deepEqual(opened(html), ['archive-anniversary', 'older-archive']);
    assert.doesNotMatch(html, /data-(?:add|edit|delete|add-item|remove-item|move|item)(?:=|\s|>)/);
    if (!privateAccess) {
      const program = view.page({ ...state, view: 'program', selected: 'older-archive' }).html;
      assert.match(program, /Program finished/);
      assert.doesNotMatch(html + program, /Private preparation note|Private volunteer|private@example\.test/);
      assert.doesNotMatch(program, /data-(?:add|edit|delete|add-item|remove-item|move|item)(?:=|\s|>)/);
    }
  }
});
