import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const core = createRequire(import.meta.url)('../src/core.cjs');
const source = readFileSync(new URL('../src/userscript.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const now = Date.parse('2026-11-05T12:00:00Z');
const warStart = '2026-11-05T11:00:00Z';
const warId = `10:20:${Date.parse(warStart)}`;
const escapeHtml = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const plain = value => JSON.parse(JSON.stringify(value));

// Named top-level functions have a two-space closing brace; nested statements do not.
function functionSource(name) {
  const match = new RegExp(`^  (?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(match, `production function ${name} exists`);
  const tail = source.slice(match.index);
  const end = /^  }\s*$/m.exec(tail);
  assert.ok(end, `production function ${name} has a closing brace`);
  return tail.slice(0, end.index + end[0].trimEnd().length);
}
function runtime(names, globals = {}) {
  const context = {
    core, Date, Number, String, Math, Map, Set, Promise, escapeHtml,
    isOnline: () => true, socketIsOpen: () => true, directSocketIsOpen: () => true,
    rosterIsFresh: () => true, currentEnemyRosterIsFresh: () => true,
    scheduleRender() {}, setTimeout: fn => { fn(); return 1; }, clearTimeout() {},
    ...globals,
  };
  return runInNewContext(`${names.map(functionSource).join('\n')}\n({${names.join(',')}})`, context);
}
const target = (id = 2, name = 'Opponent') => ({ member_id: id, member_name: name, faction_id: '20', status: { userStatus: 'Okay' }, location: { current: 'Torn' } });
const basePlan = () => ({
  ownerFactionId: '10', enemyFactionId: '20', warId, warStartedAt: warStart,
  currentPlayerId: '1', enabled: true, available: true, readOnly: false, revision: 1,
  hitLimit: 20, defaultCapacity: 40, targets: [], assignments: [],
  alliedMembers: [{ id: '1', name: 'Me' }, { id: '3', name: 'Contact' }],
  enemyMembers: [{ id: '2', name: 'Opponent' }, { id: '4', name: 'Other opponent' }],
});
const assignment = (playerId = '1', targetId = '2', plannedHits = 20, completedHits = 0) => ({
  id: `assignment-${playerId}-${targetId}`, playerId, playerName: playerId === '1' ? 'Me' : 'Contact',
  targetId, targetName: targetId === '2' ? 'Opponent' : 'Other opponent', plannedHits, completedHits, status: 'active',
});
function baseView(dibs = { claims: [] }) {
  return {
    ownFactionId: '10', enemyFactionId: '20', alliedScore: { factionId: '10', start: warStart }, enemyScore: { factionId: '20', start: warStart },
    ownRoster: [{ member_id: 1, member_name: 'Me', faction_id: '10', status: { userStatus: 'Okay' }, location: { current: 'Torn' } }],
    enemyRoster: [target(), target(4, 'Other opponent')], dibs,
  };
}
function medoutFixture(overrides = {}) {
  const view = overrides.view || baseView();
  const state = {
    session: { factionId: '10', playerId: '1', factionName: 'Own faction' }, authEpoch: 1,
    settings: { enabled: true }, clockReady: true, nowMs: now, phase: 'connected', token: 'fixture-only',
    medoutPlan: basePlan(), medoutPendingPlan: null, medoutApplicationSequence: 0, medoutSynced: true, medoutBusyTargetId: 0, medoutError: '', medoutNotice: '', medoutIntroOpen: false, medoutCopySequence: 0,
    sharedStateRequestSequence: 0,
    dibs: view.dibs, dibsBusyTargetId: 0, dibsApplicationSequence: 0, targetQuickBusyId: 0, targetsSaving: false,
    rosters: new Map([['10', { members: view.ownRoster }], ['20', { members: view.enemyRoster }]]),
    rosterDataAt: new Map([['10', now], ['20', now]]), factionNames: new Map([['10', 'Own faction'], ['20', 'Enemy faction']]),
    scores: new Map([['10', view.alliedScore], ['20', view.enemyScore]]), retaliation: { attacks: [] }, loadouts: new Map(),
    ...overrides.state,
  };
  const calls = [];
  const names = Array.from(source.matchAll(/^  (?:async )?function (\w*[Mm]edout\w*)\(/gm), match => match[1]);
  assert.ok(names.includes('activeMedoutPlan'));
  const globals = {
    state, sessionView: () => view, currentEnemyFactionId: () => view.enemyFactionId,
    MEDOUT_URL: 'https://askelads.grusmedia.no/medout-buddies',
    frontendUrl: path => `https://askelads.grusmedia.no${path}`, backendUrl: path => `https://backend.grusmedia.no${path}`,
    getStoredKey: () => 'fixture-only', dataIsStale: () => false, transportIsLive: () => true,
    requestSocketAction: async (action, payload) => { calls.push({ action, payload }); return state.medoutPlan; },
    publishSharedTransport() {}, sharedBrokerEnabled: () => false, tabBroker: null,
    navigator: { clipboard: { writeText: async () => {} } }, document: { querySelector: () => null },
    ...overrides.globals,
  };
  const api = runtime([...names, ...(overrides.functions || [])], globals);
  return { api, state, view, calls };
}

test('actual Dibs claim context explains an online Medout partner reservation and preserves country rules', () => {
  const dibs = { claims: [], hospitalWindowSeconds: 300, medoutProtection: { '2': { buddies: [
    { playerId: '3', playerName: 'Contact', remainingHits: 10, online: true },
    { playerId: '1', playerName: 'Me', remainingHits: 8, online: false },
  ] } } };
  const state = { dibs, clockReady: true, nowMs: now, session: { playerId: '9' } };
  const view = baseView(dibs);
  view.ownRoster.push({ member_id: 9, status: { userStatus: 'Okay' }, location: { current: 'Torn' } });
  const api = runtime(['dibsClaimContext'], { state });
  let result = api.dibsClaimContext(target(), view);
  assert.equal(result.eligible, false);
  assert.match(result.reason, /medout|buddy/i);
  assert.match(result.reason, /Contact/);
  state.session.playerId = '1';
  assert.equal(api.dibsClaimContext(target(), view).eligible, true, 'an unfinished assigned partner can claim even if another partner is the online one');
  view.ownRoster[0].location.current = 'Canada';
  result = api.dibsClaimContext(target(), view);
  assert.equal(result.eligible, false, 'Medout never bypasses ordinary same-country eligibility');
  assert.match(result.reason, /Torn|Canada|location|country/i);
});

test('the actual blocked Dibs control shows a lock, partner names and remaining hits without offering a claim', () => {
  const dibs = { claims: [], medoutProtection: { '2': { buddies: [{ playerId: '3', playerName: '<img onerror=evil>', remainingHits: 10, online: true }] } } };
  const view = baseView(dibs);
  const f = medoutFixture({ view, state: { medoutPlan: null }, functions: ['dibsMarkup', 'dibsClaimContext'] });
  const html = f.api.dibsMarkup(target(), view, undefined, 'roster-2');
  assert.match(html, /data-dibs-action="inspect"/);
  assert.match(html, /medout-protected/);
  assert.match(html, /&#128274;/);
  assert.match(html, /&lt;img onerror=evil&gt;/);
  assert.match(html, /10 hits left/);
  assert.doesNotMatch(html, /data-dibs-action="claim"|<img/);
});

test('actual Medout snapshots require the current owner/match and never regress a newer revision', () => {
  const f = medoutFixture();
  assert.ok(f.api.activeMedoutPlan(f.view));
  assert.equal(f.api.applyMedoutSnapshot({ ...basePlan(), revision: 5 }), true);
  assert.equal(f.state.medoutPlan.revision, 5);
  assert.equal(f.state.medoutSynced, true, 'ignored older snapshots cannot downgrade live readiness');
  for (const value of [
    { ...basePlan(), ownerFactionId: '99', revision: 100 },
    { ...basePlan(), warId: '10:20:old', revision: 100 },
    { ...basePlan(), enemyFactionId: '99', revision: 100 },
    { ...basePlan(), revision: 4 },
  ]) assert.equal(f.api.applyMedoutSnapshot(value), false);
  assert.equal(f.state.medoutPlan.revision, 5);
  assert.equal(f.api.applyMedoutSnapshot({ ...basePlan(), enabled: false, revision: 6 }), true);
  assert.equal(f.api.activeMedoutPlan(f.view), null);
});

test('actual reserve actions share one in-flight lock and accept only the server result', async () => {
  let finish;
  const calls = [];
  const f = medoutFixture({ globals: { requestSocketAction: (action, payload) => {
    calls.push({ action, payload });
    return new Promise(resolve => { finish = resolve; });
  } } });
  const pending = f.api.reserveMedoutBuddy(2);
  await f.api.reserveMedoutBuddy(4);
  assert.deepEqual(plain(calls), [{ action: 'war_medout:claim', payload: { warId, targetId: '2', plannedHits: 20 } }]);
  assert.equal(f.state.medoutPlan.assignments.length, 0, 'a pending request never fabricates an assignment');
  finish({ ...basePlan(), revision: 2, assignments: [assignment()] });
  await pending;
  assert.equal(f.state.medoutPlan.assignments[0].targetId, '2');
  assert.equal(f.state.medoutBusyTargetId, 0);
});

test('HTTP fallback and unsynchronized Medout snapshots cannot submit reserve actions', async () => {
  const fallback = medoutFixture({ globals: { socketIsOpen: () => false } });
  await fallback.api.reserveMedoutBuddy(2);
  assert.equal(fallback.calls.length, 0);
  const unsynced = medoutFixture({ state: { medoutSynced: false } });
  await unsynced.api.reserveMedoutBuddy(2);
  assert.equal(unsynced.calls.length, 0);
  const stale = medoutFixture({ globals: { rosterIsFresh: () => false, currentEnemyRosterIsFresh: () => false } });
  await stale.api.reserveMedoutBuddy(2);
  assert.equal(stale.calls.length, 0);
});

test('receiving a compatible HTTP snapshot actually clears Medout write readiness', async () => {
  const f = medoutFixture({ functions: ['applyFallbackSnapshot'], globals: {
    syncTrustedClock() {}, syncTargetDraft() {}, applyDibsSnapshot() {}, evaluateNotifications() {},
  } });
  f.api.applyFallbackSnapshot({
    settings: { enabled: true }, rosters: [
      { factionId: '10', members: f.view.ownRoster }, { factionId: '20', members: f.view.enemyRoster },
    ], scores: [f.view.alliedScore, f.view.enemyScore], dibs: { claims: [] },
    serverTime: new Date(now).toISOString(), revision: 'fallback-1',
  });
  assert.equal(f.state.medoutSynced, false);
  await f.api.reserveMedoutBuddy(2);
  assert.equal(f.calls.length, 0);
});

test('an unsupported optional Medout topic does not degrade the main connection or existing Dibs state', () => {
  let published = 0;
  const f = medoutFixture({ functions: ['handleSocketMessage'], state: { error: '', socketRequests: new Map() }, globals: {
    syncTrustedClock() {}, publishSharedTransport: () => { published++; },
  } });
  const beforeDibs = f.state.dibs;
  f.api.handleSocketMessage({ data: JSON.stringify({ type: 'error', id: 'wc-war_medout-123', error: { message: 'Topic is not available' } }) });
  assert.equal(f.state.phase, 'connected');
  assert.equal(f.state.error, '');
  assert.equal(f.state.dibs, beforeDibs);
  assert.equal(f.state.rosters.size, 2);
  assert.equal(f.state.medoutPlan, null);
  assert.equal(f.state.medoutSynced, false);
  assert.equal(published, 0);
  f.api.handleSocketMessage({ data: JSON.stringify({ type: 'error', id: 'wc-score-123', error: { message: 'Required topic failed' } }) });
  assert.equal(f.state.error, 'Required topic failed', 'required topic failures still surface');
});

test('optional Medout topic errors without request IDs remain isolated from the main connection', () => {
  for (const envelope of [
    { topic: 'war_medout', error: { message: 'Unsupported topic' } },
    { error: { topic: 'war_medout', message: 'Unsupported topic' } },
  ]) {
    const f = medoutFixture({ functions: ['handleSocketMessage'], state: { error: '', socketRequests: new Map() }, globals: { syncTrustedClock() {} } });
    f.api.handleSocketMessage({ data: JSON.stringify({ type: 'error', ...envelope }) });
    assert.equal(f.state.error, '');
    assert.equal(f.state.phase, 'connected');
    assert.equal(f.state.medoutPlan, null);
    assert.equal(f.state.medoutPendingPlan, null);
    assert.equal(f.state.medoutSynced, false);
    assert.equal(f.state.rosters.size, 2);
  }
});

test('an early next-war Medout event is staged until matching scores arrive and old-war events stay inactive', () => {
  let currentState;
  const f = medoutFixture({ functions: ['applyEvent'], globals: {
    sessionView: () => ({ ...baseView(), alliedScore: currentState.scores.get('10'), enemyScore: currentState.scores.get('20') }),
    syncTrustedClock() {}, maybeLoadEnemyLoadouts() {}, evaluateNotifications() {},
  } });
  currentState = f.state;
  const nextStart = '2026-11-06T11:00:00Z';
  const nextPlan = { ...basePlan(), warId: `10:20:${Date.parse(nextStart)}`, warStartedAt: nextStart, revision: 2 };
  f.api.applyMedoutSnapshot(nextPlan);
  assert.equal(f.state.medoutPendingPlan.warId, nextPlan.warId);
  assert.equal(f.api.activeMedoutPlan().warId, warId, 'early next-war data is not used under the old score scope');
  f.api.applyMedoutSnapshot({ ...nextPlan, revision: 1 });
  assert.equal(f.state.medoutPendingPlan.revision, 2, 'staged data cannot regress');
  f.api.applyEvent('score', [{ factionId: '10', start: nextStart }, { factionId: '20', start: nextStart }]);
  assert.equal(f.state.medoutPendingPlan, null);
  assert.equal(f.api.activeMedoutPlan().warId, nextPlan.warId);
  assert.equal(f.state.medoutSynced, true);
  f.api.applyMedoutSnapshot({ ...basePlan(), revision: 999 });
  assert.equal(f.api.activeMedoutPlan().warId, nextPlan.warId, 'old-war revision numbers cannot restore the previous match');
});

test('a late mutation cannot restore an old faction after authentication changes', async () => {
  let finish;
  const f = medoutFixture({ globals: { requestSocketAction: () => new Promise(resolve => { finish = resolve; }) } });
  const pending = f.api.reserveMedoutBuddy(2);
  f.state.authEpoch++;
  f.state.session = { factionId: '99', playerId: '8' };
  f.state.medoutPlan = null;
  f.state.medoutBusyTargetId = 0;
  finish({ ...basePlan(), revision: 9, assignments: [assignment()] });
  await pending;
  assert.equal(f.state.medoutPlan, null);
  assert.equal(f.state.medoutNotice, '');
  assert.equal(f.state.medoutError, '');
});

test('a changed war discards a late old-war claim even when its revision is higher', async () => {
  let finish;
  const f = medoutFixture({ globals: { requestSocketAction: () => new Promise(resolve => { finish = resolve; }) } });
  const pending = f.api.reserveMedoutBuddy(2);
  const nextStart = '2026-11-06T11:00:00Z';
  const nextPlan = { ...basePlan(), warStartedAt: nextStart, warId: `10:20:${Date.parse(nextStart)}`, revision: 1 };
  f.view.alliedScore.start = nextStart;
  f.view.enemyScore.start = nextStart;
  f.state.medoutPlan = nextPlan;
  finish({ ...basePlan(), revision: 99, assignments: [assignment()] });
  await pending;
  assert.equal(f.state.medoutPlan.warId, nextPlan.warId);
  assert.equal(f.state.medoutPlan.assignments.length, 0);
  assert.equal(f.state.medoutNotice, '');
});

test('copying the introduction is local-only and a denied clipboard opens the manual message', async () => {
  const value = basePlan();
  value.targets = [{ targetId: '2', name: 'Opponent', contactStatus: 'uncontacted', contactPlayerId: '1' }];
  value.assignments = [assignment()];
  const copied = [];
  const f = medoutFixture({ state: { medoutPlan: value }, globals: { navigator: { clipboard: { writeText: async text => { copied.push(text); } } } } });
  await f.api.copyMedoutIntroduction();
  assert.deepEqual(copied, [core.medoutMessage('Opponent', 20)]);
  assert.equal(f.calls.length, 0, 'copying never calls a backend or marks contact status');
  assert.equal(f.state.medoutPlan.targets[0].contactStatus, 'uncontacted');
  assert.match(f.state.medoutNotice, /copied/i);
  const denied = medoutFixture({ state: { medoutPlan: value }, globals: { navigator: { clipboard: { writeText: async () => { throw Error('denied'); } } } } });
  await denied.api.copyMedoutIntroduction();
  assert.equal(denied.state.medoutIntroOpen, true);
  assert.match(denied.state.medoutNotice, /Select and copy/i);
});

test('late clipboard completion cannot show a previous account message', async () => {
  const value = basePlan();
  value.targets = [{ targetId: '2', name: 'Opponent', contactStatus: 'uncontacted', contactPlayerId: '1' }];
  value.assignments = [assignment()];
  let finish;
  const f = medoutFixture({ state: { medoutPlan: value }, globals: { navigator: { clipboard: { writeText: () => new Promise(resolve => { finish = resolve; }) } } } });
  const pending = f.api.copyMedoutIntroduction();
  f.state.authEpoch++;
  f.state.session = { factionId: '99', playerId: '8' };
  f.state.medoutPlan = null;
  finish();
  await pending;
  assert.equal(f.state.medoutNotice, '');
  assert.equal(f.state.medoutIntroOpen, false);
});

test('compact Medout markup is admin-gated and never appears for an allied or unrelated target', () => {
  const f = medoutFixture();
  assert.match(f.api.medoutMarkup(target(), f.view), /data-medout-action="claim"/);
  assert.doesNotMatch(f.api.medoutMarkup({ ...target(), faction_id: '10' }, f.view), /data-medout-action/);
  assert.doesNotMatch(f.api.medoutMarkup(target(999, 'Unrelated'), f.view), /data-medout-action/);
  f.state.medoutPlan = { ...basePlan(), enabled: false };
  assert.equal(f.api.medoutMarkup(target(), f.view), '');
});

test('shared leader state carries Medout data and an older leader without it cannot leave mutations enabled', () => {
  const f = medoutFixture({ functions: ['sharedStatePayload', 'applySharedState'], globals: {
    sharedTransportPayload: () => ({ phase: 'connected', socketOpen: true }),
    applySharedTransport() {}, tabBroker: { isLeader: () => false },
    applyDibsSnapshot() {}, syncTargetDraft() {}, maybeLoadEnemyLoadouts() {}, evaluateNotifications() {},
  } });
  const shared = f.api.sharedStatePayload();
  assert.equal(shared.medoutPlan.warId, warId);
  assert.equal(shared.medoutSynced, true);
  f.state.medoutPlan = null;
  f.state.medoutSynced = false;
  assert.equal(f.api.applySharedState(shared), true);
  assert.equal(f.state.medoutPlan.warId, warId);
  assert.equal(f.state.medoutSynced, true);
  delete shared.medoutPlan;
  delete shared.medoutSynced;
  assert.equal(f.api.applySharedState(shared), true);
  assert.equal(f.state.medoutSynced, false);
});

test('a stale shared bootstrap preserves live transport, rosters and Medout and retries only once through the broker', async () => {
  const finishes = [], brokerRequests = [];
  const f = medoutFixture({ functions: ['sharedStatePayload', 'applySharedState', 'applySharedTransport', 'requestSharedState', 'applyEvent'], state: { sharedSocketOpen: true }, globals: {
    sharedTransportPayload: () => ({ phase: 'connected', socketOpen: true }),
    sharedBrokerEnabled: () => true,
    tabBroker: { isLeader: () => false, hasLeader: () => true, leaderId: () => 'leader', request: (type, payload) => {
      brokerRequests.push({ type, payload });
      return new Promise(resolve => { finishes.push(resolve); });
    } },
    applyDibsSnapshot() {}, syncTargetDraft() {}, syncTrustedClock() {}, maybeLoadEnemyLoadouts() {}, evaluateNotifications() {},
  } });
  const stale = f.api.sharedStatePayload();
  stale.phase = 'connecting'; stale.socketOpen = false; stale.settings = { enabled: false };
  stale.scores = [['10', { factionId: '10', start: '2026-11-01T11:00:00Z' }]];
  stale.rosters = [];
  delete stale.medoutPlan;
  delete stale.medoutSynced;
  f.api.requestSharedState();
  f.api.applyEvent('war_medout', { ...basePlan(), revision: 2, assignments: [assignment()] });
  const sequence = f.state.medoutApplicationSequence;
  assert.ok(sequence > 0);
  finishes[0](stale);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.state.sharedStateRequestSequence, 2, 'discarding a stale bootstrap requests one fresh broker state');
  assert.equal(brokerRequests.length, 2);
  assert.equal(f.state.sharedSocketOpen, true);
  assert.equal(f.state.phase, 'connected');
  assert.equal(f.state.settings.enabled, true);
  assert.equal(f.state.scores.get('10').start, warStart);
  assert.equal(f.state.rosters.get('10').members.length, 1);
  assert.equal(f.state.medoutPlan.revision, 2);
  assert.equal(f.state.medoutPlan.assignments[0].targetId, '2');
  assert.equal(f.state.medoutSynced, true, 'a stale response with no Medout payload cannot undo a new live event');
  assert.equal(f.state.medoutApplicationSequence, sequence);
  f.api.applyEvent('war_medout', { ...basePlan(), revision: 3, assignments: [assignment()] });
  finishes[1](stale);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(brokerRequests.length, 2, 'another stale retry response cannot start an unbounded retry loop');
  assert.deepEqual(plain(brokerRequests.map(request => request.type)), ['state', 'state']);
  assert.equal(f.calls.length, 0, 'the bounded refresh only uses the existing tab broker');
  assert.equal(f.state.medoutPlan.revision, 3);
  assert.equal(f.state.sharedSocketOpen, true);
  assert.equal(f.state.medoutSynced, true);
});

test('own-buddy introduction escapes names and message contents instead of creating executable markup', () => {
  const value = basePlan();
  const badName = '</textarea><script>alert(1)</script>';
  value.enemyMembers[0].name = badName;
  value.targets = [{ targetId: '2', name: badName, contactStatus: 'uncontacted', contactPlayerId: '1' }];
  value.assignments = [{ ...assignment(), targetName: badName }];
  const f = medoutFixture({ state: { medoutPlan: value, medoutIntroOpen: true } });
  const html = f.api.medoutSummaryMarkup(f.view);
  assert.match(html, /Copy introduction/);
  assert.match(html, /<textarea[^>]*data-focus-key="[^"]+"/, 'manual-copy selection has a stable focus key across render ticks');
  assert.match(html, /20/);
  assert.doesNotMatch(html, /<script>|<\/textarea><script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /medout-buddies/);
});
