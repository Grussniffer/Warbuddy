import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";

const require = createRequire(import.meta.url);
const core = require("../src/core.cjs");

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
    assert.match(sessionRefreshSource, /expiresAt <= Date\.now\(\) \+ 30_000/);
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
    assert.ok(source.includes('data-dibs-action="claim"') || source.includes('const action = claim || !canClaim ? "inspect" : "claim"'));
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
    assert.match(markupSource, /const action = claim \|\| !canClaim \? "inspect" : "claim"/);
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
    assert.match(sharedDataSource, /applyEvent\(String\(payload\.topic\), payload\.payload, "shared-live-event"\)/);
    assert.match(socketSource, /applyEvent\(String\(message\.topic\), message\.payload, "websocket"\)/);
    assert.match(sharedRequestSource, /const leaderId = tabBroker\.leaderId\(\)/);
    assert.match(sharedRequestSource, /requestSequence !== state\.sharedStateRequestSequence/);
    assert.match(sharedRequestSource, /tabBroker\?\.leaderId\(\) !== leaderId/);
  });

  it("removes a released Dibs target from personal watch without discarding other draft edits", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");

    assert.ok(source.includes("function applyReleasedTargetWatchState(memberId, response)"));
    assert.ok(source.includes("savedTargetIds().filter((candidate) => candidate !== memberId)"));
    assert.ok(source.includes("normalizeTargetIds(state.targetDraft).filter((candidate) => candidate !== memberId)"));
    assert.ok(source.includes('if (action === "release") applyReleasedTargetWatchState(memberId, response)'));
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
    assert.match(surfaceSource, /const hasWarbuddySurface = \(\) => !!targetPageMemberId\(\) \|\| isRosterModePage\(\) \|\| state\.displayMode === "floating"/);
    assert.doesNotMatch(source, /state\.collapsed|COLLAPSED_STORAGE/);
    assert.doesNotMatch(statusSource, /collapsed|Expand and resume|Collapse and pause/);
    assert.match(statusSource, /if \(document\.visibilityState === "hidden"\) return \{ label: "Paused while hidden", tone: "" \}/);
  });
});

