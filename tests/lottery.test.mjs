import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const core = createRequire(import.meta.url)('../src/core.cjs');
const now = Date.UTC(2026, 7, 31);
const tickets = { base: 1, losses: 3, bonuses: [{ rule: 'fairFight', label: 'Fair Fight', tickets: 1 }], total: 5 };
const dibs = { policy: { mode: 'lottery', entryWindowSeconds: 30, availableWindowSeconds: 3 }, claims: [], draws: [{ id: 'draw', targetMemberId: 11,
  targetMemberName: 'Enemy', closesAt: new Date(now + 3000).toISOString(),
  entrants: [{ playerId: '1', tickets }, { playerId: '2', tickets: { ...tickets, total: 1 } }] }] };

test('pending draws have per-player odds without a premature claim', () => {
  const view = core.dibsLotteryView(dibs, 11, '1', now);
  assert.equal(view.chance, 83);
  assert.equal(view.entry.tickets.total, 5);
  assert.equal(core.activeDibsClaim(dibs, 11, now), undefined);
  assert.equal(core.dibsLotteryView(dibs, 12, '1', now).elsewhere, true);
  assert.equal(core.dibsLotteryView(dibs, 11, '1', now + 3000).closing, true);
  assert.equal(core.dibsTicketLabel(tickets), '5 tickets · Base 1 · Losses 3 · Fair Fight 1');
});

test('configurable early entry still requires fresh same-country rosters', () => {
  const target = { member_id: 11, status: { userStatus: 'Hospital', until: (now + 330000) / 1000 }, location: { current: 'Torn' } };
  const claimant = { status: { userStatus: 'Okay' }, location: { current: 'Torn' } };
  const context = { target, claimant, claimantRosterFresh: true, targetRosterFresh: true, hospitalWindowSeconds: 330 };
  assert.equal(core.dibsClaimEligibility(context, now).eligible, true);
  assert.equal(core.dibsClaimEligibility(context, now - 1).eligible, false);
  assert.equal(core.dibsClaimEligibility({ ...context, targetRosterFresh: false }, now).eligible, false);
  assert.equal(core.dibsClaimEligibility({ ...context, claimant: { ...claimant, location: { current: 'Switzerland' } } }, now).eligible, false);
});

test('lottery use follows the exact half-open server-time boundary', () => {
  const policy = { mode: 'lottery', entryWindowSeconds: 30, availableWindowSeconds: 3 };
  const hospitalUntil = now + 10 * 60_000;
  const target = { state: 'hospitalized', hospitalUntil };
  const eligibilityAt = hospitalUntil - 300_000;
  const opensAt = eligibilityAt - 30_000;
  const closesAt = eligibilityAt + 3_000;

  assert.equal(core.dibsUsesLottery(policy, target, opensAt - 1, 300), false);
  assert.equal(core.dibsUsesLottery(policy, target, opensAt, 300), true);
  assert.equal(core.dibsUsesLottery(policy, target, eligibilityAt, 300), true);
  assert.equal(core.dibsUsesLottery(policy, target, closesAt - 1, 300), true);
  assert.equal(core.dibsUsesLottery(policy, target, closesAt, 300), false);
  assert.equal(core.dibsUsesLottery(policy, target, hospitalUntil, 300), false);
  assert.equal(core.dibsUsesLottery(policy, { state: 'available', hospitalUntil }, eligibilityAt, 300), false);
  assert.equal(core.dibsUsesLottery({ ...policy, mode: 'instant' }, target, eligibilityAt, 300), false);
  assert.equal(core.dibsUsesLottery(policy, target, hospitalUntil, 300, true), true);
});

test('expired valid hospital time is immediately eligible while missing or invalid time fails closed', () => {
  const claimant = { status: { userStatus: 'Okay' }, location: { current: 'Torn' } };
  const claimContext = (until) => ({
    claimant,
    target: { member_id: 11, status: { userStatus: 'Hospital', until }, location: { current: 'Torn' } },
    claimantRosterFresh: true,
    targetRosterFresh: true,
  });

  assert.deepEqual(
    { eligible: core.dibsClaimEligibility(claimContext(now / 1000), now).eligible, state: core.dibsClaimEligibility(claimContext(now / 1000), now).state },
    { eligible: true, state: 'available' }
  );
  assert.deepEqual(
    { eligible: core.dibsClaimEligibility(claimContext((now - 1) / 1000), now).eligible, state: core.dibsClaimEligibility(claimContext((now - 1) / 1000), now).state },
    { eligible: true, state: 'available' }
  );
  assert.equal(core.dibsClaimEligibility(claimContext(undefined), now).eligible, false);
  assert.equal(core.dibsClaimEligibility(claimContext(undefined), now).state, 'target_status_unknown');
  assert.equal(core.dibsClaimEligibility(claimContext('not-a-time'), now).eligible, false);
  assert.equal(core.dibsClaimEligibility(claimContext('not-a-time'), now).state, 'target_status_unknown');
});

