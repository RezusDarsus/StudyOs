import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './setup.js';

load('state/app-state.js');
const AppState = globalThis.StudyOSState;

test('selecting a workspace bumps the load token so stale responses die', () => {
  const tokenA = AppState.loadToken;
  AppState.selectWorkspace('workspace-a', { id: 'workspace-a', title: 'A' });
  const tokenB = AppState.loadToken;
  assert.notEqual(tokenA, tokenB);
  assert.ok(AppState.isCurrent(tokenB));
  assert.ok(!AppState.isCurrent(tokenA));
  // An in-flight request from workspace A must be rejected after the switch.
  AppState.selectWorkspace('workspace-b', { id: 'workspace-b', title: 'B' });
  assert.ok(!AppState.isCurrent(tokenB), 'response from the previous workspace must be dropped');
});

test('selecting a workspace clears the per-workspace data cache', () => {
  AppState.selectWorkspace('workspace-c', { id: 'workspace-c', title: 'C' });
  AppState.setData({ topics: [{ id: 't1', name: 'Ghost from another workspace' }] });
  assert.equal(AppState.data.topics.length, 1);
  AppState.selectWorkspace('workspace-d', { id: 'workspace-d', title: 'D' });
  assert.equal(AppState.data.topics.length, 0, 'topics from the previous workspace must not leak');
  assert.equal(AppState.courseId, 'workspace-d');
});

test('route changes emit and deduplicate', () => {
  let changes = 0;
  const off = AppState.on('route', () => { changes += 1; });
  AppState.setRoute('curriculum');
  AppState.setRoute('curriculum'); // same route: no event
  assert.equal(changes, 1);
  off();
});
