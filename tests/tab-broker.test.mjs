import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const brokerApi = require("../src/tab-broker.cjs");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeBroadcastChannel {
  static rooms = new Map();
  static sent = [];
  static paused = false;

  static reset() {
    this.rooms.clear();
    this.sent = [];
    this.paused = false;
  }

  constructor(name) {
    this.name = name;
    this.listeners = new Set();
    this.closed = false;
    const room = FakeBroadcastChannel.rooms.get(name) || new Set();
    room.add(this);
    FakeBroadcastChannel.rooms.set(name, room);
  }

  addEventListener(type, listener) {
    if (type === "message") this.listeners.add(listener);
  }

  postMessage(message) {
    if (this.closed) throw new Error("Channel is closed");
    FakeBroadcastChannel.sent.push(structuredClone(message));
    if (FakeBroadcastChannel.paused) return;
    for (const peer of FakeBroadcastChannel.rooms.get(this.name) || []) {
      if (peer === this || peer.closed) continue;
      const cloned = structuredClone(message);
      for (const listener of peer.listeners) listener({ data: cloned });
    }
  }

  close() {
    this.closed = true;
    FakeBroadcastChannel.rooms.get(this.name)?.delete(this);
  }
}

const createBroker = (tabId, options = {}) => brokerApi.createConnectionBroker({
  BroadcastChannelCtor: FakeBroadcastChannel,
  channelName: "private-test-channel",
  tabId,
  heartbeatMs: 10,
  leaderTimeoutMs: 30,
  electionGraceMs: 5,
  idleGraceMs: 15,
  ...options,
});

