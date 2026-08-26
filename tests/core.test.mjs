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

  it("matches backend Dibs eligibility for hospital and Torn targets", () => {
    const nowMs = 2_000_000_000_000;
    assert.equal(core.dibsEligibility({
      status: { userStatus: "Hospital", untill: nowMs + 5 * 60_000 },
      location: { current: "Torn" },
    }, nowMs).eligible, true);
    assert.equal(core.dibsEligibility({
      status: { userStatus: "Hospital", untill: nowMs + 5 * 60_000 + 1 },
      location: { current: "Torn" },
    }, nowMs).eligible, false);
    assert.equal(core.dibsEligibility({
      status: { userStatus: "Okay" },
      location: { current: "Torn" },
    }, nowMs).eligible, true);
    assert.equal(core.dibsEligibility({
      status: { userStatus: "Okay" },
      location: { current: "Mexico" },
    }, nowMs).eligible, false);
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

  it("keeps compatible-mode recovery bounded and pauses expensive PDA rendering", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");

    assert.ok(source.includes("const FALLBACK_POLL_MS = 2_000"));
    assert.ok(source.includes("const FALLBACK_POLL_MAX_MS = 10_000"));
    assert.ok(source.includes("core.fallbackPollDelayMs({"));
    assert.ok(source.includes("revision=${encodeURIComponent(state.fallbackRevision)}"));
    assert.ok(source.includes("markFallbackSnapshotUnchanged(snapshot)"));
    assert.ok(source.includes("if (!isTornPda || !state.fallbackActive) scheduleRender()"));
    assert.ok(source.includes('state.pageObserver.observe(document.body, { childList: true })'));
    assert.ok(!source.includes('state.pageObserver.observe(document.body, { childList: true, subtree: true })'));
    assert.ok(source.includes('document.addEventListener("visibilitychange", syncVisibilityState)'));
    assert.ok(source.includes("cancelAnimationFrame(state.renderFrame)"));
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
    const renderSource = compactSource(sourceSection(source, "function render()", "function forgetStoredKey"));

    assert.match(authenticateSource, /state\.authTerminal = isTerminalAuthenticationError\(error\)/);
    assert.match(authenticateSource, /if \(state\.authTerminal\) state\.keyEditorOpen = true/);
    assert.match(reconnectSource, /if \(!isForeground\(\) \|\| state\.reconnectTimer \|\| state\.authTerminal\) return/);
    assert.match(reconnectSource, /if \(!isForeground\(\) \|\| !getStoredKey\(\) \|\| state\.authTerminal\) return/);
    assert.match(reconnectSource, /if \(!state\.authTerminal\) scheduleReconnect\(\)/);
    assert.match(renderSource, /const showKeyEditor = !savedKey \|\| state\.keyEditorOpen \|\| state\.authTerminal/);
    assert.match(renderSource, /savedKey \? "Replacement Torn API key" : "Torn API key"/);
    assert.match(renderSource, /savedKey \? "Replace" : "Connect"/);
  });

  it("does not replace an API key while the player is entering it", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");

    assert.ok(source.includes('keyDraft: ""'));
    assert.ok(source.includes('if (getStoredKey()) startTicker();\n      else stopTicker();'));
    assert.ok(source.includes('keyInput?.addEventListener("input"'));
    assert.ok(source.includes('state.keyDraft = String(event.currentTarget?.value || "")'));
    assert.ok(source.includes('value="${escapeHtml(state.keyDraft)}"'));
    assert.ok(source.includes('const key = String(input?.value || state.keyDraft || "").trim()'));
  });

  it("keeps live state and named factions compact in the header", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");

    assert.ok(source.includes('class="wc-header-status"'));
    assert.ok(source.includes('class="wc-matchup"'));
    assert.ok(source.includes("const enemyScore = core.scoreForFaction(state.scores, enemyFactionId);"));
    assert.ok(source.includes('{ side: "Us", faction: ownFactionLabel'));
    assert.ok(source.includes('{ side: "Them", faction: enemyFactionLabel'));
    assert.ok(source.includes('class="wc-chains"'));
    assert.ok(source.includes('class="wc-roster-chains"'));
    assert.ok(source.includes("ownFactionName"));
    assert.ok(source.includes("enemyFactionName"));
    assert.ok(source.includes("factionNames: new Map()"));
    assert.doesNotMatch(source, /<div class="wc-status">/);
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

    assert.ok(source.includes("const SCRIPT_CHECK_IN_INTERVAL_MS = 10 * 60 * 1000"));
    assert.ok(source.includes('data: JSON.stringify({ tornApiKey: key, scriptVersion: SCRIPT_VERSION })'));
    assert.ok(source.includes('/war-companion/check-in'));
    assert.ok(source.includes('Authorization: `Bearer ${state.token}`'));
    assert.ok(source.includes('data: JSON.stringify({ scriptVersion: SCRIPT_VERSION, transport })'));
    assert.ok(source.includes('if (state.phase === "connected") void recordScriptCheckIn("websocket")'));
    assert.ok(source.includes('if (state.phase === "fallback") void recordScriptCheckIn("compatible")'));
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
    assert.ok(source.includes('data-dibs-action="claim"') || source.includes('const action = claim ? "inspect" : "claim"'));
    assert.ok(source.includes('data-dibs-action="release"'));
    assert.ok(source.includes("wc-action-section .wc-dibs-tip"));
    assert.match(source, /\.wc-dibs-tip\s*\{[^}]*position:\s*fixed/);
    assert.match(tipPositionSource, /const viewport = window\.visualViewport/);
    assert.match(tipPositionSource, /tip\.style\.left =/);
    assert.match(tipPositionSource, /tip\.style\.top =/);
    assert.match(source, /\.wc-dibs\s*\{[^}]*width:\s*16px;\s*height:\s*16px/);
    assert.doesNotMatch(source, /api\.torn\.com[^\n]*dibs/i);
  });

  it("removes a released Dibs target from personal watch without discarding other draft edits", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");

    assert.ok(source.includes("function applyReleasedTargetWatchState(memberId, response)"));
    assert.ok(source.includes("savedTargetIds().filter((candidate) => candidate !== memberId)"));
    assert.ok(source.includes("normalizeTargetIds(state.targetDraft).filter((candidate) => candidate !== memberId)"));
    assert.ok(source.includes('if (action === "release") applyReleasedTargetWatchState(memberId, response)'));
  });

  it("does not start the one-second ticker before a key is submitted", async () => {
    const page = await bootUserscript("https://www.torn.com/factions.php?step=your&type=1", {
      visibilityState: "visible",
    });

    assert.equal(page.intervalCount(), 1, "only the faction-route watcher should be running");
  });

  it("persists a draggable panel position", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");

    assert.ok(source.includes('const POSITION_STORAGE = "warbuddy_position"'));
    assert.ok(source.includes('[KEY_STORAGE]: "lads_war_companion_api_key"'));
    assert.ok(source.includes('storage.set(key, legacyValue)'));
    assert.ok(source.includes('header.addEventListener("pointerdown"'));
    assert.ok(source.includes('header.addEventListener("pointermove"'));
    assert.ok(source.includes("setPanelPosition(panel, { left: rect.left, top: rect.top }, true)"));
    assert.ok(source.includes('registerMenuCommand("Warbuddy: reset position"'));
  });

  it("migrates existing local settings to faction-neutral storage keys", async () => {
    const page = await bootUserscript("https://www.torn.com/factions.php?step=your&type=1", {
      storedValues: {
        lads_war_companion_api_key: "legacy-key",
        lads_war_companion_collapsed: "1",
        lads_war_companion_position: '{"left":20,"top":30}',
      },
    });

    assert.equal(page.storageValues.get("warbuddy_api_key"), "legacy-key");
    assert.equal(page.storageValues.get("warbuddy_collapsed"), "1");
    assert.equal(page.storageValues.get("warbuddy_position"), '{"left":20,"top":30}');
    assert.equal(page.storageValues.has("lads_war_companion_api_key"), false);
    assert.equal(page.storageValues.has("lads_war_companion_collapsed"), false);
    assert.equal(page.storageValues.has("lads_war_companion_position"), false);
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

  it("pauses a collapsed floating panel without pausing the collapsed roster strip", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");
    const statusSource = compactSource(sourceSection(source, "const statusView", "function dibsMarkup"));

    assert.ok(source.includes("const isForeground = () => state.active\n    && (!state.collapsed || isRosterModePage())"));
    assert.ok(source.includes('title="${state.collapsed ? "Expand and resume" : "Collapse and pause"}"'));
    assert.ok(source.includes('storage.set(COLLAPSED_STORAGE, state.collapsed ? "1" : "0");\n      syncForegroundState();'));
    assert.match(statusSource, /if \(state\.collapsed && !isRosterModePage\(\)\) return \{ label: "Paused", tone: "" \}/);
    assert.match(statusSource, /if \(document\.visibilityState === "hidden"\) return \{ label: "Paused while hidden", tone: "" \}/);
  });
});

