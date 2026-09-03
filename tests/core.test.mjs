import assert from "node:assert/strict";
import { readFile as readFileRaw } from "node:fs/promises";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";

const require = createRequire(import.meta.url);
const core = require("../src/core.cjs");

const readFile = async (...args) => {
  const source = await readFileRaw(...args);
  return typeof source === "string" ? source.replace(/\r\n/g, "\n") : source;
};

const compactSource = (value) => String(value || "").replace(/\s+/g, " ").trim();

const sourceSection = (source, startMarker, endMarker) => {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `missing source marker: ${startMarker}`);
  const end = endMarker ? source.indexOf(endMarker, start + startMarker.length) : source.length;
  assert.ok(end >= 0, `missing source marker: ${endMarker}`);
  return source.slice(start, end);
};

it("keeps package and userscript release versions aligned", async () => {
  const [packageSource, header, userscript] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../userscript.header.txt", import.meta.url), "utf8"),
    readFile(new URL("../src/userscript.js", import.meta.url), "utf8"),
  ]);
  const version = JSON.parse(packageSource).version;
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  assert.match(header, new RegExp(`^// @version\\s+${escapedVersion}$`, "m"));
  assert.match(userscript, new RegExp(`const SCRIPT_VERSION = "${escapedVersion}";`));
});

const bootUserscript = async (href, { withBody = true, visibilityState = "hidden", storedValues = {} } = {}) => {
  const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");
  const elements = new Map();
  const documentListeners = new Map();
  const menuCommands = new Map();
  const storageValues = new Map(Object.entries(storedValues));
  let observerCallback = null;
  let intervalCount = 0;
  const mount = {
    appendChild(element) {
      element.parentNode = this;
      elements.set(element.id, element);
    },
  };
  const document = {
    body: withBody ? mount : null,
    documentElement: mount,
    head: mount,
    readyState: withBody ? "complete" : "loading",
    visibilityState,
    hasFocus: () => false,
    addEventListener(name, callback) { documentListeners.set(name, callback); },
    querySelector: () => null,
    getElementById: (id) => elements.get(id) || null,
    createElement(tagName) {
      return {
        id: "",
        tagName: String(tagName || "").toUpperCase(),
        parentNode: null,
        offsetWidth: 320,
        offsetHeight: 100,
        style: { removeProperty() {} },
        classList: { toggle() {} },
        addEventListener() {},
        getBoundingClientRect: () => ({ left: 10, top: 10, width: 320, height: 100 }),
        querySelector: () => null,
        querySelectorAll: () => [],
        remove() { elements.delete(this.id); },
      };
    },
  };
  let routeCheck = null;
  const context = {
    WarbuddyCore: core,
    URL,
    console,
    document,
    location: { href },
    GM_addStyle() {},
    GM_getValue: (key, fallback) => storageValues.has(key) ? storageValues.get(key) : fallback,
    GM_setValue: (key, value) => storageValues.set(key, value),
    GM_deleteValue: (key) => storageValues.delete(key),
    GM_registerMenuCommand(name, callback) { menuCommands.set(name, callback); },
    MutationObserver: class {
      constructor(callback) { observerCallback = callback; }
      observe() {}
      disconnect() {}
    },
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    alert() {},
    requestAnimationFrame: (callback) => callback(),
    setInterval(callback) { routeCheck = callback; intervalCount += 1; return intervalCount; },
    clearInterval() {},
    setTimeout: () => 1,
    clearTimeout() {},
    addEventListener() {},
  };
  context.window = context;
  runInNewContext(source, context);
  return {
    elements,
    menuCommands,
    storageValues,
    intervalCount: () => intervalCount,
    routeCheck: () => routeCheck?.(),
    notifyMutation: () => observerCallback?.([]),
    activateBody() {
      document.body = mount;
      document.readyState = "complete";
      documentListeners.get("DOMContentLoaded")?.();
    },
    setVisibility(value) {
      document.visibilityState = value;
      documentListeners.get("visibilitychange")?.();
    },
  };
};

describe("Warbuddy roster presentation", () => {
  it("normalizes filters and matches only the requested row state", () => {
    assert.equal(core.normalizeRosterFilter(undefined), "all");
    assert.equal(core.normalizeRosterFilter("RETALIATIONS"), "retaliations");
    assert.equal(core.normalizeRosterFilter("unexpected"), "all");
    assert.equal(core.rosterFilterMatches("all", {}), true);
    assert.equal(core.rosterFilterMatches("watched", { watched: true }), true);
    assert.equal(core.rosterFilterMatches("watched", { actionable: true }), false);
    assert.equal(core.rosterFilterMatches("actionable", { retaliation: true }), true);
    assert.equal(core.rosterFilterMatches("retaliations", { actionable: true }), false);
  });

  it("orders urgent roster states without changing ordinary Torn order", () => {
    assert.equal(core.rosterPriority({ retaliation: true, dibsTaken: true }), 0);
    assert.equal(core.rosterPriority({ dibsMine: true }), 1);
    assert.equal(core.rosterPriority({ actionable: true }), 2);
    assert.equal(core.rosterPriority({ watched: true, targetGroup: "priority" }), 3);
    assert.equal(core.rosterPriority({ watched: true, targetGroup: "chain" }), 4);
    assert.equal(core.rosterPriority({ watched: true, targetGroup: "later" }), 5);
    assert.equal(core.rosterPriority({ watched: true }), 6);
    assert.equal(core.rosterPriority({}), 7);
    assert.equal(core.rosterPriority({ dibsTaken: true }), 8);
  });

  it("presents backend hospital and travel state compactly", () => {
    const nowMs = 2_000_000_000_000;
    assert.deepEqual(
      core.memberAvailability({
        status: { userStatus: "Hospital", untill: nowMs + 245_000 },
        location: { current: "Torn" },
      }, nowMs),
      {
        state: "hospital",
        label: "H 4:05",
        title: "Hospital - 4m 05s remaining",
        tone: "soon",
        until: nowMs + 245_000,
      }
    );
    assert.equal(core.memberAvailability({
      status: { userStatus: "Traveling", untill: nowMs + 128_000 },
      location: { current: "Switzerland", destination: "Torn" },
    }, nowMs).label, "IN CH 2:08");
    assert.equal(core.memberAvailability({
      status: { userStatus: "Traveling", untill: nowMs + 400_000 },
      location: { current: "Torn", destination: "Mexico" },
    }, nowMs).label, "OUT MX 6:40");
    assert.equal(core.memberAvailability({
      status: { userStatus: "Okay" },
      location: { current: "Canada" },
    }, nowMs).label, "CA");
    assert.equal(core.memberAvailability({
      status: { userStatus: "Abroad" },
      location: { current: "United Kingdom" },
    }, nowMs).label, "UK");
    assert.equal(core.memberAvailability({
      status: { userStatus: "Okay" },
      location: { current: "Torn" },
    }, nowMs).label, "");
  });

  it("maps backend availability to Torn status families and yields to explicit Torn sorts", () => {
    assert.equal(core.availabilityCategory({ state: "hospital" }), "hospital");
    assert.equal(core.availabilityCategory({ state: "jail" }), "hospital");
    assert.equal(core.availabilityCategory({ state: "incoming" }), "traveling");
    assert.equal(core.availabilityCategory({ state: "abroad" }), "traveling");
    assert.equal(core.availabilityCategory({ state: "available" }), "available");
    assert.equal(core.availabilityCategory({ state: "unknown" }), "");
    assert.equal(core.rosterPriorityAllowedForSort(""), true);
    assert.equal(core.rosterPriorityAllowedForSort("status"), true);
    assert.equal(core.rosterPriorityAllowedForSort("BSP"), false);
    assert.equal(core.rosterPriorityAllowedForSort("member"), false);
  });

  it("keeps Warbuddy urgency ahead of availability while sorting ordinary rows usefully", () => {
    const nowMs = 2_000_000_000_000;
    const available = { status: { userStatus: "Okay" }, location: { current: "Torn" } };
    const hospital = {
      status: { userStatus: "Hospital", untill: nowMs + 60_000 },
      location: { current: "Torn" },
    };
    const incoming = {
      status: { userStatus: "Traveling", untill: nowMs + 60_000 },
      location: { current: "Canada", destination: "Torn" },
    };
    assert.ok(core.rosterOrder({ retaliation: true }, incoming, nowMs) < core.rosterOrder({}, available, nowMs));
    assert.ok(core.rosterOrder({}, available, nowMs) < core.rosterOrder({}, hospital, nowMs));
    assert.ok(core.rosterOrder({}, hospital, nowMs) < core.rosterOrder({}, incoming, nowMs));
    assert.ok(core.rosterOrder({ dibsTaken: true }, available, nowMs) > core.rosterOrder({}, incoming, nowMs));
  });
});

describe("Warbuddy action queue", () => {
  it("uses an explicit backend chain deadline and keeps an expired live chain visible as syncing", () => {
    const nowMs = 2_000_000_000_000;
    assert.deepEqual(core.chainPresentation({
      chain: 27,
      chain_end: nowMs + 90_000,
      chain_timer: nowMs + 20_000,
    }, nowMs), {
      active: true,
      chain: 27,
      label: "Chain 27 - 1:30",
      compact: "C27 1:30",
      tone: "wait",
      endsAt: nowMs + 90_000,
    });
    assert.deepEqual(core.chainPresentation({ chain: 27, chain_timer: nowMs - 1_000 }, nowMs), {
      active: true,
      chain: 27,
      label: "Chain 27 - timer syncing",
      compact: "C27 sync",
      tone: "wait",
      endsAt: nowMs - 1_000,
    });
    assert.equal(core.chainPresentation({ chain: 0 }, nowMs).active, false);
  });

  it("accepts the backend's explicit chain deadline in queue warnings", () => {
    const nowMs = 2_000_000_000_000;
    const items = core.buildActionQueue({
      nowMs,
      alliedScore: { chain: 27, chainEnd: nowMs + 30_000 },
    });
    assert.equal(items[0]?.key, "chain-risk");
    assert.equal(items[0]?.detail, "30s remaining");
  });

  it("prioritizes urgent chain and hospital actions before online targets", () => {
    const nowMs = 2_000_000_000_000;
    const items = core.buildActionQueue({
      nowMs,
      ownBsp: 1_000_000_000,
      alliedScore: {
        chain: 27,
        chain_timer: new Date(nowMs + 90_000).toISOString(),
      },
      enemies: [
        {
          member_id: 101,
          member_name: "Returning",
          bsp: 800_000_000,
          activity: "Offline",
          status: { userStatus: "Hospital", untill: nowMs + 120_000 },
          location: { current: "Torn" },
        },
        {
          member_id: 102,
          member_name: "Online",
          bsp: 700_000_000,
          activity: "Online",
          status: { userStatus: "Okay" },
          location: { current: "Torn" },
        },
        {
          member_id: 103,
          member_name: "Too strong",
          bsp: 2_000_000_000,
          activity: "Online",
          status: { userStatus: "Okay" },
          location: { current: "Torn" },
        },
      ],
    });

    assert.deepEqual(items.map((item) => item.key), ["chain-risk", "hospital-101", "online-102"]);
    assert.equal(items[0].severity, "urgent");
    assert.equal(items[1].severity, "urgent");
  });

  it("keeps the queue empty when no action is useful", () => {
    assert.deepEqual(core.buildActionQueue({ enemies: [], alliedScore: { chain: 2 } }), []);
  });

  it("shows a tracker-relative revive transition for five minutes and opens only the profile", () => {
    const nowMs = 2_000_000_000_000;
    const revivableSince = new Date(nowMs - (5 * 60_000)).toISOString();
    const items = core.buildActionQueue({
      nowMs,
      enemies: [{
        member_id: 150,
        member_name: "Revive target",
        is_revivable: true,
        revive_setting: "Friends & faction",
        revivable_since: revivableSince,
        status: { userStatus: "Jail" },
      }],
    });

    assert.equal(items.length, 1);
    assert.equal(items[0].kind, "revive");
    assert.equal(items[0].intent, "profile");
    assert.equal(items[0].actionLabel, "Profile");
    assert.equal(items[0].title, "Revive target revive setting: Friends & faction");
    assert.match(items[0].detail, /faction-visible setting/);
    assert.equal(items[0].url, "https://www.torn.com/profiles.php?XID=150");
  });

  it("ignores missing, false, future, and expired tracker-relative revive observations", () => {
    const nowMs = 2_000_000_000_000;
    const member = (memberId, fields) => ({
      member_id: memberId,
      member_name: `Player ${memberId}`,
      status: { userStatus: "Jail" },
      ...fields,
    });
    const actions = core.buildActionQueue({
      nowMs,
      enemies: [
        member(151, { is_revivable: false, revivable_since: new Date(nowMs - 1_000).toISOString() }),
        member(152, { is_revivable: true, revivable_since: null }),
        member(153, { is_revivable: true, revivable_since: new Date(nowMs + 1).toISOString() }),
        member(154, { is_revivable: true, revivable_since: new Date(nowMs - (5 * 60_000) - 1).toISOString() }),
      ],
    });

    assert.deepEqual(actions, []);
  });

  it("keeps profile-only revive signals out of Dibs groups and browser notifications", () => {
    const revive = {
      key: "revive-160-1999999999000",
      kind: "revive",
      intent: "profile",
      memberId: 160,
      severity: "info",
      title: "Revive target became revivable for tracker",
      detail: "1s ago - opens profile",
      url: "https://www.torn.com/profiles.php?XID=160",
    };
    const attack = { key: "watched-ready-161", memberId: 161 };
    const grouped = core.applyTargetGroups([revive, attack], { 160: "priority", 161: "chain" });

    assert.equal(core.actionTargetsAttack(revive), false);
    assert.equal(core.actionTargetsAttack(attack), true);
    assert.equal(grouped.find((item) => item.memberId === 160)?.targetGroup, "");
    assert.equal(grouped.find((item) => item.memberId === 161)?.targetGroup, "chain");
    assert.deepEqual(core.notificationCandidates({ actions: [revive] }), []);
  });

  it("omits generic online suggestions when own BSP is unavailable without hiding priority actions", () => {
    const nowMs = 2_000_000_000_000;
    const items = core.buildActionQueue({
      nowMs,
      ownBsp: 0,
      watchedEnemyMemberIds: [201],
      alliedScore: {
        chain: 27,
        chain_timer: new Date(nowMs + 90_000).toISOString(),
      },
      enemies: [
        {
          member_id: 201,
          member_name: "Watched",
          bsp: 9_000_000_000,
          activity: "Offline",
          status: { userStatus: "Okay" },
          location: { current: "Torn" },
        },
        {
          member_id: 202,
          member_name: "Hospital",
          bsp: 8_000_000_000,
          activity: "Offline",
          status: { userStatus: "Hospital", untill: nowMs + 5 * 60_000 },
          location: { current: "Torn" },
        },
        {
          member_id: 203,
          member_name: "Generic online",
          bsp: 100,
          activity: "Online",
          status: { userStatus: "Okay" },
          location: { current: "Torn" },
        },
      ],
    });

    assert.deepEqual(items.map((item) => item.key), [
      "chain-risk",
      "watched-ready-201",
      "hospital-202",
    ]);
  });

  it("pins watched targets near landing, near hospital release, and while attackable", () => {
    const nowMs = 2_000_000_000_000;
    const enemies = [
      {
        member_id: 201,
        member_name: "Landing",
        activity: "Offline",
        status: { userStatus: "Traveling", untill: nowMs + 45_000 },
        location: { current: "Switzerland", destination: "Torn" },
      },
      {
        member_id: 202,
        member_name: "Hospital",
        activity: "Offline",
        status: { userStatus: "Hospital", untill: nowMs + 30_000 },
        location: { current: "Torn" },
      },
      {
        member_id: 203,
        member_name: "Ready",
        activity: "Offline",
        status: { userStatus: "Okay" },
        location: { current: "Torn" },
      },
      {
        member_id: 204,
        member_name: "Not watched",
        activity: "Offline",
        status: { userStatus: "Okay" },
        location: { current: "Torn" },
      },
    ];

    const items = core.buildActionQueue({
      enemies,
      watchedEnemyMemberIds: [201, 202, 203],
      nowMs,
    });

    assert.deepEqual(items.map((item) => item.key), [
      "watched-ready-203",
      "watched-hospital-202",
      "watched-flight-201",
    ]);
    assert.ok(items.every((item) => item.severity === "urgent"));
  });

  it("does not announce watched travel until the member is landing in Torn within one minute", () => {
    const nowMs = 2_000_000_000_000;
    const baseMember = {
      member_id: 301,
      member_name: "Traveler",
      activity: "Offline",
      status: { userStatus: "Traveling", untill: nowMs + 30_000 },
      location: { current: "Torn", destination: "Mexico" },
    };

    assert.deepEqual(core.buildActionQueue({
      enemies: [baseMember],
      watchedEnemyMemberIds: [301],
      nowMs,
    }), []);
    assert.deepEqual(core.buildActionQueue({
      enemies: [{
        ...baseMember,
        status: { ...baseMember.status, untill: nowMs + 61_000 },
        location: { current: "Switzerland", destination: "Torn" },
      }],
      watchedEnemyMemberIds: [301],
      nowMs,
    }), []);
  });

  it("preserves the ordinary hospital warning before a watched target enters the one-minute window", () => {
    const nowMs = 2_000_000_000_000;
    const items = core.buildActionQueue({
      watchedEnemyMemberIds: [401],
      nowMs,
      enemies: [{
        member_id: 401,
        member_name: "Still waiting",
        activity: "Offline",
        status: { userStatus: "Hospital", untill: nowMs + 5 * 60_000 },
        location: { current: "Torn" },
      }],
    });

    assert.deepEqual(items.map((item) => item.key), ["hospital-401"]);
  });

  it("keeps chain risk first and orders personal target groups predictably", () => {
    const items = core.applyTargetGroups([
      { key: "watched-ready-1", memberId: 1 },
      { key: "chain-risk" },
      { key: "watched-ready-2", memberId: 2 },
      { key: "watched-ready-3", memberId: 3 },
    ], {
      1: "later",
      2: "chain",
      3: "priority",
      nope: "priority",
      4: "invalid",
    });

    assert.deepEqual(items.map((item) => item.key), [
      "chain-risk",
      "watched-ready-3",
      "watched-ready-2",
      "watched-ready-1",
    ]);
    assert.deepEqual(core.normalizeTargetGroups({ 1: "PRIORITY", 2: "invalid" }), { 1: "priority" });
  });

  it("builds a three-item focus queue and notification transitions", () => {
    const actions = [
      { key: "watched-flight-1", severity: "urgent", title: "Landing", detail: "30s", memberId: 1, url: "https://example.com/1" },
      { key: "watched-ready-2", severity: "urgent", title: "Ready", detail: "now", memberId: 2, url: "https://example.com/2" },
      { key: "hospital-3", severity: "watch", title: "Hospital", detail: "5m", memberId: 3 },
    ];
    const retaliations = [{ id: "retal-1", attackerId: 4, attackerName: "Enemy", defenderName: "Ally", expiresAt: 2_000_000_100 }];

    const focus = core.buildFocusQueue({ actions, retaliations, limit: 3 });
    assert.equal(focus.length, 3);
    assert.equal(focus[0].kind, "retaliation");
    assert.deepEqual(
      core.notificationCandidates({ actions, retaliations }).map((entry) => entry.kind),
      ["retaliation", "landing", "attackable"]
    );
  });

  it("recognizes attack results without treating ordinary status text as a result", () => {
    assert.equal(core.attackOutcomeFromText("You hospitalized Target with your final hit")?.kind, "hospitalized");
    assert.equal(core.attackOutcomeFromText("You mugged Target for $10")?.kind, "mugged");
    assert.equal(core.attackOutcomeFromText("You left Target on the street")?.kind, "left");
    assert.equal(core.attackOutcomeFromText("Target is currently hospitalized"), undefined);
  });
});