describe("Warbuddy cross-tab connection broker", () => {
  it("elects one owner, delivers normal data immediately, and relays actions without credentials", async () => {
    FakeBroadcastChannel.reset();
    const received = [];
    const handled = [];
    const first = createBroker("a", {
      onRequest(type, payload) {
        handled.push({ type, payload });
        return { ok: true, echoed: payload };
      },
    });
    const second = createBroker("b", {
      onData(type, payload) {
        received.push({ type, payload });
      },
    });

    first.setScope("123:456");
    second.setScope("123:456");
    first.setActive(true);
    second.setActive(true);
    await delay(15);

    assert.equal([first, second].filter((broker) => broker.isLeader()).length, 1);
    assert.equal(first.isLeader(), true);
    const beforeBroadcast = received.length;
    assert.equal(first.broadcast("event", { topic: "score", payload: { score: 10 } }), true);
    assert.equal(received.length, beforeBroadcast + 1, "data fan-out must not wait for a heartbeat or poll");
    assert.deepEqual(received.at(-1), { type: "event", payload: { topic: "score", payload: { score: 10 } } });

    const response = await second.request("socket-action", {
      action: "war_tracker:loadouts",
      payload: { factionId: "789" },
    });
    assert.deepEqual(response, {
      ok: true,
      echoed: { action: "war_tracker:loadouts", payload: { factionId: "789" } },
    });
    assert.deepEqual(handled, [{
      type: "socket-action",
      payload: { action: "war_tracker:loadouts", payload: { factionId: "789" } },
    }]);

    first.close();
    second.close();
  });

  it("keeps a hidden leader while a visible follower has demand and hands off on close", async () => {
    FakeBroadcastChannel.reset();
    const first = createBroker("a");
    const second = createBroker("b");
    first.setScope("123:456");
    second.setScope("123:456");
    first.setActive(true);
    second.setActive(true);
    await delay(15);

    assert.equal(first.isLeader(), true);
    first.setActive(false);
    await delay(25);
    assert.equal(first.isLeader(), true);
    assert.equal(first.shouldOwnTransport(), true);

    first.close();
    await delay(10);
    assert.equal(second.isLeader(), true);
    second.close();
  });

  it("probes a throttled hidden leader before considering its heartbeat stale", async () => {
    FakeBroadcastChannel.reset();
    let clock = 1_000;
    let firstMaintenance = () => {};
    let secondMaintenance = () => {};
    const common = {
      now: () => clock,
      heartbeatMs: 10,
      leaderTimeoutMs: 20,
      electionGraceMs: 0,
      setIntervalFn(callback) {
        if (firstMaintenance === noopMaintenance) firstMaintenance = callback;
        else secondMaintenance = callback;
        return 1;
      },
      clearIntervalFn() {},
    };
    const noopMaintenance = firstMaintenance;
    const first = createBroker("a", common);
    const second = createBroker("b", common);
    first.setScope("123:456");
    second.setScope("123:456");
    first.setActive(true);
    second.setActive(true);
    await delay(5);
    assert.equal(first.isLeader(), true);

    first.setActive(false);
    clock += 25;
    secondMaintenance();
    assert.equal(first.isLeader(), true);
    assert.equal(second.leaderId(), "a");
    assert.equal(second.isLeader(), false);
    assert.ok(FakeBroadcastChannel.sent.some((message) => message.kind === "probe" && message.to === "a"));

    first.close();
    second.close();
  });

  it("isolates scopes and falls back to standalone behavior when BroadcastChannel is unavailable", async () => {
    FakeBroadcastChannel.reset();
    const received = [];
    const first = createBroker("a");
    const otherScope = createBroker("b", { onData: (type) => received.push(type) });
    first.setScope("123:456");
    otherScope.setScope("999:456");
    first.setActive(true);
    otherScope.setActive(true);
    await delay(15);
    first.broadcast("event", { value: 1 });
    assert.deepEqual(received, []);

    const unavailable = brokerApi.createConnectionBroker({
      BroadcastChannelCtor: class {
        constructor() { throw new Error("unsupported"); }
      },
    });
    assert.equal(unavailable.enabled, false);
    assert.equal(unavailable.isLeader(), true);
    assert.equal(unavailable.diagnostics().role, "standalone");

    first.close();
    otherScope.close();
  });

  it("converges split leaders on the lower deterministic lease", async () => {
    FakeBroadcastChannel.reset();
    FakeBroadcastChannel.paused = true;
    const first = createBroker("a", { electionGraceMs: 0 });
    const second = createBroker("b", { electionGraceMs: 0 });
    first.setScope("123:456");
    second.setScope("123:456");
    first.setActive(true);
    second.setActive(true);
    await delay(5);
    assert.equal(first.isLeader(), true);
    assert.equal(second.isLeader(), true);

    FakeBroadcastChannel.paused = false;
    first.setActive(true);
    await delay(5);
    assert.equal(first.isLeader(), true);
    assert.equal(second.isLeader(), false);
    assert.equal(second.leaderId(), "a");

    first.close();
    second.close();
  });

  it("refuses credential-bearing messages and keeps broker snapshots credential-free", async () => {
    FakeBroadcastChannel.reset();
    const first = createBroker("a", {
      onRequest() {
        return { wsSessionToken: "session-token-value" };
      },
    });
    const second = createBroker("b");
    first.setScope("123:456");
    second.setScope("123:456");
    first.setActive(true);
    second.setActive(true);
    await delay(15);

    const before = FakeBroadcastChannel.sent.length;
    assert.equal(first.broadcast("state", { wsSessionToken: "session-token-value" }), false);
    assert.equal(FakeBroadcastChannel.sent.length, before);
    await assert.rejects(
      second.request("socket-action", { Authorization: "Bearer session-token-value" }),
      /Secrets cannot be sent/,
    );
    await assert.rejects(second.request("state", {}), /could not be sent safely/);
    assert.equal(brokerApi.containsSecretField({ nested: { tornApiKey: "api-key-value" } }), true);
    assert.doesNotMatch(JSON.stringify(FakeBroadcastChannel.sent), /api-key-value|session-token-value/);

    const userscript = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");
    const snapshotStart = userscript.indexOf("function sharedStatePayload()");
    const snapshotEnd = userscript.indexOf("function publishSharedTransport()", snapshotStart);
    assert.ok(snapshotStart >= 0 && snapshotEnd > snapshotStart);
    const snapshotSource = userscript.slice(snapshotStart, snapshotEnd);
    assert.doesNotMatch(snapshotSource, /state\.token|getStoredKey|KEY_STORAGE|Authorization|wsSessionToken|state\.session/);
    assert.match(userscript, /channelName: "warbuddy-live-" \+ nonce/);
    assert.match(userscript, /BROKER_NONCE_STORAGE/);
    assert.match(userscript, /tabBroker\?\.close\(\);\s+tabBroker = null;\s+closeOwnedTransport\("Tab closed"\)/);
    assert.match(userscript, /Tab broker:.*leader.*peers/);
    assert.match(userscript, /open \(shared from leader\)/);
    assert.match(userscript, /direct WebSocket owner/);

    first.close();
    second.close();
  });
});