test('actual Dibs markup offers withdrawal without claiming ownership', () => {
  const source = readFileSync(new URL('../src/userscript.js', import.meta.url), 'utf8');
  const section = source.slice(source.indexOf('  function dibsMarkup('), source.indexOf('  function compactDibsDrawMarkup('));
  const html = runInNewContext(`${section}\ndibsMarkup({ member_id: 11 }, view, undefined, 'test')`, {
    core, view: { dibs, ownFactionId: '1', enemyFactionId: '2' },
    state: { settings: {}, dibs, nowMs: now, session: { playerId: '1' }, dibsInspectTargetId: 11, dibsInspectKey: 'test' },
    dibsClaimContext: () => ({ eligible: true, reason: 'Same location' }), isOnline: () => true, rosterIsFresh: () => true,
    escapeHtml: value => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;'),
  });
  assert.match(html, /Entered draw/);
  assert.match(html, /Synchronizing server time/);
  assert.match(html, /Current chance 83%/);
  assert.match(html, /Leave draw/);
  assert.match(html, /data-dibs-action="inspect"/);
  assert.doesNotMatch(html, /Release & unwatch|Dibs: /);
});

test('actual Dibs markup distinguishes draw entry from immediate claim at the close boundary', () => {
  const source = readFileSync(new URL('../src/userscript.js', import.meta.url), 'utf8');
  const section = source.slice(source.indexOf('  function dibsMarkup('), source.indexOf('  function compactDibsDrawMarkup('));
  assert.match(section, /core\.dibsUsesLottery\([\s\S]*state\.nowMs/);
  assert.doesNotMatch(section, /const lotteryMode = .*\?\.mode === ["']lottery["']/);
  const policy = { mode: 'lottery', entryWindowSeconds: 30, availableWindowSeconds: 3 };
  const hospitalUntil = now + 10 * 60_000;
  const eligibilityAt = hospitalUntil - 300_000;
  const opensAt = eligibilityAt - 30_000;
  const closesAt = eligibilityAt + 3_000;
  const markup = (at, eligibility) => runInNewContext(`${section}\ndibsMarkup({ member_id: 11 }, view, undefined, 'test')`, {
    core,
    view: { dibs: { policy, claims: [], draws: [] }, ownFactionId: '1', enemyFactionId: '2' },
    state: {
      settings: {},
      dibs: { policy, claims: [], draws: [], hospitalWindowSeconds: 300 },
      nowMs: at,
      clockReady: true,
      session: { playerId: '1' },
      dibsBusyTargetId: 11,
      dibsBusyAction: 'claim',
      dibsInspectTargetId: 0,
      dibsInspectKey: '',
    },
    dibsClaimContext: () => eligibility,
    isOnline: () => true,
    rosterIsFresh: () => true,
    escapeHtml: value => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;'),
  });
  const hospitalized = { eligible: true, state: 'hospitalized', hospitalUntil, reason: 'Same location' };

  const drawHtml = markup(opensAt, hospitalized);
  assert.match(drawHtml, /Enter Dibs draw/);
  assert.match(drawHtml, /aria-label="Entering draw"/);

  const immediateHtml = markup(closesAt, hospitalized);
  assert.match(immediateHtml, /Claim Dibs - leaves hospital/);
  assert.match(immediateHtml, /aria-label="Claiming Dibs"/);
  assert.doesNotMatch(immediateHtml, /Enter Dibs draw|Entering draw/);

  const availableHtml = markup(hospitalUntil, { eligible: true, state: 'available', hospitalUntil, reason: 'Same location' });
  assert.match(availableHtml, /Claim Dibs - attackable now/);
  assert.match(availableHtml, /aria-label="Claiming Dibs"/);
  assert.doesNotMatch(availableHtml, /Enter Dibs draw|Entering draw/);
});