describe("Warbuddy live state", () => {
  it("accepts plausible server clock samples and rejects dangerous offsets", () => {
    const deviceNowMs = 2_000_000_000_000;
    assert.equal(core.trustedClockOffset(deviceNowMs + 4_000, deviceNowMs), 4_000);
    assert.equal(core.trustedClockOffset((deviceNowMs + 4_000) / 1000, deviceNowMs), 4_000);
    assert.equal(core.trustedClockOffset(deviceNowMs + 25 * 60 * 60 * 1000, deviceNowMs), undefined);
    assert.equal(core.trustedClockOffset("not-a-time", deviceNowMs), undefined);
  });

  it("anchors timer decisions to backend time across client skew and later device-clock jumps", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");
    const clockSource = sourceSection(source, "function tornPageNowMs", "function removeInlineMemberTools");
    const serverNowMs = Date.UTC(2026, 7, 29, 12, 0, 0);
    let deviceNowMs = serverNowMs + (10 * 60_000);
    let monotonicNow = 1_000;
    const context = {
      core,
      Date: { now: () => deviceNowMs, UTC: Date.UTC },
      performance: { now: () => monotonicNow },
      unsafeWindow: { getCurrentTimestamp: () => deviceNowMs / 1000 },
      window: {},
      REQUEST_TIMEOUT_MS: 30_000,
      CLOCK_BACKWARD_TOLERANCE_MS: 250,
      state: {
        nowMs: deviceNowMs,
        clockOffsetMs: 0,
        clockSource: "device",
        clockReady: false,
        clockAnchorServerMs: 0,
        clockAnchorMonotonicMs: Number.NaN,
      },
      result: null,
    };

    runInNewContext(`${clockSource}\nsyncTrustedClock(${serverNowMs}, "session", ${deviceNowMs}); result = { nowMs: trustedNowMs(), ready: state.clockReady, source: state.clockSource };`, context);
    assert.equal(context.result.ready, true);
    assert.equal(context.result.source, "session");
    assert.equal(context.result.nowMs, serverNowMs);

    const claimant = { member_id: 1, status: { userStatus: "Okay" }, location: { current: "Torn" } };
    const target = {
      member_id: 2,
      status: { userStatus: "Hospital", untill: serverNowMs + (5 * 60_000) + 1 },
      location: { current: "Torn" },
    };
    const eligibility = (nowMs) => core.dibsClaimEligibility({
      claimant,
      target,
      claimantRosterFresh: true,
      targetRosterFresh: true,
    }, nowMs);
    assert.equal(eligibility(context.result.nowMs).state, "hospital_too_early");

    deviceNowMs += 60 * 60_000;
    monotonicNow += 1;
    runInNewContext("result = { nowMs: trustedNowMs() };", context);
    assert.equal(context.result.nowMs, serverNowMs + 1);
    assert.equal(eligibility(context.result.nowMs).state, "hospitalized");

    runInNewContext(`result = { applied: syncTrustedClock(${serverNowMs - 5_000}, "delayed", Date.now()), nowMs: trustedNowMs() };`, context);
    assert.equal(context.result.applied, false);
    assert.equal(context.result.nowMs, serverNowMs + 1);
  });

  it("fails Dibs closed until an explicit backend clock sample is ready", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");
    const contextSource = sourceSection(source, "function dibsClaimContext", "function syncIntegratedMemberTools");
    const context = {
      state: { clockReady: false },
      result: null,
    };
    runInNewContext(`${contextSource}\nresult = dibsClaimContext({}, {}, undefined);`, context);
    assert.equal(context.result.eligible, false);
    assert.equal(context.result.state, "clock_syncing");
    assert.equal(context.result.reason, "Synchronizing server time.");
  });

  it("keeps local data freshness independent from the server clock offset", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");
    const freshnessSource = sourceSection(source, "const dataIsStale", "const currentEnemyFactionId");
    let deviceNowMs = Date.UTC(2026, 7, 29, 12, 10, 0);
    const context = {
      Date: { now: () => deviceNowMs },
      DATA_STALE_MS: 45_000,
      state: {
        lastLiveDataAt: deviceNowMs,
        socketOpenedAt: 0,
        nowMs: deviceNowMs - (10 * 60_000),
        rosterDataAt: new Map([["enemy", deviceNowMs]]),
      },
      socketIsOpen: () => false,
      transportIsLive: () => true,
      isOnline: () => true,
      result: null,
    };
    runInNewContext(`${freshnessSource}\nresult = { stale: dataIsStale(), age: liveDataAgeMs(), fresh: rosterIsFresh("enemy") };`, context);
    assert.deepEqual({ ...context.result }, { stale: false, age: 0, fresh: true });

    deviceNowMs += 45_001;
    runInNewContext("result = { stale: dataIsStale(), age: liveDataAgeMs(), fresh: rosterIsFresh(\"enemy\") };", context);
    assert.deepEqual({ ...context.result }, { stale: true, age: 45_001, fresh: false });
  });

  it("calibrates and relays only authoritative server clock samples", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");
    const sessionSource = compactSource(sourceSection(source, "async function requestCompanionSession", "function applyCompanionSession"));
    const eventSource = compactSource(sourceSection(source, "function applyEvent", "function applyFallbackSnapshot"));
    const sharedTransportSource = compactSource(sourceSection(source, "function sharedTransportPayload", "function applySharedState"));
    const sharedDataSource = compactSource(sourceSection(source, "function handleTabBrokerData", "function handleTabBrokerRequest"));
    const socketSource = compactSource(sourceSection(source, "function handleSocketMessage", "function scheduleReconnect"));
    const outcomeSource = compactSource(sourceSection(source, "async function recordAttackOutcome", "function inspectAttackOutcomeNode"));
    const renderSource = compactSource(sourceSection(source, "function render()", "function forgetStoredKey"));

    assert.match(sessionSource, /const responseReceivedAt = Date\.now\(\)/);
    assert.match(sessionSource, /response\?\.serverTime \|\| response\?\.session\?\.serverTime/);
    assert.match(sessionSource, /"session", responseReceivedAt/);
    assert.doesNotMatch(sessionSource, /requestStartedAt|responseReceivedAt - requestStartedAt/);
    assert.match(eventSource, /topic === "war_dibs" \? payload\?\.generatedAt : undefined/);
    assert.match(eventSource, /syncTrustedClock\(eventServerTime, `event:\$\{topic\}`\)/);
    assert.match(sharedTransportSource, /serverTime: state\.clockReady \? trustedNowMs\(\) : null/);
    assert.match(sharedTransportSource, /syncTrustedClock\(payload\.serverTime, "shared-tab"\)/);
    assert.doesNotMatch(sharedTransportSource, /syncTrustedClock\(payload\.generatedAt/);
    assert.match(sharedDataSource, /"shared-live-event", payload\.serverTime/);
    assert.match(socketSource, /const envelopeServerTime = message\?\.serverTime \|\| message\?\.generatedAt/);
    assert.match(socketSource, /payload: message\.payload, serverTime: envelopeServerTime/);
    assert.match(outcomeSource, /core\.activeDibsClaim\(state\.dibs, targetMemberId, trustedNowMs\(\)\)/);
    assert.ok(renderSource.indexOf("state.nowMs = trustedNowMs()") < renderSource.indexOf("const view = sessionView()"));
  });

  it("uses legacy generatedAt clock samples only for Dibs events", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");
    const eventSource = sourceSection(source, "function applyEvent", "function applyFallbackSnapshot");
    const samples = [];
    const context = {
      core: { dibsFeatureEnabled: () => true },
      Date: { now: () => 1_000 },
      state: { lastLiveDataAt: 0, scores: new Map(), retaliation: { attacks: [] } },
      syncTrustedClock: (value) => samples.push(value),
      applyDibsSnapshot() {},
      scheduleRender() {},
      setTimeout() { return 0; },
      result: null,
    };
    runInNewContext(`${eventSource}\napplyEvent("war_dibs", { generatedAt: "2026-08-29T12:00:00.000Z" }, "test"); applyEvent("score", { generatedAt: "2026-08-29T11:00:00.000Z", scores: [] }, "test");`, context);
    assert.deepEqual(samples, ["2026-08-29T12:00:00.000Z", undefined]);
  });

  it("applies full snapshots and ordered deltas", () => {
    const full = core.applyRosterUpdate(undefined, {
      version: 4,
      members: [{ member_id: 1, member_name: "One" }, { member_id: 2, member_name: "Two" }],
    });
    const delta = core.applyRosterUpdate(full, {
      baseVersion: 4,
      version: 5,
      changedMembers: [{ member_id: 2, member_name: "Two updated" }],
      removedMemberIds: [1],
    });
    assert.equal(delta.needsSnapshot, false);
    assert.deepEqual(delta.members, [{ member_id: 2, member_name: "Two updated" }]);
    assert.equal(delta.version, 5);
  });

  it("accepts a matching lightweight freshness event without replacing roster members", () => {
    const current = {
      version: 8,
      members: [{ member_id: 1, member_name: "One" }],
      needsSnapshot: false,
    };
    const refreshed = core.applyRosterUpdate(current, {
      mode: "freshness",
      factionId: "49352",
      version: 8,
      sampledAt: "2026-09-03T10:00:00.000Z",
    });

    assert.equal(refreshed.needsSnapshot, false);
    assert.equal(refreshed.version, 8);
    assert.equal(refreshed.members, current.members);
  });

  it("requests a snapshot for orphaned or mismatched freshness events", () => {
    const orphaned = core.applyRosterUpdate(undefined, { mode: "freshness", version: 8 });
    const mismatched = core.applyRosterUpdate({
      version: 7,
      members: [{ member_id: 1 }],
      needsSnapshot: false,
    }, { mode: "freshness", version: 8 });

    assert.equal(orphaned.needsSnapshot, true);
    assert.equal(orphaned.version, 0);
    assert.equal(mismatched.needsSnapshot, true);
    assert.equal(mismatched.version, 7);
    assert.deepEqual(mismatched.members, [{ member_id: 1 }]);
  });

  it("requests a new snapshot when a delta base is missing", () => {
    const result = core.applyRosterUpdate({ version: 4, members: [] }, {
      baseVersion: 3,
      version: 5,
      changedMembers: [{ member_id: 2 }],
    });
    assert.equal(result.needsSnapshot, true);
    assert.equal(result.version, 4);
  });

  it("requests a snapshot when the first roster message is a delta with a base version", () => {
    const result = core.applyRosterUpdate(undefined, {
      baseVersion: 4,
      version: 5,
      changedMembers: [{ member_id: 2, member_name: "Partial member" }],
    });

    assert.equal(result.needsSnapshot, true);
    assert.equal(result.version, 0);
    assert.deepEqual(result.members, []);
  });

  it("keeps waiting for a full snapshot after a roster version gap", () => {
    const missing = core.applyRosterUpdate({ version: 4, members: [{ member_id: 1 }] }, {
      baseVersion: 5,
      version: 6,
      changedMembers: [{ member_id: 2 }],
    });
    const laterDelta = core.applyRosterUpdate(missing, {
      baseVersion: 4,
      version: 7,
      changedMembers: [{ member_id: 3 }],
    });
    const emptyDelta = core.applyRosterUpdate(missing, { baseVersion: 6, version: 7 });

    assert.equal(laterDelta.needsSnapshot, true);
    assert.equal(emptyDelta.needsSnapshot, true);
    assert.deepEqual(laterDelta.members, [{ member_id: 1 }]);
  });

  it("prefers the score's explicit opponent over extra tracked rosters", () => {
    const scores = new Map([
      ["41309", { factionId: "41309", opponentFactionId: "49352", start: "2026-08-23T12:00:00.000Z" }],
    ]);
    const rosters = new Map([["41309", {}], ["41067", {}], ["49352", {}]]);
    assert.equal(core.inferEnemyFactionId("41309", scores, rosters), "49352");
  });

  it("uses the only enemy roster before an own score snapshot arrives", () => {
    const rosters = new Map([["41309", {}], ["49352", {}]]);
    assert.equal(core.inferEnemyFactionId("41309", new Map(), rosters), "49352");
  });

  it("does not infer an opponent after the own score says the war has ended", () => {
    const scores = new Map([
      ["41309", { factionId: "41309", opponentFactionId: "49352", start: "" }],
      ["49352", { factionId: "49352", opponentFactionId: "41309", start: "" }],
    ]);
    const rosters = new Map([["41309", {}], ["49352", {}]]);
    assert.equal(core.inferEnemyFactionId("41309", scores, rosters), "");
  });

  it("drops expired retaliation opportunities", () => {
    assert.deepEqual(
      core.activeRetaliations({ attacks: [
        { attackerId: 1, expiresAt: 99 },
        { attackerId: 2, expiresAt: 101 },
      ] }, 100).map((attack) => attack.attackerId),
      [2]
    );
  });

  it("requires fresh cached rosters and known normalized same-country Dibs locations", () => {
    const nowMs = 2_000_000_000_000;
    const claimant = {
      member_id: 1,
      status: { userStatus: "Okay" },
      location: { current: "  Cayman   Islands " },
    };
    const target = {
      member_id: 2,
      status: { userStatus: "Abroad" },
      location: { current: "cayman islands" },
    };
    const eligible = core.dibsClaimEligibility({
      claimant,
      target,
      claimantRosterFresh: true,
      targetRosterFresh: true,
    }, nowMs);

    assert.equal(eligible.eligible, true);
    assert.equal(eligible.state, "available");
    assert.equal(eligible.claimantLocation, "Cayman Islands");
    assert.equal(eligible.targetLocation, "cayman islands");
    assert.match(eligible.reason, /Same location/);

    assert.deepEqual(core.dibsClaimEligibility({
      claimant,
      target,
      claimantRosterFresh: false,
      targetRosterFresh: true,
    }, nowMs), {
      eligible: false,
      state: "claimant_roster_stale",
      reason: "Waiting for your faction location data.",
    });
    assert.equal(core.dibsClaimEligibility({
      claimant,
      target,
      claimantRosterFresh: true,
      targetRosterFresh: false,
    }, nowMs).state, "target_roster_stale");
  });

  it("rejects traveling, unknown, and different-location Dibs without failing open on blanks", () => {
    const nowMs = 2_000_000_000_000;
    const settled = (current, status = "Okay") => ({ status: { userStatus: status }, location: { current } });
    const check = (claimant, target) => core.dibsClaimEligibility({
      claimant,
      target,
      claimantRosterFresh: true,
      targetRosterFresh: true,
    }, nowMs);

    assert.equal(check(settled("Torn"), settled("Mexico")).state, "location_mismatch");
    assert.match(check(settled("Torn"), settled("Mexico")).reason, /You are in Torn; target is in Mexico/);
    assert.equal(check(settled(""), settled("Torn")).state, "claimant_location_unknown");
    assert.equal(check(settled("Torn"), settled("")).state, "target_location_unknown");
    assert.equal(check(settled("Torn", "Traveling"), settled("Torn")).state, "claimant_traveling");
    assert.equal(check(settled("Torn"), settled("Torn", "Traveling")).state, "target_traveling");
    assert.equal(check(settled("Torn", "Returning"), settled("Torn")).state, "claimant_traveling");
    assert.equal(check(settled("Torn"), {
      status: { userStatus: "Okay" },
      location: { current: "Torn", destination: "Mexico" },
    }).state, "target_traveling");
    assert.equal(check(settled("Torn"), {
      status: { userStatus: "Okay" },
      location: { current: "Torn", destination: "unknown" },
    }).state, "target_traveling");
    for (const unknown of ["unknown", " none ", "N/A", "-"]) {
      assert.equal(check(settled("Torn"), settled(unknown)).state, "target_location_unknown");
    }
    assert.equal(check(settled("Torn"), settled("Torn", "Abroad")).state, "target_location_unknown");
    assert.equal(check(settled("UAE"), settled("United Arab Emirates")).state, "location_mismatch");
    assert.equal(check(settled("Mexico"), settled("\uFF2D\uFF45\uFF58\uFF49\uFF43\uFF4F")).eligible, true);
    assert.equal(core.dibsEligibility(settled(""), nowMs).eligible, false);
    assert.equal(core.dibsEligibility(settled(""), nowMs).state, "target_location_unknown");
  });

  it("applies the five-minute hospital window after same-location validation", () => {
    const nowMs = 2_000_000_000_000;
    const claimant = { status: { userStatus: "Okay" }, location: { current: "Mexico" } };
    const hospitalTarget = (remainingMs) => ({
      status: { userStatus: "Hospital", untill: nowMs + remainingMs },
      location: { current: "mexico" },
    });
    const check = (remainingMs) => core.dibsClaimEligibility({
      claimant,
      target: hospitalTarget(remainingMs),
      claimantRosterFresh: true,
      targetRosterFresh: true,
    }, nowMs);

    assert.equal(check(5 * 60_000).eligible, true);
    assert.equal(check(5 * 60_000).state, "hospitalized");
    assert.equal(check(5 * 60_000 + 1).eligible, false);
    assert.equal(check(5 * 60_000 + 1).state, "hospital_too_early");
  });

  it("shows only an active Dibs claim for the requested target", () => {
    const nowMs = 2_000_000_000_000;
    const payload = { claims: [
      { targetMemberId: 101, expiresAt: new Date(nowMs + 60_000).toISOString() },
      { targetMemberId: 102, expiresAt: new Date(nowMs - 1).toISOString() },
    ] };
    assert.equal(core.activeDibsClaim(payload, 101, nowMs)?.targetMemberId, 101);
    assert.equal(core.activeDibsClaim(payload, 102, nowMs), undefined);
    assert.equal(core.activeDibsClaim(payload, 103, nowMs), undefined);
  });

  it("orders equal-millisecond Dibs snapshots by source and mutation baseline", () => {
    const initial = {
      generatedAt: "2026-08-29T10:00:00.000Z",
      claims: [{ targetMemberId: 101, claimedByPlayerId: "1" }],
    };
    const websocketClaim = {
      generatedAt: "2026-08-29T10:00:00.000Z",
      claims: [{ targetMemberId: 101, claimedByPlayerId: "2" }],
    };
    const mutationRelease = {
      generatedAt: "2026-08-29T10:00:00.000Z",
      claims: [],
    };
    const baselineSequence = 7;

    const websocketFirst = core.reconcileDibsSnapshot(initial, websocketClaim, {
      source: "websocket",
      applicationSequence: baselineSequence,
    });
    assert.deepEqual(websocketFirst, {
      snapshot: websocketClaim,
      applicationSequence: 8,
      applied: true,
    });
    const delayedMutation = core.reconcileDibsSnapshot(websocketFirst.snapshot, mutationRelease, {
      source: "mutation-response",
      applicationSequence: websocketFirst.applicationSequence,
      baselineSequence,
    });
    assert.strictEqual(delayedMutation.snapshot, websocketClaim);
    assert.equal(delayedMutation.applicationSequence, 8);
    assert.equal(delayedMutation.applied, false);

    const mutationFirst = core.reconcileDibsSnapshot(initial, mutationRelease, {
      source: "mutation-response",
      applicationSequence: baselineSequence,
      baselineSequence,
    });
    assert.equal(mutationFirst.applied, true);
    const websocketLast = core.reconcileDibsSnapshot(mutationFirst.snapshot, websocketClaim, {
      source: "websocket",
      applicationSequence: mutationFirst.applicationSequence,
    });
    assert.strictEqual(websocketLast.snapshot, websocketClaim);
    assert.equal(websocketLast.applicationSequence, 9);
    assert.equal(websocketLast.applied, true);

    for (const source of ["shared-hydration", "fallback-hydration"]) {
      const staleHydration = core.reconcileDibsSnapshot(websocketClaim, mutationRelease, {
        source,
        applicationSequence: 8,
      });
      assert.strictEqual(staleHydration.snapshot, websocketClaim);
      assert.equal(staleHydration.applicationSequence, 8);
      assert.equal(staleHydration.applied, false);
    }

    const identical = {
      claims: [{ claimedByPlayerId: "2", targetMemberId: 101 }],
      generatedAt: "2026-08-29T10:00:00.000Z",
    };
    const identicalResult = core.reconcileDibsSnapshot(websocketClaim, identical, {
      source: "websocket",
      applicationSequence: 8,
    });
    assert.strictEqual(identicalResult.snapshot, websocketClaim);
    assert.equal(identicalResult.applicationSequence, 8);
    assert.equal(identicalResult.applied, false);
  });

  it("keeps Dibs timestamps monotonic across every source", () => {
    const current = {
      generatedAt: "2026-08-29T10:00:02.000Z",
      claims: [{ targetMemberId: 101, claimedByPlayerId: "2" }],
    };
    for (const payload of [
      { generatedAt: "2026-08-29T10:00:01.000Z", claims: [] },
      { claims: [] },
    ]) {
      const result = core.reconcileDibsSnapshot(current, payload, {
        source: "websocket",
        applicationSequence: 4,
      });
      assert.strictEqual(result.snapshot, current);
      assert.equal(result.applicationSequence, 4);
      assert.equal(result.applied, false);
    }
    const newest = { generatedAt: "2026-08-29T10:00:03.000Z", claims: [] };
    assert.deepEqual(core.reconcileDibsSnapshot(current, newest, {
      source: "shared-hydration",
      applicationSequence: 4,
    }), {
      snapshot: newest,
      applicationSequence: 5,
      applied: true,
    });
  });

  it("makes claimed attacks obvious without blocking their links", () => {
    const claim = {
      claimedByPlayerId: "2813921",
      claimedByPlayerName: "SneipLadd",
    };

    assert.deepEqual(core.dibsAttackPresentation(undefined, "2813921", "Attack"), {
      state: "free",
      label: "Attack",
      title: "Attack",
    });
    assert.deepEqual(core.dibsAttackPresentation(claim, "2813921", "Attack"), {
      state: "mine",
      label: "Your Dibs",
      title: "Your Dibs - Attack",
    });
    assert.deepEqual(core.dibsAttackPresentation(claim, "999", "Attack"), {
      state: "taken",
      label: "Dibsed",
      title: "Dibsed by SneipLadd - Attack anyway",
    });
  });

  it("renders another member's Dibs as a solid gray link that stays clickable", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");

    assert.ok(source.includes(".wc-link.dibs-taken { border-color:#a1a1aa; background:#52525b;"));
    assert.ok(source.includes('data-dibs-state="${presentation.state}" href="${escapeHtml(url)}"'));
    assert.ok(source.includes('dibsMarkup(member, view, claim, `action-${item.key}`)'));
    assert.ok(source.includes('attackLinkMarkup(item.url, memberId, item.actionLabel || "Open", view, item.severity === "urgent", claim)'));
  });

  it("lets Dibs details close without a sticky focus state", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");

    assert.ok(source.includes('data-dibs-action="close"'));
    assert.ok(source.includes('document.addEventListener("pointerdown"'));
    assert.ok(source.includes("state.dibsInspectTargetId = 0"));
    assert.ok(!source.includes(".wc-dibs-wrap:focus-within .wc-dibs-tip"));
    assert.ok(!source.includes(".wc-dibs-wrap:hover .wc-dibs-tip"));
  });

  it("defaults Dibs on and honors either faction-level disable switch", () => {
    assert.equal(core.dibsFeatureEnabled(undefined), true);
    assert.equal(core.dibsFeatureEnabled({ enabled: true, dibsEnabled: true }), true);
    assert.equal(core.dibsFeatureEnabled({ enabled: true, dibsEnabled: false }), false);
    assert.equal(core.dibsFeatureEnabled({ enabled: false, dibsEnabled: true }), false);
  });
});