describe("Warbuddy userscript source contracts", () => {
  it("uses native surfaces by default and mounts the full controls as floating only when opted in", async () => {
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
    assert.match(modeSource, /removeIntegratedMount\(true\).*scheduleRender\(\).*syncForegroundState\(\)/);
    assert.doesNotMatch(modeSource, /new WebSocket|connectSocket|startFallbackPolling|setInterval|requestJson/);
    assert.match(mountSource, /if \(state\.displayMode === "floating"\) \{ removeIntegratedMount\(true\); return \{ mount: document\.body, placement: "floating", fallback: false \}/);
    assert.match(source, /const isRosterModePage = \(view = null\) => core\.isOwnRankedWarPageUrl\(/);
    assert.match(mountSource, /const desiredPlacement = isRosterModePage\(view\) \? "rank" : ""/);
    assert.match(mountSource, /createRankedWarHost\(view, board\)/);
    assert.match(mountSource, /placement: "inline", fallback: false/);
    assert.match(mountSource, /return \{ mount: null, placement: "none", fallback: false \}/);
    assert.match(inlineSource, /isRosterModePage\(view\)/);
    assert.doesNotMatch(inlineSource, /state\.displayMode/, "ranked-row Retal and Dibs indicators stay native in both layouts");
    assert.match(renderSource, /const targetPage = !!targetPageMemberId\(\)/);
    assert.match(renderSource, /if \(targetPage\) syncTargetPageContext\(view\)/);
    assert.match(renderSource, /if \(state\.displayMode !== "floating" && targetPage\)/);
    assert.match(renderSource, /if \(state\.displayMode !== "floating" && !rankedWarPage\)/);
    assert.match(renderSource, /const panelMarkup = `\$\{rosterMode \? rosterHeader : standardHeader\}<div class="wc-body">\$\{panelBody\}<\/div>`/);
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
    assert.equal(core.profileMemberIdFromUrl("https://www.torn.com/profiles.php?XID=3601225"), 3601225);
    assert.equal(core.profileMemberIdFromUrl("/profiles.php?xid=3601225"), 3601225);
    assert.equal(core.profileMemberIdFromUrl("https://example.com/profiles.php?XID=3601225"), 0);
    assert.equal(core.profileMemberIdFromUrl("https://www.torn.com/factions.php?ID=3601225"), 0);
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
      return context;
    };

    const matched = resolve({ attackIds: [99, 42] });
    assert.equal(matched.result, matched.row);
    assert.equal(core.attackPageTargetId(matched.link.href), 42);

    const wrongAttack = resolve({ attackIds: [99] });
    assert.equal(wrongAttack.result, null);
    assert.equal(wrongAttack.link, null);

    const mixedProfiles = resolve({ attackIds: [42], extraProfiles: [profileLink(99)] });
    assert.equal(mixedProfiles.result, null);
  });

  it("refuses to discover a roster board through a permissive enemy-row fallback", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");
    const enemyAnchorSource = compactSource(sourceSection(
      source,
      "function enemyProfileAnchors",
      "function rankedWarAttackLinkForMember"
    ));
    const boardSource = sourceSection(
      source,
      "function rankedWarBoardForView",
      "function markRankedWarBoard"
    );
    const ownAnchor = {};
    const enemyAnchor = {};
    const ownRow = {};
    let enemyFallbackCalls = 0;
    let commonAncestorCalls = 0;
    const context = {
      result: {},
      view: { ownRoster: [{}], enemyRoster: [{}] },
      document: { body: {}, documentElement: {} },
      rosterProfileAnchors() { return [ownAnchor]; },
      enemyProfileAnchors() { return [enemyAnchor]; },
      rankedWarOwnRowForAnchor(anchor) {
        if (anchor === enemyAnchor) {
          enemyFallbackCalls += 1;
          return {};
        }
        return ownRow;
      },
      rankedWarRowForAnchor() { return null; },
      lowestCommonAncestor() { commonAncestorCalls += 1; return {}; },
    };
    runInNewContext(`${boardSource}\nresult = rankedWarBoardForView(view);`, context);

    assert.equal(context.result, null);
    assert.equal(enemyFallbackCalls, 0);
    assert.equal(commonAncestorCalls, 0);
    assert.match(enemyAnchorSource, /!rankedWarRowForAnchor\(anchor\)/);
    assert.doesNotMatch(enemyAnchorSource, /rankedWarOwnRowForAnchor/);
    assert.doesNotMatch(boardSource, /rankedWarOwnRowForAnchor\(enemyAnchor\)/);
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
    assert.match(missingSource, /const board = rankedWarBoardForView\(view\)/);
    assert.match(missingSource, /if \(!board\?\.parentElement \|\| board\.isConnected === false\) return floatingPanelMissing/);
    assert.match(missingSource, /if \(!document\.getElementById\(PANEL_ID\)\) return true/);
    assert.match(missingSource, /const anchors = rosterProfileAnchors\(view\.enemyRoster, board\)/);
    assert.match(missingSource, /const row = rankedWarRowForAnchor\(anchor\); const attackLink = rankedWarAttackLinkForMember\(row, memberId\)/);
    assert.doesNotMatch(missingSource, /const anchors = enemyProfileAnchors\(view\)/);
    assert.match(missingSource, /return !tools \|\| !rosterActions/);
    assert.match(observerSource, /if \(window\.location\.href !== state\.lastPageHref\) \{ syncPageActivation\(\); return; \}/);
    assert.match(observerSource, /const outsideWarbuddy = mutations\.some/);
    assert.match(observerSource, /if \(!outsideWarbuddy\) return/);
    assert.match(observerSource, /if \(activeSurfaceMissing\(\)\) scheduleRender\(\)/);
    assert.match(observerSource, /observe\(document\.body, \{ childList: true, subtree: true \}\)/);
    assert.match(heartbeatSource, /href !== state\.lastPageHref \|\| activeSurfaceMissing\(\)/);
  });

  it("waits for a verified common board before mounting the ranked-war strip", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");
    const rowSource = compactSource(sourceSection(
      source,
      "function lowestCommonAncestor",
      "function resolvePanelMount"
    ));
    const mountSource = compactSource(sourceSection(source, "function resolvePanelMount", "async function getProfileWithKey"));
    const styleSource = compactSource(sourceSection(source, "addStyle(`", "const normalizeResponse"));
    const wrapperRoot = compactSource(styleSource.match(/#\$\{INTEGRATED_WRAPPER_ID\} \{([^}]*)\}/)?.[1]);

    assert.match(source, /const SAFE_INTEGRATED_PARENT_DISPLAYS = new Set\(\["block", "flow-root", "list-item"\]\)/);
    assert.match(rowSource, /function rankedWarBoardForView\(view\)/);
    assert.match(rowSource, /lowestCommonAncestor\(ownRow, enemyRow\)/);
    assert.match(rowSource, /board\.contains\?\.\(ownRow\)/);
    assert.match(rowSource, /board\.contains\?\.\(enemyRow\)/);
    assert.match(rowSource, /if \(best\) return best; return null/);
    assert.doesNotMatch(rowSource, /const domRows/);
    assert.match(rowSource, /const ownAnchors = rosterProfileAnchors\(view\?\.ownRoster\)\.slice\(0, 16\)/);
    assert.match(rowSource, /const enemyAnchors = enemyProfileAnchors\(view\)\.slice\(0, 8\)/);
    assert.match(rowSource, /if \(checkedBoards\.has\(board\)\) continue; checkedBoards\.add\(board\)/);
    assert.match(rowSource, /function markRankedWarBoard\(board\)/);
    assert.match(rowSource, /board && markedBoards\.length === 1 && markedBoards\[0\] === board/);
    assert.match(rowSource, /board\.dataset\.warbuddyRosterBoard = "1"/);
    assert.match(rowSource, /function rankedWarSafeMountPoint\(parent, before, wrapper = null\)/);
    assert.match(rowSource, /SAFE_INTEGRATED_PARENT_DISPLAYS\.has\(display\)/);
    assert.match(rowSource, /mountBefore = mountParent; mountParent = mountParent\.parentElement/);
    assert.match(rowSource, /function rankedWarMountPoint\(board, wrapper = null\)/);
    assert.match(rowSource, /if \(!board\?\.parentElement \|\| board\.isConnected === false\) return null/);
    assert.match(rowSource, /return rankedWarSafeMountPoint\(board\.parentElement, board, wrapper\)/);
    assert.doesNotMatch(rowSource, /#mainContainer|mainContainer\.firstChild/);
    assert.match(rowSource, /function createRankedWarHost\(view, board = rankedWarBoardForView\(view\)\) \{ if \(!board\?\.parentElement \|\| board\.isConnected === false\) return null/);
    assert.match(rowSource, /wrapper\.dataset\.warbuddyBoardVerified = "1"/);
    assert.match(rowSource, /const mountPoint = rankedWarMountPoint\(board\)/);
    assert.match(rowSource, /mountPoint\.parent\.insertBefore\(wrapper, mountPoint\.before\)/);
    assert.doesNotMatch(rowSource, /\.insertBefore\(wrapper, (?:board|row)\b/);

    assert.match(mountSource, /const board = rankedWarBoardForView\(view\); if \(!host && board\?\.parentElement && board\.isConnected !== false\) \{ host = createRankedWarHost\(view, board\)/);
    assert.match(mountSource, /const wrapper = document\.getElementById\(INTEGRATED_WRAPPER_ID\); if \(board\?\.parentElement && board\.isConnected !== false\) \{ markRankedWarBoard\(board\)/);
    assert.match(mountSource, /if \(wrapper\) wrapper\.dataset\.warbuddyBoardVerified = "1"/);
    assert.match(mountSource, /const mountPoint = rankedWarMountPoint\(board, wrapper\)/);
    assert.match(mountSource, /wrapper\.parentNode !== mountPoint\.parent \|\| wrapper\.nextSibling !== mountPoint\.before/);
    assert.match(mountSource, /mountPoint\.parent\.insertBefore\(wrapper, mountPoint\.before\)/);
    assert.doesNotMatch(mountSource, /markRankedWarBoard\(null\)|boardVerified = board \?/);

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

  it("never relocates an existing ranked-war strip through a transient fallback", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");
    const resolveSource = sourceSection(source, "function resolvePanelMount", "function setDisplayMode");
    const runResolve = ({ host = null, createdHost = null, board = null, wrapper = null, mountPoint = null, rosterMode = true } = {}) => {
      const events = { creates: 0, inserts: 0, marks: 0, removals: 0, boardChecks: 0 };
      const context = {
        result: null,
        events,
        state: { displayMode: "native" },
        window: { location: { href: "https://www.torn.com/factions.php#/war/rank" } },
        isRosterModePage() { return rosterMode; },
        PANEL_ID: "warbuddy-panel",
        INTEGRATED_HOST_ID: "warbuddy-integrated-host",
        INTEGRATED_WRAPPER_ID: "warbuddy-integrated-wrapper",
        document: {
          body: {},
          getElementById(id) {
            if (id === "warbuddy-integrated-host") return host;
            if (id === "warbuddy-integrated-wrapper") return wrapper;
            return null;
          },
        },
        removeIntegratedMount() { events.removals += 1; },
        createRankedWarHost() {
          events.creates += 1;
          return createdHost;
        },
        rankedWarBoardForView() { events.boardChecks += 1; return board; },
        markRankedWarBoard() { events.marks += 1; },
        rankedWarMountPoint() { return mountPoint; },
      };
      if (mountPoint?.parent) {
        mountPoint.parent.insertBefore = () => { events.inserts += 1; };
      }
      runInNewContext(`${resolveSource}\nresult = resolvePanelMount({});`, context);
      return { result: context.result, events };
    };

    const absent = runResolve();
    assert.equal(absent.result.mount, null);
    assert.equal(absent.events.creates, 0);
    assert.equal(absent.events.inserts, 0);

    const foreign = runResolve({
      host: { dataset: { placement: "rank" } },
      wrapper: {},
      rosterMode: false,
    });
    assert.equal(foreign.result.mount, null);
    assert.equal(foreign.events.boardChecks, 0);
    assert.equal(foreign.events.creates, 0);
    assert.equal(foreign.events.inserts, 0);
    assert.equal(foreign.events.removals, 1);

    const initialParent = {};
    const initialBefore = {};
    const initialHost = { dataset: { placement: "rank" } };
    const initialWrapper = {
      dataset: {},
      parentNode: initialParent,
      nextSibling: initialBefore,
    };
    const initial = runResolve({
      createdHost: initialHost,
      board: { parentElement: {}, isConnected: true },
      wrapper: initialWrapper,
      mountPoint: { parent: initialParent, before: initialBefore },
    });
    assert.equal(initial.result.placement, "inline");
    assert.equal(initial.events.creates, 1);
    assert.equal(initial.events.inserts, 0);
    assert.equal(initial.events.marks, 1);

    const stableParent = {};
    const stableBefore = {};
    const stableWrapper = {
      dataset: {},
      parentNode: stableParent,
      nextSibling: stableBefore,
    };
    const transient = runResolve({
      host: { dataset: { placement: "rank" } },
      board: null,
      wrapper: stableWrapper,
    });
    assert.equal(transient.result.placement, "inline");
    assert.equal(transient.events.inserts, 0);
    assert.equal(transient.events.marks, 0);

    const replacementParent = {};
    const replacementBefore = {};
    const replacement = runResolve({
      host: { dataset: { placement: "rank" } },
      board: { parentElement: {}, isConnected: true },
      wrapper: stableWrapper,
      mountPoint: { parent: replacementParent, before: replacementBefore },
    });
    assert.equal(replacement.result.placement, "inline");
    assert.equal(replacement.events.inserts, 1);
    assert.equal(replacement.events.marks, 1);
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
    assert.match(listenerSource, /state\.displayMode !== "floating" && isRosterModePage\(\)\) scheduleRender\(\)/);
    assert.match(listenerSource, /window\.addEventListener\("resize", handleViewportResize\)/);
    assert.match(listenerSource, /window\.visualViewport\?\.addEventListener\?\.\("resize", handleViewportResize\)/);
  });

  it("keeps roster filtering reversible while showing independent Retal and Dibs actions", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");
    const inlineSource = compactSource(sourceSection(source, "function syncIntegratedMemberTools", "function dibsMarkup"));
    const cleanupSource = compactSource(sourceSection(source, "function removeInlineMemberTools", "function removeIntegratedMount"));
    const mountCleanupSource = compactSource(sourceSection(source, "function removeIntegratedMount", "function rosterProfileAnchors"));
    const styleSource = compactSource(sourceSection(source, "addStyle(`", "const normalizeResponse"));

    assert.match(inlineSource, /if \(!canFindBoard\) \{ if \(state\.integratedDecorationsActive\) removeInlineMemberTools\(\); return/);
    assert.match(inlineSource, /const board = rankedWarBoardForView\(view\); if \(!board \|\| board\.isConnected === false\) return/);
    assert.match(inlineSource, /rosterProfileAnchors\(view\.enemyRoster, board\)/);
    assert.doesNotMatch(inlineSource, /: enemyProfileAnchors\(view\)|\[data-warbuddy-roster-board='1'\]/);
    assert.match(inlineSource, /const row = rankedWarRowForAnchor\(anchor\)/);
    assert.match(inlineSource, /const attackLink = rankedWarAttackLinkForMember\(row, memberId\)/);
    assert.doesNotMatch(inlineSource, /board\?\.contains\?\.\(anchor\)|rankedWarOwnRowForAnchor\(anchor\)/);
    assert.match(inlineSource, /core\.rosterFilterMatches\(state\.rosterFilter, flags\)/);
    assert.match(inlineSource, /core\.memberAvailability\(member, state\.nowMs\)/);
    assert.match(inlineSource, /syncIntegratedStatusCell\(row, attackLink, memberId, availability, keepStatusCells\)/);
    assert.doesNotMatch(inlineSource, /availabilityMarkup/);
    assert.match(inlineSource, /tools\.classList\.toggle\("quiet", !watched && !retaliation && !claim\)/);
    assert.match(inlineSource, /rosterActions\.className = ROSTER_ACTIONS_CLASS/);
    assert.match(inlineSource, /actionParent\.insertBefore\(rosterActions, attackLink\)/);
    assert.match(inlineSource, /const rosterDibsState = claim/);
    assert.match(inlineSource, /const rosterRetalState = retaliation/);
    assert.match(inlineSource, /wc-native-state wc-native-dibs/);
    assert.match(inlineSource, /wc-native-state wc-native-retal/);
    assert.match(inlineSource, /dibsMarkup\(member, view, claim, `roster-\$\{memberId\}`\)/);
    assert.match(inlineSource, /const fallbackDibsControl = !attackLink \? dibsMarkup\(member, view, claim, `roster-fallback-\$\{memberId\}`\) : ""/);
    assert.match(source, /function handleInlineToolAction\(event\) \{\s*if \(handleDibsControlAction\(event\)\) return/);
    assert.match(inlineSource, /warbuddy-attack-dibs-mine/);
    assert.match(inlineSource, /warbuddy-attack-dibs-taken/);
    assert.match(inlineSource, /core\.rosterOrder\(flags, member, state\.nowMs\)/);
    assert.match(inlineSource, /ffscouterFilterActive\(\)/);
    assert.match(inlineSource, /tornRosterSortState\(decoratedRows, board\)/);
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
    assert.match(styleSource, /\.\$\{ROSTER_ACTIONS_CLASS\} \{ display:inline-flex; min-width:0; max-width:min\(190px,45vw\); flex-wrap:nowrap;[\s\S]*?overflow:hidden/);
    assert.match(styleSource, /\.\$\{ROSTER_ACTIONS_CLASS\} \.wc-native-state \{ min-width:0; max-width:86px; flex:0 1 auto; overflow:hidden; text-overflow:ellipsis/);
  });

  it("reconciles Torn status, reuses native colors, and avoids unchanged roster rewrites", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");
    const statusSource = compactSource(sourceSection(
      source,
      "function tornStatusCategory",
      "function syncIntegratedMemberTools"
    ));
    const inlineSource = compactSource(sourceSection(source, "function syncIntegratedMemberTools", "function dibsMarkup"));
    const styleSource = compactSource(sourceSection(source, "addStyle(`", "const normalizeResponse"));
    const clockSource = compactSource(sourceSection(source, "function tornPageNowMs", "function removeInlineMemberTools"));

    assert.match(statusSource, /const mismatch = !!tornCategory && !!backendCategory && tornCategory !== backendCategory/);
    assert.match(statusSource, /!availability\?\.label \|\| \(tornCategory && !backendCategory\)/);
    assert.match(statusSource, /clearIntegratedStatusCell\(statusCell, false\)/);
    assert.match(statusSource, /warbuddyStatusMismatch/);
    assert.match(inlineSource, /inlineMarkupCache\.get\(tools\) !== toolsMarkup/);
    assert.match(inlineSource, /tools\.addEventListener\("click", handleInlineToolAction\)/);
    assert.doesNotMatch(inlineSource, /querySelector\?\.\('\[data-inline-action="watch"\]'\)\?\.addEventListener/);
    assert.match(styleSource, /var\(--user-status-blue-color,#22d3ee\)/);
    assert.match(styleSource, /var\(--user-status-red-color,#f87171\)/);
    assert.match(clockSource, /pageWindow\.getCurrentTimestamp\(\)/);
    assert.match(clockSource, /core\.trustedClockOffset\(value, Date\.now\(\)\)/);
    assert.match(source, /syncTrustedClock\(snapshot\?\.generatedAt, "snapshot"\)/);
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

  it("uses one compact native target context on profile and attack pages", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");
    const activationSource = compactSource(sourceSection(
      source,
      "function syncPageActivation",
      "function syncVisibilityState"
    ));
    const contextSource = compactSource(sourceSection(
      source,
      "function targetContextMountPoint",
      "function handleTargetContextAction"
    ));
    const attackMountSource = compactSource(sourceSection(
      source,
      "function attackTargetLabelsContainer",
      "function targetContextMountPoint"
    ));
    const profileMountSource = compactSource(sourceSection(
      source,
      "function profileTargetContainer",
      "function targetContextMountPoint"
    ));
    const relevanceSource = compactSource(sourceSection(
      source,
      "function targetPageFactionEligible",
      "function attackTargetLabelsContainer"
    ));
    const compactMarkupSource = compactSource(sourceSection(
      source,
      "if (state.attackTargetId || state.profileTargetId)",
      "function handleTargetContextAction"
    ));
    const actionSource = compactSource(sourceSection(
      source,
      "function handleTargetContextAction",
      "function syncTargetPageContext"
    ));
    const syncContextSource = compactSource(sourceSection(
      source,
      "function syncTargetPageContext",
      "function capturePanelFocus"
    ));
    const renderSource = compactSource(sourceSection(source, "function render()", "function forgetStoredKey"));

    assert.match(activationSource, /const nextAttackTargetId = active \? core\.attackPageTargetId\(href\) : 0/);
    assert.match(activationSource, /const nextProfileTargetId = active \? core\.profilePageTargetId\(href\) : 0/);
    assert.match(attackMountSource, /\[class\*='labelsContainer'\]/);
    assert.match(attackMountSource, /core\.profileMemberIdFromUrl/);
    assert.match(attackMountSource, /candidate\.closest\?\.\("\[class\*='defender'\]"\)/);
    assert.match(attackMountSource, /const matchedDefender = defenderCandidates\.find\(\(\{ defender \}\) => matchesTargetProfile\(defender\)\)/);
    assert.match(attackMountSource, /if \(defenderCandidates\.length === 1\) return defenderCandidates\[0\]\.candidate/);
    assert.match(attackMountSource, /return locallyMatched\.length === 1 \? locallyMatched\[0\] : null/);
    assert.match(contextSource, /if \(state\.attackTargetId\) \{ const attackMount = attackTargetLabelsContainer\(\); if \(!attackMount\) return null; return \{ parent: attackMount, before: null, placement: "attack" \}/);
    assert.match(relevanceSource, /registeredFactionId === ownFactionId/);
    assert.match(relevanceSource, /state\.session\?\.access === "war_companion"/);
    assert.match(relevanceSource, /state\.settings\?\.enabled === true/);
    assert.match(relevanceSource, /!!view\?\.alliedScore\?\.start/);
    assert.match(relevanceSource, /enemyFactionId !== ownFactionId/);
    assert.match(relevanceSource, /!memberId \|\| !targetPageFactionEligible\(view\)/);
    assert.match(relevanceSource, /if \(state\.attackTargetId\) return true/);
    assert.match(relevanceSource, /savedTargetIds\(\)\.includes\(memberId\)/);
    assert.match(relevanceSource, /view\?\.enemyRoster/);
    assert.match(relevanceSource, /view\?\.retaliation/);
    assert.match(relevanceSource, /memberLoadout\(view, memberId\)/);
    assert.match(relevanceSource, /core\.activeDibsClaim\(view\?\.dibs, memberId, state\.nowMs\)/);
    assert.match(profileMountSource, /document\.getElementById\?\.\(TARGET_CONTEXT_ID\)/);
    assert.match(profileMountSource, /existing\?\.classList\?\.contains\?\.\("wc-profile-context"\)/);
    assert.match(profileMountSource, /Number\(existing\.dataset\?\.memberId \|\| 0\) === targetId/);
    assert.match(profileMountSource, /existing\.parentElement\.matches\?\.\("\.profile-container"\)/);
    assert.match(profileMountSource, /document\.querySelectorAll\?\.\("\.profile-container"\)/);
    assert.match(profileMountSource, /querySelectorAll\?\.\("a\[href\*='sid=attack'\]"\)/);
    assert.match(profileMountSource, /core\.attackPageTargetId\(control\.getAttribute\?\.\("href"\) \|\| control\.href \|\| ""\) === targetId/);
    assert.match(profileMountSource, /return candidates\.length === 1 \? candidates\[0\] : null/);
    assert.doesNotMatch(profileMountSource, /profileWrapper|mainContainer|\[class\*='profile-container'\]|nativeControls/);
    assert.match(contextSource, /if \(!state\.profileTargetId\) return null; const profileMount = profileTargetContainer\(\); if \(!profileMount\) return null/);
    assert.match(contextSource, /return \{ parent: profileMount, before: null, placement: "profile" \}/);
    assert.match(contextSource, /const memberId = targetPageMemberId\(\)/);
    assert.match(compactMarkupSource, /const surface = state\.attackTargetId \? "attack" : "profile"/);
    assert.match(compactMarkupSource, /wc-native-state wc-native-dibs/);
    assert.match(compactMarkupSource, /wc-native-state wc-native-retal/);
    assert.match(compactMarkupSource, /dibsMarkup\(targetRecord, view, claim, `\$\{surface\}-\$\{memberId\}`\)/);
    assert.match(compactMarkupSource, /state\.profileTargetId && savedKey \? loadoutMarkup\(view, memberId\) : ""/);
    assert.match(compactMarkupSource, /const compactWatchControl = savedKey && \(enemyMember \|\| watched\)/);
    assert.match(compactMarkupSource, /data-action="toggle-watch"/);
    assert.match(compactMarkupSource, /data-target-member="\$\{memberId\}"/);
    assert.match(compactMarkupSource, /data-action="set-display-mode"/);
    assert.match(compactMarkupSource, /data-display-mode="\$\{floating \? "native" : "floating"\}"/);
    assert.match(compactMarkupSource, /wc-native-brand wc-attack-brand/);
    assert.doesNotMatch(compactMarkupSource, /wc-native-target|wc-native-details|wc-native-key|War roster|showKeyEditor|Connect Warbuddy/);
    assert.match(actionSource, /event\.currentTarget\?\.classList\?\.contains\("wc-compact-context"\)\) event\.stopPropagation\(\)/);
    assert.match(syncContextSource, /context\.id = TARGET_CONTEXT_ID/);
    assert.match(syncContextSource, /!state\.active \|\| !memberId \|\| !targetPageContextRelevant\(view\)/);
    assert.match(syncContextSource, /context\.addEventListener\("click", handleTargetContextAction\)/);
    assert.match(syncContextSource, /context\.addEventListener\("pointerdown", \(event\) => \{ if \(event\.currentTarget\?\.classList\?\.contains\("wc-compact-context"\)\) event\.stopPropagation\(\)/);
    assert.match(syncContextSource, /const expectedTagName = mountPoint\.placement === "attack" \? "SPAN" : "DIV"/);
    assert.match(syncContextSource, /document\.createElement\(expectedTagName\.toLowerCase\(\)\)/);
    assert.match(syncContextSource, /warbuddy-target-context wc-compact-context wc-\$\{mountPoint\.placement\}-context/);
    assert.match(syncContextSource, /const profileHost = mountPoint\.placement === "profile" \? mountPoint\.parent : null/);
    assert.match(syncContextSource, /hostPosition === "static"\) profileHost\.classList\?\.add\?\.\(PROFILE_HOST_CLASS\)/);
    assert.match(syncContextSource, /mountPoint\.parent\.insertBefore\(context, mountPoint\.before \|\| null\)/);
    assert.match(renderSource, /const targetPage = !!targetPageMemberId\(\)/);
    assert.match(renderSource, /if \(targetPage && !targetPageFactionEligible\(view\)\) \{ document\.getElementById\(PANEL_ID\)\?\.remove\(\); removeTargetContext\(\); removeInlineMemberTools\(\); removeIntegratedMount\(false\); stopAttackOutcomeDetection\(\); return; \}/);
    assert.match(renderSource, /if \(targetPage\) syncTargetPageContext\(view\); else removeTargetContext\(\)/);
    assert.match(renderSource, /if \(state\.displayMode !== "floating" && targetPage\)/);
    assert.doesNotMatch(source, /function attackTargetMarkup|Current Torn target/);
  });

  it("mounts profiles only in one target-specific stable Actions container", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");
    const mountSource = sourceSection(source, "function profileTargetContainer", "function targetContextMarkup");
    const attackControl = (memberId) => ({
      href: `https://www.torn.com/page.php?sid=attack&user2ID=${memberId}`,
      getAttribute() { return this.href; },
    });
    const container = (controls = [], isConnected = true) => ({
      isConnected,
      querySelectorAll() {
        return controls;
      },
    });
    const resolveMount = ({ candidates = [], existing = null } = {}) => {
      const context = {
        result: null,
        TARGET_CONTEXT_ID: "warbuddy-target-context",
        state: { attackTargetId: 0, profileTargetId: 42 },
        core: {
          attackPageTargetId(value) {
            return Number(new URL(value, "https://www.torn.com/").searchParams.get("user2ID") || 0);
          },
        },
        document: {
          getElementById() {
            return existing;
          },
          querySelectorAll(selector) {
            return selector === ".profile-container" ? candidates : [];
          },
        },
      };
      runInNewContext(`${mountSource}\nresult = targetContextMountPoint();`, context);
      return context.result;
    };

    const exact = container([attackControl(42)]);
    const mounted = resolveMount({ candidates: [exact] });
    assert.equal(mounted.parent, exact);
    assert.equal(mounted.before, null);
    assert.equal(mounted.placement, "profile");
    assert.equal(resolveMount({ candidates: [container([])] }), null);
    assert.equal(resolveMount({ candidates: [container([attackControl(41)])] }), null);
    assert.equal(resolveMount({ candidates: [container([attackControl(42)], false)] }), null);
    assert.equal(resolveMount({ candidates: [container([attackControl(42)]), container([attackControl(42)])] }), null);

    const establishedParent = container([]);
    establishedParent.matches = (selector) => selector === ".profile-container";
    const existingContext = {
      dataset: { memberId: "42" },
      parentElement: establishedParent,
      classList: { contains(value) { return value === "wc-profile-context"; } },
    };
    assert.equal(resolveMount({ existing: existingContext }).parent, establishedParent);
    assert.equal(resolveMount({ existing: { ...existingContext, dataset: { memberId: "41" } } }), null);
    assert.equal(resolveMount({ existing: {
      ...existingContext,
      parentElement: { ...establishedParent, matches() { return false; } },
    } }), null);
    assert.doesNotMatch(mountSource, /profileWrapper|mainContainer|\[class\*='profile-container'\]|nativeControls/);
  });

  it("leaves unrelated player profiles untouched while preserving actionable contexts", async () => {
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

    assert.equal(isRelevant(), false);
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

  it("blocks stale or offline mutations and removes only generic online suggestions", async () => {
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
    assert.match(sessionViewSource, /\.filter\(\(item\) => genericSuggestionsEnabled \|\| !String\(item\.key \|\| ""\)\.startsWith\("online-"\)\)/);
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
    assert.match(dibsMarkupSource, /const action = claim \|\| !canClaim \? "inspect" : "claim"/);
    assert.match(dibsMarkupSource, /!canRelease \|\| anyBusy \? " disabled" : ""/);
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
    assert.match(profileRoot, /position:absolute !important; inset:auto 6px 6px auto !important; z-index:6; display:inline-flex; width:auto; max-width:calc\(100% - 12px\); height:26px; max-height:26px/);
    assert.doesNotMatch(profileRoot, /position:static|flex-wrap:wrap|box-shadow|(?:^|;\s*)width:100%|flex:(?:1|0) 0 100%/);
    assert.match(styleSource, /\.\$\{PROFILE_HOST_CLASS\} \{ position:relative !important; \}/);
    assert.match(compactStates, /min-width:0; max-width:100%; flex:1 1 auto/);
    assert.match(compactStates, /overflow:hidden/);
    assert.doesNotMatch(compactStates, /flex:0 0 auto/);
    assert.match(compactActions, /min-width:0; flex:0 0 auto; flex-wrap:nowrap; gap:2px; margin-left:auto/);
    assert.match(compactState, /min-width:0; min-height:20px; max-width:145px; flex:0 1 auto; overflow:hidden/);
    assert.match(compactResult, /min-width:0; min-height:20px; max-width:150px; flex:0 1 auto/);
    assert.match(profileLoadoutTip, /top:auto; bottom:calc\(100% \+ 4px\)/);
    assert.match(styleSource, /@media \(pointer:coarse\) \{ #\$\{TARGET_CONTEXT_ID\} \.wc-button,[\s\S]*?min-width:36px; min-height:36px/);
    assert.match(styleSource, /#\$\{TARGET_CONTEXT_ID\} \.wc-attack-icon,[\s\S]*?min-width:36px; min-height:36px/);
    assert.match(styleSource, /#\$\{TARGET_CONTEXT_ID\}\.wc-profile-context \{ height:44px; max-height:44px/);
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