describe("Warbuddy userscript source contracts", () => {
  it("keeps floating mode as the default and reuses the existing live session in integrated mode", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");
    const modeSource = compactSource(sourceSection(source, "function setDisplayMode", "function attachPanelDragHandler"));
    const mountSource = compactSource(sourceSection(source, "function resolvePanelMount", "function setDisplayMode"));
    const inlineSource = compactSource(sourceSection(source, "function syncIntegratedMemberTools", "function dibsMarkup"));

    assert.equal(core.normalizeDisplayMode(undefined), "floating");
    assert.equal(core.normalizeDisplayMode("unexpected"), "floating");
    assert.equal(core.normalizeDisplayMode("integrated"), "integrated");
    assert.match(source, /displayMode: core\.normalizeDisplayMode\(storage\.get\(DISPLAY_MODE_STORAGE, ""\)\)/);
    assert.match(modeSource, /storage\.set\(DISPLAY_MODE_STORAGE, nextMode\)/);
    assert.match(modeSource, /scheduleRender\(\)/);
    assert.doesNotMatch(modeSource, /new WebSocket|connectSocket|startFallbackPolling|setInterval/);
    assert.match(mountSource, /if \(state\.displayMode !== "integrated"\)/);
    assert.match(mountSource, /placement: "floating"/);
    assert.match(mountSource, /fallback: true/);
    assert.match(inlineSource, /state\.displayMode === "integrated"/);
    assert.match(inlineSource, /core\.isRankedWarPageUrl\(window\.location\.href\)/);
  });

  it("matches only ranked-war enemy profile links for integrated row actions", () => {
    assert.equal(core.isRankedWarPageUrl("https://www.torn.com/factions.php?step=your&type=1#/war/rank"), true);
    assert.equal(core.isRankedWarPageUrl("https://www.torn.com/factions.php?step=your&type=1#/tab=armoury"), false);
    assert.equal(core.isRankedWarPageUrl("https://example.com/factions.php#/war/rank"), false);
    assert.equal(core.profileMemberIdFromUrl("https://www.torn.com/profiles.php?XID=3601225"), 3601225);
    assert.equal(core.profileMemberIdFromUrl("/profiles.php?xid=3601225"), 3601225);
    assert.equal(core.profileMemberIdFromUrl("https://example.com/profiles.php?XID=3601225"), 0);
    assert.equal(core.profileMemberIdFromUrl("https://www.torn.com/factions.php?ID=3601225"), 0);
  });

  it("provides reversible display controls and a safe floating fallback", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");
    const renderSource = compactSource(sourceSection(source, "function render()", "function forgetStoredKey"));

    assert.match(renderSource, /\[ \["floating", "Floating"\], \["integrated", "Roster \(beta\)"\], \]/);
    assert.match(renderSource, /data-display-mode="\$\{value\}"/);
    assert.match(renderSource, /Roster \(beta\)/);
    assert.doesNotMatch(renderSource, /wc-display-help/);
    assert.match(renderSource, /Roster mode is unavailable here\. Using Floating\./);
    assert.match(source, /Warbuddy: use floating mode/);
    assert.match(source, /Warbuddy: use roster beta/);
  });

  it("mounts roster mode above the common two-faction board instead of a member cell", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");
    const rowSource = compactSource(sourceSection(
      source,
      "function lowestCommonAncestor",
      "function createAttackHost"
    ));
    const styleSource = compactSource(sourceSection(source, "addStyle(`", "const normalizeResponse"));

    assert.match(rowSource, /function rankedWarBoardForView\(view\)/);
    assert.match(rowSource, /lowestCommonAncestor\(ownRow, enemyRow\)/);
    assert.match(rowSource, /board\.contains\?\.\(ownRow\)/);
    assert.match(rowSource, /board\.contains\?\.\(enemyRow\)/);
    assert.match(rowSource, /board\.dataset\.warbuddyRosterBoard = "1"/);
    assert.match(rowSource, /parent\.insertBefore\(wrapper, board\)/);
    assert.doesNotMatch(rowSource, /parent\.insertBefore\(wrapper, row\)/);
    assert.match(styleSource, /grid-column:1 \/ -1 !important/);
    assert.match(styleSource, /flex:0 0 100%/);
    assert.match(styleSource, /wc-roster-mode/);
    assert.match(styleSource, /width:100%; max-width:none/);
    assert.match(styleSource, /wc-roster-mode \.wc-body \{ max-height:none; overflow:visible; overscroll-behavior:auto/);
    assert.match(styleSource, /\.wc-target-list \{ max-height:180px; overflow:auto/);
  });

  it("keeps roster filtering and priority ordering reversible", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");
    const inlineSource = compactSource(sourceSection(source, "function syncIntegratedMemberTools", "function dibsMarkup"));
    const cleanupSource = compactSource(sourceSection(source, "function removeInlineMemberTools", "function removeIntegratedMount"));
    const mountCleanupSource = compactSource(sourceSection(source, "function removeIntegratedMount", "function rosterProfileAnchors"));

    assert.match(inlineSource, /rosterProfileAnchors\(view\.enemyRoster, board\)/);
    assert.match(inlineSource, /board\?\.contains\?\.\(anchor\) \? rankedWarOwnRowForAnchor\(anchor\) : rankedWarRowForAnchor\(anchor\)/);
    assert.match(inlineSource, /core\.rosterFilterMatches\(state\.rosterFilter, flags\)/);
    assert.match(inlineSource, /core\.memberAvailability\(member, state\.nowMs\)/);
    assert.match(inlineSource, /core\.rosterOrder\(flags, member, state\.nowMs\)/);
    assert.match(inlineSource, /ffscouterFilterActive\(\)/);
    assert.match(inlineSource, /!ffscouterOwnsOrder/);
    assert.match(inlineSource, /row\.style\.order = String/);
    assert.doesNotMatch(inlineSource, /appendChild\(row\)|insertBefore\(row/);
    assert.match(cleanupSource, /warbuddy-roster-hidden/);
    assert.match(cleanupSource, /removeProperty\?\.\("order"\)/);
    assert.match(cleanupSource, /warbuddy-roster-sort-parent/);
    assert.match(cleanupSource, /warbuddyAvailability/);
    assert.match(mountCleanupSource, /\[data-warbuddy-roster-board\]/);
    assert.match(mountCleanupSource, /delete board\.dataset\.warbuddyRosterBoard/);
  });

  it("hides the whole action queue via showActionQueue while keeping the tracker-disabled notice separate", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");
    const sessionViewSource = compactSource(sourceSection(source, "function sessionView", "const statusView"));
    const queueMarkupSource = compactSource(sourceSection(
      source,
      "function actionQueueMarkup",
      "function attackTargetMarkup"
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

  it("uses the attack-page target for a current-target card with quick watch and Dibs", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");
    const activationSource = compactSource(sourceSection(
      source,
      "function syncPageActivation",
      "function syncVisibilityState"
    ));
    const attackCardSource = compactSource(sourceSection(
      source,
      "function attackTargetMarkup",
      "function capturePanelFocus"
    ));
    const renderSource = compactSource(sourceSection(source, "function render()", "function forgetStoredKey"));

    assert.match(activationSource, /const nextAttackTargetId = active \? core\.attackPageTargetId\(window\.location\.href\) : 0/);
    assert.match(attackCardSource, /if \(!state\.attackTargetId\) return ""/);
    assert.match(attackCardSource, /Current Torn target/);
    assert.match(attackCardSource, /member \? dibsMarkup\(member, view, claim, `attack-\$\{memberId\}`\) : ""/);
    assert.match(attackCardSource, /data-action="toggle-watch"/);
    assert.match(attackCardSource, /data-target-member="\$\{memberId\}"/);
    assert.match(renderSource, /toggleWatchedTarget\(event\.currentTarget\?\.dataset\?\.targetMember\)/);
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
    assert.match(dibsMarkupSource, /const canMutate = rosterIsFresh\(view\.enemyFactionId\) && !state\.authTerminal && !state\.keySaving/);
    assert.match(saveTargetsSource, /if \(!isOnline\(\) \|\| state\.authTerminal \|\| state\.keySaving\)/);
    assert.match(quickWatchSource, /if \(!isOnline\(\) \|\| state\.authTerminal \|\| state\.keySaving\)/);
    assert.match(updateDibsSource, /action === "claim" && !currentEnemyRosterIsFresh\(\)/);
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
    assert.match(dibsMarkupSource, /const disabled = anyBusy \|\| \(!claim && !canMutate\)/);
    assert.match(dibsMarkupSource, /!canRelease \|\| anyBusy \? " disabled" : ""/);
    assert.match(updateDibsSource, /state\.dibsBusyTargetId \|\| state\.targetsSaving \|\| state\.targetQuickBusyId \|\| !Number\.isSafeInteger\(memberId\)/);
    assert.match(updateDibsSource, /const expectsSocketSnapshot = socketIsOpen\(\)/);
    assert.match(updateDibsSource, /if \(!expectsSocketSnapshot\) applyDibsSnapshot\(response\)/);
    assert.match(updateDibsSource, /if \(resumeFallback\) stopFallbackPolling\(\)/);
    assert.match(updateDibsSource, /if \(resumeFallback && !socketIsOpen\(\)\) startFallbackPolling\(\)/);
    assert.match(updateDibsSource, /finally \{ state\.dibsBusyTargetId = 0/);
    assert.match(retaliationSource, /view\.enemyRoster\.find/);
    assert.match(retaliationSource, /member \? dibsMarkup\(member, view, claim, `retal-\$\{memberId\}-\$\{attack\.expiresAt\}`\) : ""/);
    assert.match(retaliationSource, /attackLinkMarkup\(attack\.attackUrl \|\| core\.attackUrl\(attack\.attackerId\), memberId, "Attack", view, true, claim\)/);
  });

  it("provides viewport-safe mobile layout and 40px coarse-pointer controls", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");
    const styleSource = sourceSection(source, "addStyle(`", "const normalizeResponse");
    const coarseMarker = /@media\s*\(pointer:\s*coarse\)/.exec(styleSource);

    assert.match(styleSource, /@media\s*\(max-width:\s*520px\)/);
    assert.match(styleSource, /safe-area-inset-right/);
    assert.match(styleSource, /max-height:\s*58dvh/);
    assert.ok(coarseMarker, "missing coarse-pointer media query");
    const coarseSource = styleSource.slice(coarseMarker.index);
    assert.match(coarseSource, /\.wc-button,[\s\S]*?\.wc-link\s*\{[^}]*min-height:\s*40px/);
    assert.match(coarseSource, /\.wc-icon\s*\{[^}]*width:\s*40px/);
    assert.match(coarseSource, /\.wc-dibs,[\s\S]*?\.wc-dibs-close\s*\{[^}]*width:\s*40px;\s*height:\s*40px/);
    assert.match(coarseSource, /summary\s*\{[^}]*min-height:\s*40px/);
  });
});

describe("Warbuddy route activation", () => {
  it("runs throughout Torn faction pages", () => {
    assert.equal(core.isFactionPageUrl("https://www.torn.com/factions.php?step=your#/war/rank"), true);
    assert.equal(core.isFactionPageUrl("https://torn.com/factions.php?step=profile&ID=41309"), true);
    assert.equal(core.isFactionPageUrl("https://www.torn.com/factions.php?step=your#/tab=crimes"), true);
  });

  it("also runs on the exact Torn attack page", () => {
    assert.equal(core.isWarbuddyPageUrl("https://www.torn.com/page.php?sid=attack"), true);
    assert.equal(core.isWarbuddyPageUrl("https://torn.com/page.php?sid=attack&user2ID=123"), true);
    assert.equal(core.attackPageTargetId("https://torn.com/page.php?sid=attack&user2ID=123"), 123);
  });

  it("stays inactive on Bazaar and unrelated Torn pages", () => {
    assert.equal(core.isWarbuddyPageUrl("https://www.torn.com/bazaar.php"), false);
    assert.equal(core.isWarbuddyPageUrl("https://www.torn.com/page.php?sid=stocks"), false);
    assert.equal(core.isWarbuddyPageUrl("https://example.com/factions.php#/war/rank"), false);
  });

  it("mounts and restores the panel on faction and attack pages without mounting elsewhere", async () => {
    const faction = await bootUserscript("https://www.torn.com/factions.php?step=your&type=1", { withBody: false });
    assert.equal(faction.elements.has("warbuddy-panel"), false);

    faction.activateBody();
    assert.equal(faction.elements.has("warbuddy-panel"), false);
    faction.setVisibility("visible");
    assert.equal(faction.elements.has("warbuddy-panel"), true);
    assert.equal(faction.elements.get("warbuddy-panel").tagName, "DIV");
    assert.equal(faction.menuCommands.has("Warbuddy: diagnostics"), true);

    faction.elements.get("warbuddy-panel").remove();
    faction.notifyMutation();
    assert.equal(faction.elements.has("warbuddy-panel"), true);

    const bazaar = await bootUserscript("https://www.torn.com/bazaar.php");
    assert.equal(bazaar.elements.has("warbuddy-panel"), false);

    const attack = await bootUserscript("https://www.torn.com/page.php?sid=attack&user2ID=123", {
      visibilityState: "visible",
    });
    assert.equal(attack.elements.has("warbuddy-panel"), true);

    const stocks = await bootUserscript("https://www.torn.com/page.php?sid=stocks");
    assert.equal(stocks.elements.has("warbuddy-panel"), false);
  });

  it("injects only on Torn faction and page routes, with exact runtime activation", async () => {
    const header = await readFile(new URL("../userscript.header.txt", import.meta.url), "utf8");
    assert.match(header, /^\/\/ @name\s+Warbuddy$/m);
    assert.match(header, /Grussniffer\/Warbuddy\/main\/warbuddy\.user\.js/);
    assert.doesNotMatch(header, /Askelads|The Lads/i);
    assert.match(header, /@sandbox\s+DOM/);
    assert.match(header, /@match\s+https:\/\/www\.torn\.com\/factions\.php\*/);
    assert.match(header, /@include\s+https:\/\/www\.torn\.com\/page\.php\?\*sid=attack\*/);
    assert.doesNotMatch(header, /@match\s+https:\/\/www\.torn\.com\/\*/);
  });
});