describe("Warbuddy panel state", () => {
  it("preserves disclosures and independent scroll positions across live renders", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");
    const renderSource = compactSource(sourceSection(source, "function render()", "function forgetStoredKey()"));

    assert.ok(source.includes("privacyOpen: false"));
    assert.ok(source.includes('if (privacyDisclosure) state.privacyOpen = privacyDisclosure.open'));
    assert.ok(source.includes('data-section="privacy"${state.privacyOpen ? " open" : ""}'));
    assert.ok(renderSource.includes("nextBody.scrollTop = bodyScrollTop"));
    assert.ok(source.includes("targetListScrollTop: 0"));
    assert.ok(source.includes("state.targetListScrollTop = Number(currentTargetList.scrollTop || 0)"));
    assert.ok(source.includes("nextTargetList.scrollTop = state.targetListScrollTop"));
    assert.ok(source.includes('nextTargetList.addEventListener("scroll"'));
    assert.ok(source.includes("state.privacyOpen = event.currentTarget.open"));
    assert.ok(source.includes("core.isWarbuddyPageUrl(window.location.href)"));
  });

  it("keeps the API key field out of browser login autofill", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");

    assert.ok(source.includes('class="wc-input wc-secret-input"'));
    assert.ok(source.includes('if (!core.dibsFeatureEnabled(state.settings)) return ""'));
    assert.ok(source.includes('type="text"'));
    assert.ok(source.includes('autocomplete="one-time-code"'));
    assert.ok(source.includes('data-1p-ignore'));
    assert.ok(source.includes('data-lpignore="true"'));
    assert.ok(source.includes('data-bwignore="true"'));
    assert.doesNotMatch(source, /data-field="api-key" type="password"/);
  });

  it("keeps authorization headers on Torn PDA's HTTP bridge", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");

    const pdaGet = source.indexOf('window.PDA_httpGet(options.url, options.headers || {})');
    const pdaPost = source.indexOf('window.PDA_httpPost(options.url, options.headers || {}, options.data || "")');

    assert.ok(pdaGet >= 0);
    assert.ok(pdaPost >= 0);
    assert.ok(pdaGet < source.indexOf('typeof GM_xmlhttpRequest === "function"'));
    assert.ok(source.includes('const isTornPda = typeof window.PDA_httpGet === "function" || typeof window.PDA_httpPost === "function"'));
    assert.ok(source.includes('if (isTornPda) {\n        if (!fallbackIsFresh()) state.phase = "connecting";\n        startFallbackPolling();'));
  });

  it("parses nested Torn and top-level gateway errors", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");
    const requestSource = sourceSection(source, "const requestJson", "const getStoredKey");
    const requestError = async (body) => runInNewContext(`${requestSource}\n(async () => {
      try {
        await requestJson({ url: "https://backend.invalid", label: "Warbuddy login" });
      } catch (error) {
        return { message: error.message, status: error.status, code: error.code };
      }
      return null;
    })()`, {
      body,
      REQUEST_TIMEOUT_MS: 15_000,
      normalizeResponse: (value) => value,
      sendRequest(options) {
        options.onload({ status: 404, responseText: JSON.stringify(body) });
      },
      setTimeout() { return 1; },
      clearTimeout() {},
    });

    const gateway = await requestError({ error: "Faction is not managed by this backend", code: "FACTION_NOT_FOUND" });
    assert.deepEqual({ ...gateway }, {
      message: "Faction is not managed by this backend",
      status: 404,
      code: "FACTION_NOT_FOUND",
    });
    const torn = await requestError({ error: { error: "Incorrect key", code: 2 } });
    assert.deepEqual({ ...torn }, { message: "Incorrect key", status: 404, code: 2 });
  });

  it("keeps compatible-mode recovery bounded while restoring missing native surfaces", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");

    assert.ok(source.includes("const FALLBACK_POLL_MS = 2_000"));
    assert.ok(source.includes("const FALLBACK_POLL_MAX_MS = 10_000"));
    assert.ok(source.includes("core.fallbackPollDelayMs({"));
    assert.ok(source.includes("revision=${encodeURIComponent(state.fallbackRevision)}"));
    assert.ok(source.includes("markFallbackSnapshotUnchanged(snapshot)"));
    assert.ok(source.includes("(!isTornPda || !state.fallbackActive) && Date.now() - state.lastRenderAt >= renderInterval"));
    assert.ok(source.includes('state.pageObserver.observe(document.body, { childList: true, subtree: true })'));
    assert.ok(source.includes("if (activeSurfaceMissing()) scheduleRender()"));
    assert.ok(source.includes('document.addEventListener("visibilitychange", syncVisibilityState)'));
    assert.ok(source.includes("cancelAnimationFrame(state.renderFrame)"));
  });

  it("keeps socket updates immediate while throttling idle browser work", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");

    assert.ok(source.includes("const TICKER_INTERVAL_MS = 2_000"));
    assert.ok(source.includes("const IDLE_RENDER_INTERVAL_MS = 10_000"));
    assert.ok(source.includes("const ROUTE_HEARTBEAT_MS = 2_000"));
    assert.ok(source.includes("const renderInterval = hasTimeSensitiveState() ? TICKER_INTERVAL_MS : IDLE_RENDER_INTERVAL_MS"));
    assert.ok(source.includes("const targetView = targetPageMemberId() ? sessionView() : null"));
    assert.ok(source.includes("if (targetView && !targetPageFactionEligible(targetView)) return"));
    assert.ok(source.includes("Date.now() - state.lastRenderAt >= renderInterval"));
    assert.ok(source.includes("setInterval(pollPageActivation, ROUTE_HEARTBEAT_MS)"));
    assert.ok(source.includes("href !== state.lastPageHref || activeSurfaceMissing()"));
    assert.ok(source.includes("panelMarkupCache.get(panel) === panelMarkup && panel.querySelector(\".wc-body\")"));
    assert.ok(source.includes("if (state.integratedDecorationsActive) removeInlineMemberTools()"));
    assert.doesNotMatch(source, /setInterval\(syncPageActivation,\s*1_000\)/);
  });

  it("does not periodically render target pages before faction and war eligibility", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");
    const tickerSource = sourceSection(source, "function startTicker", "function stopTicker");
    const runTick = ({ displayMode = "native", relevant = false, eligible = true, attackTargetId = 0 } = {}) => {
      let tick = null;
      let renders = 0;
      const context = {
        state: {
          ticker: 0,
          nowMs: 0,
          profileTargetId: 42,
          attackTargetId,
          displayMode,
          phase: "paused",
          fallbackActive: false,
          lastRenderAt: 0,
        },
        TICKER_INTERVAL_MS: 2_000,
        IDLE_RENDER_INTERVAL_MS: 10_000,
        isTornPda: false,
        setInterval(callback) { tick = callback; return 1; },
        trustedNowMs() { return 1_000; },
        syncTabBrokerNonce() { return false; },
        syncTabBrokerIdentity() {},
        ensureConnected() {},
        sharedBrokerEnabled() { return false; },
        localSessionNeedsRefresh() { return false; },
        recordScriptCheckIn() {},
        targetPageMemberId() { return Number(attackTargetId || 42); },
        targetPageFactionEligible() { return eligible; },
        targetPageContextRelevant() { return relevant; },
        sessionView() { return {}; },
        hasTimeSensitiveState() { return true; },
        scheduleRender() { renders += 1; },
      };
      runInNewContext(`${tickerSource}\nstartTicker();`, context);
      tick();
      return renders;
    };

    assert.equal(runTick({ displayMode: "native", relevant: false, eligible: false }), 0);
    assert.equal(runTick({ displayMode: "floating", relevant: false, eligible: false }), 0);
    assert.equal(runTick({ attackTargetId: 42, eligible: false }), 0);
    assert.equal(runTick({ displayMode: "native", relevant: true }), 1);
    assert.equal(runTick({ displayMode: "floating", relevant: false }), 1);
  });

  it("keeps urgent fallback polling fast and backs off quiet snapshots", () => {
    assert.equal(core.fallbackPollDelayMs({ urgent: true, unchangedCount: 20 }), 2_000);
    assert.equal(core.fallbackPollDelayMs({ activeWar: true, unchangedCount: 2 }), 2_000);
    assert.equal(core.fallbackPollDelayMs({ activeWar: true, unchangedCount: 3 }), 5_000);
    assert.equal(core.fallbackPollDelayMs({ activeWar: false, unchangedCount: 3 }), 10_000);
    assert.equal(core.fallbackPollDelayMs({ failureCount: 1 }), 4_000);
    assert.equal(core.fallbackPollDelayMs({ failureCount: 4 }), 10_000);
  });

  it("verifies a candidate API key before replacing the stored key", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");
    const connectSource = sourceSection(
      source,
      "async function connectFromInput",
      "function cancelScheduledRender"
    );

    const verificationAt = connectSource.indexOf("await requestCompanionSession(key)");
    const invalidationAt = connectSource.indexOf("invalidateAuthentication()", verificationAt);
    const storageAt = connectSource.indexOf("storage.set(KEY_STORAGE, key)");
    assert.ok(verificationAt >= 0, "candidate key must request a scoped companion session");
    assert.ok(invalidationAt > verificationAt, "verified replacement must invalidate older authentication work");
    assert.ok(storageAt > verificationAt, "candidate key must not be persisted until verification succeeds");
    assert.ok(storageAt > invalidationAt, "older authentication work must be invalidated before key replacement");
    assert.match(compactSource(connectSource), /const previousKey = getStoredKey\(\)/);
  });

  it("clears live war state when authentication moves to another faction", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");
    const applySource = sourceSection(source, "function applyCompanionSession", "function invalidateAuthentication");
    const apply = (previousFactionId, nextFactionId) => {
      let clearCalls = 0;
      const context = {
        state: {
          session: previousFactionId ? { factionId: previousFactionId } : null,
          factionNames: new Map(),
          token: "",
          lastCheckInAt: 1,
          lastCheckInAttemptAt: 1,
          lastCheckInTransport: "old",
          reconnectAttempt: 2,
          authTerminal: true,
          error: "old",
        },
        clearLiveFactionData() { clearCalls += 1; },
        loadTargetGroups() {},
        syncTabBrokerIdentity() {},
        result: null,
      };
      runInNewContext(`${applySource}\napplyCompanionSession({
        factionId: "${nextFactionId}",
        factionName: "Next",
        wsSessionToken: "next-token",
      });
      result = state.session.factionId;`, context);
      return { clearCalls, factionId: context.result };
    };

    assert.deepEqual(apply("41309", "41309"), { clearCalls: 0, factionId: "41309" });
    assert.deepEqual(apply("41309", "49352"), { clearCalls: 1, factionId: "49352" });
    assert.deepEqual(apply("", "49352"), { clearCalls: 0, factionId: "49352" });
  });

  it("stops reconnect loops on terminal authentication errors and exposes key replacement", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");
    const authenticateSource = compactSource(sourceSection(
      source,
      "async function authenticate",
      "function recordScriptCheckIn"
    ));
    const reconnectSource = compactSource(sourceSection(
      source,
      "function scheduleReconnect",
      "function startTicker"
    ));
    const sessionRefreshSource = compactSource(sourceSection(
      source,
      "const localSessionNeedsRefresh",
      "const directSocketIsOpen"
    ));
    const tickerSource = compactSource(sourceSection(source, "function startTicker", "function stopTicker"));
    const renderSource = compactSource(sourceSection(source, "function render()", "function forgetStoredKey"));
    const terminalSource = sourceSection(
      source,
      "const transientTornErrorCodes",
      "const syncTargetDraft"
    );

    assert.match(authenticateSource, /state\.authTerminal = isTerminalAuthenticationError\(error\)/);
    assert.match(authenticateSource, /if \(state\.authTerminal\) \{ state\.keyEditorOpen = true; stopTicker\(\); \}/);
    assert.match(reconnectSource, /!shouldRunOwnedTransport\(\) && !localSessionNeedsRefresh\(\)/);
    assert.match(reconnectSource, /if \(!getStoredKey\(\) \|\| state\.authTerminal\) return/);
    assert.match(reconnectSource, /const canAuthenticate = isForeground\(\)/);
    assert.match(reconnectSource, /if \(!state\.authTerminal\) scheduleReconnect\(\)/);
    assert.match(sessionRefreshSource, /if \(!isForeground\(\)\) return false/);
    assert.match(sessionRefreshSource, /!state\.session \|\| !state\.token/);
    assert.match(sessionRefreshSource, /expiresAt <= trustedNowMs\(\) \+ 30_000/);
    assert.match(tickerSource, /!tabBroker\.isLeader\(\).*tabBroker\.hasLeader\(\).*localSessionNeedsRefresh\(\)/);
    assert.doesNotMatch(tickerSource, /tabBroker\.(?:broadcast|request)/);
    assert.match(renderSource, /const showKeyEditor = !savedKey \|\| state\.keyEditorOpen \|\| state\.authTerminal/);
    assert.match(renderSource, /savedKey \? "Replacement Torn API key" : "Torn API key"/);
    assert.match(renderSource, /savedKey \? "Replace" : "Connect"/);
    const terminalContext = { result: null };
    runInNewContext(`${terminalSource}\nresult = [
      isTerminalAuthenticationError({ status: 404, code: "FACTION_NOT_FOUND" }),
      isTerminalAuthenticationError({ status: 404, code: "FACTION_NOT_MANAGED" }),
      isTerminalAuthenticationError({ status: 404, code: "SOMETHING_ELSE" }),
    ];`, terminalContext);
    assert.deepEqual(Array.from(terminalContext.result), [true, true, false]);
  });

  it("does not replace an API key while the player is entering it", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");

    assert.ok(source.includes('keyDraft: ""'));
    assert.ok(source.includes('if (getStoredKey() && !state.authTerminal) startTicker();\n      else stopTicker();'));
    assert.ok(source.includes('keyInput?.addEventListener("input"'));
    assert.ok(source.includes('state.keyDraft = String(event.currentTarget?.value || "")'));
    assert.ok(source.includes('value="${escapeHtml(state.keyDraft)}"'));
    assert.ok(source.includes('const key = String(input?.value || state.keyDraft || "").trim()'));
  });

  it("keeps live state and named factions compact in the ranked-war strip", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");
    const renderSource = compactSource(sourceSection(source, "function render()", "function forgetStoredKey"));
    const rosterHeaderSource = compactSource(sourceSection(source, "const rosterHeader =", "const panelMarkup ="));

    assert.match(renderSource, /const rosterHeader = `<div class="wc-roster-summary">/);
    assert.match(renderSource, /class="wc-roster-status"/);
    assert.match(renderSource, /class="wc-roster-matchup"/);
    assert.match(renderSource, /\{ side: "Us", faction: ownFactionLabel/);
    assert.match(renderSource, /\{ side: "Them", faction: enemyFactionLabel/);
    assert.match(renderSource, /class="wc-roster-chains"/);
    assert.ok(source.includes("ownFactionName"));
    assert.ok(source.includes("enemyFactionName"));
    assert.ok(source.includes("factionNames: new Map()"));
    assert.doesNotMatch(rosterHeaderSource, /wc-header-status|wc-matchup|wc-chains/);
  });

  it("keeps recovery controls inside Privacy instead of the live panel", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");

    const privacyAt = source.indexOf('<details data-section="privacy"');
    const privacyEnd = source.indexOf("</details>", privacyAt);
    const reconnectAt = source.indexOf('data-action="refresh"', privacyAt);
    const changeKeyAt = source.indexOf('data-action="change-key"', privacyAt);
    const forgetAt = source.indexOf('data-action="forget"', privacyAt);
    assert.ok(privacyAt > 0);
    assert.ok(privacyAt < reconnectAt && reconnectAt < changeKeyAt && changeKeyAt < forgetAt);
    assert.ok(forgetAt < privacyEnd);
    assert.doesNotMatch(source, /data-action="refresh">Refresh/);
  });

  it("records quiet, scoped version check-ins without adding Torn calls", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");
    const checkInSource = sourceSection(source, "function recordScriptCheckIn", "function clearSocketConnectTimer");

    assert.ok(source.includes("const SCRIPT_CHECK_IN_INTERVAL_MS = 10 * 60 * 1000"));
    assert.ok(source.includes('data: JSON.stringify({ tornApiKey: key, scriptVersion: SCRIPT_VERSION })'));
    assert.ok(source.includes('/war-companion/check-in'));
    assert.ok(source.includes('Authorization: `Bearer ${state.token}`'));
    assert.ok(source.includes('data: JSON.stringify({ scriptVersion: SCRIPT_VERSION, transport })'));
    assert.ok(source.includes('if (state.phase === "connected") void recordScriptCheckIn("websocket")'));
    assert.ok(source.includes('if (state.phase === "fallback") void recordScriptCheckIn("compatible")'));
    assert.doesNotMatch(checkInSource, /sharedBrokerEnabled|tabBroker\.isLeader/);
    assert.ok(!source.includes("ownsLiveTransport"));
    assert.ok(!source.includes("sharedTransportLeaderId"));
    assert.ok(source.includes("authEpoch !== state.authEpoch"));
    assert.ok(source.includes("state.checkInPromise === checkInPromise"));
    assert.doesNotMatch(source, /api\.torn\.com[^\n]*check-in/i);
  });

  it("lets the verified player manage only their personal watched targets", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");
    const persistSource = compactSource(sourceSection(
      source,
      "async function persistWatchedTargetIds",
      "async function saveWatchedTargets"
    ));
    const saveSource = compactSource(sourceSection(
      source,
      "async function saveWatchedTargets",
      "async function toggleWatchedTarget"
    ));

    assert.ok(source.includes('data-section="targets"'));
    assert.ok(source.includes('data-action="save-targets"'));
    assert.ok(source.includes('/war-companion/watched-targets'));
    assert.match(persistSource, /const memberIds = normalizeTargetIds\(value\)/);
    assert.match(persistSource, /data: JSON\.stringify\(\{ memberIds \}\)/);
    assert.match(saveSource, /await persistWatchedTargetIds\(state\.targetDraft\)/);
    assert.ok(source.includes('save only your watched-target list'));
    assert.doesNotMatch(source, /faction-configured watched/i);
    assert.doesNotMatch(source, /Personal targets pinned near landing/i);
    assert.doesNotMatch(source, /wc-target-note/);
  });

  it("shares Dibs through the scoped companion session without extra Torn calls", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");
    const tipPositionSource = compactSource(sourceSection(
      source,
      "function positionOpenDibsTip",
      "function render()"
    ));

    assert.ok(source.includes('"war_dibs"'));
    assert.ok(source.includes('/war-companion/dibs'));
    assert.ok(source.includes('JSON.stringify({ action, targetMemberId: memberId })'));
    assert.ok(source.includes('data-dibs-action="claim"') || source.includes('const action = claim || lottery.entry || !canClaim ? "inspect" : "claim"'));
    assert.ok(source.includes('data-dibs-action="release"'));
    assert.ok(source.includes("wc-action-section .wc-dibs-tip"));
    assert.match(source, /\.wc-dibs-tip\s*\{[^}]*position:\s*fixed/);
    assert.match(tipPositionSource, /const viewport = window\.visualViewport/);
    assert.match(tipPositionSource, /tip\.style\.left =/);
    assert.match(tipPositionSource, /tip\.style\.top =/);
    assert.match(source, /\.wc-dibs\s*\{[^}]*width:\s*16px;\s*height:\s*16px/);
    assert.doesNotMatch(source, /api\.torn\.com[^\n]*dibs/i);
  });

  it("uses cached roster locations for immediate Dibs feedback and keeps the server authoritative", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");
    const contextSource = compactSource(sourceSection(source, "function dibsClaimContext", "function syncIntegratedMemberTools"));
    const inlineSource = compactSource(sourceSection(source, "function syncIntegratedMemberTools", "function dibsMarkup"));
    const markupSource = compactSource(sourceSection(source, "function dibsMarkup", "function attackLinkMarkup"));
    const updateSource = compactSource(sourceSection(source, "async function updateDibs", "function actionQueueMarkup"));

    assert.match(contextSource, /view\?\.ownRoster/);
    assert.match(contextSource, /core\.dibsClaimEligibility/);
    assert.match(contextSource, /claimantRosterFresh: rosterIsFresh\(view\?\.ownFactionId\)/);
    assert.match(contextSource, /targetRosterFresh: rosterIsFresh\(view\?\.enemyFactionId\)/);
    assert.doesNotMatch(contextSource, /requestJson|authenticate|setTimeout|setInterval/);
    assert.doesNotMatch(markupSource, /if \(!claim && !eligibility\.eligible\) return/);
    assert.match(markupSource, /const action = claim \|\| lottery\.entry \|\| !canClaim \? "inspect" : "claim"/);
    assert.doesNotMatch(markupSource, /aria-disabled/);
    assert.match(markupSource, /aria-expanded="\$\{open \? "true" : "false"\}"/);
    assert.match(markupSource, /aria-label="\$\{escapeHtml\(busyLabel\)\}"/);
    assert.match(markupSource, /title="\$\{escapeHtml\(label\)\}"/);
    assert.match(markupSource, /Dibs unavailable - \$\{unavailableReason\}/);
    assert.match(inlineSource, /const claimWarning = claim && !claimEligibility\?\.eligible/);
    assert.match(updateSource, /const eligibility = dibsClaimContext\(target, view\)/);
    assert.match(updateSource, /showDibsError\(eligibility\.reason, memberId\)/);
    assert.match(updateSource, /requestJson\(\{/);
  });

  it("reconciles successful Dibs responses and shared state through one monotonic path", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");
    const applySource = compactSource(sourceSection(source, "function applyDibsSnapshot", "function applyEvent"));
    const fallbackSource = compactSource(sourceSection(source, "function applyFallbackSnapshot", "function markFallbackSnapshotUnchanged"));
    const sharedRequestSource = compactSource(sourceSection(source, "function requestSharedState", "function tornPageNowMs"));
    const sharedStateSource = compactSource(sourceSection(source, "function applySharedState", "function handleTabBrokerData"));
    const sharedDataSource = compactSource(sourceSection(source, "function handleTabBrokerData", "function handleTabBrokerRequest"));
    const socketSource = compactSource(sourceSection(source, "function handleSocketMessage", "function scheduleReconnect"));
    const updateSource = compactSource(sourceSection(source, "async function updateDibs", "function actionQueueMarkup"));

    assert.match(applySource, /core\.reconcileDibsSnapshot\(state\.dibs, payload/);
    assert.match(applySource, /applicationSequence: state\.dibsApplicationSequence/);
    assert.match(updateSource, /const expectsSocketSnapshot = socketIsOpen\(\)/);
    assert.match(updateSource, /const dibsMutationBaselineSequence = state\.dibsApplicationSequence/);
    assert.match(updateSource, /const response = await requestJson\(\{/);
    assert.match(updateSource, /source: "mutation-response"/);
    assert.match(updateSource, /baselineSequence: dibsMutationBaselineSequence/);
    assert.doesNotMatch(updateSource, /if \(!expectsSocketSnapshot\) applyDibsSnapshot/);
    assert.match(fallbackSource, /source: "fallback-hydration"/);
    assert.match(sharedStateSource, /source: "shared-hydration"/);
    assert.doesNotMatch(sharedStateSource, /state\.dibs = payload\.dibs/);
    assert.match(sharedDataSource, /applyEvent\(String\(payload\.topic\), payload\.payload, "shared-live-event", payload\.serverTime\)/);
    assert.match(socketSource, /applyEvent\(String\(message\.topic\), message\.payload, "websocket", envelopeServerTime\)/);
    assert.match(sharedRequestSource, /const leaderId = tabBroker\.leaderId\(\)/);
    assert.match(sharedRequestSource, /requestSequence !== state\.sharedStateRequestSequence/);
    assert.match(sharedRequestSource, /tabBroker\?\.leaderId\(\) !== leaderId/);
  });

  it("removes a released Dibs target from personal watch without discarding other draft edits", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");

    assert.ok(source.includes("function applyReleasedTargetWatchState(memberId, response)"));
    assert.ok(source.includes("savedTargetIds().filter((candidate) => candidate !== memberId)"));
    assert.ok(source.includes("normalizeTargetIds(state.targetDraft).filter((candidate) => candidate !== memberId)"));
    assert.ok(source.includes('if (action === "release" && (response.releaseKind === "claim" || (!response.releaseKind && !leavingDraw))) applyReleasedTargetWatchState(memberId, response)'));
  });

  it("does not start the live ticker before a key is submitted", async () => {
    const page = await bootUserscript("https://www.torn.com/factions.php?step=your&type=1", {
      visibilityState: "visible",
    });

    assert.equal(page.intervalCount(), 1, "only the faction-route watcher should be running");
  });

  it("persists only the opt-in layout while keeping collapse, drag, and position obsolete", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");
    const modeSource = compactSource(sourceSection(source, "function setDisplayMode", "async function getProfileWithKey"));

    assert.ok(source.includes('[KEY_STORAGE]: "lads_war_companion_api_key"'));
    assert.ok(source.includes('storage.set(key, legacyValue)'));
    assert.equal(core.normalizeDisplayMode(undefined), "native");
    assert.equal(core.normalizeDisplayMode("unexpected"), "native");
    assert.equal(core.normalizeDisplayMode("integrated"), "native", "the old integrated value migrates to the native default");
    assert.equal(core.normalizeDisplayMode("native"), "native");
    assert.equal(core.normalizeDisplayMode("FLOATING"), "floating");
    assert.ok(source.includes('const DISPLAY_MODE_STORAGE = "warbuddy_display_mode"'));
    assert.match(source, /displayMode: core\.normalizeDisplayMode\(storage\.get\(DISPLAY_MODE_STORAGE, ""\)\)/);
    assert.match(modeSource, /storage\.set\(DISPLAY_MODE_STORAGE, nextMode\)/);
    assert.doesNotMatch(source, /const (?:POSITION|COLLAPSED)_STORAGE/);
    assert.doesNotMatch(source, /state\.(?:collapsed|dragging)/);
    assert.doesNotMatch(source, /function (?:setPanelPosition|attachPanelDragHandler|resetPanelPosition)/);
    assert.doesNotMatch(source, /data-action="collapse"|Warbuddy: reset position/);
  });

  it("migrates existing local settings to faction-neutral storage keys", async () => {
    const page = await bootUserscript("https://www.torn.com/factions.php?step=your&type=1", {
      storedValues: {
        lads_war_companion_api_key: "legacy-key",
      },
    });

    assert.equal(page.storageValues.get("warbuddy_api_key"), "legacy-key");
    assert.equal(page.storageValues.has("lads_war_companion_api_key"), false);
  });

  it("keeps the socket alive while a visible page briefly loses focus", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");

    assert.doesNotMatch(source, /const isForeground = \(\) =>[^;]*document\.hasFocus/s);
    assert.doesNotMatch(source, /addEventListener\("blur", syncForegroundState\)/);
    assert.ok(source.includes('window.addEventListener("online", syncForegroundState)'));
    assert.ok(source.includes('window.addEventListener("offline", syncForegroundState)'));
    assert.doesNotMatch(source, /state\.error = "Live connection failed"/);
  });

  it("recovers a socket handshake failure without flashing a transport error", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");

    assert.ok(source.includes("const SOCKET_CONNECT_TIMEOUT_MS = 15_000"));
    assert.ok(source.includes("socketConnectTimer: 0"));
    assert.ok(source.includes('"Handshake timed out"'));
    assert.ok(source.includes("state.socketConnectTimer = 0"));
    assert.doesNotMatch(source, /socket\.readyState !== WebSocket\.CONNECTING\) return/);
    assert.ok(source.includes('"Handshake rejected"'));
    assert.doesNotMatch(source, /Live connection was rejected\. Retrying automatically\./);
    assert.ok(source.includes('state.error = "";\n    state.phase = fallbackIsFresh()'));
    assert.ok(source.includes('if (state.phase === "error" && state.error)'));
    assert.ok(source.includes("recoverFailedSocket("));
    assert.ok(source.includes("scheduleReconnect();"));
  });

  it("falls back to a scoped HTTP snapshot when native WebSockets are rejected", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");

    assert.ok(source.includes("const FALLBACK_POLL_MS = 2_000"));
    assert.ok(source.includes("const FALLBACK_SOCKET_RETRY_MS = 60_000"));
    assert.ok(source.includes("/war-companion/snapshot?timestamp="));
    assert.ok(source.includes("headers: { Authorization: `Bearer ${state.token}` }"));
    assert.ok(source.includes("startFallbackPolling();"));
    assert.ok(source.includes("fallbackFailureCount: 0"));
    assert.ok(source.includes("state.fallbackFailureCount >= 3"));
    assert.ok(source.includes('if (state.phase === "fallback") return { label: "Live (compatible)", tone: "live" };'));
    assert.doesNotMatch(source, /war-companion\/snapshot[^\n]*tornApiKey/);
  });

  it("ignores delayed close events from sockets that were already replaced", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");

    assert.ok(source.includes('socket.addEventListener("close", (event) => {\n        if (socket !== state.socket) return;'));
    assert.ok(source.includes('socket.addEventListener("message", (event) => {\n        if (socket !== state.socket) return;'));
    assert.doesNotMatch(source, /socketClosing/);
  });

  it("keeps native surfaces and opted-in floating pages live without a collapse-state gate", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");
    const statusSource = compactSource(sourceSection(source, "const statusView", "function dibsMarkup"));
    const surfaceSource = compactSource(sourceSection(source, "const isRosterModePage", "const backendUrl"));

    assert.ok(source.includes("const isForeground = () => state.active\n    && hasWarbuddySurface()\n    && document.visibilityState !== \"hidden\""));
    assert.match(surfaceSource, /const hasWarbuddySurface = \(\) => !!targetPageMemberId\(\) \|\| isRosterBootstrapPage\(\) \|\| state\.displayMode === "floating"/);
    assert.doesNotMatch(source, /state\.collapsed|COLLAPSED_STORAGE/);
    assert.doesNotMatch(statusSource, /collapsed|Expand and resume|Collapse and pause/);
    assert.match(statusSource, /if \(document\.visibilityState === "hidden"\) return \{ label: "Paused while hidden", tone: "" \}/);
  });
});

describe("Warbuddy userscript source contracts", () => {
  it("uses native surfaces by default, reuses the full controls inline, and keeps floating optional", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");
    const modeSource = compactSource(sourceSection(source, "function setDisplayMode", "async function getProfileWithKey"));
    const mountSource = compactSource(sourceSection(source, "function resolvePanelMount", "async function getProfileWithKey"));
    const inlineSource = compactSource(sourceSection(source, "function syncIntegratedMemberTools", "function dibsMarkup"));
    const renderSource = compactSource(sourceSection(source, "function render()", "function forgetStoredKey"));

    assert.equal(core.normalizeDisplayMode(undefined), "native");
    assert.equal(core.normalizeDisplayMode("floating"), "floating");
    assert.match(source, /displayMode: core\.normalizeDisplayMode\(storage\.get\(DISPLAY_MODE_STORAGE, ""\)\)/);
    assert.match(modeSource, /const nextMode = core\.normalizeDisplayMode\(value\)/);
    assert.match(modeSource, /storage\.set\(DISPLAY_MODE_STORAGE, nextMode\)/);
    assert.match(modeSource, /if \(nextMode === "floating"\) \{ removeIntegratedMount\(true\); \} else \{ document\.getElementById\(PANEL_ID\)\?\.remove\(\); removeIntegratedMount\(false\); \} scheduleRender\(\); syncForegroundState\(\)/);
    assert.doesNotMatch(modeSource, /new WebSocket|connectSocket|startFallbackPolling|setInterval|requestJson/);
    assert.match(mountSource, /if \(state\.displayMode === "floating"\) \{ removeIntegratedMount\(true\); return \{ mount: document\.body, placement: "floating", fallback: false \}/);
    assert.match(source, /const isRosterBootstrapPage = \(\) => core\.isRankedWarPageUrl\(window\.location\.href\)/);
    assert.match(source, /if \(core\.isOwnRankedWarPageUrl\(window\.location\.href, ownFactionId\)\) return true/);
    assert.match(source, /if \(!view \|\| !targetPageFactionEligible\(view\)\) return false/);
    assert.match(source, /core\.rankedWarPageFactionId\(window\.location\.href\).*Number\(view\.enemyFactionId \|\| 0\)/);
    assert.doesNotMatch(mountSource, /isRosterModePage|rankedWarBoardForView|createRankedWarHost|placement: "inline"/);
    assert.match(mountSource, /return \{ mount: null, placement: "none", fallback: false \}/);
    assert.match(inlineSource, /isRosterModePage\(view\)/);
    assert.doesNotMatch(inlineSource, /state\.displayMode/, "ranked-row Retal and Dibs indicators stay native in both layouts");
    assert.match(renderSource, /const targetPage = !!targetPageMemberId\(\)/);
    assert.match(renderSource, /if \(targetPage\) syncTargetPageContext\(view\)/);
    assert.match(renderSource, /if \(state\.displayMode !== "floating"\)/);
    assert.match(renderSource, /const rosterContextReady = syncNativeRosterContext\(view\)/);
    assert.match(renderSource, /syncIntegratedMemberTools\(view\)/);
    assert.match(renderSource, /document\.querySelector\?\.\(`#\$\{ROSTER_CONTEXT_ID\} #\$\{INTEGRATED_HOST_ID\}`\)/);
    assert.match(renderSource, /mountState = \{ mount: inlineMount, placement: "accordion", fallback: false \}/);
    assert.ok(renderSource.indexOf('if (state.displayMode !== "floating")') < renderSource.indexOf("let panel = document.getElementById(PANEL_ID)"));
    assert.match(renderSource, /const inlineAccordion = mountState\.placement === "accordion"/);
    assert.match(renderSource, /panel\.classList\.toggle\("wc-inline-accordion", inlineAccordion\)/);
    assert.match(renderSource, /const panelMarkup = `\$\{inlineAccordion \? "" : rosterMode \? rosterHeader : standardHeader\}<div class="wc-body">\$\{panelBody\}<\/div>`/);
    assert.match(renderSource, /\[ \["native", "Native \(default\)"\], \["floating", "Floating"\], \]/);
    assert.match(source, /registerMenuCommand\("Warbuddy: use native layout", \(\) => setDisplayMode\("native"\)\)/);
    assert.match(source, /registerMenuCommand\("Warbuddy: use floating panel", \(\) => setDisplayMode\("floating"\)\)/);
  });

  it("matches only ranked-war enemy profile links for integrated row actions", () => {
    assert.equal(core.isRankedWarPageUrl("https://www.torn.com/factions.php?step=your&type=1#/war/rank"), true);
    assert.equal(core.isOwnRankedWarPageUrl("https://www.torn.com/factions.php?step=your&type=1#/war/rank", 399), true);
    assert.equal(core.isOwnRankedWarPageUrl("https://www.torn.com/factions.php?step=profile&ID=399#/war/rank", 399), true);
    assert.equal(core.isOwnRankedWarPageUrl("https://www.torn.com/factions.php?step=profile&ID=400#/war/rank", 399), false);
    assert.equal(core.isOwnRankedWarPageUrl("https://www.torn.com/factions.php?step=profile&ID=399#/war/rank"), false);
    assert.equal(core.isOwnRankedWarPageUrl("https://www.torn.com/factions.php#/war/rank", 399), false);
    assert.equal(core.isRankedWarPageUrl("https://www.torn.com/factions.php?step=your&type=1#/tab=armoury"), false);
    assert.equal(core.isRankedWarPageUrl("https://example.com/factions.php#/war/rank"), false);
    assert.equal(core.rankedWarPageFactionId("https://www.torn.com/factions.php?step=profile&ID=400#/war/rank"), 400);
    assert.equal(core.rankedWarPageFactionId("https://www.torn.com/factions.php?step=your&type=1#/war/rank"), 0);
    assert.equal(core.rankedWarPageFactionId("https://www.torn.com/factions.php?step=profile&ID=400#/tab=armoury"), 0);
    assert.equal(core.profileMemberIdFromUrl("https://www.torn.com/profiles.php?XID=3601225"), 3601225);
    assert.equal(core.profileMemberIdFromUrl("/profiles.php?xid=3601225"), 3601225);
    assert.equal(core.profileMemberIdFromUrl("https://example.com/profiles.php?XID=3601225"), 0);
    assert.equal(core.profileMemberIdFromUrl("https://www.torn.com/factions.php?ID=3601225"), 0);
  });

  it("bootstraps ranked-war transport broadly but renders only the own or confirmed opponent roster", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");
    const routeSource = sourceSection(source, "const isRosterBootstrapPage", "const targetPageMemberId");
    const evaluate = (href, view, eligible = true) => {
      const context = {
        result: null,
        view,
        window: { location: { href } },
        state: { session: { factionId: "399" } },
        core: {
          isRankedWarPageUrl: core.isRankedWarPageUrl,
          isOwnRankedWarPageUrl: core.isOwnRankedWarPageUrl,
          rankedWarPageFactionId: core.rankedWarPageFactionId,
        },
        targetPageFactionEligible() { return eligible; },
      };
      runInNewContext(
        `${routeSource}\nresult = { bootstrap: isRosterBootstrapPage(), roster: isRosterModePage(view) };`,
        context
      );
      return context.result;
    };
    const activeView = { ownFactionId: "399", enemyFactionId: "400" };
    const opponentUrl = "https://www.torn.com/factions.php?step=profile&ID=400#/war/rank";

    assert.equal(evaluate(opponentUrl, activeView).bootstrap, true);
    assert.equal(evaluate(opponentUrl, activeView).roster, true);
    assert.equal(evaluate(opponentUrl, activeView, false).roster, false);
    assert.equal(evaluate("https://www.torn.com/factions.php?step=profile&ID=401#/war/rank", activeView).roster, false);
    assert.equal(evaluate("https://www.torn.com/factions.php?step=your&type=1#/war/rank", null).roster, true);
  });

  it("matches each enemy roster row to that member's own Attack control", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");
    const resolverSource = sourceSection(
      source,
      "function rankedWarAttackLinkForMember",
      "function rankedWarOwnRowForAnchor"
    );
    const profileLink = (memberId) => ({
      href: `https://www.torn.com/profiles.php?XID=${memberId}`,
      getAttribute() { return this.href; },
      parentElement: null,
    });
    const attackLink = (memberId) => ({
      href: `https://www.torn.com/page.php?sid=attack&user2ID=${memberId}`,
      getAttribute() { return this.href; },
    });
    const element = ({ profiles = [], attacks = [], parentElement = null } = {}) => ({
      parentElement,
      querySelectorAll(selector) {
        if (selector.includes("profiles.php")) return profiles;
        if (selector.includes("sid=attack")) return attacks;
        return [];
      },
    });
    const resolve = ({ targetId = 42, attackIds = [42], extraProfiles = [] } = {}) => {
      const anchor = profileLink(targetId);
      const attacks = attackIds.map(attackLink);
      const body = {};
      const row = element({ profiles: [anchor, ...extraProfiles], attacks, parentElement: body });
      const label = element({ profiles: [anchor], parentElement: row });
      anchor.parentElement = label;
      const context = {
        result: null,
        link: null,
        anchor,
        row,
        document: { body, documentElement: {} },
        core: {
          profileMemberIdFromUrl(value) {
            return Number(new URL(value, "https://www.torn.com/").searchParams.get("XID") || 0);
          },
          attackPageTargetId(value) {
            return Number(new URL(value, "https://www.torn.com/").searchParams.get("user2ID") || 0);
          },
        },
      };
      runInNewContext(
        `${resolverSource}\nresult = rankedWarRowForAnchor(anchor); link = rankedWarAttackLinkForMember(row, ${targetId});`,
        context
      );
      context.label = label;
      return context;
    };

    const matched = resolve({ attackIds: [99, 42] });
    assert.equal(matched.result, matched.row);
    assert.equal(core.attackPageTargetId(matched.link.href), 42);

    const wrongAttack = resolve({ attackIds: [99] });
    assert.equal(wrongAttack.result, wrongAttack.row);
    assert.equal(wrongAttack.link, null);

    const duplicateTargetProfiles = resolve({
      attackIds: [42],
      extraProfiles: [profileLink(42)],
    });
    assert.equal(duplicateTargetProfiles.result, duplicateTargetProfiles.row);

    const mixedProfiles = resolve({ attackIds: [42], extraProfiles: [profileLink(99)] });
    assert.equal(mixedProfiles.result, mixedProfiles.label);
  });

  it("resolves the exact own-war enemy roster from backend IDs without sidebar or common-board dependence", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");
    const boardSource = sourceSection(
      source,
      "function hasRankedWarRosterSignature",
      "function markRankedWarBoard"
    );
    const evaluate = (enemyMatches = 2, withRosterHeader = true) => {
      const enemyRoster = [{ member_id: 3 }, { member_id: 4 }];
      const node = ({ tagName = "DIV", excluded = false, text = "" } = {}) => ({
        tagName,
        excluded,
        textContent: text,
        parentElement: null,
        previousElementSibling: null,
        children: [],
        isConnected: true,
        contains(target) {
          for (let current = target; current; current = current.parentElement) {
            if (current === this) return true;
          }
          return false;
        },
        closest(selector) {
          for (let current = this; current; current = current.parentElement) {
            if (current.excluded && /chat|sidebar|complementary|aside/i.test(selector)) return current;
          }
          return null;
        },
        querySelectorAll(selector) {
          const matches = [];
          const visit = (current) => {
            for (const child of current.children || []) {
              if (selector.includes("profiles.php") && String(child.href || "").includes("profiles.php")) matches.push(child);
              visit(child);
            }
          };
          visit(this);
          return matches;
        },
      });
      const append = (parent, ...children) => {
        parent.children = children;
        children.forEach((child, index) => {
          child.parentElement = parent;
          child.previousElementSibling = children[index - 1] || null;
        });
      };
      const anchor = (id) => ({
        ...node({ tagName: "A" }),
        href: `https://www.torn.com/profiles.php?XID=${id}`,
        getAttribute() { return this.href; },
        row: null,
      });
      const rowWith = (id) => {
        const row = node();
        const link = anchor(id);
        link.row = row;
        append(row, link);
        return { row, link };
      };
      const body = node({ tagName: "BODY" });
      const documentElement = node({ tagName: "HTML" });
      const main = node({ tagName: "MAIN" });
      const ownCluster = node();
      const enemyCluster = node();
      const enemyHeader = node({
        text: withRosterHeader ? "Members Level Est Score Status" : "Targets Online Attack",
      });
      const sidebar = node({ tagName: "ASIDE", excluded: true });
      const ownRows = [rowWith(1), rowWith(2)];
      const enemyRows = [rowWith(3), rowWith(4)].slice(0, enemyMatches);
      const duplicate = rowWith(3);
      append(sidebar, duplicate.row);
      append(ownCluster, ...ownRows.map(({ row }) => row));
      append(enemyCluster, ...enemyRows.map(({ row }) => row));
      append(main, ownCluster, enemyHeader, enemyCluster);
      append(body, sidebar, main);
      const allAnchors = [duplicate.link, ...ownRows.map(({ link }) => link), ...enemyRows.map(({ link }) => link)];
      const context = {
        result: null,
        view: { enemyRoster },
        PANEL_ID: "warbuddy-panel",
        INTEGRATED_HOST_ID: "warbuddy-integrated-host",
        TARGET_CONTEXT_ID: "warbuddy-target-context",
        INLINE_TOOLS_CLASS: "warbuddy-inline-tools",
        ROSTER_ACTIONS_CLASS: "warbuddy-roster-actions",
        document: {
          body,
          documentElement,
          querySelector() { return main; },
          querySelectorAll(selector) { return selector.includes("profiles.php") ? allAnchors : []; },
        },
        core: {
          profileMemberIdFromUrl(value) {
            return Number(new URL(value, "https://www.torn.com/").searchParams.get("XID") || 0);
          },
        },
        rankedWarRowForAnchor(profileAnchor) { return profileAnchor?.row || null; },
      };
      runInNewContext(`${boardSource}\nresult = rankedWarBoardForView(view);`, context);
      return { result: context.result, enemyCluster, sidebar };
    };

    const verified = evaluate(2);
    assert.equal(verified.result, verified.enemyCluster);
    assert.notEqual(verified.result, verified.sidebar);
    assert.equal(evaluate(1).result, null);
    assert.equal(evaluate(2, false).result, null, "an in-main two-target attack widget is not a roster");
    assert.match(boardSource, /const mainScope = document\.querySelector\?\.\("#mainContainer, main, \[role='main'\]"\)/);
    assert.match(boardSource, /\[class\*='chat' i\]/);
    assert.match(boardSource, /\[class\*='sidebar' i\]/);
    assert.match(boardSource, /const requiredMatches = Math\.min\(2, memberIds\.size\)/);
    assert.match(boardSource, /function hasRankedWarRosterSignature\(root\)/);
    assert.match(boardSource, /\/\\bmembers\?\\b\/i\.test\(text\)/);
    assert.match(boardSource, /\/\\bstatus\\b\/i\.test\(text\)/);
    assert.match(boardSource, /\/\\b\(\?:level\|est\|score\)\\b\/i\.test\(text\)/);
    assert.match(boardSource, /if \(!hasRankedWarRosterSignature\(root\)\) continue/);
    assert.match(boardSource, /const profileIdLimit = Math\.min/);
    assert.match(boardSource, /const profileLinkLimit = Math\.min/);
    assert.match(boardSource, /return rankedWarRosterCluster\(view\?\.enemyRoster, rankedWarRowForAnchor\)/);
    assert.doesNotMatch(boardSource, /lowestCommonAncestor\(ownRow, enemyRow\)|requiredOwnMatches|requiredEnemyMatches/);
  });

  it("restores native no-Attack roster tools from a bounded backend-matched cluster", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");
    const rowSource = sourceSection(
      source,
      "function rankedWarAttackLinkForMember",
      "function rankedWarOwnRowForAnchor"
    );
    const clusterSource = sourceSection(
      source,
      "function rankedWarUnsignedRosterCluster",
      "function markRankedWarBoard"
    );
    const ensureSource = sourceSection(
      source,
      "function ensureInlineMemberTools",
      "function syncIntegratedMemberTools"
    );
    const createdTags = [];
    const element = ({ text = "", image = false, excluded = false } = {}) => ({
      textContent: text,
      image,
      excluded,
      className: "",
      dataset: {},
      isConnected: true,
      parentElement: null,
      children: [],
      contains(target) {
        for (let current = target; current; current = current.parentElement) {
          if (current === this) return true;
        }
        return false;
      },
      closest() {
        for (let current = this; current; current = current.parentElement) {
          if (current.excluded) return current;
        }
        return null;
      },
      querySelector(selector) {
        if (/img|picture|svg/.test(selector) && this.image) return {};
        return this.querySelectorAll(selector)[0] || null;
      },
      querySelectorAll(selector) {
        const matches = [];
        const visit = (current) => {
          for (const child of current.children || []) {
            if (selector.includes("profiles.php") && String(child.href || "").includes("profiles.php")) matches.push(child);
            if (selector.includes("warbuddy-inline-tools") && String(child.className || "").includes("warbuddy-inline-tools")) matches.push(child);
            visit(child);
          }
        };
        visit(this);
        return matches;
      },
      addEventListener() {},
    });
    const append = (parent, ...children) => {
      parent.children = children;
      children.forEach((child) => { child.parentElement = parent; });
    };
    const profile = (id, options = {}) => {
      const link = element(options);
      link.href = "https://www.torn.com/profiles.php?XID=" + id;
      link.getAttribute = (name) => name === "href" ? link.href : "";
      link.insertAdjacentElement = (_position, child) => {
        const siblings = link.parentElement.children;
        siblings.splice(siblings.indexOf(link) + 1, 0, child);
        child.parentElement = link.parentElement;
      };
      return link;
    };
    const memberRow = (id, duplicate = false) => {
      const row = element();
      const cell = element();
      const avatar = duplicate ? profile(id, { image: true }) : null;
      const name = profile(id, { text: "Member " + id });
      append(cell, ...[avatar, name].filter(Boolean));
      append(row, cell);
      return { row, avatar, name };
    };
    const evaluate = (withRealRoster) => {
      const body = element();
      const html = element();
      const main = element();
      const roster = element();
      const rows = [memberRow(3, true), memberRow(4), memberRow(5)];
      append(roster, ...rows.map(({ row }) => row));
      const decoy = element();
      append(decoy, memberRow(7).row, memberRow(8).row);
      const mixed = element();
      append(mixed, profile(6, { text: "Member 6" }), profile(99, { text: "Other" }));
      const sidebar = element({ excluded: true });
      append(sidebar, memberRow(6).row);
      append(main, ...[withRealRoster ? roster : null, decoy, mixed, sidebar].filter(Boolean));
      append(body, main);
      const view = { enemyRoster: [3, 4, 5, 6, 7, 8].map((member_id) => ({ member_id })) };
      const context = {
        result: null,
        entries: [],
        view,
        PANEL_ID: "warbuddy-panel",
        INTEGRATED_HOST_ID: "warbuddy-integrated-host",
        TARGET_CONTEXT_ID: "warbuddy-target-context",
        INLINE_TOOLS_CLASS: "warbuddy-inline-tools",
        ROSTER_ACTIONS_CLASS: "warbuddy-roster-actions",
        document: {
          body,
          documentElement: html,
          querySelector() { return main; },
          createElement(tag) {
            createdTags.push(tag);
            return element();
          },
        },
        core: {
          profileMemberIdFromUrl(value) {
            return Number(new URL(value, "https://www.torn.com/").searchParams.get("XID") || 0);
          },
          attackPageTargetId() { return 0; },
        },
        handleInlineToolAction() {},
      };
      runInNewContext(
        rowSource + "\n" + clusterSource + "\n" + ensureSource
          + "\nresult = rankedWarUnsignedRosterCluster(view.enemyRoster);"
          + "\nentries = rankedWarEnemyRowEntries(view.enemyRoster, result);"
          + "\nentries.forEach(({ anchor, memberId }) => ensureInlineMemberTools(anchor, memberId));",
        context
      );
      return { ...context, roster, rows };
    };

    const restored = evaluate(true);
    assert.equal(core.isOwnRankedWarPageUrl(
      "https://www.torn.com/factions.php?step=your&type=1#/war/rank",
      399
    ), true);
    assert.equal(restored.result, restored.roster);
    assert.deepEqual(Array.from(restored.entries, ({ memberId }) => memberId), [3, 4, 5]);
    assert.equal(restored.entries[0].anchor, restored.rows[0].name);
    assert.equal(restored.rows[0].name.parentElement.children[2].className, "warbuddy-inline-tools");
    assert.ok(createdTags.length >= 3 && createdTags.every((tag) => tag === "span"));

    const decoyOnly = evaluate(false);
    assert.equal(decoyOnly.result, null);
    assert.deepEqual(Array.from(decoyOnly.entries), []);
  });

  it("restores missing target and ranked-war native surfaces", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");
    const missingSource = compactSource(sourceSection(source, "function activeSurfaceMissing", "function startPageObserver"));
    const observerSource = compactSource(sourceSection(source, "function startPageObserver", "function pollPageActivation"));
    const heartbeatSource = compactSource(sourceSection(source, "function pollPageActivation", "function syncPageActivation"));

    assert.match(missingSource, /const floatingPanelMissing = state\.displayMode === "floating" && !document\.getElementById\(PANEL_ID\)/);
    assert.match(missingSource, /if \(targetPageMemberId\(\)\) \{ const context = document\.getElementById\(TARGET_CONTEXT_ID\); if \(!targetPageFactionEligible\(view\)\) return !!context \|\| !!document\.getElementById\(PANEL_ID\); if \(!targetPageContextRelevant\(view\)\) return !!context \|\| floatingPanelMissing; const mountPoint = targetContextMountPoint\(\)/);
    assert.match(missingSource, /!context \|\| !mountPoint\?\.parent \|\| context\.parentNode !== mountPoint\.parent/);
    assert.match(missingSource, /Number\(context\.dataset\?\.memberId \|\| 0\) !== targetPageMemberId\(\)/);
    assert.match(missingSource, /!context\.querySelector\?\.\("\.wc-native-brand"\) \|\| floatingPanelMissing/);
    assert.match(missingSource, /if \(!isRosterModePage\(view\)\) return floatingPanelMissing/);
    assert.match(missingSource, /if \(state\.displayMode === "floating"\) return floatingPanelMissing/);
    assert.match(missingSource, /const rosterContext = document\.getElementById\(ROSTER_CONTEXT_ID\)/);
    assert.match(missingSource, /if \(!targetPageFactionEligible\(view\)\) return !!rosterContext/);
    assert.match(missingSource, /const rosterMountPoint = rankedWarRosterContextMountPoint\(\)/);
    assert.match(missingSource, /String\(rosterContext\.tagName \|\| ""\)\.toUpperCase\(\) !== "DETAILS"/);
    assert.match(missingSource, /!rosterMountPoint\?\.parent \|\| rosterContext\.parentNode !== rosterMountPoint\.parent/);
    assert.match(missingSource, /const signedBoard = rankedWarBoardForView\(view\)/);
    assert.match(missingSource, /: rankedWarUnsignedRosterCluster\(view\.enemyRoster\)/);
    assert.doesNotMatch(missingSource, /if \(!document\.getElementById\(PANEL_ID\)\) return true/);
    assert.match(missingSource, /const entries = rankedWarEnemyRowEntries\(view\.enemyRoster, board\)/);
    assert.match(missingSource, /if \(!entries\.length\) return true/);
    assert.match(missingSource, /entries\.some\(\(\{ anchor, memberId, row \}\) =>/);
    assert.match(missingSource, /const attackLink = rankedWarAttackLinkForMember\(row, memberId\)/);
    assert.doesNotMatch(missingSource, /const anchors = enemyProfileAnchors\(view\)/);
    assert.match(missingSource, /const dibsControlMissing = state\.rosterDibsButtons/);
    assert.match(missingSource, /!rosterActions\?\.querySelector\?\.\("\.wc-dibs"\)/);
    assert.match(missingSource, /return !tools \|\| !rosterActions \|\| dibsControlMissing/);
    assert.match(observerSource, /if \(window\.location\.href !== state\.lastPageHref\) \{ syncPageActivation\(\); return; \}/);
    assert.match(observerSource, /const outsideWarbuddy = mutations\.some/);
    assert.match(observerSource, /#\$\{ROSTER_CONTEXT_ID\}/);
    assert.match(observerSource, /if \(!outsideWarbuddy\) return/);
    assert.match(observerSource, /if \(activeSurfaceMissing\(\)\) scheduleRender\(\)/);
    assert.match(observerSource, /observe\(document\.body, \{ childList: true, subtree: true \}\)/);
    assert.match(heartbeatSource, /href !== state\.lastPageHref \|\| activeSurfaceMissing\(\)/);
  });

  it("requires a bounded semantic enemy-roster cluster before decorating native ranked-war rows", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");
    const rowSource = compactSource(sourceSection(
      source,
      "function lowestCommonAncestor",
      "function resolvePanelMount"
    ));
    const mountSource = compactSource(sourceSection(source, "function resolvePanelMount", "async function getProfileWithKey"));
    const inlineSource = compactSource(sourceSection(source, "function syncIntegratedMemberTools", "function dibsMarkup"));
    const styleSource = compactSource(sourceSection(source, "addStyle(`", "const normalizeResponse"));
    const wrapperRoot = compactSource(styleSource.match(/#\$\{INTEGRATED_WRAPPER_ID\} \{([^}]*)\}/)?.[1]);

    assert.match(source, /const SAFE_INTEGRATED_PARENT_DISPLAYS = new Set\(\["block", "flow-root", "list-item"\]\)/);
    assert.match(rowSource, /function hasRankedWarRosterSignature\(root\)/);
    assert.match(rowSource, /function rankedWarRosterCluster\(roster, rowForAnchor = rankedWarRowForAnchor\)/);
    assert.match(rowSource, /function rankedWarBoardForView\(view\)/);
    assert.match(rowSource, /return rankedWarRosterCluster\(view\?\.enemyRoster, rankedWarRowForAnchor\)/);
    assert.match(rowSource, /if \(candidate === document\.body \|\| candidate === document\.documentElement\) break/);
    assert.match(rowSource, /if \(candidate === mainScope\) break/);
    assert.match(rowSource, /if \(!hasRankedWarRosterSignature\(root\)\) continue/);
    assert.match(rowSource, /profileIds\.size > profileIdLimit/);
    assert.match(rowSource, /profileLinks\.length > profileLinkLimit/);
    assert.doesNotMatch(rowSource, /lowestCommonAncestor\(ownRow, enemyRow\)|requiredOwnMatches|requiredEnemyMatches/);
    assert.match(rowSource, /function markRankedWarBoard\(board\)/);
    assert.match(rowSource, /board && markedBoards\.length === 1 && markedBoards\[0\] === board/);
    assert.match(rowSource, /board\.dataset\.warbuddyRosterBoard = "1"/);
    assert.match(rowSource, /function rankedWarSafeMountPoint\(parent, before, wrapper = null\)/);
    assert.match(rowSource, /SAFE_INTEGRATED_PARENT_DISPLAYS\.has\(display\)/);
    assert.match(rowSource, /mountBefore = mountParent; mountParent = mountParent\.parentElement/);
    assert.match(rowSource, /function rankedWarMountPoint\(board, wrapper = null\)/);
    assert.match(rowSource, /if \(!board\?\.parentElement \|\| board\.isConnected === false\) return null/);
    assert.match(rowSource, /return rankedWarSafeMountPoint\(board\.parentElement, board, wrapper\)/);
    assert.doesNotMatch(rowSource, /mainContainer\.firstChild/);
    assert.match(rowSource, /function createRankedWarHost\(view, board = rankedWarBoardForView\(view\)\) \{ if \(!board\?\.parentElement \|\| board\.isConnected === false\) return null/);
    assert.match(rowSource, /wrapper\.dataset\.warbuddyBoardVerified = "1"/);
    assert.match(rowSource, /const mountPoint = rankedWarMountPoint\(board\)/);
    assert.match(rowSource, /mountPoint\.parent\.insertBefore\(wrapper, mountPoint\.before\)/);
    assert.doesNotMatch(rowSource, /\.insertBefore\(wrapper, (?:board|row)\b/);

    assert.match(inlineSource, /const signedBoard = rankedWarBoardForView\(view\)/);
    assert.match(inlineSource, /const verifiedBoard = board \|\| rankedWarUnsignedRosterCluster\(view\.enemyRoster\)/);
    assert.match(inlineSource, /const enemyEntries = rankedWarEnemyRowEntries\(view\.enemyRoster, verifiedBoard\)/);
    assert.match(inlineSource, /if \(!enemyEntries\.length\) \{ if \(state\.integratedDecorationsActive\) removeInlineMemberTools\(\); return; \}/);
    assert.doesNotMatch(mountSource, /rankedWarBoardForView|createRankedWarHost|INTEGRATED_WRAPPER_ID|placement: "inline"/);

    assert.match(wrapperRoot, /display:block; box-sizing:border-box; width:100%; min-width:0; max-width:100%/);
    assert.doesNotMatch(wrapperRoot, /grid-column|flex:/);
    assert.match(styleSource, /wc-roster-mode/);
    assert.match(styleSource, /width:100%; max-width:none/);
    assert.match(styleSource, /wc-roster-mode \.wc-body \{ max-height:none; overflow:visible; overscroll-behavior:auto/);
    assert.match(styleSource, /\.wc-target-list \{ max-height:180px; overflow:auto/);
  });

  it("lifts ranked-war mounts out of Torn's internal roster layout", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");
    const safeDisplaysSource = sourceSection(
      source,
      "const SAFE_INTEGRATED_PARENT_DISPLAYS",
      "const STATUS_CELL_CLASS"
    );
    const mountPointSource = sourceSection(
      source,
      "function rankedWarSafeMountPoint",
      "function createRankedWarHost"
    );
    const resolveMountPoint = ({ board, wrapper = null }) => {
      const context = {
        board,
        wrapper,
        mountPoint: null,
        document: {
          body: null,
          documentElement: null,
        },
        getComputedStyle(element) {
          return { display: element.display || "block" };
        },
      };
      runInNewContext(`${safeDisplaysSource}\n${mountPointSource}\nmountPoint = rankedWarMountPoint(board, wrapper);`, context);
      return context.mountPoint;
    };

    const pageShell = { display: "block", firstChild: null, parentElement: null };
    const mainContainer = { display: "block", firstChild: null, parentElement: pageShell };
    const pageSection = { display: "block", parentElement: mainContainer };
    const rosterGrid = { display: "grid", parentElement: pageSection };
    const commonBoard = { parentElement: rosterGrid };
    pageShell.firstChild = mainContainer;
    mainContainer.firstChild = pageSection;

    commonBoard.isConnected = true;
    const verified = resolveMountPoint({ board: commonBoard });
    assert.equal(verified.parent, pageSection);
    assert.equal(verified.before, rosterGrid);

    const wrapper = { parentElement: mainContainer, nextSibling: pageSection };
    mainContainer.firstChild = wrapper;
    assert.equal(resolveMountPoint({ board: null, wrapper }), null);
    assert.equal(resolveMountPoint({ board: { parentElement: rosterGrid, isConnected: false }, wrapper }), null);

    mainContainer.display = "flex";
    mainContainer.isConnected = true;
    const flexSafe = resolveMountPoint({ board: mainContainer, wrapper });
    assert.equal(flexSafe.parent, pageShell);
    assert.equal(flexSafe.before, mainContainer);

    mainContainer.display = "grid";
    const boardIsMain = resolveMountPoint({ board: mainContainer, wrapper });
    assert.equal(boardIsMain.parent, pageShell);
    assert.equal(boardIsMain.before, mainContainer);
  });

  it("never returns a full-panel mount in native mode and keeps floating mode optional", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");
    const resolveSource = sourceSection(source, "function resolvePanelMount", "function setDisplayMode");
    const modeSource = sourceSection(source, "function setDisplayMode", "async function getProfileWithKey");
    const runResolve = (displayMode) => {
      const panel = { removals: 0, remove() { this.removals += 1; } };
      const body = {};
      const cleanupCalls = [];
      const context = {
        result: null,
        state: { displayMode },
        PANEL_ID: "warbuddy-panel",
        document: {
          body,
          getElementById(id) { return id === "warbuddy-panel" ? panel : null; },
        },
        removeIntegratedMount(preservePanel) { cleanupCalls.push(preservePanel); },
      };
      runInNewContext(`${resolveSource}\nresult = resolvePanelMount({});`, context);
      return { result: context.result, panel, body, cleanupCalls };
    };

    const native = runResolve("native");
    assert.equal(native.result.mount, null);
    assert.equal(native.result.placement, "none");
    assert.equal(native.panel.removals, 1);
    assert.deepEqual(native.cleanupCalls, [false]);

    const floating = runResolve("floating");
    assert.equal(floating.result.mount, floating.body);
    assert.equal(floating.result.placement, "floating");
    assert.equal(floating.panel.removals, 0);
    assert.deepEqual(floating.cleanupCalls, [true]);
    assert.doesNotMatch(resolveSource, /rankedWarBoardForView|createRankedWarHost|placement:\s*["']inline/);

    const runModeChange = (value) => {
      const panel = { removals: 0, remove() { this.removals += 1; } };
      const cleanupCalls = [];
      const context = {
        value,
        state: { displayMode: "floating" },
        core: { normalizeDisplayMode: core.normalizeDisplayMode },
        DISPLAY_MODE_STORAGE: "warbuddy_display_mode",
        PANEL_ID: "warbuddy-panel",
        document: { getElementById() { return panel; } },
        storage: { set(key, next) { context.stored = [key, next]; } },
        removeIntegratedMount(preservePanel) { cleanupCalls.push(preservePanel); },
        scheduleRender() { context.renderScheduled = true; },
        syncForegroundState() { context.foregroundSynced = true; },
      };
      runInNewContext(`${modeSource}\nsetDisplayMode(value);`, context);
      return { context, panel, cleanupCalls };
    };

    const nativeChange = runModeChange("native");
    assert.equal(nativeChange.panel.removals, 1);
    assert.deepEqual(nativeChange.cleanupCalls, [false]);
    assert.deepEqual(nativeChange.context.stored, ["warbuddy_display_mode", "native"]);
    assert.equal(nativeChange.context.renderScheduled, true);

    const floatingChange = runModeChange("floating");
    assert.equal(floatingChange.panel.removals, 0);
    assert.deepEqual(floatingChange.cleanupCalls, [true]);
  });

  it("revalidates native ranked-war placement when the responsive layout changes", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");
    const listenerSource = compactSource(sourceSection(
      source,
      "window.addEventListener(\"focus\"",
      "window.addEventListener(\"hashchange\""
    ));

    assert.match(listenerSource, /const handleViewportResize = \(\) => \{/);
    assert.match(listenerSource, /positionOpenDibsTip\(document\)/);
    assert.match(listenerSource, /scheduleNativeOverlayPosition\(\)/);
    assert.match(listenerSource, /targetPageMemberId\(\) \|\| \(state\.displayMode !== "floating" && isRosterModePage\(\)\)\) scheduleRender\(\)/);
    assert.match(listenerSource, /window\.addEventListener\("resize", handleViewportResize\)/);
    assert.match(listenerSource, /window\.visualViewport\?\.addEventListener\?\.\("resize", handleViewportResize\)/);
    assert.match(listenerSource, /window\.addEventListener\("scroll", scheduleNativeOverlayPosition, \{ passive: true \}\)/);
    assert.match(listenerSource, /window\.visualViewport\?\.addEventListener\?\.\("scroll", scheduleNativeOverlayPosition, \{ passive: true \}\)/);
  });

  it("keeps roster filtering reversible while showing independent Retal and Dibs actions", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");
    const inlineSource = compactSource(sourceSection(source, "function syncIntegratedMemberTools", "function dibsMarkup"));
    const cleanupSource = compactSource(sourceSection(source, "function removeInlineMemberTools", "function removeIntegratedMount"));
    const mountCleanupSource = compactSource(sourceSection(source, "function removeIntegratedMount", "function rosterProfileAnchors"));
    const styleSource = compactSource(sourceSection(source, "addStyle(`", "const normalizeResponse"));

    assert.match(inlineSource, /if \(!canFindBoard\) \{ if \(state\.integratedDecorationsActive\) removeInlineMemberTools\(\); return/);
    assert.match(inlineSource, /const verifiedBoard = board \|\| rankedWarUnsignedRosterCluster\(view\.enemyRoster\)/);
    assert.match(inlineSource, /rankedWarEnemyRowEntries\(view\.enemyRoster, verifiedBoard\)/);
    assert.doesNotMatch(inlineSource, /: enemyProfileAnchors\(view\)|\[data-warbuddy-roster-board='1'\]/);
    assert.match(inlineSource, /for \(const \{ anchor, memberId, row \} of enemyEntries\)/);
    assert.match(inlineSource, /const attackLink = rankedWarAttackLinkForMember\(row, memberId\)/);
    assert.doesNotMatch(inlineSource, /board\?\.contains\?\.\(anchor\)|rankedWarOwnRowForAnchor\(anchor\)/);
    assert.match(inlineSource, /core\.rosterFilterMatches\(state\.rosterFilter, flags\)/);
    assert.match(inlineSource, /core\.memberAvailability\(member, state\.nowMs\)/);
    assert.match(inlineSource, /syncIntegratedStatusCell\(row, attackLink, memberId, availability, keepStatusCells\)/);
    assert.doesNotMatch(inlineSource, /availabilityMarkup/);
    assert.match(inlineSource, /tools\.classList\.toggle\("quiet", !state\.rosterDibsButtons && !watched && !retaliation && !claim\)/);
    assert.match(inlineSource, /rosterActions\.className = ROSTER_ACTIONS_CLASS/);
    assert.match(inlineSource, /actionParent\.insertBefore\(rosterActions, attackLink\)/);
    assert.match(inlineSource, /actionParent\.classList\.add\("warbuddy-roster-action-cell"\)/);
    assert.match(inlineSource, /attackLink\.classList\.toggle\("warbuddy-attack-has-dibs", state\.rosterDibsButtons\)/);
    assert.match(source, /const ROSTER_DIBS_STORAGE = "warbuddy_roster_dibs_buttons"/);
    assert.match(source, /rosterDibsButtons: String\(storage\.get\(ROSTER_DIBS_STORAGE, "1"\)\) !== "0"/);
    assert.match(inlineSource, /const rosterDibsControl = state\.rosterDibsButtons \? dibsMarkup\(member, view, claim, `roster-\$\{memberId\}`\) : ""/);
    assert.match(inlineSource, /const fallbackDibsControl = !attackLink && state\.rosterDibsButtons \? dibsMarkup\(member, view, claim, `roster-fallback-\$\{memberId\}`\) : ""/);
    assert.match(source, /id="\$\{INTEGRATED_HOST_ID\}" class="wc-native-roster-panel-host"/);
    assert.match(source, /data-field="roster-dibs-buttons"/);
    assert.match(source, /panel\.querySelector\('\[data-field="roster-dibs-buttons"\]'\)/);
    assert.match(source, /function handleInlineToolAction\(event\) \{\s*if \(handleDibsControlAction\(event\)\) return/);
    assert.match(inlineSource, /warbuddy-attack-dibs-mine/);
    assert.match(inlineSource, /warbuddy-attack-dibs-taken/);
    assert.match(inlineSource, /core\.rosterOrder\(flags, member, state\.nowMs\)/);
    assert.match(inlineSource, /ffscouterFilterActive\(\)/);
    assert.match(inlineSource, /tornRosterSortState\(decoratedRows, verifiedBoard\)/);
    assert.match(inlineSource, /core\.rosterPriorityAllowedForSort\(tornSort\.column\)/);
    assert.match(inlineSource, /state\.rosterPrioritySort && !externalSortReason/);
    assert.match(inlineSource, /if \(row\.style\.order !== order\) row\.style\.order = order/);
    assert.doesNotMatch(inlineSource, /appendChild\(row\)|insertBefore\(row/);
    assert.match(cleanupSource, /warbuddy-roster-hidden/);
    assert.match(cleanupSource, /removeProperty\?\.\("order"\)/);
    assert.match(cleanupSource, /warbuddy-roster-sort-parent/);
    assert.match(cleanupSource, /warbuddyAvailability/);
    assert.match(cleanupSource, /querySelectorAll\?\.\(`\.\$\{ROSTER_ACTIONS_CLASS\}`\)/);
    assert.match(mountCleanupSource, /\[data-warbuddy-roster-board\]/);
    assert.match(mountCleanupSource, /delete board\.dataset\.warbuddyRosterBoard/);
    assert.match(source, /function rankedWarStatusCell\(row, attackLink\)/);
    assert.match(source, /classList\.remove\(STATUS_CELL_CLASS\)/);
    assert.match(styleSource, /\.warbuddy-roster-action-cell \{ position:relative !important/);
    assert.match(styleSource, /\.\$\{ROSTER_ACTIONS_CLASS\} \{ position:absolute; left:2px; top:50%;[\s\S]*?overflow:visible/);
    assert.match(styleSource, /\.\$\{ROSTER_ACTIONS_CLASS\}:empty \{ display:none/);
    assert.match(styleSource, /a\.warbuddy-attack-has-dibs \{ box-sizing:border-box !important; padding-left:24px !important/);
  });

  it("reconciles Torn status, reuses native colors, and avoids unchanged roster rewrites", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");
    const statusSource = compactSource(sourceSection(
      source,
      "function tornStatusCategory",
      "function syncIntegratedMemberTools"
    ));
    const ensureSource = compactSource(sourceSection(source, "function ensureInlineMemberTools", "function syncIntegratedMemberTools"));
    const inlineSource = compactSource(sourceSection(source, "function syncIntegratedMemberTools", "function dibsMarkup"));
    const styleSource = compactSource(sourceSection(source, "addStyle(`", "const normalizeResponse"));
    const clockSource = compactSource(sourceSection(source, "function tornPageNowMs", "function removeInlineMemberTools"));

    assert.match(statusSource, /const mismatch = !!tornCategory && !!backendCategory && tornCategory !== backendCategory/);
    assert.match(statusSource, /!availability\?\.label \|\| \(tornCategory && !backendCategory\)/);
    assert.match(statusSource, /clearIntegratedStatusCell\(statusCell, false\)/);
    assert.match(statusSource, /warbuddyStatusMismatch/);
    assert.match(inlineSource, /inlineMarkupCache\.get\(tools\) !== toolsMarkup/);
    assert.match(ensureSource, /tools\.addEventListener\("click", handleInlineToolAction\)/);
    assert.doesNotMatch(inlineSource, /querySelector\?\.\('\[data-inline-action="watch"\]'\)\?\.addEventListener/);
    assert.match(styleSource, /var\(--user-status-blue-color,#22d3ee\)/);
    assert.match(styleSource, /var\(--user-status-red-color,#f87171\)/);
    assert.match(clockSource, /pageWindow\.getCurrentTimestamp\(\)/);
    assert.match(clockSource, /core\.trustedClockOffset\(serverSampleMs, sampledAt, Number\.POSITIVE_INFINITY\)/);
    assert.match(source, /syncTrustedClock\(snapshot\?\.serverTime \|\| snapshot\?\.generatedAt, "snapshot"\)/);
    assert.match(source, /state\.nowMs = trustedNowMs\(\)/);
  });

  it("hides the whole action queue via showActionQueue while keeping the tracker-disabled notice separate", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");
    const sessionViewSource = compactSource(sourceSection(source, "function sessionView", "const statusView"));
    const queueMarkupSource = compactSource(sourceSection(
      source,
      "function actionQueueMarkup",
      "const loadoutRarityColor"
    ));
    const renderSource = compactSource(sourceSection(source, "function render()", "function forgetStoredKey"));

    assert.match(sessionViewSource, /const actionQueueEnabled = state\.settings\?\.enabled !== false && state\.settings\?\.showActionQueue !== false/);
    assert.match(sessionViewSource, /const actions = !actionQueueEnabled \? \[\] : core\.applyTargetGroups\(core\.buildActionQueue\(/);
    assert.match(queueMarkupSource, /if \(trackerDisabled\) return ""/);
    assert.match(queueMarkupSource, /if \(!view\.actionQueueEnabled\) return ""/);
    assert.match(renderSource, /const trackerDisabled = state\.settings\?\.enabled === false/);
    assert.match(renderSource, /const trackerDisabledNotice = trackerDisabled \? .*War tracker is disabled\..* : ""/);
    assert.ok(renderSource.includes("${trackerDisabledNotice}${queueSection}"));
    assert.equal(core.dibsFeatureEnabled({ enabled: true, dibsEnabled: true, showActionQueue: false }), true);
  });

  it("renders revive observations only from a fresh enemy roster as profile-only queue entries", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");
    const sessionViewSource = compactSource(sourceSection(source, "function sessionView", "const statusView"));
    const actionMarkupSource = compactSource(sourceSection(source, "function actionMarkup", "function retaliationMarkup"));
    const attackOnlyFilters = source.match(/\.filter\(core\.actionTargetsAttack\)/g) || [];

    assert.match(sessionViewSource, /item\?\.kind !== "revive"/);
    assert.match(actionMarkupSource, /const targetsAttack = core\.actionTargetsAttack\(item\)/);
    assert.match(actionMarkupSource, /targetsAttack && member \? dibsMarkup/);
    assert.match(actionMarkupSource, /item\.actionLabel \|\| "Profile"/);
    assert.ok(attackOnlyFilters.length >= 3);
    assert.match(source, /if \(!isForeground\(\) \|\| !currentEnemyRosterIsFresh\(\)\) return/);
  });

  it("uses a body-mounted profile overlay and an inline ranked-war accordion", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");
    const activationSource = compactSource(sourceSection(
      source,
      "function syncPageActivation",
      "function syncVisibilityState"
    ));
    const relevanceSource = compactSource(sourceSection(
      source,
      "function targetPageFactionEligible",
      "function attackTargetLabelsContainer"
    ));
    const anchorSource = compactSource(sourceSection(
      source,
      "function nativeAnchorRect",
      "function targetContextMarkup"
    ));
    const syncContextSource = compactSource(sourceSection(
      source,
      "function syncTargetPageContext",
      "function capturePanelFocus"
    ));
    const renderSource = compactSource(sourceSection(source, "function render()", "function forgetStoredKey"));
    const styleSource = compactSource(sourceSection(source, "addStyle(`", "const normalizeResponse"));

    assert.match(activationSource, /const nextAttackTargetId = active \? core\.attackPageTargetId\(href\) : 0/);
    assert.match(activationSource, /const nextProfileTargetId = active \? core\.profilePageTargetId\(href\) : 0/);
    assert.match(relevanceSource, /registeredFactionId === ownFactionId/);
    assert.match(relevanceSource, /state\.session\?\.access === "war_companion"/);
    assert.match(relevanceSource, /state\.settings\?\.enabled !== false/);
    assert.match(relevanceSource, /!!view\?\.alliedScore\?\.start/);
    assert.match(relevanceSource, /if \(state\.attackTargetId\) return true; return !!state\.profileTargetId/);
    assert.match(anchorSource, /function profileNameAnchor\(\)/);
    assert.match(anchorSource, /const idToken = `\[\$\{memberId\}\]`/);
    assert.match(anchorSource, /text\.includes\(idToken\)/);
    assert.match(anchorSource, /function rankedWarFilterAnchor\(\)/);
    assert.match(anchorSource, /\^ranked\\s\+war\\s\+filter/);
    assert.match(anchorSource, /function rankedWarFilterBar\(anchor = rankedWarFilterAnchor\(\)\)/);
    assert.match(anchorSource, /function rankedWarRosterContextMountPoint\(\)/);
    assert.match(anchorSource, /return \{ parent, before, anchor: bar \}/);
    assert.match(anchorSource, /function positionNativeOverlay\(context, anchor, placement\)/);
    assert.match(anchorSource, /wc-native-overlay-fallback/);
    assert.match(anchorSource, /context\.style\.setProperty\(property, value, "important"\)/);
    assert.match(anchorSource, /parent: document\.body/);
    assert.match(anchorSource, /anchor: profileNameAnchor\(\)/);
    assert.match(anchorSource, /overlay: true/);
    assert.doesNotMatch(syncContextSource, /PROFILE_HOST_CLASS|profileHost/);
    assert.match(syncContextSource, /if \(mountPoint\.overlay\) positionNativeOverlay\(context, mountPoint\.anchor, mountPoint\.placement\)/);
    assert.match(syncContextSource, /function syncNativeRosterContext\(view = sessionView\(\)\)/);
    assert.match(syncContextSource, /const mountPoint = rankedWarRosterContextMountPoint\(\)/);
    assert.match(syncContextSource, /context = document\.createElement\("details"\)/);
    assert.match(syncContextSource, /mountPoint\.parent\.insertBefore\(context, mountPoint\.before\)/);
    assert.match(syncContextSource, /state\.rosterControlsOpen = event\.currentTarget\.open === true/);
    assert.doesNotMatch(syncContextSource, /positionNativeOverlay\(context, anchor/);
    assert.match(renderSource, /syncNativeRosterContext\(view\)/);
    assert.match(renderSource, /removeNativeRosterContext\(\)/);
    assert.match(styleSource, /body > #\$\{TARGET_CONTEXT_ID\}\.wc-profile-context \{ position:fixed !important/);
    assert.match(styleSource, /#\$\{ROSTER_CONTEXT_ID\}\.wc-native-roster-context \{ position:relative !important/);
    assert.match(styleSource, /#\$\{ROSTER_CONTEXT_ID\} > summary \{ display:flex/);
    assert.doesNotMatch(source, /function attackTargetMarkup|Current Torn target/);
  });

  it("anchors the profile overlay beside the exact player name and the roster marker to the filter heading", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");
    const mountSource = sourceSection(source, "function nativeAnchorRect", "function targetContextMarkup");
    const node = ({ text, tagName = "DIV", rect }) => ({
      textContent: text,
      tagName,
      isConnected: true,
      closest() { return null; },
      getBoundingClientRect() { return rect; },
    });
    const decoy = node({
      text: "Other player [99]",
      tagName: "H1",
      rect: { left: 60, right: 260, top: 20, bottom: 52, width: 200, height: 32 },
    });
    const exact = node({
      text: "Bhonkai [42]",
      tagName: "H1",
      rect: { left: 70, right: 220, top: 40, bottom: 70, width: 150, height: 30 },
    });
    const outerFilter = node({
      text: "Ranked War Filter",
      rect: { left: 600, right: 1000, top: 500, bottom: 540, width: 400, height: 40 },
    });
    const exactFilter = node({
      text: "Ranked War Filter",
      tagName: "H3",
      rect: { left: 620, right: 980, top: 505, bottom: 530, width: 360, height: 25 },
    });
    const body = { children: [] };
    const main = {
      querySelectorAll() { return [outerFilter, exactFilter]; },
    };
    const overlay = {
      offsetWidth: 120,
      offsetHeight: 18,
      style: {
        removeProperty(name) { delete this[name]; },
        setProperty(name, value, priority) {
          this[name] = value;
          this[`${name}Priority`] = priority;
        },
      },
      classList: {
        fallback: false,
        toggle(name, enabled) {
          if (name === "wc-native-overlay-fallback") this.fallback = enabled;
        },
      },
      getBoundingClientRect() {
        return { left: 0, right: 120, top: 0, bottom: 18, width: 120, height: 18 };
      },
    };
    const context = {
      result: null,
      state: { attackTargetId: 0, profileTargetId: 42 },
      TARGET_CONTEXT_ID: "warbuddy-target-context",
      ROSTER_CONTEXT_ID: "warbuddy-roster-context",
      PANEL_ID: "warbuddy-panel",
      document: {
        body,
        documentElement: { clientWidth: 1200, clientHeight: 800 },
        querySelectorAll() { return [decoy, exact]; },
        querySelector() { return null; },
      },
      window: {
        scrollX: 0,
        scrollY: 0,
        innerWidth: 1200,
        innerHeight: 800,
        visualViewport: null,
      },
      rankedWarMainContent() { return main; },
      overlay,
    };
    runInNewContext(
      `${mountSource}\nconst mount = targetContextMountPoint(); const positioned = positionNativeOverlay(overlay, mount.anchor, mount.placement); result = { mount, positioned, filter: rankedWarFilterAnchor() };`,
      context
    );

    assert.equal(context.result.mount.parent, body);
    assert.equal(context.result.mount.anchor, exact);
    assert.equal(context.result.mount.placement, "profile");
    assert.equal(context.result.mount.overlay, true);
    assert.equal(context.result.positioned, true);
    assert.equal(overlay.classList.fallback, false);
    assert.equal(overlay.style.left, "228px");
    assert.equal(overlay.style.top, "46px");
    assert.equal(overlay.style.leftPriority, "important");
    assert.equal(overlay.style.topPriority, "important");
    assert.equal(context.result.filter, exactFilter);
    assert.deepEqual(body.children, []);
  });

  it("shows profile context throughout an eligible registered war and stays closed otherwise", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");
    const relevanceSource = sourceSection(
      source,
      "function targetPageFactionEligible",
      "function attackTargetLabelsContainer"
    );
    const isRelevant = ({
      attackTargetId = 0,
      profileTargetId = 42,
      watched = [],
      enemyRoster = [],
      retaliation = [],
      claims = [],
      loadout = false,
      registeredFactionId = "41309",
      ownFactionId = "41309",
      enemyFactionId = "49352",
      token = "session-token",
      trackerEnabled = true,
      warStart = "2026-08-29T12:00:00.000Z",
    } = {}) => {
      const context = {
        result: false,
        state: {
          session: registeredFactionId ? {
            factionId: registeredFactionId,
            access: "war_companion",
            enabledModules: { war_planner: true },
          } : null,
          token,
          authTerminal: false,
          attackTargetId,
          profileTargetId,
          settings: { enabled: trackerEnabled, dibsEnabled: true },
          nowMs: 1_000,
        },
        view: {
          ownFactionId,
          enemyFactionId,
          alliedScore: warStart ? { start: warStart } : null,
          enemyRoster,
          retaliation,
          dibs: { claims },
        },
        targetPageMemberId() { return Number(attackTargetId || profileTargetId || 0); },
        savedTargetIds() { return watched; },
        memberLoadout() { return loadout ? {} : undefined; },
        core: {
          dibsFeatureEnabled() { return true; },
          activeDibsClaim(dibs, memberId) {
            return dibs?.claims?.find((claim) => Number(claim.targetMemberId || 0) === memberId);
          },
        },
      };
      runInNewContext(`${relevanceSource}\nresult = targetPageContextRelevant(view);`, context);
      return context.result;
    };

    assert.equal(isRelevant(), true);
    assert.equal(isRelevant({ attackTargetId: 42, profileTargetId: 0 }), true);
    assert.equal(isRelevant({ attackTargetId: 42, profileTargetId: 0, registeredFactionId: "" }), false);
    assert.equal(isRelevant({ attackTargetId: 42, profileTargetId: 0, token: "" }), false);
    assert.equal(isRelevant({ attackTargetId: 42, profileTargetId: 0, trackerEnabled: false }), false);
    assert.equal(isRelevant({ attackTargetId: 42, profileTargetId: 0, warStart: "" }), false);
    assert.equal(isRelevant({ attackTargetId: 42, profileTargetId: 0, enemyFactionId: "" }), false);
    assert.equal(isRelevant({ attackTargetId: 42, profileTargetId: 0, registeredFactionId: "400", ownFactionId: "41309" }), false);
    assert.equal(isRelevant({ watched: [42] }), true);
    assert.equal(isRelevant({ enemyRoster: [{ member_id: 42 }] }), true);
    assert.equal(isRelevant({ retaliation: [{ attackerId: 42 }] }), true);
    assert.equal(isRelevant({ claims: [{ targetMemberId: 42 }] }), true);
    assert.equal(isRelevant({ loadout: true }), true);
  });

  it("mounts the compact attack HUD only in a verified target-side label container", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");
    const mountSource = sourceSection(
      source,
      "function attackTargetLabelsContainer",
      "function targetContextMarkup"
    );
    const area = (kind, memberId = 0) => ({
      kind,
      querySelectorAll() {
        return memberId
          ? [{ href: `https://www.torn.com/profiles.php?XID=${memberId}`, getAttribute() { return this.href; } }]
          : [];
      },
    });
    const label = (
      targetArea,
      isConnected = true,
      defenderArea = targetArea.kind === "defender" ? targetArea : null
    ) => ({
      isConnected,
      parentElement: targetArea,
      closest(selector) {
        if (selector.includes("playerArea")) return targetArea;
        if (selector.includes("defender")) return defenderArea;
        return null;
      },
    });
    const resolveMount = (candidates) => {
      const context = {
        result: null,
        state: { attackTargetId: 42, profileTargetId: 0 },
        core: {
          profileMemberIdFromUrl(value) {
            return Number(new URL(value).searchParams.get("XID") || 0);
          },
        },
        URL,
        document: {
          querySelectorAll() { return candidates; },
          querySelector() { return null; },
          getElementById() { return null; },
        },
      };
      runInNewContext(`${mountSource}\nresult = targetContextMountPoint();`, context);
      return context.result;
    };

    const wrongDefender = label(area("defender", 7));
    const matchedTarget = label(area("defender", 42));
    const profileMatched = resolveMount([wrongDefender, matchedTarget]);
    assert.equal(profileMatched.parent, matchedTarget);
    assert.equal(profileMatched.before, null);
    assert.equal(profileMatched.placement, "attack");

    const defenderFallback = label(area("defender"));
    assert.equal(resolveMount([label(area("playerArea")), defenderFallback]).parent, defenderFallback);
    const locallyMatched = label(area("playerArea", 42));
    assert.equal(resolveMount([label(area("playerArea", 7)), locallyMatched]).parent, locallyMatched);
    const sharedPlayerArea = area("playerArea", 42);
    const attackerLabels = label(sharedPlayerArea);
    const targetLabels = label(sharedPlayerArea, true, area("defender"));
    assert.equal(resolveMount([attackerLabels, targetLabels]).parent, targetLabels);
    assert.equal(resolveMount([label(sharedPlayerArea), label(sharedPlayerArea)]), null);
    assert.equal(resolveMount([label(area("playerArea"))]), null);
    assert.equal(resolveMount([label(area("defender", 42), false)]), null);
  });

  it("keeps watched-target options stable, searchable, filterable, and explicitly actionable", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");
    const optionsSource = compactSource(sourceSection(
      source,
      "function watchedTargetOptions",
      "function filteredWatchedTargetOptions"
    ));
    const filterSource = compactSource(sourceSection(
      source,
      "function filteredWatchedTargetOptions",
      "async function persistWatchedTargetIds"
    ));
    const renderSource = compactSource(sourceSection(source, "function render()", "function forgetStoredKey"));

    assert.match(optionsSource, /for \(const memberId of selectedIds\)/);
    assert.match(optionsSource, /\.sort\(\(left, right\) => left\.name\.localeCompare\(right\.name\) \|\| left\.memberId - right\.memberId\)/);
    assert.match(filterSource, /const query = state\.targetSearch\.trim\(\)\.toLowerCase\(\)/);
    assert.match(filterSource, /`\$\{option\.name\} \$\{option\.memberId\}`\.toLowerCase\(\)\.includes\(query\)/);
    for (const filter of ["selected", "attackable", "hospital", "traveling"]) {
      assert.match(filterSource, new RegExp(`state\\.targetFilter === "${filter}"`));
    }
    assert.match(renderSource, /data-field="target-search"/);
    assert.match(renderSource, /data-field="target-filter"/);
    assert.match(renderSource, /data-action="clear-targets"[^>]*>Clear<\/button>/);
    assert.match(renderSource, /data-action="cancel-targets"[^>]*>Cancel<\/button>/);
    assert.match(renderSource, /data-action="save-targets"[^>]*>\$\{state\.targetsSaving \? "Saving\.\.\." : "Save"\}<\/button>/);
  });

  it("preserves dirty target drafts and restores picker focus across renders", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");
    const draftSource = compactSource(sourceSection(source, "const syncTargetDraft", "const resetPersonalTargets"));
    const quickWatchSource = compactSource(sourceSection(
      source,
      "async function toggleWatchedTarget",
      "function showDibsError"
    ));
    const focusSource = compactSource(sourceSection(
      source,
      "function capturePanelFocus",
      "function positionOpenDibsTip"
    ));
    const renderSource = compactSource(sourceSection(source, "function render()", "function forgetStoredKey"));

    assert.match(draftSource, /if \(state\.targetsDirty && !sameTargetIds\(state\.targetDraft, savedTargetIds\(\)\)\) return/);
    assert.match(renderSource, /const targetIds = state\.targetsOpen \|\| state\.targetsDirty \? normalizeTargetIds\(state\.targetDraft\) : savedTargetIds\(\)/);
    assert.match(renderSource, /if \(open && !state\.targetsDirty\) state\.targetDraft = savedTargetIds\(\)/);
    assert.match(quickWatchSource, /if \(state\.targetsOpen \|\| state\.targetsDirty\)/);
    assert.match(quickWatchSource, /state\.targetsDirty = !sameTargetIds\(state\.targetDraft, savedIds\)/);
    assert.match(focusSource, /focusKey/);
    assert.match(focusSource, /candidate\.focus\?\.\(\{ preventScroll: true \}\)/);
    assert.match(focusSource, /candidate\.setSelectionRange\(snapshot\.selectionStart, snapshot\.selectionEnd\)/);
    assert.match(renderSource, /prepareSameKeyReconnect\(\)/);

    const captureAt = renderSource.indexOf("const focusSnapshot = capturePanelFocus(panel)");
    const replaceAt = renderSource.indexOf("panel.innerHTML =");
    const restoreAt = renderSource.indexOf("restorePanelFocus(panel, focusSnapshot)");
    assert.ok(captureAt >= 0 && captureAt < replaceAt && replaceAt < restoreAt);
  });

  it("blocks stale or offline mutations and removes generic online and revive suggestions", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");
    const sessionViewSource = compactSource(sourceSection(source, "function sessionView", "const statusView"));
    const dibsMarkupSource = compactSource(sourceSection(source, "function dibsMarkup", "function attackLinkMarkup"));
    const saveTargetsSource = compactSource(sourceSection(
      source,
      "async function saveWatchedTargets",
      "async function toggleWatchedTarget"
    ));
    const quickWatchSource = compactSource(sourceSection(
      source,
      "async function toggleWatchedTarget",
      "function showDibsError"
    ));
    const updateDibsSource = compactSource(sourceSection(
      source,
      "async function updateDibs",
      "function actionQueueMarkup"
    ));
    const renderSource = compactSource(sourceSection(source, "function render()", "function forgetStoredKey"));

    assert.match(sessionViewSource, /const genericSuggestionsEnabled = rosterIsFresh\(ownFactionId\) && rosterIsFresh\(enemyFactionId\)/);
    assert.match(sessionViewSource, /\.filter\(\(item\) => genericSuggestionsEnabled \|\| \(/);
    assert.match(sessionViewSource, /!String\(item\.key \|\| ""\)\.startsWith\("online-"\)/);
    assert.match(sessionViewSource, /item\?\.kind !== "revive"/);
    assert.match(dibsMarkupSource, /const canMutate = isOnline\(\) && rosterIsFresh\(view\.ownFactionId\) && rosterIsFresh\(view\.enemyFactionId\) && !state\.authTerminal && !state\.keySaving/);
    assert.match(saveTargetsSource, /if \(!isOnline\(\) \|\| state\.authTerminal \|\| state\.keySaving\)/);
    assert.match(quickWatchSource, /if \(!isOnline\(\) \|\| state\.authTerminal \|\| state\.keySaving\)/);
    assert.match(quickWatchSource, /const currentEnemy = sessionView\(\)\.enemyRoster\.some/);
    assert.match(quickWatchSource, /if \(!wasWatched && !currentEnemy\)/);
    assert.match(quickWatchSource, /Only current war opponents can be added to watched targets\./);
    assert.match(updateDibsSource, /if \(action === "claim"\).*const eligibility = dibsClaimContext\(target, view\)/);
    assert.match(source, /state\.rosterDataAt\.delete\(factionId\)/);
    assert.match(source, /state\.rosterDataAt\.set\(factionId, Date\.now\(\)\)/);
    assert.match(renderSource, /data-action="save-targets"[^>]*!isOnline\(\)[^>]*state\.authTerminal[^>]*state\.keySaving/);
    assert.match(renderSource, /Showing cached data from .* ago\. Live-only suggestions and changes are paused\./);
  });

  it("globally locks Dibs during a mutation and offers Dibs on retaliation rows", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");
    const dibsMarkupSource = compactSource(sourceSection(source, "function dibsMarkup", "function attackLinkMarkup"));
    const retaliationSource = compactSource(sourceSection(
      source,
      "function retaliationMarkup",
      "function watchedTargetOptions"
    ));
    const updateDibsSource = compactSource(sourceSection(
      source,
      "async function updateDibs",
      "function actionQueueMarkup"
    ));

    assert.match(dibsMarkupSource, /const anyBusy = state\.dibsBusyTargetId > 0/);
    assert.match(dibsMarkupSource, /const disabled = anyBusy/);
    assert.match(dibsMarkupSource, /const action = claim \|\| lottery\.entry \|\| !canClaim \? "inspect" : "claim"/);
    assert.match(dibsMarkupSource, /!canRelease \|\| anyBusy \|\| lottery\.closing \? " disabled" : ""/);
    assert.match(updateDibsSource, /state\.dibsBusyTargetId \|\| state\.targetsSaving \|\| state\.targetQuickBusyId \|\| !Number\.isSafeInteger\(memberId\)/);
    assert.match(updateDibsSource, /const expectsSocketSnapshot = socketIsOpen\(\)/);
    assert.match(updateDibsSource, /source: "mutation-response"/);
    assert.match(updateDibsSource, /baselineSequence: dibsMutationBaselineSequence/);
    assert.match(updateDibsSource, /if \(resumeFallback\) stopFallbackPolling\(\)/);
    assert.match(updateDibsSource, /if \(resumeFallback && !socketIsOpen\(\)\) startFallbackPolling\(\)/);
    assert.match(updateDibsSource, /finally \{ state\.dibsBusyTargetId = 0/);
    assert.match(retaliationSource, /view\.enemyRoster\.find/);
    assert.match(retaliationSource, /member \? dibsMarkup\(member, view, claim, `retal-\$\{memberId\}-\$\{attack\.expiresAt\}`\) : ""/);
    assert.match(retaliationSource, /attackLinkMarkup\(attack\.attackUrl \|\| core\.attackUrl\(attack\.attackerId\), memberId, "Attack", view, true, claim\)/);
  });

  it("provides responsive native target and ranked-war controls", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");
    const styleSource = sourceSection(source, "addStyle(`", "const normalizeResponse");
    const compactRoot = compactSource(styleSource.match(/#\$\{TARGET_CONTEXT_ID\}\.wc-compact-context \{([^}]*)\}/)?.[1]);
    const attackRoot = compactSource(styleSource.match(/#\$\{TARGET_CONTEXT_ID\}\.wc-attack-context \{([^}]*)\}/)?.[1]);
    const profileRoot = compactSource(styleSource.match(/#\$\{TARGET_CONTEXT_ID\}\.wc-profile-context \{([^}]*)\}/)?.[1]);
    const rosterRoot = compactSource(styleSource.match(/#\$\{ROSTER_CONTEXT_ID\}\.wc-native-roster-context \{([^}]*)\}/)?.[1]);
    const compactStates = compactSource(styleSource.match(/#\$\{TARGET_CONTEXT_ID\}\.wc-compact-context \.wc-native-states \{([^}]*)\}/)?.[1]);
    const compactActions = compactSource(styleSource.match(/#\$\{TARGET_CONTEXT_ID\}\.wc-compact-context \.wc-native-actions \{([^}]*)\}/)?.[1]);
    const compactState = compactSource(styleSource.match(/#\$\{TARGET_CONTEXT_ID\}\.wc-compact-context \.wc-native-state \{([^}]*)\}/)?.[1]);
    const compactResult = compactSource(styleSource.match(/#\$\{TARGET_CONTEXT_ID\}\.wc-compact-context \.wc-attack-result \{([^}]*)\}/)?.[1]);
    const profileLoadoutTip = compactSource(styleSource.match(/#\$\{TARGET_CONTEXT_ID\}\.wc-profile-context \.wc-loadout-tip \{([^}]*)\}/)?.[1]);

    assert.match(compactRoot, /position:static !important/);
    assert.match(compactRoot, /flex-wrap:nowrap/);
    assert.match(compactRoot, /box-shadow:none/);
    assert.match(attackRoot, /display:inline-flex/);
    assert.match(attackRoot, /width:auto/);
    assert.match(attackRoot, /max-width:min\(260px,100%\)/);
    assert.match(attackRoot, /flex:0 1 auto/);
    assert.match(attackRoot, /overflow:hidden/);
    assert.doesNotMatch(attackRoot, /(?:^|;\s*)width:100%|flex:1 0 100%|position:(?:fixed|absolute)/);
    assert.match(profileRoot, /position:fixed !important/);
    assert.match(profileRoot, /inset:auto/);
    assert.match(profileRoot, /z-index:2147483000 !important/);
    assert.match(profileRoot, /display:inline-flex/);
    assert.match(profileRoot, /width:max-content/);
    assert.match(profileRoot, /max-width:min\(340px,calc\(100vw - 16px\)\)/);
    assert.match(profileRoot, /min-height:18px; max-height:20px/);
    assert.match(profileRoot, /margin:0/);
    assert.match(profileRoot, /transform:none/);
    assert.doesNotMatch(profileRoot, /position:static|margin-left:auto|float:|(?:^|;\s*)width:100%|flex:(?:1|0) 0 100%/);
    assert.match(styleSource, /body > #\$\{TARGET_CONTEXT_ID\}\.wc-profile-context \{ position:fixed !important/);
    assert.match(rosterRoot, /position:relative !important/);
    assert.match(rosterRoot, /width:100%/);
    assert.match(rosterRoot, /max-width:100%/);
    assert.match(rosterRoot, /margin:5px 0/);
    assert.match(styleSource, /#\$\{ROSTER_CONTEXT_ID\} > summary \{ display:flex; min-height:32px/);
    assert.match(styleSource, /#\$\{ROSTER_CONTEXT_ID\} \.wc-native-roster-panel-host \{ display:block; width:100%; min-width:0/);
    assert.match(styleSource, /#\$\{PANEL_ID\}\.wc-inline-accordion \.wc-body \{ display:block !important/);
    assert.doesNotMatch(styleSource, /div#\$\{TARGET_CONTEXT_ID\}\.wc-profile-context|span#\$\{TARGET_CONTEXT_ID\}\.wc-profile-context/);
    assert.match(compactStates, /min-width:0; max-width:100%; flex:1 1 auto/);
    assert.match(compactStates, /overflow:hidden/);
    assert.doesNotMatch(compactStates, /flex:0 0 auto/);
    assert.match(compactActions, /min-width:0; flex:0 0 auto; flex-wrap:nowrap; gap:2px; margin-left:auto/);
    assert.match(compactState, /min-width:0; min-height:20px; max-width:145px; flex:0 1 auto; overflow:hidden/);
    assert.match(compactResult, /min-width:0; min-height:20px; max-width:150px; flex:0 1 auto/);
    assert.match(profileLoadoutTip, /top:calc\(100% \+ 4px\); bottom:auto/);
    assert.match(styleSource, /@media \(pointer:coarse\) \{ #\$\{TARGET_CONTEXT_ID\} \.wc-button,[\s\S]*?min-width:36px; min-height:36px/);
    assert.match(styleSource, /#\$\{TARGET_CONTEXT_ID\} \.wc-attack-icon,[\s\S]*?min-width:36px; min-height:36px/);
    assert.match(styleSource, /body > #\$\{TARGET_CONTEXT_ID\}\.wc-profile-context \{ min-height:20px; max-height:20px/);
    assert.match(styleSource, /max-width:min\(260px,calc\(100vw - 16px\)\)/);
    assert.match(styleSource, /@media\s*\(max-width:\s*520px\)/);
    assert.match(styleSource, /#\$\{PANEL_ID\}\.wc-roster-mode \{ max-height:none/);
    assert.match(styleSource, /#\$\{PANEL_ID\}\.wc-roster-mode \.wc-body \{ max-height:none; overflow:visible; overscroll-behavior:auto/);
  });
});

describe("Warbuddy route activation", () => {
  it("runs throughout Torn faction pages", () => {
    assert.equal(core.isFactionPageUrl("https://www.torn.com/factions.php?step=your#/war/rank"), true);
    assert.equal(core.isFactionPageUrl("https://torn.com/factions.php?step=profile&ID=41309"), true);
    assert.equal(core.isFactionPageUrl("https://www.torn.com/factions.php?step=your#/tab=crimes"), true);
  });

  it("also runs on exact Torn profile and attack target pages", () => {
    assert.equal(core.isWarbuddyPageUrl("https://www.torn.com/page.php?sid=attack"), true);
    assert.equal(core.isWarbuddyPageUrl("https://torn.com/page.php?sid=attack&user2ID=123"), true);
    assert.equal(core.attackPageTargetId("https://torn.com/page.php?sid=attack&user2ID=123"), 123);
    assert.equal(core.isWarbuddyPageUrl("https://www.torn.com/profiles.php?XID=456"), true);
    assert.equal(core.isWarbuddyPageUrl("https://torn.com/profiles.php?xid=456"), true);
    assert.equal(core.profilePageTargetId("https://www.torn.com/profiles.php?XID=456"), 456);
    assert.equal(core.profilePageTargetId("https://www.torn.com/profiles.php"), 0);
  });

  it("stays inactive on Bazaar and unrelated Torn pages", () => {
    assert.equal(core.isWarbuddyPageUrl("https://www.torn.com/bazaar.php"), false);
    assert.equal(core.isWarbuddyPageUrl("https://www.torn.com/page.php?sid=stocks"), false);
    assert.equal(core.isWarbuddyPageUrl("https://example.com/factions.php#/war/rank"), false);
  });

  it("does not mount the full panel by default on generic faction, profile, attack, or unrelated pages", async () => {
    const faction = await bootUserscript("https://www.torn.com/factions.php?step=your&type=1", { withBody: false });
    assert.equal(faction.elements.has("warbuddy-panel"), false);

    faction.activateBody();
    assert.equal(faction.elements.has("warbuddy-panel"), false);
    faction.setVisibility("visible");
    assert.equal(faction.elements.has("warbuddy-panel"), false);
    assert.equal(faction.menuCommands.has("Warbuddy: diagnostics"), true);

    const bazaar = await bootUserscript("https://www.torn.com/bazaar.php");
    assert.equal(bazaar.elements.has("warbuddy-panel"), false);

    const attack = await bootUserscript("https://www.torn.com/page.php?sid=attack&user2ID=123", {
      visibilityState: "visible",
    });
    assert.equal(attack.elements.has("warbuddy-panel"), false);

    const profile = await bootUserscript("https://www.torn.com/profiles.php?XID=123", {
      visibilityState: "visible",
    });
    assert.equal(profile.elements.has("warbuddy-panel"), false);

    const stocks = await bootUserscript("https://www.torn.com/page.php?sid=stocks");
    assert.equal(stocks.elements.has("warbuddy-panel"), false);
  });

  it("mounts and persists one opt-in floating panel on supported faction pages", async () => {
    for (const href of [
      "https://www.torn.com/factions.php?step=your&type=1",
      "https://www.torn.com/factions.php?step=your&type=1#/war/rank",
    ]) {
      const page = await bootUserscript(href, {
        visibilityState: "visible",
        storedValues: { warbuddy_display_mode: "floating" },
      });

      assert.equal(page.elements.has("warbuddy-panel"), true, href);
      assert.equal(page.storageValues.get("warbuddy_display_mode"), "floating");
      assert.equal(page.menuCommands.has("Warbuddy: use native layout"), true);
      assert.equal(page.menuCommands.has("Warbuddy: use floating panel"), true);

      page.menuCommands.get("Warbuddy: use native layout")();
      assert.equal(page.elements.has("warbuddy-panel"), false, `${href} after switching native`);
      assert.equal(page.storageValues.get("warbuddy_display_mode"), "native");

      page.menuCommands.get("Warbuddy: use floating panel")();
      assert.equal(page.elements.has("warbuddy-panel"), true, `${href} after switching floating`);
      assert.equal(page.storageValues.get("warbuddy_display_mode"), "floating");
    }

    for (const href of [
      "https://www.torn.com/page.php?sid=attack&user2ID=123",
      "https://www.torn.com/profiles.php?XID=123",
    ]) {
      const page = await bootUserscript(href, {
        visibilityState: "visible",
        storedValues: { warbuddy_display_mode: "floating" },
      });
      assert.equal(page.elements.has("warbuddy-panel"), false, `${href} before backend war eligibility`);
      assert.equal(page.storageValues.get("warbuddy_display_mode"), "floating");
    }
  });

  it("injects only on Torn faction and page routes, with exact runtime activation", async () => {
    const header = await readFile(new URL("../userscript.header.txt", import.meta.url), "utf8");
    assert.match(header, /^\/\/ @name\s+Warbuddy$/m);
    assert.match(header, /Grussniffer\/Warbuddy\/main\/warbuddy\.user\.js/);
    assert.doesNotMatch(header, /Askelads|The Lads/i);
    assert.match(header, /@sandbox\s+DOM/);
    assert.match(header, /@match\s+https:\/\/www\.torn\.com\/factions\.php\*/);
    assert.match(header, /@match\s+https:\/\/www\.torn\.com\/profiles\.php\*/);
    assert.match(header, /@match\s+https:\/\/torn\.com\/profiles\.php\*/);
    assert.match(header, /@include\s+https:\/\/www\.torn\.com\/page\.php\?\*sid=attack\*/);
    assert.doesNotMatch(header, /@match\s+https:\/\/www\.torn\.com\/\*/);
  });
});
