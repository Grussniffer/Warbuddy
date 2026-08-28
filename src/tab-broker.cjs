(function initializeWarbuddyTabBroker(globalScope, factory) {
  const api = factory();
  if (typeof module === "object" && module?.exports) module.exports = api;
  if (globalScope && typeof globalScope === "object") globalScope.WarbuddyTabBroker = api;
})(typeof globalThis === "object" ? globalThis : this, function createWarbuddyTabBrokerApi() {
  "use strict";

  const PROTOCOL = "warbuddy-tab-broker-v1";
  const FORBIDDEN_FIELD = /(?:authorization|api.?key|token)/i;
  const noop = () => {};
  const normalizeId = (value) => String(value || "").trim();
  const randomId = () => {
    try {
      if (typeof globalThis?.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
    } catch {
      // A userscript sandbox may expose crypto without all methods.
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  };

  function containsSecretField(value, seen = new Set()) {
    if (!value || typeof value !== "object") return false;
    if (seen.has(value)) return false;
    seen.add(value);
    if (Array.isArray(value)) return value.some((entry) => containsSecretField(entry, seen));
    return Object.entries(value).some(([key, entry]) => FORBIDDEN_FIELD.test(key) || containsSecretField(entry, seen));
  }

  function createConnectionBroker(options = {}) {
    const BroadcastChannelCtor = options.BroadcastChannelCtor
      || (typeof globalThis === "object" ? globalThis.BroadcastChannel : undefined);
    const now = typeof options.now === "function" ? options.now : Date.now;
    const setIntervalFn = options.setIntervalFn || setInterval;
    const clearIntervalFn = options.clearIntervalFn || clearInterval;
    const setTimeoutFn = options.setTimeoutFn || setTimeout;
    const clearTimeoutFn = options.clearTimeoutFn || clearTimeout;
    const heartbeatMs = Math.max(10, Number(options.heartbeatMs || 1_000));
    const leaderTimeoutMs = Math.max(heartbeatMs * 2, Number(options.leaderTimeoutMs || 3_500));
    const electionGraceMs = Math.max(0, Number(options.electionGraceMs ?? 120));
    const idleGraceMs = Math.max(0, Number(options.idleGraceMs ?? 2_500));
    const requestTimeoutMs = Math.max(10, Number(options.requestTimeoutMs || 10_000));
    const tabId = normalizeId(options.tabId) || randomId();
    const channelName = normalizeId(options.channelName) || "warbuddy-live-connection";
    const onRoleChange = typeof options.onRoleChange === "function" ? options.onRoleChange : noop;
    const onLeaderChange = typeof options.onLeaderChange === "function" ? options.onLeaderChange : noop;
    const onDemandChange = typeof options.onDemandChange === "function" ? options.onDemandChange : noop;
    const onData = typeof options.onData === "function" ? options.onData : noop;
    const onRequest = typeof options.onRequest === "function"
      ? options.onRequest
      : () => Promise.reject(new Error("Shared request is unsupported"));

    let channel = null;
    try {
      if (typeof BroadcastChannelCtor === "function") channel = new BroadcastChannelCtor(channelName);
    } catch {
      channel = null;
    }
    if (!channel) {
      return Object.freeze({
        enabled: false,
        tabId,
        setScope: noop,
        setActive: noop,
        isLeader: () => true,
        hasLeader: () => false,
        leaderId: () => "",
        hasDemand: () => false,
        shouldOwnTransport: () => true,
        broadcast: () => false,
        request: () => Promise.reject(new Error("Cross-tab sharing is unavailable")),
        close: noop,
        diagnostics: () => ({ enabled: false, role: "standalone", tabId }),
      });
    }

    let closed = false;
    let scope = "";
    let active = false;
    let leader = "";
    let leaderSeenAt = 0;
    let role = "follower";
    let demand = false;
    let idleUntil = 0;
    let electionTimer = 0;
    let probedLeader = "";
    let leaderProbeUntil = 0;
    let requestSequence = 0;
    const peers = new Map();
    const pendingRequests = new Map();

    const post = (message) => {
      if (closed || !scope || containsSecretField(message)) return false;
      try {
        channel.postMessage({ protocol: PROTOCOL, scope, from: tabId, at: now(), ...message });
        return true;
      } catch {
        return false;
      }
    };
    const currentDemand = () => {
      const cutoff = now() - leaderTimeoutMs;
      if (active) return true;
      for (const peer of peers.values()) if (peer.active && peer.seenAt >= cutoff) return true;
      return false;
    };
    const refreshDemand = () => {
      const next = currentDemand();
      if (next === demand) return;
      demand = next;
      if (demand) idleUntil = 0;
      else if (role === "leader") idleUntil = now() + idleGraceMs;
      onDemandChange(demand);
    };
    const setLeader = (nextLeader, seenAt = now()) => {
      const normalized = normalizeId(nextLeader);
      const changed = normalized !== leader;
      leader = normalized;
      leaderSeenAt = normalized ? seenAt : 0;
      probedLeader = "";
      leaderProbeUntil = 0;
      if (changed) onLeaderChange(leader, leader === tabId);
    };
    const setRole = (nextRole) => {
      if (role === nextRole) return;
      role = nextRole;
      onRoleChange(role === "leader", role);
    };
    const announcePresence = () => post({ kind: "presence", active });
    const resign = () => {
      if (role === "leader") post({ kind: "resign" });
      setRole("follower");
      if (leader === tabId) setLeader("");
      idleUntil = 0;
    };
    const becomeLeader = () => {
      if (closed || !scope || !currentDemand()) return;
      setLeader(tabId);
      setRole("leader");
      idleUntil = 0;
      post({ kind: "leader" });
    };
    const elect = () => {
      electionTimer = 0;
      if (closed || !scope || !currentDemand()) return;
      if (leader && now() - leaderSeenAt <= leaderTimeoutMs) return;
      const cutoff = now() - leaderTimeoutMs;
      const candidates = active ? [tabId] : [];
      for (const [peerId, peer] of peers) if (peer.active && peer.seenAt >= cutoff) candidates.push(peerId);
      candidates.sort();
      if (candidates[0] === tabId) becomeLeader();
    };
    const scheduleElection = (delay = electionGraceMs) => {
      if (closed || electionTimer || !scope || !currentDemand()) return;
      electionTimer = setTimeoutFn(elect, Math.max(0, delay));
    };
    const rejectPendingRequests = (message) => {
      for (const pending of pendingRequests.values()) {
        clearTimeoutFn(pending.timer);
        pending.reject(new Error(message));
      }
      pendingRequests.clear();
    };
    const handleRequest = (message) => {
      if (role !== "leader" || normalizeId(message.to) !== tabId) return;
      const requestId = normalizeId(message.requestId);
      if (!requestId || !message.requestType || containsSecretField(message.payload)) return;
      Promise.resolve()
        .then(() => onRequest(String(message.requestType), message.payload, normalizeId(message.from)))
        .then((payload) => {
          if (post({ kind: "response", to: message.from, requestId, success: true, payload })) return;
          post({
            kind: "response",
            to: message.from,
            requestId,
            success: false,
            error: "Shared response could not be sent safely",
          });
        })
        .catch((error) => post({
          kind: "response",
          to: message.from,
          requestId,
          success: false,
          error: String(error?.message || "Shared request failed"),
        }));
    };
    const handleResponse = (message) => {
      if (normalizeId(message.to) !== tabId) return;
      const requestId = normalizeId(message.requestId);
      const pending = pendingRequests.get(requestId);
      if (!pending) return;
      pendingRequests.delete(requestId);
      clearTimeoutFn(pending.timer);
      if (message.success === false) pending.reject(new Error(String(message.error || "Shared request failed")));
      else pending.resolve(message.payload);
    };
    const handleMessage = (event) => {
      const message = event?.data;
      if (
        closed || !message || message.protocol !== PROTOCOL
        || normalizeId(message.scope) !== scope || normalizeId(message.from) === tabId
        || containsSecretField(message)
      ) return;
      const sender = normalizeId(message.from);
      const seenAt = now();
      if (message.kind === "bye") {
        peers.delete(sender);
        refreshDemand();
        if (leader === sender) {
          setLeader("");
          scheduleElection(0);
        }
        return;
      }
      const peer = peers.get(sender) || { active: false, seenAt: 0 };
      peer.seenAt = seenAt;
      if (message.kind === "presence") peer.active = message.active === true;
      peers.set(sender, peer);
      refreshDemand();
      if (message.kind === "presence" && role === "leader") {
        post({ kind: "leader" });
        return;
      }
      if (message.kind === "leader") {
        const leaderIsFresh = leader && now() - leaderSeenAt <= leaderTimeoutMs;
        if (role === "leader" && sender !== tabId) {
          if (sender < tabId) {
            post({ kind: "resign" });
            setRole("follower");
            setLeader(sender, seenAt);
          } else post({ kind: "leader" });
          return;
        }
        if (!leaderIsFresh || leader === sender || (leader && sender < leader)) setLeader(sender, seenAt);
        return;
      }
      if (message.kind === "probe") {
        if (role === "leader" && normalizeId(message.to) === tabId) post({ kind: "leader" });
        return;
      }
      if (message.kind === "resign") {
        if (leader === sender) {
          setLeader("");
          scheduleElection(0);
        }
        return;
      }
      if (message.kind === "request") return handleRequest(message);
      if (message.kind === "response") return handleResponse(message);
      if (message.kind === "data" && sender === leader) {
        leaderSeenAt = seenAt;
        onData(String(message.dataType || ""), message.payload, sender);
      }
    };
    channel.addEventListener?.("message", handleMessage);
    if (!channel.addEventListener) channel.onmessage = handleMessage;

    const maintain = () => {
      if (closed || !scope) return;
      const cutoff = now() - leaderTimeoutMs;
      for (const [peerId, peer] of peers) if (peer.seenAt < cutoff) peers.delete(peerId);
      refreshDemand();
      if (role === "leader") {
        announcePresence();
        if (!demand && idleUntil && now() >= idleUntil) return resign();
        post({ kind: "leader" });
        return;
      }
      if (leader && now() - leaderSeenAt > leaderTimeoutMs) {
        if (probedLeader !== leader) {
          probedLeader = leader;
          leaderProbeUntil = now() + heartbeatMs;
          post({ kind: "probe", to: leader });
          return;
        }
        if (now() < leaderProbeUntil) return;
        setLeader("");
      }
      announcePresence();
      if (!leader && demand) scheduleElection(0);
    };
    const maintenanceTimer = setIntervalFn(maintain, heartbeatMs);

    const setScope = (value) => {
      const nextScope = normalizeId(value);
      if (nextScope === scope) return;
      if (scope) {
        if (role === "leader") post({ kind: "resign" });
        post({ kind: "bye" });
      }
      if (electionTimer) clearTimeoutFn(electionTimer);
      electionTimer = 0;
      rejectPendingRequests("Shared connection identity changed");
      peers.clear();
      setRole("follower");
      setLeader("");
      demand = false;
      idleUntil = 0;
      scope = nextScope;
      if (scope) {
        announcePresence();
        refreshDemand();
        if (active) scheduleElection();
      }
    };
    const setActive = (value) => {
      const nextActive = value === true;
      if (nextActive === active) {
        if (scope) announcePresence();
        return;
      }
      active = nextActive;
      announcePresence();
      refreshDemand();
      if (active && !leader) scheduleElection();
    };
    const request = (requestType, payload = {}, timeout = requestTimeoutMs) => {
      if (containsSecretField(payload)) return Promise.reject(new Error("Secrets cannot be sent between Warbuddy tabs"));
      if (role === "leader") return Promise.resolve().then(() => onRequest(String(requestType || ""), payload, tabId));
      if (!leader || now() - leaderSeenAt > leaderTimeoutMs) return Promise.reject(new Error("Shared live connection is unavailable"));
      const requestId = `${tabId}-${++requestSequence}-${now()}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeoutFn(() => {
          pendingRequests.delete(requestId);
          reject(new Error(`${String(requestType || "Request")} timed out`));
        }, Math.max(10, Number(timeout || requestTimeoutMs)));
        pendingRequests.set(requestId, { resolve, reject, timer });
        if (!post({ kind: "request", to: leader, requestId, requestType: String(requestType || ""), payload })) {
          pendingRequests.delete(requestId);
          clearTimeoutFn(timer);
          reject(new Error("Shared request could not be sent"));
        }
      });
    };
    const close = () => {
      if (closed) return;
      if (role === "leader") post({ kind: "resign" });
      post({ kind: "bye" });
      closed = true;
      if (electionTimer) clearTimeoutFn(electionTimer);
      clearIntervalFn(maintenanceTimer);
      rejectPendingRequests("Warbuddy tab closed");
      try { channel.close(); } catch { /* Already closed. */ }
      peers.clear();
      setRole("follower");
      setLeader("");
    };

    return Object.freeze({
      enabled: true,
      tabId,
      setScope,
      setActive,
      isLeader: () => role === "leader",
      hasLeader: () => !!leader && now() - leaderSeenAt <= leaderTimeoutMs,
      leaderId: () => leader,
      hasDemand: () => currentDemand(),
      shouldOwnTransport: () => role === "leader" && (currentDemand() || (idleUntil > 0 && now() < idleUntil)),
      broadcast(dataType, payload) {
        if (role !== "leader" || containsSecretField(payload)) return false;
        return post({ kind: "data", dataType: String(dataType || ""), payload });
      },
      request,
      close,
      diagnostics: () => ({
        enabled: true,
        role,
        tabId,
        leaderId: leader,
        active,
        demand: currentDemand(),
        peerCount: peers.size,
        scope: scope ? "set" : "unset",
      }),
    });
  }

  return Object.freeze({ PROTOCOL, containsSecretField, createConnectionBroker });
});
