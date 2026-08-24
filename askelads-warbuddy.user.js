// ==UserScript==
// @name         Warbuddy
// @namespace    https://grusmedia.no/warbuddy
// @version      0.1.31
// @description  Shows a war action queue, shared target Dibs, watched targets, and live retaliation opportunities inside Torn.
// @author       SneipLadd [2813921]
// @homepageURL  https://github.com/Grussniffer/Warbuddy
// @supportURL   https://github.com/Grussniffer/Warbuddy/issues
// @downloadURL  https://raw.githubusercontent.com/Grussniffer/Warbuddy/main/warbuddy.user.js
// @updateURL    https://raw.githubusercontent.com/Grussniffer/Warbuddy/main/warbuddy.meta.js
// @match        https://www.torn.com/factions.php*
// @match        https://torn.com/factions.php*
// @include      https://www.torn.com/page.php?*sid=attack*
// @include      https://torn.com/page.php?*sid=attack*
// @run-at       document-idle
// @sandbox      DOM
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      api.torn.com
// @connect      backend.grusmedia.no
// @noframes
// ==/UserScript==

(function attachWarbuddyCore(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.WarbuddyCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createWarbuddyCore() {
  "use strict";

  const HOSPITAL_WINDOW_MS = 15 * 60 * 1000;
  const URGENT_HOSPITAL_MS = 3 * 60 * 1000;
  const CHAIN_WINDOW_MS = 5 * 60 * 1000;
  const URGENT_CHAIN_MS = 2 * 60 * 1000;
  const WATCHED_TARGET_WINDOW_MS = 60 * 1000;
  const DIBS_HOSPITAL_WINDOW_MS = 5 * 60 * 1000;

  const toTimestampMs = (value) => {
    const numeric = Number(value || 0);
    if (Number.isFinite(numeric) && numeric > 0) return numeric < 1e12 ? numeric * 1000 : numeric;
    const parsed = Date.parse(String(value || ""));
    return Number.isFinite(parsed) ? parsed : 0;
  };

  const duration = (milliseconds) => {
    const seconds = Math.max(0, Math.ceil(Number(milliseconds || 0) / 1000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  };

  const formatBsp = (value) => {
    const numeric = Number(value || 0);
    if (numeric >= 1e12) return `${(numeric / 1e12).toFixed(1)}t`;
    if (numeric >= 1e9) return `${(numeric / 1e9).toFixed(1)}b`;
    if (numeric >= 1e6) return `${(numeric / 1e6).toFixed(1)}m`;
    return Math.round(numeric).toLocaleString("en-US");
  };

  const attackUrl = (memberId) =>
    `https://www.torn.com/page.php?sid=attack&user2ID=${encodeURIComponent(String(memberId || ""))}`;

  const isFactionPageUrl = (value) => {
    let url;
    try {
      url = new URL(String(value || ""), "https://www.torn.com/");
    } catch {
      return false;
    }
    if (url.hostname.toLowerCase().replace(/^www\./, "") !== "torn.com") return false;
    return /^\/factions(?:\.php)?(?:\/|$)/i.test(url.pathname);
  };

  const attackPageTargetId = (value) => {
    let url;
    try {
      url = new URL(String(value || ""), "https://www.torn.com/");
    } catch {
      return 0;
    }
    if (url.hostname.toLowerCase().replace(/^www\./, "") !== "torn.com") return 0;
    if (!/^\/page\.php$/i.test(url.pathname) || String(url.searchParams.get("sid") || "").toLowerCase() !== "attack") {
      return 0;
    }
    const memberId = Number(url.searchParams.get("user2ID") || url.searchParams.get("user2id") || 0);
    return Number.isSafeInteger(memberId) && memberId > 0 ? memberId : 0;
  };

  const isWarbuddyPageUrl = (value) => {
    if (isFactionPageUrl(value)) return true;
    let url;
    try {
      url = new URL(String(value || ""), "https://www.torn.com/");
    } catch {
      return false;
    }
    return url.hostname.toLowerCase().replace(/^www\./, "") === "torn.com"
      && /^\/page\.php$/i.test(url.pathname)
      && String(url.searchParams.get("sid") || "").toLowerCase() === "attack";
  };

  const memberStatus = (member) =>
    String(member?.status?.userStatus || member?.status?.state || member?.status?.status || "").toLowerCase();

  const memberLocation = (member) =>
    String(member?.location?.current || member?.location?.name || member?.location || "").toLowerCase();

  const memberActivity = (member) => String(member?.activity || "").toLowerCase();

  const memberDestination = (member) =>
    String(member?.location?.destination || member?.destination || "").toLowerCase();

  const normalizeMemberIds = (value) => new Set(
    (Array.isArray(value) ? value : [])
      .map((memberId) => Number(memberId))
      .filter((memberId) => Number.isSafeInteger(memberId) && memberId > 0)
  );

  const dibsEligibility = (member, nowMs = Date.now()) => {
    const status = memberStatus(member);
    if (!status) return { eligible: false, state: "unknown" };
    if (status.includes("hospital")) {
      const hospitalUntil = toTimestampMs(member?.status?.untill || member?.status?.until);
      return {
        eligible: hospitalUntil > nowMs && hospitalUntil - nowMs <= DIBS_HOSPITAL_WINDOW_MS,
        state: "hospitalized",
        hospitalUntil,
      };
    }
    if (status === "okay" || status.startsWith("okay ") || status.startsWith("okay -")) {
      const current = memberLocation(member);
      const destination = memberDestination(member);
      const available = (!current || current.includes("torn")) && (!destination || destination.includes("torn"));
      return { eligible: available, state: available ? "available" : "unavailable" };
    }
    return { eligible: false, state: "unavailable" };
  };

  const activeDibsClaim = (payload, targetMemberId, nowMs = Date.now()) =>
    (Array.isArray(payload?.claims) ? payload.claims : []).find((claim) => (
      Number(claim?.targetMemberId || 0) === Number(targetMemberId || 0)
      && toTimestampMs(claim?.expiresAt) > nowMs
    ));

  const dibsAttackPresentation = (claim, viewerPlayerId, actionLabel = "Attack") => {
    const action = String(actionLabel || "Attack").trim() || "Attack";
    if (!claim) return { state: "free", label: action, title: action };
    if (String(claim.claimedByPlayerId || "") === String(viewerPlayerId || "")) {
      return { state: "mine", label: "Your Dibs", title: `Your Dibs - ${action}` };
    }
    const owner = String(claim.claimedByPlayerName || claim.claimedByPlayerId || "another member");
    return {
      state: "taken",
      label: "Dibsed",
      title: `Dibsed by ${owner} - ${action} anyway`,
    };
  };

  const dibsFeatureEnabled = (settings) => (
    settings?.enabled !== false && settings?.dibsEnabled !== false
  );

  const scoreForFaction = (scores, factionId) => {
    if (scores instanceof Map) return scores.get(String(factionId));
    return Object.values(scores || {}).find((score) => String(score?.factionId || score?.faction_id || "") === String(factionId));
  };

  const inferEnemyFactionId = (ownFactionId, scores, rosters) => {
    const ownScore = scoreForFaction(scores, ownFactionId);
    if (ownScore && !ownScore.start) return "";
    const explicitOpponent = String(ownScore?.opponentFactionId || ownScore?.opponent_faction_id || "").trim();
    if (explicitOpponent && explicitOpponent !== String(ownFactionId)) return explicitOpponent;

    const scoreValues = scores instanceof Map ? Array.from(scores.values()) : Object.values(scores || {});
    const opposingScore = scoreValues.find((score) => {
      const factionId = String(score?.factionId || score?.faction_id || "");
      return factionId && factionId !== String(ownFactionId)
        && String(score?.opponentFactionId || score?.opponent_faction_id || "") === String(ownFactionId);
    });
    if (opposingScore) return String(opposingScore.factionId || opposingScore.faction_id);

    const rosterIds = (rosters instanceof Map ? Array.from(rosters.keys()) : Object.keys(rosters || {}))
      .map(String)
      .filter((factionId) => factionId !== String(ownFactionId));
    return rosterIds.length === 1 ? rosterIds[0] : "";
  };

  const applyRosterUpdate = (current, payload) => {
    const existing = current || { version: 0, members: [] };
    const version = Number(payload?.version || 0);
    if (Array.isArray(payload?.members)) {
      return { version, members: payload.members.slice(), needsSnapshot: false };
    }
    if (existing.needsSnapshot) return { ...existing, needsSnapshot: true };

    const changed = Array.isArray(payload?.changedMembers) ? payload.changedMembers : [];
    const removed = new Set((payload?.removedMemberIds || []).map((id) => Number(id)));
    if (!changed.length && !removed.size) return { ...existing, needsSnapshot: false };
    const baseVersion = Number(payload?.baseVersion || 0);
    if (baseVersion && existing.version !== baseVersion) {
      return { ...existing, needsSnapshot: true };
    }

    const byId = new Map(existing.members.map((member) => [Number(member?.member_id || 0), member]));
    for (const memberId of removed) byId.delete(memberId);
    for (const member of changed) byId.set(Number(member?.member_id || 0), member);
    return {
      version: version || existing.version,
      members: Array.from(byId.values()),
      needsSnapshot: false,
    };
  };

  const buildActionQueue = ({
    enemies = [],
    alliedScore,
    ownBsp = 0,
    watchedEnemyMemberIds = [],
    nowMs = Date.now(),
  }) => {
    const result = [];
    const watchedActions = [];
    const watchedIds = normalizeMemberIds(watchedEnemyMemberIds);
    const activeWatchedIds = new Set();
    const chainEndsAt = toTimestampMs(alliedScore?.chain_timer);
    const chainRemaining = chainEndsAt - nowMs;
    if (Number(alliedScore?.chain || 0) >= 10 && chainRemaining > 0 && chainRemaining <= CHAIN_WINDOW_MS) {
      result.push({
        key: "chain-risk",
        severity: chainRemaining <= URGENT_CHAIN_MS ? "urgent" : "watch",
        title: `Chain ${alliedScore.chain} needs a hit`,
        detail: `${duration(chainRemaining)} remaining`,
        order: chainEndsAt,
      });
    }

    for (const member of enemies) {
      const memberId = Number(member?.member_id || 0);
      if (!watchedIds.has(memberId)) continue;
      const status = memberStatus(member);
      const until = toTimestampMs(member?.status?.untill || member?.status?.until);
      const remaining = until - nowMs;
      const bsp = member.bsp ? `${formatBsp(member.bsp)} BSP` : "BSP unknown";

      if (
        status === "traveling"
        && memberDestination(member) === "torn"
        && remaining > 0
        && remaining <= WATCHED_TARGET_WINDOW_MS
      ) {
        activeWatchedIds.add(memberId);
        watchedActions.push({
          key: `watched-flight-${memberId}`,
          memberId,
          severity: "urgent",
          title: `${member.member_name} lands in Torn`,
          detail: `${duration(remaining)} - watched - ${bsp}`,
          actionLabel: "Open",
          url: attackUrl(memberId),
          order: until,
        });
        continue;
      }

      if (status === "hospital" && remaining > 0 && remaining <= WATCHED_TARGET_WINDOW_MS) {
        activeWatchedIds.add(memberId);
        watchedActions.push({
          key: `watched-hospital-${memberId}`,
          memberId,
          severity: "urgent",
          title: `${member.member_name} leaves hospital`,
          detail: `${duration(remaining)} - watched - ${bsp}`,
          actionLabel: "Open",
          url: attackUrl(memberId),
          order: until,
        });
        continue;
      }

      if (status === "okay" && memberLocation(member) === "torn") {
        activeWatchedIds.add(memberId);
        watchedActions.push({
          key: `watched-ready-${memberId}`,
          memberId,
          severity: "urgent",
          title: `${member.member_name} is attackable now`,
          detail: `Watched target - ${bsp}`,
          actionLabel: "Attack",
          url: attackUrl(memberId),
          order: nowMs,
        });
      }
    }

    for (const member of enemies) {
      if (activeWatchedIds.has(Number(member?.member_id || 0))) continue;
      if (memberStatus(member) !== "hospital") continue;
      const until = toTimestampMs(member?.status?.untill || member?.status?.until);
      const remaining = until - nowMs;
      if (remaining <= 0 || remaining > HOSPITAL_WINDOW_MS) continue;
      result.push({
        key: `hospital-${member.member_id}`,
        memberId: Number(member.member_id || 0),
        severity: remaining <= URGENT_HOSPITAL_MS ? "urgent" : "watch",
        title: `${member.member_name} leaves hospital`,
        detail: `${duration(remaining)} - ${member.bsp ? `${formatBsp(member.bsp)} BSP` : "BSP unknown"}`,
        actionLabel: "Open",
        url: attackUrl(member.member_id),
        order: until,
      });
    }

    const numericOwnBsp = Number(ownBsp || 0);
    const onlineTargets = numericOwnBsp > 0
      ? enemies
        .filter((member) => !activeWatchedIds.has(Number(member?.member_id || 0)))
        .filter((member) => memberActivity(member) === "online" && memberStatus(member) === "okay")
        .filter((member) => memberLocation(member) === "torn")
        .filter((member) => !member.bsp || Number(member.bsp) <= numericOwnBsp * 1.25)
        .sort((a, b) => Number(b.bsp || 0) - Number(a.bsp || 0))
        .slice(0, 3)
      : [];
    for (const member of onlineTargets) {
      result.push({
        key: `online-${member.member_id}`,
        memberId: Number(member.member_id || 0),
        severity: "info",
        title: `${member.member_name} is online in Torn`,
        detail: member.bsp ? `${formatBsp(member.bsp)} BSP` : `Level ${member.level || "?"} - BSP unknown`,
        actionLabel: "Attack",
        url: attackUrl(member.member_id),
        order: Number.MAX_SAFE_INTEGER - Number(member.bsp || 0),
      });
    }

    const severityRank = { urgent: 0, watch: 1, info: 2 };
    const byPriority = (a, b) => severityRank[a.severity] - severityRank[b.severity] || a.order - b.order;
    const chainActions = result.filter((item) => item.key === "chain-risk").sort(byPriority);
    const ordinaryActions = result.filter((item) => item.key !== "chain-risk").sort(byPriority);
    const pinnedActions = [...chainActions, ...watchedActions.sort(byPriority)];
    return [...pinnedActions, ...ordinaryActions.slice(0, Math.max(0, 9 - pinnedActions.length))];
  };

  const activeRetaliations = (payload, nowSeconds = Math.floor(Date.now() / 1000)) =>
    (Array.isArray(payload?.attacks) ? payload.attacks : [])
      .filter((attack) => Number(attack?.expiresAt || 0) > nowSeconds && Number(attack?.attackerId || 0) > 0)
      .sort((a, b) => Number(a.expiresAt || 0) - Number(b.expiresAt || 0));

  return {
    activeDibsClaim,
    activeRetaliations,
    attackPageTargetId,
    applyRosterUpdate,
    attackUrl,
    buildActionQueue,
    dibsAttackPresentation,
    dibsEligibility,
    dibsFeatureEnabled,
    duration,
    formatBsp,
    inferEnemyFactionId,
    isFactionPageUrl,
    isWarbuddyPageUrl,
    scoreForFaction,
    toTimestampMs,
  };
});

(function runWarbuddy() {
  "use strict";

  const core = globalThis.WarbuddyCore;
  if (!core) return;

  const BACKEND_BASE_URL = "https://backend.grusmedia.no";
  const SCRIPT_VERSION = "0.1.31";
  const PANEL_ID = "warbuddy-panel";
  const KEY_STORAGE = "warbuddy_api_key";
  const COLLAPSED_STORAGE = "warbuddy_collapsed";
  const POSITION_STORAGE = "warbuddy_position";
  const LEGACY_STORAGE_KEYS = {
    [KEY_STORAGE]: "lads_war_companion_api_key",
    [COLLAPSED_STORAGE]: "lads_war_companion_collapsed",
    [POSITION_STORAGE]: "lads_war_companion_position",
  };
  const REQUEST_TIMEOUT_MS = 30_000;
  const SOCKET_CONNECT_TIMEOUT_MS = 15_000;
  const FALLBACK_POLL_MS = 2_000;
  const FALLBACK_POLL_MAX_MS = 10_000;
  const FALLBACK_SOCKET_RETRY_MS = 60_000;
  const DATA_STALE_MS = 45_000;
  const SCRIPT_CHECK_IN_INTERVAL_MS = 10 * 60 * 1000;
  const SCRIPT_CHECK_IN_RETRY_MS = 60_000;
  const isTornPda = typeof window.PDA_httpGet === "function" || typeof window.PDA_httpPost === "function";
  const PANEL_EDGE_GAP = 8;
  const MAX_WATCHED_TARGETS = 25;
  const TOPICS = ["war_tracker_settings", "war_tracker", "score", "retaliation", "war_dibs"];

  const storage = {
    get(key, fallback = "") {
      if (typeof GM_getValue === "function") return GM_getValue(key, fallback);
      return window.localStorage?.getItem(key) ?? fallback;
    },
    set(key, value) {
      if (typeof GM_setValue === "function") GM_setValue(key, value);
      else window.localStorage?.setItem(key, String(value));
    },
    remove(key) {
      if (typeof GM_deleteValue === "function") GM_deleteValue(key);
      else window.localStorage?.removeItem(key);
    },
  };

  for (const [key, legacyKey] of Object.entries(LEGACY_STORAGE_KEYS)) {
    if (storage.get(key, null) !== null) continue;
    const legacyValue = storage.get(legacyKey, null);
    if (legacyValue === null) continue;
    storage.set(key, legacyValue);
    storage.remove(legacyKey);
  }

  const state = {
    phase: "idle",
    error: "",
    session: null,
    token: "",
    socket: null,
    socketOpenedAt: 0,
    socketConnectTimer: 0,
    reconnectTimer: 0,
    reconnectAttempt: 0,
    fallbackTimer: 0,
    fallbackInFlight: false,
    fallbackActive: false,
    fallbackGeneration: 0,
    fallbackFailureCount: 0,
    lastFallbackAt: "",
    lastFallbackError: "",
    lastLiveDataAt: 0,
    rosterDataAt: new Map(),
    keyDraft: "",
    keyEditorOpen: false,
    keySaving: false,
    keyEditorError: "",
    forgetConfirm: false,
    forgetConfirmTimer: 0,
    ticker: 0,
    routeTimer: 0,
    pageObserver: null,
    observedBody: null,
    authPromise: null,
    authEpoch: 0,
    authTerminal: false,
    checkInPromise: null,
    lastCheckInAt: 0,
    lastCheckInAttemptAt: 0,
    lastCheckInTransport: "",
    rosters: new Map(),
    factionNames: new Map(),
    scores: new Map(),
    settings: null,
    retaliation: { attacks: [] },
    dibs: { claims: [] },
    dibsBusyTargetId: 0,
    dibsBusyAction: "",
    dibsInspectTargetId: 0,
    dibsInspectKey: "",
    dibsError: "",
    dibsErrorTargetId: 0,
    dibsErrorTimer: 0,
    nowMs: Date.now(),
    collapsed: String(storage.get(COLLAPSED_STORAGE, "")) === "1",
    privacyOpen: false,
    targetsOpen: false,
    targetDraft: [],
    targetsDirty: false,
    targetsSaving: false,
    targetError: "",
    targetListScrollTop: 0,
    targetSearch: "",
    targetFilter: "all",
    targetQuickBusyId: 0,
    targetQuickError: "",
    attackTargetId: 0,
    attackQueueOpen: false,
    moreActionsOpen: false,
    active: false,
    renderQueued: false,
    renderFrame: 0,
    dragging: false,
    lastSocketErrorAt: "",
    lastSocketClose: null,
  };

  const escapeHtml = (value) => String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");

  const addStyle = (css) => {
    if (typeof GM_addStyle === "function") GM_addStyle(css);
    else {
      const style = document.createElement("style");
      style.textContent = css;
      (document.head || document.documentElement).appendChild(style);
    }
  };

  const registerMenuCommand = (name, callback) => {
    if (typeof GM_registerMenuCommand === "function") GM_registerMenuCommand(name, callback);
  };

  addStyle(`
    #${PANEL_ID} { display:block !important; visibility:visible !important; opacity:1 !important; position:fixed !important; right:10px; right:max(10px,env(safe-area-inset-right)); bottom:10px; bottom:max(10px,env(safe-area-inset-bottom)); z-index:2147483647 !important; width:min(320px,calc(100vw - 20px)); max-height:min(70vh,620px); max-height:min(70dvh,620px); overflow:hidden; border:1px solid #3f3f46; border-radius:7px; background:#111113; color:#f4f4f5; box-shadow:0 12px 32px rgba(0,0,0,.55); font:12px/1.35 Arial,Helvetica,sans-serif; }
    #${PANEL_ID} * { box-sizing:border-box; letter-spacing:0; }
    #${PANEL_ID}.wc-collapsed .wc-body { display:none; }
    #${PANEL_ID}.wc-collapsed { width:auto; min-width:154px; max-width:calc(100vw - 20px); border-radius:999px; }
    #${PANEL_ID}.wc-collapsed .wc-header { min-height:34px; align-items:center; border:0; border-radius:999px; padding:4px 5px 4px 10px; }
    #${PANEL_ID}.wc-collapsed .wc-matchup, #${PANEL_ID}.wc-collapsed .wc-version { display:none; }
    #${PANEL_ID} .wc-header { display:flex; align-items:flex-start; justify-content:space-between; gap:8px; min-height:42px; padding:5px 7px; border-bottom:1px solid #27272a; background:#18181b; cursor:move; touch-action:none; user-select:none; }
    #${PANEL_ID}.wc-dragging .wc-header { cursor:grabbing; }
    #${PANEL_ID} .wc-heading { min-width:0; flex:1; }
    #${PANEL_ID} .wc-title-row { display:flex; min-width:0; align-items:center; gap:4px; }
    #${PANEL_ID} .wc-player { min-width:0; flex:0 1 auto; overflow:hidden; font-weight:700; text-overflow:ellipsis; white-space:nowrap; }
    #${PANEL_ID} .wc-version { flex:0 0 auto; color:#71717a; font-size:10px; font-weight:400; }
    #${PANEL_ID} .wc-header-status { display:inline-flex; flex:0 0 auto; align-items:center; gap:3px; margin-left:auto; color:#d4d4d8; font-size:10px; font-weight:600; }
    #${PANEL_ID} .wc-matchup { margin-top:1px; overflow:hidden; color:#a1a1aa; font-size:10px; text-overflow:ellipsis; white-space:nowrap; }
    #${PANEL_ID} .wc-body { max-height:calc(min(70vh,620px) - 42px); max-height:calc(min(70dvh,620px) - 42px); overflow:auto; overscroll-behavior:contain; padding:7px; }
    #${PANEL_ID} .wc-dot { width:7px; height:7px; flex:0 0 auto; border-radius:50%; background:#71717a; }
    #${PANEL_ID} .wc-dot.live { background:#10b981; }
    #${PANEL_ID} .wc-dot.wait { background:#f59e0b; }
    #${PANEL_ID} .wc-muted { color:#a1a1aa; }
    #${PANEL_ID} .wc-error { margin-bottom:6px; padding:6px; border:1px solid #7f1d1d; border-radius:5px; background:#2a1114; color:#fecaca; }
    #${PANEL_ID} .wc-section { margin-top:6px; border:1px solid #27272a; border-radius:5px; overflow:hidden; }
    #${PANEL_ID} .wc-section-title { display:flex; align-items:center; justify-content:space-between; gap:6px; padding:5px 6px; background:#18181b; font-weight:700; }
    #${PANEL_ID} .wc-count { color:#a1a1aa; font-size:10px; font-weight:400; }
    #${PANEL_ID} .wc-empty { padding:7px; color:#a1a1aa; }
    #${PANEL_ID} .wc-item { display:flex; align-items:center; justify-content:space-between; gap:7px; min-height:38px; padding:5px 6px; border-top:1px solid #27272a; }
    #${PANEL_ID} .wc-item:first-child { border-top:0; }
    #${PANEL_ID} .wc-item-text { min-width:0; }
    #${PANEL_ID} .wc-item-title { overflow:hidden; color:#e4e4e7; font-weight:700; text-overflow:ellipsis; white-space:nowrap; }
    #${PANEL_ID} .wc-item-detail { overflow:hidden; color:#a1a1aa; font-size:10px; text-overflow:ellipsis; white-space:nowrap; }
    #${PANEL_ID} .wc-item.urgent { box-shadow:inset 3px 0 #ef4444; }
    #${PANEL_ID} .wc-item.watch { box-shadow:inset 3px 0 #f59e0b; }
    #${PANEL_ID} .wc-item.retal { box-shadow:inset 3px 0 #38bdf8; }
    #${PANEL_ID} .wc-item-actions { display:flex; flex:0 0 auto; align-items:center; gap:5px; }
    #${PANEL_ID} .wc-dibs-wrap { position:relative; display:inline-flex; flex:0 0 auto; align-items:center; }
    #${PANEL_ID} .wc-dibs { display:inline-flex; width:16px; height:16px; flex:0 0 auto; align-items:center; justify-content:center; border:0; border-radius:3px; background:transparent; color:#a1a1aa; padding:0; font:11px/1 Arial,Helvetica,sans-serif; cursor:pointer; }
    #${PANEL_ID} .wc-dibs:hover, #${PANEL_ID} .wc-dibs:focus-visible { background:#27272a; color:#e4e4e7; outline:1px solid #71717a; }
    #${PANEL_ID} .wc-dibs.mine { color:#10b981; }
    #${PANEL_ID} .wc-dibs.taken { color:#f59e0b; }
    #${PANEL_ID} .wc-dibs:disabled { opacity:.45; cursor:wait; }
    #${PANEL_ID} .wc-dibs-tip { position:fixed; z-index:2147483647; display:none; width:max-content; max-width:min(210px,calc(100vw - 28px)); border:1px solid #3f3f46; border-radius:4px; background:#09090b; color:#e4e4e7; padding:5px 6px; box-shadow:0 6px 18px rgba(0,0,0,.45); font-size:10px; white-space:normal; }
    #${PANEL_ID} .wc-action-section { overflow:visible; }
    #${PANEL_ID} .wc-action-section .wc-section-title { border-radius:4px 4px 0 0; }
    #${PANEL_ID} .wc-action-section .wc-item:last-child { border-radius:0 0 4px 4px; }
    #${PANEL_ID} .wc-action-section .wc-dibs-tip { font-size:11px; line-height:1.3; }
    #${PANEL_ID} .wc-dibs-wrap.open .wc-dibs-tip { display:block; }
    #${PANEL_ID} .wc-dibs-close { float:right; width:16px; height:16px; margin:-2px -2px 1px 4px; border:0; border-radius:3px; background:transparent; color:#a1a1aa; padding:0; font:700 14px/16px Arial,Helvetica,sans-serif; cursor:pointer; }
    #${PANEL_ID} .wc-dibs-close:hover, #${PANEL_ID} .wc-dibs-close:focus-visible { background:#27272a; color:#fff; outline:1px solid #71717a; }
    #${PANEL_ID} .wc-dibs-release { display:block; width:100%; margin-top:4px; border:1px solid #3f3f46; border-radius:3px; background:#27272a; color:#f4f4f5; padding:3px 5px; font:inherit; font-weight:700; cursor:pointer; }
    #${PANEL_ID} .wc-row { display:flex; gap:5px; margin-top:6px; }
    #${PANEL_ID} .wc-input { min-width:0; flex:1; border:1px solid #3f3f46; border-radius:5px; background:#09090b; color:#f4f4f5; padding:6px; }
    #${PANEL_ID} .wc-secret-input { -webkit-text-security:disc; }
    #${PANEL_ID} .wc-button, #${PANEL_ID} .wc-link { display:inline-flex; flex:0 0 auto; align-items:center; justify-content:center; border:1px solid #3f3f46; border-radius:5px; background:#27272a; color:#f4f4f5; padding:5px 7px; text-decoration:none; font:inherit; font-weight:700; cursor:pointer; }
    #${PANEL_ID} .wc-button:hover, #${PANEL_ID} .wc-link:hover { background:#3f3f46; }
    #${PANEL_ID} .wc-button.primary, #${PANEL_ID} .wc-link.primary { border-color:#065f46; background:#064e3b; color:#d1fae5; }
    #${PANEL_ID} .wc-link.dibs-mine { border-color:#10b981; background:#047857; color:#ecfdf5; }
    #${PANEL_ID} .wc-link.dibs-taken { border-color:#a1a1aa; background:#52525b; color:#fafafa; box-shadow:0 0 0 1px rgba(161,161,170,.55); opacity:1; }
    #${PANEL_ID} .wc-link.dibs-taken:hover { border-color:#d4d4d8; background:#71717a; color:#fff; }
    #${PANEL_ID} .wc-button:disabled { opacity:.45; cursor:default; }
    #${PANEL_ID} .wc-icon { width:22px; height:22px; padding:0; }
    #${PANEL_ID} details { margin-top:6px; border:1px solid #27272a; border-radius:5px; color:#a1a1aa; }
    #${PANEL_ID} summary { cursor:pointer; padding:5px 6px; color:#d4d4d8; font-weight:700; }
    #${PANEL_ID} .wc-summary-count { float:right; color:#a1a1aa; font-size:10px; font-weight:400; }
    #${PANEL_ID} .wc-target-list { max-height:180px; overflow:auto; border-top:1px solid #27272a; }
    #${PANEL_ID} .wc-target-toolbar { display:grid; grid-template-columns:minmax(0,1fr) 108px; gap:5px; padding:6px; border-top:1px solid #27272a; }
    #${PANEL_ID} .wc-target-toolbar .wc-input { width:100%; }
    #${PANEL_ID} .wc-target-option-row { display:flex; min-height:30px; align-items:center; gap:4px; border-top:1px solid #27272a; padding-right:6px; }
    #${PANEL_ID} .wc-target-option-row:first-child { border-top:0; }
    #${PANEL_ID} .wc-target-option { display:flex; min-width:0; flex:1; align-items:center; gap:6px; padding:4px 6px; color:#e4e4e7; cursor:pointer; }
    #${PANEL_ID} .wc-target-option input { width:14px; height:14px; flex:0 0 auto; margin:0; accent-color:#10b981; }
    #${PANEL_ID} .wc-target-option span { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    #${PANEL_ID} .wc-target-actions { display:flex; align-items:center; justify-content:flex-end; gap:6px; padding:6px; border-top:1px solid #27272a; }
    #${PANEL_ID} .wc-target-error { flex:1; color:#fca5a5; font-size:10px; }
    #${PANEL_ID} .wc-unsaved { color:#fbbf24; font-size:10px; font-weight:700; }
    #${PANEL_ID} .wc-attack-card { padding:7px; border:1px solid #065f46; border-radius:5px; background:#09251f; }
    #${PANEL_ID} .wc-attack-kicker { color:#6ee7b7; font-size:10px; font-weight:700; text-transform:uppercase; }
    #${PANEL_ID} .wc-attack-row { display:flex; align-items:center; justify-content:space-between; gap:7px; margin-top:3px; }
    #${PANEL_ID} .wc-attack-name { min-width:0; overflow:hidden; color:#ecfdf5; font-weight:700; text-overflow:ellipsis; white-space:nowrap; }
    #${PANEL_ID} .wc-attack-detail { margin-top:2px; color:#a7f3d0; font-size:10px; }
    #${PANEL_ID} .wc-stale { margin-bottom:6px; padding:5px 6px; border:1px solid #78350f; border-radius:5px; background:#29170b; color:#fde68a; }
    #${PANEL_ID} .wc-queue-details { overflow:hidden; }
    #${PANEL_ID} .wc-queue-details > .wc-section { margin:0; border:0; border-top:1px solid #27272a; border-radius:0; }
    #${PANEL_ID} .wc-more-actions { margin:0; border:0; border-top:1px solid #27272a; border-radius:0; }
    #${PANEL_ID} .wc-privacy { padding:0 6px 6px; }
    #${PANEL_ID} .wc-private-actions { display:flex; gap:5px; padding:0 6px 6px; }
    @media (max-width:520px) { #${PANEL_ID} { right:6px; right:max(6px,env(safe-area-inset-right)); bottom:6px; bottom:max(6px,env(safe-area-inset-bottom)); width:calc(100vw - 12px); width:calc(100vw - 12px - env(safe-area-inset-left) - env(safe-area-inset-right)); max-height:58vh; max-height:58dvh; } #${PANEL_ID}.wc-collapsed { width:auto; } #${PANEL_ID} .wc-body { max-height:calc(58vh - 42px); max-height:calc(58dvh - 42px); padding-bottom:7px; padding-bottom:max(7px,env(safe-area-inset-bottom)); } #${PANEL_ID} .wc-item-detail { white-space:normal; } }
    @media (pointer:coarse) { #${PANEL_ID} .wc-button, #${PANEL_ID} .wc-link { min-height:40px; padding:8px 10px; } #${PANEL_ID} .wc-icon { width:40px; padding:0; } #${PANEL_ID} .wc-dibs, #${PANEL_ID} .wc-dibs-close { width:40px; height:40px; font-size:16px; } #${PANEL_ID} .wc-target-option-row { min-height:44px; } #${PANEL_ID} .wc-target-option input { width:18px; height:18px; } #${PANEL_ID} summary { min-height:40px; padding:11px 8px; } }
  `);

  const normalizeResponse = (response) => {
    if (typeof response === "string") return { status: 200, responseText: response };
    if (response && typeof response === "object" && !("responseText" in response) && !("status" in response)) {
      return { status: 200, responseText: JSON.stringify(response) };
    }
    return response || {};
  };

  const sendRequest = (options) => {
    const method = String(options.method || "GET").toUpperCase();
    if (isTornPda && method === "GET" && typeof window.PDA_httpGet === "function") {
      window.PDA_httpGet(options.url, options.headers || {})
        .then((value) => options.onload?.(normalizeResponse(value))).catch(options.onerror);
      return;
    }
    if (isTornPda && method === "POST" && typeof window.PDA_httpPost === "function") {
      window.PDA_httpPost(options.url, options.headers || {}, options.data || "")
        .then((value) => options.onload?.(normalizeResponse(value))).catch(options.onerror);
      return;
    }
    if (typeof GM_xmlhttpRequest === "function") return GM_xmlhttpRequest({ ...options, anonymous: true });
    fetch(options.url, {
      method,
      headers: options.headers || {},
      body: options.data,
      credentials: "omit",
    }).then(async (response) => options.onload?.({
      status: response.status,
      responseText: await response.text(),
    })).catch(options.onerror);
  };

  const requestJson = (options) => new Promise((resolve, reject) => {
    let settled = false;
    const timeoutMs = Math.max(1_000, Number(options.timeout || REQUEST_TIMEOUT_MS));
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback(value);
    };
    const timeout = setTimeout(() => finish(reject, new Error(`${options.label || "Request"} timed out`)), timeoutMs);
    sendRequest({
      ...options,
      timeout: timeoutMs,
      onload(rawResponse) {
        const response = normalizeResponse(rawResponse);
        let body;
        try { body = JSON.parse(response.responseText || "null"); }
        catch { finish(reject, new Error(`${options.label || "Request"} returned invalid JSON`)); return; }
        const status = Number(response.status || 200);
        if (status < 200 || status >= 300) {
          const message = body?.error?.error || body?.error?.message || body?.message || `HTTP ${status}`;
          const error = new Error(message);
          error.status = status;
          error.code = body?.error?.code;
          finish(reject, error);
          return;
        }
        finish(resolve, body);
      },
      onerror() { finish(reject, new Error(`${options.label || "Request"} failed`)); },
      ontimeout() { finish(reject, new Error(`${options.label || "Request"} timed out`)); },
    });
  });

  const getStoredKey = () => String(storage.get(KEY_STORAGE, "") || "").trim();
  const normalizeTargetIds = (value) => Array.from(new Set(
    (Array.isArray(value) ? value : [])
      .map((memberId) => Number(memberId))
      .filter((memberId) => Number.isSafeInteger(memberId) && memberId > 0)
  )).slice(0, MAX_WATCHED_TARGETS);
  const savedTargetIds = () => normalizeTargetIds(state.settings?.watchedEnemyMemberIds);
  const sameTargetIds = (left, right) => {
    const normalizedLeft = normalizeTargetIds(left).sort((a, b) => a - b);
    const normalizedRight = normalizeTargetIds(right).sort((a, b) => a - b);
    return normalizedLeft.length === normalizedRight.length
      && normalizedLeft.every((memberId, index) => memberId === normalizedRight[index]);
  };
  const isOnline = () => typeof navigator === "undefined" || navigator.onLine !== false;
  const transportIsLive = () => state.phase === "connected" || state.phase === "fallback";
  const socketIsOpen = () => Number(state.socket?.readyState) === 1;
  const dataIsStale = () => socketIsOpen()
    ? state.lastLiveDataAt < state.socketOpenedAt
    : state.lastLiveDataAt > 0 && state.nowMs - state.lastLiveDataAt > DATA_STALE_MS;
  const rosterIsFresh = (factionId) => {
    const normalizedFactionId = String(factionId || "");
    if (!normalizedFactionId) return false;
    if (!transportIsLive() || !isOnline()) return false;
    const updatedAt = Number(state.rosterDataAt.get(normalizedFactionId) || 0);
    if (socketIsOpen()) return updatedAt >= state.socketOpenedAt;
    return updatedAt > 0 && state.nowMs - updatedAt <= DATA_STALE_MS;
  };
  const currentEnemyFactionId = () => core.inferEnemyFactionId(
    String(state.session?.factionId || ""),
    state.scores,
    state.rosters
  );
  const currentEnemyRosterIsFresh = () => rosterIsFresh(currentEnemyFactionId());
  const transientTornErrorCodes = new Set([0, 5, 9, 12, 13, 14, 15, 17]);
  const authenticationError = (message, properties = {}) => Object.assign(new Error(message), properties);
  const isTerminalAuthenticationError = (error) => error?.terminalAuth === true
    || [400, 401, 403, 422].includes(Number(error?.status || 0));
  const syncTargetDraft = () => {
    if (state.targetsDirty && !sameTargetIds(state.targetDraft, savedTargetIds())) return;
    state.targetDraft = savedTargetIds();
    state.targetsDirty = false;
    state.targetError = "";
  };
  const resetPersonalTargets = () => {
    state.targetsOpen = false;
    state.targetDraft = [];
    state.targetsDirty = false;
    state.targetsSaving = false;
    state.targetError = "";
    state.targetSearch = "";
    state.targetFilter = "all";
    state.targetListScrollTop = 0;
  };
  const closeDibsDetails = () => {
    state.dibsInspectTargetId = 0;
    state.dibsInspectKey = "";
  };
  const clearLiveFactionData = () => {
    state.rosters.clear();
    state.factionNames.clear();
    state.scores.clear();
    state.settings = null;
    state.retaliation = { attacks: [] };
    state.dibs = { claims: [] };
    closeDibsDetails();
    state.dibsError = "";
    state.dibsErrorTargetId = 0;
    state.lastLiveDataAt = 0;
    state.rosterDataAt.clear();
    state.targetQuickError = "";
    resetPersonalTargets();
  };
  const prepareSameKeyReconnect = () => {
    state.lastLiveDataAt = 0;
    state.rosterDataAt.clear();
    state.dibsError = "";
    state.dibsErrorTargetId = 0;
    state.targetQuickError = "";
    closeDibsDetails();
  };
  const isForeground = () => state.active
    && !state.collapsed
    && document.visibilityState !== "hidden"
    && (typeof navigator === "undefined" || navigator.onLine !== false);
  const backendUrl = (path) => `${BACKEND_BASE_URL.replace(/\/$/, "")}${path}`;
  const socketUrl = () => `${BACKEND_BASE_URL.replace(/^http/i, "ws").replace(/\/$/, "")}/ws`;
  const fallbackIsFresh = () => state.fallbackActive
    && Number.isFinite(Date.parse(state.lastFallbackAt))
    && Date.parse(state.lastFallbackAt) > Date.now() - (FALLBACK_POLL_MS * 3);

  function getStoredPanelPosition() {
    const raw = storage.get(POSITION_STORAGE, "");
    if (!raw) return null;
    try {
      const position = JSON.parse(String(raw));
      const left = Number(position?.left);
      const top = Number(position?.top);
      if (Number.isFinite(left) && Number.isFinite(top)) return { left, top };
    } catch {
      // Ignore invalid coordinates left by an older browser session.
    }
    storage.remove(POSITION_STORAGE);
    return null;
  }

  function clampPanelPosition(panel, left, top) {
    const width = panel.offsetWidth || panel.getBoundingClientRect().width || 320;
    const height = panel.offsetHeight || panel.getBoundingClientRect().height || 80;
    return {
      left: Math.min(Math.max(PANEL_EDGE_GAP, left), Math.max(PANEL_EDGE_GAP, window.innerWidth - width - PANEL_EDGE_GAP)),
      top: Math.min(Math.max(PANEL_EDGE_GAP, top), Math.max(PANEL_EDGE_GAP, window.innerHeight - height - PANEL_EDGE_GAP)),
    };
  }

  function setPanelPosition(panel, position, persist = false) {
    if (!panel || !position) return;
    const next = clampPanelPosition(panel, position.left, position.top);
    panel.style.left = `${next.left}px`;
    panel.style.top = `${next.top}px`;
    panel.style.right = "auto";
    panel.style.bottom = "auto";
    if (persist) storage.set(POSITION_STORAGE, JSON.stringify(next));
  }

  function applyStoredPanelPosition() {
    const panel = document.getElementById(PANEL_ID);
    const position = getStoredPanelPosition();
    if (panel && position) setPanelPosition(panel, position);
  }

  function resetPanelPosition() {
    storage.remove(POSITION_STORAGE);
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    for (const property of ["left", "top", "right", "bottom"]) panel.style.removeProperty(property);
  }

  function attachPanelDragHandler(panel) {
    const header = panel?.querySelector(".wc-header");
    if (!header) return;
    let drag = null;

    const stopDrag = (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      header.releasePointerCapture?.(event.pointerId);
      panel.classList.remove("wc-dragging");
      state.dragging = false;
      if (drag.moved) {
        const rect = panel.getBoundingClientRect();
        setPanelPosition(panel, { left: rect.left, top: rect.top }, true);
      }
      drag = null;
      scheduleRender();
    };

    header.addEventListener("pointerdown", (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      if (event.target?.closest?.("button, a, input, summary, details")) return;
      const rect = panel.getBoundingClientRect();
      drag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        left: rect.left,
        top: rect.top,
        moved: false,
      };
      state.dragging = true;
      header.setPointerCapture?.(event.pointerId);
    });

    header.addEventListener("pointermove", (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) < 5) return;
      drag.moved = true;
      panel.classList.add("wc-dragging");
      event.preventDefault();
      setPanelPosition(panel, { left: drag.left + dx, top: drag.top + dy });
    });

    header.addEventListener("pointerup", stopDrag);
    header.addEventListener("pointercancel", stopDrag);
  }

  async function getProfileWithKey(key) {
    const query = `key=${encodeURIComponent(key)}&timestamp=${Date.now()}`;
    let profile = await requestJson({
      method: "GET",
      url: `https://api.torn.com/user/?selections=profile&${query}`,
      label: "Torn profile",
    });
    if (profile?.error?.code === 16) {
      profile = await requestJson({
        method: "GET",
        url: `https://api.torn.com/user/?selections=&${query}`,
        label: "Torn profile",
      });
    }
    if (profile?.error) {
      const code = Number(profile.error.code || 0);
      throw authenticationError(profile.error.error || "Torn rejected this key", {
        code,
        terminalAuth: !transientTornErrorCodes.has(code),
      });
    }
    if (!profile?.player_id) throw new Error("Torn did not return your profile");
    return profile;
  }

  const profileFactionId = (profile) => String(
    profile?.faction?.faction_id || profile?.faction?.id || profile?.faction_id || ""
  ).trim();

  async function requestCompanionSession(key) {
    const profile = await getProfileWithKey(key);
    const factionId = profileFactionId(profile);
    if (!factionId) throw authenticationError("Your Torn profile is not in a faction", { terminalAuth: true });
    const response = await requestJson({
      method: "POST",
      url: backendUrl(`/api/v1/factions/${encodeURIComponent(factionId)}/war-companion/session`),
      headers: { "Content-Type": "application/json" },
      data: JSON.stringify({ tornApiKey: key, scriptVersion: SCRIPT_VERSION }),
      label: "Warbuddy login",
    });
    if (!response?.session?.wsSessionToken) throw new Error("Backend did not return a companion session");
    return response.session;
  }

  function applyCompanionSession(session) {
    state.session = session;
    if (session.factionId && session.factionName) {
      state.factionNames.set(String(session.factionId), String(session.factionName));
    }
    state.token = session.wsSessionToken;
    state.lastCheckInAt = 0;
    state.lastCheckInAttemptAt = 0;
    state.lastCheckInTransport = "";
    state.reconnectAttempt = 0;
    state.authTerminal = false;
    state.error = "";
  }

  function invalidateAuthentication() {
    state.authEpoch += 1;
    state.authPromise = null;
    state.checkInPromise = null;
  }

  async function authenticate() {
    if (state.authPromise) return state.authPromise;
    const key = getStoredKey();
    if (!key) return;
    const authEpoch = state.authEpoch;
    state.phase = "authenticating";
    state.error = "";
    state.authTerminal = false;
    scheduleRender();
    let authPromise;
    authPromise = (async () => {
      const session = await requestCompanionSession(key);
      if (authEpoch !== state.authEpoch || key !== getStoredKey()) return undefined;
      applyCompanionSession(session);
      return session;
    })().catch((error) => {
      if (authEpoch !== state.authEpoch || key !== getStoredKey()) return undefined;
      state.phase = "error";
      state.error = String(error?.message || "Could not connect");
      state.authTerminal = isTerminalAuthenticationError(error);
      if (state.authTerminal) state.keyEditorOpen = true;
      throw error;
    }).finally(() => {
      if (state.authPromise === authPromise) {
        state.authPromise = null;
        scheduleRender();
      }
    });
    state.authPromise = authPromise;
    return authPromise;
  }

  function recordScriptCheckIn(transport) {
    if (transport !== "websocket" && transport !== "compatible") return Promise.resolve();
    if (!state.session?.factionId || !state.token || !isForeground()) return Promise.resolve();
    if (state.checkInPromise) return state.checkInPromise;
    const now = Date.now();
    if (
      state.lastCheckInTransport === transport
      && now - state.lastCheckInAt < SCRIPT_CHECK_IN_INTERVAL_MS
    ) return Promise.resolve();
    if (now - state.lastCheckInAttemptAt < SCRIPT_CHECK_IN_RETRY_MS) return Promise.resolve();

    const authEpoch = state.authEpoch;
    const factionId = String(state.session.factionId);
    const token = state.token;
    state.lastCheckInAttemptAt = now;
    let checkInPromise;
    checkInPromise = requestJson({
      method: "POST",
      url: backendUrl(`/api/v1/factions/${encodeURIComponent(factionId)}/war-companion/check-in`),
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      data: JSON.stringify({ scriptVersion: SCRIPT_VERSION, transport }),
      label: "Warbuddy check-in",
      timeout: 10_000,
    }).then((response) => {
      if (authEpoch !== state.authEpoch || factionId !== String(state.session?.factionId || "") || token !== state.token) return;
      if (response?.recorded === false) return;
      state.lastCheckInAt = Date.now();
      state.lastCheckInTransport = transport;
    }).catch(() => undefined).finally(() => {
      if (state.checkInPromise === checkInPromise) state.checkInPromise = null;
    });
    state.checkInPromise = checkInPromise;
    return checkInPromise;
  }

  function clearSocketConnectTimer() {
    if (state.socketConnectTimer) clearTimeout(state.socketConnectTimer);
    state.socketConnectTimer = 0;
  }

  function closeSocket() {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = 0;
    stopFallbackPolling();
    clearSocketConnectTimer();
    const socket = state.socket;
    state.socket = null;
    state.socketOpenedAt = 0;
    if (socket && socket.readyState < WebSocket.CLOSING) {
      socket.close(1000, "Paused");
    }
  }

  function recoverFailedSocket(socket, reason = "Connection failed") {
    if (socket !== state.socket) return;
    clearSocketConnectTimer();
    state.socket = null;
    state.socketOpenedAt = 0;
    state.lastSocketClose = {
      code: 1006,
      reason,
      at: new Date().toISOString(),
    };
    state.error = "";
    state.phase = fallbackIsFresh() ? "fallback" : isForeground() ? "connecting" : "paused";
    try {
      if (socket.readyState < WebSocket.CLOSING) socket.close(4000, reason);
    } catch {
      // A rejected browser handshake may discard the socket before close() runs.
    }
    scheduleRender();
    if (isForeground()) {
      startFallbackPolling();
      scheduleReconnect();
    }
  }

  function subscribeTopics(socket) {
    for (const topic of TOPICS) {
      socket.send(JSON.stringify({
        type: "subscribe",
        id: `wc-${topic}-${Date.now()}`,
        topic,
        payload: { wsSessionToken: state.token },
      }));
    }
  }

  function requestRosterSnapshot() {
    const socket = state.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      if (state.fallbackActive) pollFallbackSnapshot();
      return;
    }
    socket.send(JSON.stringify({ type: "unsubscribe", id: `wc-reset-${Date.now()}`, topic: "war_tracker", payload: { wsSessionToken: state.token } }));
    setTimeout(() => {
      if (socket !== state.socket || socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify({ type: "subscribe", id: `wc-resub-${Date.now()}`, topic: "war_tracker", payload: { wsSessionToken: state.token } }));
    }, 100);
  }

  function applyDibsSnapshot(payload) {
    if (!core.dibsFeatureEnabled(state.settings)) {
      state.dibs = { claims: [] };
      return false;
    }
    const next = payload || { claims: [] };
    const currentGeneratedAt = Date.parse(String(state.dibs?.generatedAt || ""));
    const nextGeneratedAt = Date.parse(String(next?.generatedAt || ""));
    if (Number.isFinite(currentGeneratedAt)) {
      if (!Number.isFinite(nextGeneratedAt) || nextGeneratedAt < currentGeneratedAt) return false;
    }
    state.dibs = next;
    return true;
  }

  function applyEvent(topic, payload) {
    state.lastLiveDataAt = Date.now();
    if (topic === "war_tracker_settings") {
      state.settings = payload || null;
      if (!core.dibsFeatureEnabled(state.settings)) {
        state.dibs = { claims: [] };
        closeDibsDetails();
        state.dibsError = "";
        state.dibsErrorTargetId = 0;
      }
      syncTargetDraft();
    }
    if (topic === "war_tracker") {
      const factionId = String(payload?.factionId || payload?.faction_id || "");
      if (factionId) {
        const factionName = String(payload?.factionName || payload?.faction_name || "").trim();
        if (factionName) state.factionNames.set(factionId, factionName);
        const next = core.applyRosterUpdate(state.rosters.get(factionId), payload);
        state.rosters.set(factionId, next);
        if (next.needsSnapshot) {
          state.rosterDataAt.delete(factionId);
          requestRosterSnapshot();
        } else {
          state.rosterDataAt.set(factionId, Date.now());
        }
      }
    }
    if (topic === "score") {
      const values = Array.isArray(payload) ? payload : Array.isArray(payload?.scores) ? payload.scores : [payload];
      for (const score of values) {
        const factionId = String(score?.factionId || score?.faction_id || "");
        if (factionId) state.scores.set(factionId, score);
      }
    }
    if (topic === "retaliation") state.retaliation = payload || { attacks: [] };
    if (topic === "war_dibs") applyDibsSnapshot(payload);
    scheduleRender();
  }

  function applyFallbackSnapshot(snapshot) {
    state.lastLiveDataAt = Date.now();
    state.settings = snapshot?.settings || null;
    syncTargetDraft();
    const factionNames = new Map();
    const ownFactionId = String(state.session?.factionId || "");
    const ownFactionName = String(state.session?.factionName || "").trim();
    if (ownFactionId && ownFactionName) factionNames.set(ownFactionId, ownFactionName);
    for (const [factionId, factionName] of Object.entries(snapshot?.factionNames || {})) {
      const normalizedName = String(factionName || "").trim();
      if (factionId && normalizedName) factionNames.set(String(factionId), normalizedName);
    }
    const rosters = new Map();
    const rosterDataAt = new Map();
    for (const payload of Array.isArray(snapshot?.rosters) ? snapshot.rosters : []) {
      const factionId = String(payload?.factionId || payload?.faction_id || "");
      if (!factionId) continue;
      const factionName = String(payload?.factionName || payload?.faction_name || "").trim();
      if (factionName) factionNames.set(factionId, factionName);
      const next = core.applyRosterUpdate(undefined, payload);
      rosters.set(factionId, next);
      if (!next.needsSnapshot) rosterDataAt.set(factionId, state.lastLiveDataAt);
    }
    const scores = new Map();
    for (const score of Array.isArray(snapshot?.scores) ? snapshot.scores : []) {
      const factionId = String(score?.factionId || score?.faction_id || "");
      if (factionId) scores.set(factionId, score);
    }
    state.rosters = rosters;
    state.rosterDataAt = rosterDataAt;
    state.factionNames = factionNames;
    state.scores = scores;
    state.retaliation = snapshot?.retaliation || { attacks: [] };
    applyDibsSnapshot(snapshot?.dibs);
    scheduleRender();
  }

  function clearFallbackTimer() {
    if (state.fallbackTimer) clearTimeout(state.fallbackTimer);
    state.fallbackTimer = 0;
  }

  function stopFallbackPolling() {
    clearFallbackTimer();
    state.fallbackGeneration += 1;
    state.fallbackActive = false;
    state.fallbackInFlight = false;
    state.fallbackFailureCount = 0;
  }

  function scheduleFallbackPoll() {
    clearFallbackTimer();
    if (!state.fallbackActive || !isForeground()) return;
    const delay = Math.min(
      FALLBACK_POLL_MAX_MS,
      FALLBACK_POLL_MS * (2 ** Math.min(state.fallbackFailureCount, 3)),
    );
    state.fallbackTimer = setTimeout(() => {
      state.fallbackTimer = 0;
      pollFallbackSnapshot();
    }, delay);
  }

  function startFallbackPolling() {
    if (!state.session || !state.token || !isForeground()) return;
    if (!state.fallbackActive) state.fallbackFailureCount = 0;
    state.fallbackActive = true;
    pollFallbackSnapshot();
  }

  async function pollFallbackSnapshot() {
    if (!state.fallbackActive || state.fallbackInFlight || !isForeground()) return;
    const generation = state.fallbackGeneration;
    state.fallbackInFlight = true;
    clearFallbackTimer();
    try {
      const expiresAt = Date.parse(String(state.session?.wsSessionTokenExpiresAt || state.session?.expiresAt || ""));
      if (!state.token || !Number.isFinite(expiresAt) || expiresAt <= Date.now() + 30_000) {
        await authenticate();
      }
      const factionId = String(state.session?.factionId || "");
      if (!factionId || !state.token) throw new Error("Companion session is unavailable");
      const snapshot = await requestJson({
        method: "GET",
        url: backendUrl(`/api/v1/factions/${encodeURIComponent(factionId)}/war-companion/snapshot?timestamp=${Date.now()}`),
        headers: { Authorization: `Bearer ${state.token}` },
        label: "Warbuddy snapshot",
      });
      if (generation !== state.fallbackGeneration || !state.fallbackActive || !isForeground()) return;
      state.nowMs = Date.now();
      applyFallbackSnapshot(snapshot);
      state.phase = "fallback";
      state.error = "";
      state.lastFallbackAt = new Date().toISOString();
      state.lastFallbackError = "";
      state.fallbackFailureCount = 0;
      void recordScriptCheckIn("compatible");
    } catch (error) {
      if (generation !== state.fallbackGeneration || !state.fallbackActive) return;
      state.lastFallbackError = String(error?.message || "Fallback update failed");
      state.fallbackFailureCount += 1;
      if (fallbackIsFresh()) {
        state.phase = "fallback";
        state.error = "";
      } else if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
        state.phase = "connecting";
        state.error = state.fallbackFailureCount >= 3
          ? `Live connection and compatible fallback failed: ${state.lastFallbackError}`
          : "";
      }
      scheduleRender();
    } finally {
      if (generation !== state.fallbackGeneration) return;
      state.fallbackInFlight = false;
      scheduleFallbackPoll();
    }
  }

  function handleSocketMessage(event) {
    let message;
    try { message = JSON.parse(String(event.data || "")); }
    catch { return; }
    if (message?.type === "event" && TOPICS.includes(String(message.topic || ""))) {
      applyEvent(String(message.topic), message.payload);
    }
    if (message?.type === "error") {
      state.error = message?.error?.error || message?.error?.message || "Live update failed";
      scheduleRender();
    }
  }

  function scheduleReconnect() {
    if (!isForeground() || state.reconnectTimer || state.authTerminal) return;
    const delay = state.fallbackActive
      ? FALLBACK_SOCKET_RETRY_MS
      : Math.min(20_000, 1_000 * 2 ** Math.min(state.reconnectAttempt, 4));
    state.reconnectAttempt += 1;
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = 0;
      ensureConnected();
    }, delay);
  }

  async function ensureConnected() {
    if (!isForeground() || !getStoredKey() || state.authTerminal) return;
    if (state.socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(state.socket.readyState)) return;
    try {
      const expiresAt = Date.parse(String(state.session?.wsSessionTokenExpiresAt || state.session?.expiresAt || ""));
      if (!state.token || !Number.isFinite(expiresAt) || expiresAt <= Date.now() + 30_000) await authenticate();
      if (!isForeground() || !getStoredKey() || !state.session || !state.token) return;
      if (state.socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(state.socket.readyState)) return;
      if (isTornPda) {
        if (!fallbackIsFresh()) state.phase = "connecting";
        startFallbackPolling();
        scheduleRender();
        return;
      }
      if (!fallbackIsFresh()) {
        state.phase = "connecting";
        scheduleRender();
      }
      const socket = new window.WebSocket(socketUrl());
      state.socket = socket;
      clearSocketConnectTimer();
      state.socketConnectTimer = setTimeout(() => {
        if (socket !== state.socket) return;
        state.socketConnectTimer = 0;
        if (socket.readyState === WebSocket.OPEN) return;
        recoverFailedSocket(
          socket,
          "Handshake timed out"
        );
      }, SOCKET_CONNECT_TIMEOUT_MS);
      socket.addEventListener("open", () => {
        if (socket !== state.socket) return;
        clearSocketConnectTimer();
        stopFallbackPolling();
        state.phase = "connected";
        state.socketOpenedAt = Date.now();
        state.authTerminal = false;
        state.reconnectAttempt = 0;
        state.error = "";
        state.lastSocketClose = null;
        subscribeTopics(socket);
        void recordScriptCheckIn("websocket");
        scheduleRender();
      });
      socket.addEventListener("message", (event) => {
        if (socket !== state.socket) return;
        handleSocketMessage(event);
      });
      socket.addEventListener("error", () => {
        if (socket !== state.socket) return;
        state.lastSocketErrorAt = new Date().toISOString();
        setTimeout(() => {
          if (socket !== state.socket || socket.readyState < WebSocket.CLOSING) return;
          recoverFailedSocket(
            socket,
            "Handshake rejected"
          );
        }, 0);
      });
      socket.addEventListener("close", (event) => {
        if (socket !== state.socket) return;
        clearSocketConnectTimer();
        state.socket = null;
        state.socketOpenedAt = 0;
        state.lastSocketClose = {
          code: Number(event.code || 1006),
          reason: String(event.reason || ""),
          at: new Date().toISOString(),
        };
        if (!isForeground()) {
          state.phase = "paused";
          scheduleRender();
          return;
        }
        const hasFreshFallback = fallbackIsFresh();
        if (event.code === 1008) {
          state.token = "";
          state.session = null;
          state.error = "Live authorization expired. Reconnecting.";
        } else if (typeof navigator !== "undefined" && navigator.onLine === false) {
          state.error = "Device is offline. Live updates will resume automatically.";
        } else if (!hasFreshFallback && state.reconnectAttempt >= 2) {
          state.error = `Live connection interrupted (code ${event.code || 1006}). Retrying automatically.`;
        } else {
          state.error = "";
        }
        state.phase = hasFreshFallback ? "fallback" : "connecting";
        if (state.token && state.session) startFallbackPolling();
        scheduleRender();
        scheduleReconnect();
      });
    } catch (error) {
      if (state.phase === "error" && state.error) {
        // Keep authentication and permission failures visible.
      } else if (fallbackIsFresh()) {
        state.phase = "fallback";
        state.error = "";
      } else {
        state.phase = "connecting";
        state.error = "";
        if (state.token && state.session) startFallbackPolling();
      }
      scheduleRender();
      if (!state.authTerminal) scheduleReconnect();
    }
  }

  function startTicker() {
    if (state.ticker) return;
    state.ticker = setInterval(() => {
      state.nowMs = Date.now();
      if (state.phase === "connected") void recordScriptCheckIn("websocket");
      if (state.phase === "fallback") void recordScriptCheckIn("compatible");
      if (!isTornPda || !state.fallbackActive) scheduleRender();
    }, 1_000);
  }

  function stopTicker() {
    if (state.ticker) clearInterval(state.ticker);
    state.ticker = 0;
  }

  function syncForegroundState() {
    if (!state.active) {
      stopTicker();
      closeSocket();
      return;
    }
    if (isForeground()) {
      if (getStoredKey()) startTicker();
      else stopTicker();
      ensureConnected();
      return;
    }
    stopTicker();
    closeSocket();
    state.phase = getStoredKey() ? "paused" : "idle";
    cancelScheduledRender();
    scheduleRender();
  }

  function sessionView() {
    const ownFactionId = String(state.session?.factionId || "");
    const enemyFactionId = currentEnemyFactionId();
    const ownFactionName = String(state.session?.factionName || state.factionNames.get(ownFactionId) || "").trim();
    const enemyFactionName = String(state.factionNames.get(enemyFactionId) || "").trim();
    const ownRoster = state.rosters.get(ownFactionId)?.members || [];
    const enemyRoster = state.rosters.get(enemyFactionId)?.members || [];
    const ownMember = ownRoster.find((member) => Number(member?.member_id || 0) === Number(state.session?.playerId || 0));
    const alliedScore = core.scoreForFaction(state.scores, ownFactionId);
    const actionQueueEnabled = state.settings?.enabled !== false && state.settings?.showActionQueue !== false;
    const genericSuggestionsEnabled = rosterIsFresh(ownFactionId) && rosterIsFresh(enemyFactionId);
    const actions = !actionQueueEnabled ? [] : core.buildActionQueue({
      enemies: enemyRoster,
      alliedScore,
      ownBsp: ownMember?.bsp || 0,
      watchedEnemyMemberIds: state.settings?.watchedEnemyMemberIds || [],
      nowMs: state.nowMs,
    }).filter((item) => genericSuggestionsEnabled || !String(item.key || "").startsWith("online-"));
    const retaliation = core.activeRetaliations(state.retaliation, Math.floor(state.nowMs / 1000));
    return { ownFactionId, ownFactionName, enemyFactionId, enemyFactionName, enemyRoster, actions, retaliation, dibs: state.dibs, actionQueueEnabled };
  }

  const statusView = () => {
    if (!getStoredKey()) return { label: "API key needed", tone: "" };
    if (state.authTerminal) return { label: "Key needs attention", tone: "wait" };
    if (state.collapsed) return { label: "Paused", tone: "" };
    if (!isOnline()) return { label: "Offline", tone: "wait" };
    if (document.visibilityState === "hidden") return { label: "Paused while hidden", tone: "" };
    if (transportIsLive() && state.settings?.enabled !== false && currentEnemyFactionId() && !currentEnemyRosterIsFresh()) return { label: "Syncing targets", tone: "wait" };
    if (transportIsLive() && dataIsStale()) return { label: "Stale", tone: "wait" };
    if (state.phase === "connected") return { label: "Live", tone: "live" };
    if (state.phase === "fallback") return { label: "Live (compatible)", tone: "live" };
    if (state.phase === "paused") return { label: "Paused", tone: "" };
    if (state.phase === "error") return { label: "Connection error", tone: "wait" };
    if (state.phase === "authenticating") return { label: "Checking key", tone: "wait" };
    return { label: "Connecting", tone: "wait" };
  };

  function dibsMarkup(member, view, knownClaim, instanceKey) {
    if (!core.dibsFeatureEnabled(state.settings)) return "";
    const memberId = Number(member?.member_id || 0);
    if (!Number.isSafeInteger(memberId) || memberId <= 0) return "";
    const claim = knownClaim || core.activeDibsClaim(view.dibs, memberId, state.nowMs);
    const eligibility = core.dibsEligibility(member, state.nowMs);
    if (!claim && !eligibility.eligible) return "";
    const isMine = !!claim && String(claim.claimedByPlayerId || "") === String(state.session?.playerId || "");
    const tone = isMine ? "mine" : claim ? "taken" : "";
    const busy = state.dibsBusyTargetId === memberId;
    const anyBusy = state.dibsBusyTargetId > 0 || state.targetsSaving || state.targetQuickBusyId > 0;
    const canMutate = rosterIsFresh(view.enemyFactionId)
      && !state.authTerminal && !state.keySaving && !state.targetsSaving && !state.targetQuickBusyId;
    const remaining = claim ? core.duration(core.toTimestampMs(claim.expiresAt) - state.nowMs) : "";
    const label = claim
      ? `Dibs: ${claim.claimedByPlayerName || claim.claimedByPlayerId} - ${remaining} left`
      : eligibility.state === "hospitalized"
        ? `Claim Dibs - leaves hospital in ${core.duration(Number(eligibility.hospitalUntil || 0) - state.nowMs)}`
        : "Claim Dibs - attackable now";
    const action = claim ? "inspect" : "claim";
    const dibsInstanceKey = String(instanceKey || `member-${memberId}`);
    const open = state.dibsInspectTargetId === memberId && state.dibsInspectKey === dibsInstanceKey ? " open" : "";
    const disabled = anyBusy || (!claim && !canMutate);
    const release = isMine
      ? `<button type="button" class="wc-dibs-release" data-dibs-action="release" data-dibs-target="${memberId}" data-dibs-instance="${escapeHtml(dibsInstanceKey)}" data-focus-key="dibs-release-${escapeHtml(dibsInstanceKey)}"${!canMutate || anyBusy ? " disabled" : ""}>${busy && state.dibsBusyAction === "release" ? "Releasing..." : "Release & unwatch"}</button>`
      : "";
    const error = state.dibsError && state.dibsErrorTargetId === memberId
      ? `<div class="wc-target-error" role="alert">${escapeHtml(state.dibsError)}</div>`
      : "";
    const busyLabel = busy && state.dibsBusyAction === "claim" ? "Claiming Dibs" : label;
    return `<span class="wc-dibs-wrap${open}" data-dibs-instance="${escapeHtml(dibsInstanceKey)}"><button type="button" class="wc-dibs ${tone}" data-dibs-action="${action}" data-dibs-target="${memberId}" data-dibs-instance="${escapeHtml(dibsInstanceKey)}" data-focus-key="dibs-${escapeHtml(dibsInstanceKey)}" aria-label="${escapeHtml(busyLabel)}" aria-pressed="${open ? "true" : "false"}"${busy ? ' aria-busy="true"' : ""} title="${escapeHtml(label)}"${disabled ? " disabled" : ""}>&#9995;</button><span class="wc-dibs-tip" role="status"><button type="button" class="wc-dibs-close" data-dibs-action="close" data-dibs-target="${memberId}" data-dibs-instance="${escapeHtml(dibsInstanceKey)}" aria-label="Close Dibs details" title="Close">&times;</button>${escapeHtml(label)}${error}${release}</span></span>`;
  }

  function attackLinkMarkup(url, targetMemberId, actionLabel, view, emphasized = false, knownClaim) {
    const claim = knownClaim || (core.dibsFeatureEnabled(state.settings)
      ? core.activeDibsClaim(view.dibs, targetMemberId, state.nowMs)
      : undefined);
    const presentation = core.dibsAttackPresentation(
      claim,
      state.session?.playerId,
      actionLabel || "Attack"
    );
    const toneClass = presentation.state === "mine"
      ? "dibs-mine"
      : presentation.state === "taken" ? "dibs-taken" : emphasized ? "primary" : "";
    return `<a class="wc-link ${toneClass}" data-dibs-state="${presentation.state}" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" aria-label="${escapeHtml(presentation.title)}" title="${escapeHtml(presentation.title)}">${escapeHtml(presentation.label)}</a>`;
  }

  function actionMarkup(item, view) {
    const member = view.enemyRoster.find((candidate) => Number(candidate?.member_id || 0) === Number(item.memberId || 0));
    const memberId = Number(member?.member_id || item.memberId || 0);
    const claim = core.dibsFeatureEnabled(state.settings)
      ? core.activeDibsClaim(view.dibs, memberId, state.nowMs)
      : undefined;
    return `<div class="wc-item ${escapeHtml(item.severity)}">
      <div class="wc-item-text"><div class="wc-item-title">${escapeHtml(item.title)}</div><div class="wc-item-detail" title="${escapeHtml(item.detail)}">${escapeHtml(item.detail)}</div></div>
      <div class="wc-item-actions">${member ? dibsMarkup(member, view, claim, `action-${item.key}`) : ""}${item.url ? attackLinkMarkup(item.url, memberId, item.actionLabel || "Open", view, item.severity === "urgent", claim) : ""}</div>
    </div>`;
  }

  function retaliationMarkup(attack, view) {
    const remaining = core.duration((Number(attack.expiresAt || 0) * 1000) - state.nowMs);
    const target = attack.defenderName ? `Hit ${attack.defenderName}` : "Faction hit";
    const memberId = Number(attack.attackerId || 0);
    const member = view.enemyRoster.find((candidate) => Number(candidate?.member_id || 0) === memberId);
    const claim = core.dibsFeatureEnabled(state.settings)
      ? core.activeDibsClaim(view.dibs, memberId, state.nowMs)
      : undefined;
    return `<div class="wc-item retal">
      <div class="wc-item-text"><div class="wc-item-title">${escapeHtml(attack.attackerName || `Player ${attack.attackerId}`)}</div><div class="wc-item-detail">${escapeHtml(`${target} - ${remaining} left`)}</div></div>
      <div class="wc-item-actions">${member ? dibsMarkup(member, view, claim, `retal-${memberId}-${attack.expiresAt}`) : ""}${attackLinkMarkup(attack.attackUrl || core.attackUrl(attack.attackerId), memberId, "Attack", view, true, claim)}</div>
    </div>`;
  }

  function watchedTargetOptions(view, selectedIds) {
    const options = new Map();
    for (const member of view.enemyRoster || []) {
      const memberId = Number(member?.member_id || 0);
      if (!Number.isSafeInteger(memberId) || memberId <= 0) continue;
      options.set(memberId, {
        memberId,
        name: String(member?.member_name || `Player ${memberId}`),
        current: true,
        member,
        status: String(member?.status?.userStatus || member?.status?.state || member?.status?.status || "").toLowerCase(),
        location: String(member?.location?.current || member?.location?.name || member?.location || "").toLowerCase(),
        destination: String(member?.location?.destination || member?.destination || "").toLowerCase(),
      });
    }
    for (const memberId of selectedIds) {
      if (!options.has(memberId)) options.set(memberId, { memberId, name: `Player ${memberId}`, current: false });
    }
    return Array.from(options.values()).sort((left, right) => left.name.localeCompare(right.name) || left.memberId - right.memberId);
  }

  function filteredWatchedTargetOptions(view, selectedIds) {
    const selected = new Set(selectedIds);
    const query = state.targetSearch.trim().toLowerCase();
    return watchedTargetOptions(view, selectedIds).filter((option) => {
      if (query && !`${option.name} ${option.memberId}`.toLowerCase().includes(query)) return false;
      if (state.targetFilter === "selected") return selected.has(option.memberId);
      if (state.targetFilter === "attackable") {
        const eligibility = option.member ? core.dibsEligibility(option.member, state.nowMs) : undefined;
        return eligibility?.eligible === true && eligibility.state === "available";
      }
      if (state.targetFilter === "hospital") return option.status.includes("hospital");
      if (state.targetFilter === "traveling") {
        return option.status.includes("travel")
          || (!!option.location && !option.location.includes("torn"))
          || (!!option.destination && !option.destination.includes("torn"));
      }
      return true;
    });
  }

  async function persistWatchedTargetIds(value) {
    const memberIds = normalizeTargetIds(value);
    const expiresAt = Date.parse(String(state.session?.wsSessionTokenExpiresAt || state.session?.expiresAt || ""));
    if (!state.token || !Number.isFinite(expiresAt) || expiresAt <= Date.now() + 30_000) await authenticate();
    const factionId = String(state.session?.factionId || "");
    if (!factionId || !state.token) throw new Error("Companion session is unavailable");
    const response = await requestJson({
      method: "POST",
      url: backendUrl(`/api/v1/factions/${encodeURIComponent(factionId)}/war-companion/watched-targets`),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${state.token}`,
      },
      data: JSON.stringify({ memberIds }),
      label: "Watched targets",
    });
    const savedIds = normalizeTargetIds(
      Array.isArray(response?.watchedEnemyMemberIds) ? response.watchedEnemyMemberIds : memberIds
    );
    state.settings = { ...(state.settings || {}), watchedEnemyMemberIds: savedIds };
    return savedIds;
  }

  async function saveWatchedTargets() {
    if (state.targetsSaving || state.targetQuickBusyId || state.dibsBusyTargetId || !state.targetsDirty) return;
    if (!isOnline() || state.authTerminal || state.keySaving) {
      state.targetError = "Watched targets are unavailable until the connection is restored.";
      scheduleRender();
      return;
    }
    state.targetsSaving = true;
    state.targetError = "";
    scheduleRender();
    try {
      const memberIds = await persistWatchedTargetIds(state.targetDraft);
      state.settings = { ...(state.settings || {}), watchedEnemyMemberIds: memberIds };
      state.targetDraft = memberIds;
      state.targetsDirty = false;
      state.targetsOpen = false;
    } catch (error) {
      state.targetError = String(error?.message || "Could not save watched targets");
    } finally {
      state.targetsSaving = false;
      scheduleRender();
    }
  }

  async function toggleWatchedTarget(targetMemberId) {
    const memberId = Number(targetMemberId || 0);
    if (state.targetQuickBusyId || state.targetsSaving || state.dibsBusyTargetId || !Number.isSafeInteger(memberId) || memberId <= 0) return;
    if (!isOnline() || state.authTerminal || state.keySaving) {
      state.targetQuickError = "Watched targets are unavailable until the connection is restored.";
      scheduleRender();
      return;
    }
    const wasWatched = savedTargetIds().includes(memberId);
    const next = new Set(savedTargetIds());
    if (wasWatched) next.delete(memberId);
    else if (next.size < MAX_WATCHED_TARGETS) next.add(memberId);
    else {
      state.targetQuickError = `You can watch up to ${MAX_WATCHED_TARGETS} targets.`;
      scheduleRender();
      return;
    }
    state.targetQuickBusyId = memberId;
    state.targetQuickError = "";
    scheduleRender();
    try {
      const savedIds = await persistWatchedTargetIds(Array.from(next));
      if (state.targetsOpen || state.targetsDirty) {
        const draft = new Set(normalizeTargetIds(state.targetDraft));
        if (wasWatched) draft.delete(memberId);
        else draft.add(memberId);
        state.targetDraft = normalizeTargetIds(Array.from(draft));
        state.targetsDirty = !sameTargetIds(state.targetDraft, savedIds);
      } else {
        state.targetDraft = savedIds;
      }
    } catch (error) {
      state.targetQuickError = String(error?.message || "Could not update watched target");
    } finally {
      state.targetQuickBusyId = 0;
      scheduleRender();
    }
  }

  function showDibsError(message, targetMemberId = 0) {
    state.dibsError = String(message || "Dibs could not be updated");
    state.dibsErrorTargetId = Number(targetMemberId || 0);
    if (state.dibsErrorTimer) clearTimeout(state.dibsErrorTimer);
    state.dibsErrorTimer = setTimeout(() => {
      state.dibsErrorTimer = 0;
      state.dibsError = "";
      state.dibsErrorTargetId = 0;
      scheduleRender();
    }, 5_000);
  }

  function applyReleasedTargetWatchState(memberId, response) {
    const savedIds = normalizeTargetIds(
      Array.isArray(response?.watchedEnemyMemberIds)
        ? response.watchedEnemyMemberIds
        : savedTargetIds().filter((candidate) => candidate !== memberId)
    );
    const draftIds = normalizeTargetIds(state.targetDraft).filter((candidate) => candidate !== memberId);
    state.settings = { ...(state.settings || {}), watchedEnemyMemberIds: savedIds };
    state.targetDraft = state.targetsOpen || state.targetsDirty ? draftIds : savedIds;
    state.targetsDirty = !sameTargetIds(state.targetDraft, savedIds);
  }

  async function updateDibs(action, targetMemberId, instanceKey = "") {
    const memberId = Number(targetMemberId || 0);
    if (!core.dibsFeatureEnabled(state.settings) || state.dibsBusyTargetId || state.targetsSaving || state.targetQuickBusyId || !Number.isSafeInteger(memberId) || memberId <= 0) return;
    if (!currentEnemyRosterIsFresh() || state.keySaving) {
      showDibsError("Dibs is unavailable until Warbuddy has a fresh live connection.", memberId);
      scheduleRender();
      return;
    }
    const expectsSocketSnapshot = socketIsOpen();
    const resumeFallback = !expectsSocketSnapshot && state.fallbackActive;
    state.dibsBusyTargetId = memberId;
    state.dibsBusyAction = action;
    state.dibsError = "";
    state.dibsErrorTargetId = 0;
    if (resumeFallback) stopFallbackPolling();
    scheduleRender();
    try {
      const expiresAt = Date.parse(String(state.session?.wsSessionTokenExpiresAt || state.session?.expiresAt || ""));
      if (!state.token || !Number.isFinite(expiresAt) || expiresAt <= Date.now() + 30_000) await authenticate();
      const factionId = String(state.session?.factionId || "");
      if (!factionId || !state.token) throw new Error("Companion session is unavailable");
      const response = await requestJson({
        method: "POST",
        url: backendUrl(`/api/v1/factions/${encodeURIComponent(factionId)}/war-companion/dibs`),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${state.token}`,
        },
        data: JSON.stringify({ action, targetMemberId: memberId }),
        label: "Dibs",
      });
      if (!expectsSocketSnapshot) applyDibsSnapshot(response);
      if (action === "release") applyReleasedTargetWatchState(memberId, response);
      if (action === "claim") {
        state.dibsInspectTargetId = memberId;
        state.dibsInspectKey = String(instanceKey || `member-${memberId}`);
      } else {
        closeDibsDetails();
      }
    } catch (error) {
      showDibsError(error?.message || "Dibs could not be updated", memberId);
    } finally {
      state.dibsBusyTargetId = 0;
      state.dibsBusyAction = "";
      if (resumeFallback && !socketIsOpen()) startFallbackPolling();
      scheduleRender();
    }
  }

  function actionQueueMarkup(view, trackerDisabled, noWar) {
    if (trackerDisabled) return "";
    if (!view.actionQueueEnabled) return "";
    const visible = view.actions.slice(0, 9);
    const remaining = view.actions.slice(9);
    const items = noWar
      ? `<div class="wc-empty">No active war.</div>`
      : visible.length
        ? visible.map((item) => actionMarkup(item, view)).join("")
        : `<div class="wc-empty">No immediate actions.</div>`;
    const more = remaining.length
      ? `<details class="wc-more-actions" data-section="more-actions"${state.moreActionsOpen ? " open" : ""}><summary>More actions <span class="wc-summary-count">${remaining.length}</span></summary>${remaining.map((item) => actionMarkup(item, view)).join("")}</details>`
      : "";
    return `<div class="wc-section wc-action-section"><div class="wc-section-title"><span>Action queue</span><span class="wc-count">${view.actions.length}</span></div>${items}${more}</div>`;
  }

  function attackTargetMarkup(view) {
    if (!state.attackTargetId) return "";
    const memberId = state.attackTargetId;
    const member = view.enemyRoster.find((candidate) => Number(candidate?.member_id || 0) === memberId);
    const watched = savedTargetIds().includes(memberId);
    const atLimit = !watched && savedTargetIds().length >= MAX_WATCHED_TARGETS;
    const busy = state.targetQuickBusyId === memberId;
    const watchUnavailable = !isOnline() || state.authTerminal || state.targetQuickBusyId > 0 || state.targetsSaving;
    const name = String(member?.member_name || `Player ${memberId}`);
    const rawStatus = String(member?.status?.userStatus || member?.status?.state || member?.status?.status || "").trim();
    const location = String(member?.location?.current || member?.location?.name || member?.location || "").trim();
    const details = [
      rawStatus || (member ? "Status unknown" : "Waiting for roster data"),
      member?.bsp ? `${core.formatBsp(member.bsp)} BSP` : "BSP unknown",
      location,
    ].filter(Boolean).join(" · ");
    const claim = member && core.dibsFeatureEnabled(state.settings)
      ? core.activeDibsClaim(view.dibs, memberId, state.nowMs)
      : undefined;
    const quickError = state.targetQuickError
      ? `<div class="wc-target-error" role="alert">${escapeHtml(state.targetQuickError)}</div>`
      : "";
    return `<div class="wc-attack-card"><div class="wc-attack-kicker">Current Torn target</div><div class="wc-attack-row"><div class="wc-attack-name" title="${escapeHtml(name)}">${escapeHtml(name)}</div><div class="wc-item-actions">${member ? dibsMarkup(member, view, claim, `attack-${memberId}`) : ""}<button type="button" class="wc-button${watched ? " primary" : ""}" data-action="toggle-watch" data-target-member="${memberId}" data-focus-key="watch-${memberId}"${watchUnavailable || atLimit ? " disabled" : ""}>${busy ? "Saving..." : watched ? "Unwatch" : "Watch"}</button></div></div><div class="wc-attack-detail">${escapeHtml(details)}</div>${quickError}</div>`;
  }

  function capturePanelFocus(panel) {
    const activeElement = document.activeElement;
    if (!activeElement || !panel.contains?.(activeElement)) return null;
    const focusKey = String(activeElement.dataset?.focusKey || activeElement.dataset?.field || "");
    if (!focusKey) return null;
    return {
      focusKey,
      selectionStart: Number.isInteger(activeElement.selectionStart) ? activeElement.selectionStart : null,
      selectionEnd: Number.isInteger(activeElement.selectionEnd) ? activeElement.selectionEnd : null,
    };
  }

  function restorePanelFocus(panel, snapshot) {
    if (!snapshot) return;
    const candidate = Array.from(panel.querySelectorAll?.("[data-focus-key], [data-field]") || []).find((element) => (
      String(element.dataset?.focusKey || element.dataset?.field || "") === snapshot.focusKey
    ));
    if (!candidate) return;
    candidate.focus?.({ preventScroll: true });
    if (snapshot.selectionStart !== null && typeof candidate.setSelectionRange === "function") {
      candidate.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd);
    }
  }

  function positionOpenDibsTip(panel) {
    const wrap = panel.querySelector?.(".wc-dibs-wrap.open");
    const button = wrap?.querySelector?.(".wc-dibs");
    const tip = wrap?.querySelector?.(".wc-dibs-tip");
    if (!button?.getBoundingClientRect || !tip?.getBoundingClientRect) return;
    const buttonRect = button.getBoundingClientRect();
    const tipRect = tip.getBoundingClientRect();
    const viewport = window.visualViewport;
    const viewportLeft = Number(viewport?.offsetLeft || 0);
    const viewportTop = Number(viewport?.offsetTop || 0);
    const viewportWidth = Number(viewport?.width || window.innerWidth || 320);
    const viewportHeight = Number(viewport?.height || window.innerHeight || 480);
    const gap = 6;
    const left = Math.max(viewportLeft + gap, Math.min(
      buttonRect.right - tipRect.width,
      viewportLeft + viewportWidth - tipRect.width - gap
    ));
    const below = buttonRect.bottom + gap;
    const top = below + tipRect.height <= viewportTop + viewportHeight - gap
      ? below
      : Math.max(viewportTop + gap, buttonRect.top - tipRect.height - gap);
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
  }

  function render() {
    state.renderQueued = false;
    if (state.dragging) return;
    const mount = document.body;
    if (!mount) return;
    if (!state.active) {
      document.getElementById(PANEL_ID)?.remove();
      return;
    }
    let panel = document.getElementById(PANEL_ID);
    if (!panel) {
      panel = document.createElement("div");
      panel.id = PANEL_ID;
      mount.appendChild(panel);
    }
    const focusSnapshot = capturePanelFocus(panel);
    const currentBody = panel.querySelector(".wc-body");
    const bodyScrollTop = Number(currentBody?.scrollTop || 0);
    const currentTargetList = panel.querySelector(".wc-target-list");
    if (currentTargetList) state.targetListScrollTop = Number(currentTargetList.scrollTop || 0);
    const privacyDisclosure = panel.querySelector('[data-section="privacy"]');
    if (privacyDisclosure) state.privacyOpen = privacyDisclosure.open;
    const targetsDisclosure = panel.querySelector('[data-section="targets"]');
    if (targetsDisclosure) state.targetsOpen = targetsDisclosure.open;
    const attackQueueDisclosure = panel.querySelector('[data-section="attack-queue"]');
    if (attackQueueDisclosure) state.attackQueueOpen = attackQueueDisclosure.open;
    const moreActionsDisclosure = panel.querySelector('[data-section="more-actions"]');
    if (moreActionsDisclosure) state.moreActionsOpen = moreActionsDisclosure.open;
    panel.classList.toggle("wc-collapsed", state.collapsed);

    const status = statusView();
    const view = sessionView();
    const savedKey = getStoredKey();
    const mutationBusy = state.targetsSaving || state.targetQuickBusyId > 0 || state.dibsBusyTargetId > 0;
    const trackerDisabled = state.settings?.enabled === false;
    const noWar = transportIsLive() && !trackerDisabled && !view.enemyFactionId;
    const queueSection = actionQueueMarkup(view, trackerDisabled, noWar);
    const retaliationSection = view.retaliation.length
      ? `<div class="wc-section"><div class="wc-section-title"><span>Retaliations</span><span class="wc-count">${view.retaliation.length}</span></div>${view.retaliation.map((attack) => retaliationMarkup(attack, view)).join("")}</div>`
      : "";
    const trackerDisabledNotice = trackerDisabled ? `<div class="wc-empty">War tracker is disabled.</div>` : "";
    const attackCard = savedKey ? attackTargetMarkup(view) : "";
    const liveSections = state.attackTargetId
      ? `${attackCard}${trackerDisabledNotice || queueSection || retaliationSection ? `<details class="wc-queue-details" data-section="attack-queue"${state.attackQueueOpen ? " open" : ""}><summary>Open full queue <span class="wc-summary-count">${view.actions.length + view.retaliation.length}</span></summary>${trackerDisabledNotice}${queueSection}${retaliationSection}</details>` : ""}`
      : `${trackerDisabledNotice}${queueSection}${retaliationSection}`;

    const ownFactionLabel = view.ownFactionName || (view.ownFactionId ? `Faction ${view.ownFactionId}` : "");
    const enemyFactionLabel = view.enemyFactionName || (view.enemyFactionId ? `Faction ${view.enemyFactionId}` : "");
    const matchupLabel = enemyFactionLabel ? `${ownFactionLabel} vs ${enemyFactionLabel}` : ownFactionLabel;
    const matchupTitle = view.enemyFactionId
      ? `${ownFactionLabel} (${view.ownFactionId}) vs ${enemyFactionLabel} (${view.enemyFactionId})`
      : ownFactionLabel;

    const targetIds = state.targetsOpen || state.targetsDirty ? normalizeTargetIds(state.targetDraft) : savedTargetIds();
    const targetIdSet = new Set(targetIds);
    const allTargetOptions = watchedTargetOptions(view, targetIds);
    const targetOptions = filteredWatchedTargetOptions(view, targetIds);
    const targetOptionsMarkup = targetOptions.length
      ? `<div class="wc-target-list">${targetOptions.map((option) => {
          const checked = targetIdSet.has(option.memberId);
          const disabled = state.targetsSaving || (!checked && targetIds.length >= MAX_WATCHED_TARGETS);
          const label = option.current ? option.name : `${option.name} (not in current roster)`;
          return `<div class="wc-target-option-row"><label class="wc-target-option" title="${escapeHtml(label)}"><input type="checkbox" data-target-id="${option.memberId}" data-focus-key="target-${option.memberId}"${checked ? " checked" : ""}${disabled ? " disabled" : ""}><span>${escapeHtml(label)}</span></label>${option.member ? dibsMarkup(option.member, view, undefined, `picker-${option.memberId}`) : ""}</div>`;
        }).join("")}</div>`
      : `<div class="wc-empty">${allTargetOptions.length ? "No targets match this filter." : "No current enemy roster."}</div>`;
    const filterOptions = [
      ["all", "All targets"],
      ["selected", "Selected"],
      ["attackable", "Attackable"],
      ["hospital", "Hospital"],
      ["traveling", "Traveling"],
    ].map(([value, label]) => `<option value="${value}"${state.targetFilter === value ? " selected" : ""}>${label}</option>`).join("");
    const watchedTargetsSection = savedKey
      ? `<details data-section="targets"${state.targetsOpen ? " open" : ""}><summary>Watched targets <span class="wc-summary-count">${targetIds.length}/${MAX_WATCHED_TARGETS}</span></summary><div class="wc-target-toolbar"><input class="wc-input" data-field="target-search" data-focus-key="target-search" type="search" inputmode="search" autocomplete="off" aria-label="Search targets" placeholder="Search name or ID" value="${escapeHtml(state.targetSearch)}"><select class="wc-input" data-field="target-filter" data-focus-key="target-filter" aria-label="Filter targets">${filterOptions}</select></div>${targetOptionsMarkup}<div class="wc-target-actions">${state.targetError ? `<span class="wc-target-error" role="alert">${escapeHtml(state.targetError)}</span>` : state.targetsDirty ? `<span class="wc-unsaved">Unsaved changes</span>` : ""}<button class="wc-button" data-action="clear-targets"${!targetIds.length || mutationBusy ? " disabled" : ""}>Clear</button><button class="wc-button" data-action="cancel-targets"${mutationBusy ? " disabled" : ""}>Cancel</button><button class="wc-button primary" data-action="save-targets"${!state.targetsDirty || mutationBusy || !isOnline() || state.authTerminal || state.keySaving ? " disabled" : ""}>${state.targetsSaving ? "Saving..." : "Save"}</button></div></details>`
      : "";

    const showKeyEditor = !savedKey || state.keyEditorOpen || state.authTerminal;
    const keyEditor = showKeyEditor
      ? `${state.keyEditorError ? `<div class="wc-error" role="alert">${escapeHtml(state.keyEditorError)}</div>` : ""}<div class="wc-row"><input class="wc-input wc-secret-input" data-field="api-key" data-focus-key="api-key" type="text" inputmode="text" autocomplete="one-time-code" autocapitalize="none" autocorrect="off" spellcheck="false" data-1p-ignore data-lpignore="true" data-bwignore="true" data-protonpass-ignore="true" data-form-type="other" aria-label="Torn API key" placeholder="${savedKey ? "Replacement Torn API key" : "Torn API key"}" value="${escapeHtml(state.keyDraft)}"${state.keySaving ? " disabled" : ""}><button class="wc-button primary" data-action="connect"${state.keySaving || mutationBusy ? " disabled" : ""}>${state.keySaving ? "Checking..." : savedKey ? "Replace" : "Connect"}</button>${savedKey && !state.authTerminal ? `<button class="wc-button" data-action="cancel-key"${state.keySaving ? " disabled" : ""}>Cancel</button>` : ""}</div>`
      : "";

    panel.innerHTML = `<div class="wc-header">
      <div class="wc-heading"><div class="wc-title-row"><span class="wc-player">${escapeHtml(state.session?.playerName || "Warbuddy")}</span><span class="wc-version">v${SCRIPT_VERSION}</span><span class="wc-header-status"><span class="wc-dot ${status.tone}"></span>${escapeHtml(status.label)}</span></div>${matchupLabel ? `<div class="wc-matchup" title="${escapeHtml(matchupTitle)}">${escapeHtml(matchupLabel)}</div>` : ""}</div>
      <button class="wc-button wc-icon" data-action="collapse" aria-expanded="${state.collapsed ? "false" : "true"}" aria-label="${state.collapsed ? "Expand and resume Warbuddy" : "Collapse and pause Warbuddy"}" title="${state.collapsed ? "Expand and resume" : "Collapse and pause"}">${state.collapsed ? "+" : "-"}</button>
    </div>
    <div class="wc-body">
      ${state.error ? `<div class="wc-error" role="alert">${escapeHtml(state.error)}</div>` : ""}
      ${state.dibsError ? `<div class="wc-error" role="alert">${escapeHtml(state.dibsError)}</div>` : ""}
      ${transportIsLive() && state.settings?.enabled !== false && currentEnemyFactionId() && !currentEnemyRosterIsFresh() ? `<div class="wc-stale" role="status">Target data is syncing or stale. Generic online suggestions and Dibs actions are paused.</div>` : ""}
      ${keyEditor}
      ${savedKey ? liveSections : ""}
      ${watchedTargetsSection}
      <details data-section="privacy"${state.privacyOpen ? " open" : ""}><summary>Privacy</summary><div class="wc-privacy">The key stays in your userscript storage. Torn and the backend use it to verify your profile and faction. Warbuddy records your version, connection mode, and last use for faction admins. Its scoped session can save only your watched-target list and Dibs actions.</div>${savedKey ? `<div class="wc-private-actions"><button class="wc-button" data-action="refresh"${mutationBusy || state.keySaving ? " disabled" : ""}>Reconnect</button><button class="wc-button" data-action="change-key"${mutationBusy || state.keySaving ? " disabled" : ""}>Change key</button><button class="wc-button" data-action="forget"${mutationBusy || state.keySaving ? " disabled" : ""}>${state.forgetConfirm ? "Confirm forget" : "Forget key"}</button></div>` : ""}</details>
    </div>`;

    const nextBody = panel.querySelector(".wc-body");
    if (nextBody) {
      nextBody.scrollTop = bodyScrollTop;
      nextBody.addEventListener("scroll", () => positionOpenDibsTip(panel), { passive: true });
    }
    const nextTargetList = panel.querySelector(".wc-target-list");
    if (nextTargetList) {
      nextTargetList.scrollTop = state.targetListScrollTop;
      nextTargetList.addEventListener("scroll", (event) => {
        state.targetListScrollTop = Number(event.currentTarget?.scrollTop || 0);
        positionOpenDibsTip(panel);
      }, { passive: true });
    }
    panel.querySelector('[data-section="privacy"]')?.addEventListener("toggle", (event) => {
      state.privacyOpen = event.currentTarget.open;
    });
    panel.querySelector('[data-section="targets"]')?.addEventListener("toggle", (event) => {
      const open = event.currentTarget.open;
      if (open === state.targetsOpen) return;
      state.targetsOpen = open;
      if (open && !state.targetsDirty) state.targetDraft = savedTargetIds();
      state.targetError = "";
      scheduleRender();
    });
    panel.querySelector('[data-section="attack-queue"]')?.addEventListener("toggle", (event) => {
      state.attackQueueOpen = event.currentTarget.open;
    });
    panel.querySelector('[data-section="more-actions"]')?.addEventListener("toggle", (event) => {
      state.moreActionsOpen = event.currentTarget.open;
    });
    applyStoredPanelPosition();
    attachPanelDragHandler(panel);

    panel.querySelector('[data-action="collapse"]')?.addEventListener("click", () => {
      state.collapsed = !state.collapsed;
      storage.set(COLLAPSED_STORAGE, state.collapsed ? "1" : "0");
      syncForegroundState();
      scheduleRender();
    });
    panel.querySelector('[data-action="connect"]')?.addEventListener("click", connectFromInput);
    panel.querySelector('[data-action="cancel-key"]')?.addEventListener("click", () => {
      state.keyEditorOpen = false;
      state.keyDraft = "";
      state.keyEditorError = "";
      scheduleRender();
    });
    panel.querySelectorAll('[data-target-id]').forEach((input) => {
      input.addEventListener("change", (event) => {
        const memberId = Number(event.currentTarget?.dataset?.targetId || 0);
        if (!Number.isSafeInteger(memberId) || memberId <= 0) return;
        const next = new Set(normalizeTargetIds(state.targetDraft));
        if (event.currentTarget.checked && next.size < MAX_WATCHED_TARGETS) next.add(memberId);
        if (!event.currentTarget.checked) next.delete(memberId);
        state.targetDraft = normalizeTargetIds(Array.from(next));
        state.targetsDirty = !sameTargetIds(state.targetDraft, savedTargetIds());
        state.targetError = "";
        scheduleRender();
      });
    });
    panel.querySelector('[data-field="target-search"]')?.addEventListener("input", (event) => {
      state.targetSearch = String(event.currentTarget?.value || "");
      state.targetListScrollTop = 0;
      scheduleRender();
    });
    panel.querySelector('[data-field="target-filter"]')?.addEventListener("change", (event) => {
      state.targetFilter = String(event.currentTarget?.value || "all");
      state.targetListScrollTop = 0;
      scheduleRender();
    });
    panel.querySelector('[data-action="save-targets"]')?.addEventListener("click", saveWatchedTargets);
    panel.querySelector('[data-action="clear-targets"]')?.addEventListener("click", () => {
      state.targetDraft = [];
      state.targetsDirty = !sameTargetIds(state.targetDraft, savedTargetIds());
      state.targetError = "";
      scheduleRender();
    });
    panel.querySelector('[data-action="cancel-targets"]')?.addEventListener("click", () => {
      state.targetDraft = savedTargetIds();
      state.targetsDirty = false;
      state.targetError = "";
      state.targetsOpen = false;
      scheduleRender();
    });
    panel.querySelector('[data-action="toggle-watch"]')?.addEventListener("click", (event) => {
      toggleWatchedTarget(event.currentTarget?.dataset?.targetMember);
    });
    panel.querySelectorAll('[data-dibs-action]').forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const memberId = Number(event.currentTarget?.dataset?.dibsTarget || 0);
        const instanceKey = String(event.currentTarget?.dataset?.dibsInstance || `member-${memberId}`);
        const action = String(event.currentTarget?.dataset?.dibsAction || "");
        if (action === "close") {
          closeDibsDetails();
          event.currentTarget.blur?.();
          scheduleRender();
          return;
        }
        if (action === "inspect") {
          if (state.dibsInspectTargetId === memberId && state.dibsInspectKey === instanceKey) {
            closeDibsDetails();
          } else {
            state.dibsInspectTargetId = memberId;
            state.dibsInspectKey = instanceKey;
          }
          scheduleRender();
          return;
        }
        if (action === "claim" || action === "release") updateDibs(action, memberId, instanceKey);
      });
    });
    const keyInput = panel.querySelector('[data-field="api-key"]');
    keyInput?.addEventListener("input", (event) => {
      state.keyDraft = String(event.currentTarget?.value || "");
      state.keyEditorError = "";
    });
    keyInput?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") connectFromInput();
    });
    panel.querySelector('[data-action="refresh"]')?.addEventListener("click", () => {
      invalidateAuthentication();
      state.authTerminal = false;
      state.keyEditorError = "";
      state.error = "";
      closeSocket();
      prepareSameKeyReconnect();
      state.phase = "connecting";
      setTimeout(ensureConnected, 50);
      scheduleRender();
    });
    panel.querySelector('[data-action="change-key"]')?.addEventListener("click", () => {
      state.keyEditorOpen = true;
      state.keyDraft = "";
      state.keyEditorError = "";
      state.forgetConfirm = false;
      scheduleRender();
    });
    panel.querySelector('[data-action="forget"]')?.addEventListener("click", () => {
      if (!state.forgetConfirm) {
        state.forgetConfirm = true;
        if (state.forgetConfirmTimer) clearTimeout(state.forgetConfirmTimer);
        state.forgetConfirmTimer = setTimeout(() => {
          state.forgetConfirmTimer = 0;
          state.forgetConfirm = false;
          scheduleRender();
        }, 5_000);
        scheduleRender();
        return;
      }
      forgetStoredKey();
    });
    restorePanelFocus(panel, focusSnapshot);
    positionOpenDibsTip(panel);
  }

  function forgetStoredKey() {
    invalidateAuthentication();
    storage.remove(KEY_STORAGE);
    if (state.forgetConfirmTimer) clearTimeout(state.forgetConfirmTimer);
    state.forgetConfirmTimer = 0;
    state.forgetConfirm = false;
    state.keyDraft = "";
    state.keyEditorOpen = false;
    state.keyEditorError = "";
    state.keySaving = false;
    state.authTerminal = false;
    stopTicker();
    closeSocket();
    state.session = null;
    state.token = "";
    state.lastCheckInAt = 0;
    state.lastCheckInAttemptAt = 0;
    state.lastCheckInTransport = "";
    state.error = "";
    state.phase = "idle";
    clearLiveFactionData();
    scheduleRender();
  }

  async function connectFromInput() {
    const input = document.querySelector(`#${PANEL_ID} [data-field="api-key"]`);
    const key = String(input?.value || state.keyDraft || "").trim();
    if (!key || state.keySaving) return;
    if (state.targetsSaving || state.targetQuickBusyId || state.dibsBusyTargetId) {
      state.keyEditorError = "Wait for the current Warbuddy update to finish.";
      scheduleRender();
      return;
    }
    const previousKey = getStoredKey();
    state.keySaving = true;
    state.keyEditorError = "";
    scheduleRender();
    try {
      const session = await requestCompanionSession(key);
      invalidateAuthentication();
      storage.set(KEY_STORAGE, key);
      closeSocket();
      clearLiveFactionData();
      applyCompanionSession(session);
      state.keyDraft = "";
      state.keyEditorOpen = false;
      state.phase = "connecting";
      syncForegroundState();
    } catch (error) {
      const message = String(error?.message || "Could not connect");
      state.keyEditorError = message;
      if (!previousKey) {
        state.phase = "error";
        state.error = "";
        state.authTerminal = isTerminalAuthenticationError(error);
      }
    } finally {
      state.keySaving = false;
      scheduleRender();
    }
  }

  function cancelScheduledRender() {
    if (state.renderFrame) cancelAnimationFrame(state.renderFrame);
    state.renderFrame = 0;
    state.renderQueued = false;
  }

  function scheduleRender() {
    if (document.visibilityState === "hidden") return;
    if (state.renderQueued) return;
    state.renderQueued = true;
    state.renderFrame = requestAnimationFrame(() => {
      state.renderFrame = 0;
      render();
    });
  }

  function start() {
    startPageObserver();
    syncPageActivation();
    syncForegroundState();
    if (!state.routeTimer) state.routeTimer = setInterval(syncPageActivation, 1_000);
  }

  function startPageObserver() {
    if (typeof MutationObserver !== "function" || !document.body) return;
    if (state.pageObserver && state.observedBody === document.body) return;
    state.pageObserver?.disconnect();
    state.observedBody = document.body;
    state.pageObserver = new MutationObserver(() => {
      if (state.active && !document.getElementById(PANEL_ID)) render();
    });
    state.pageObserver.observe(document.body, { childList: true });
  }

  function syncPageActivation() {
    if (document.visibilityState === "hidden") return;
    startPageObserver();
    const active = core.isWarbuddyPageUrl(window.location.href);
    const nextAttackTargetId = active ? core.attackPageTargetId(window.location.href) : 0;
    const attackTargetChanged = nextAttackTargetId !== state.attackTargetId;
    if (attackTargetChanged) {
      state.attackTargetId = nextAttackTargetId;
      state.attackQueueOpen = false;
      state.targetQuickError = "";
      closeDibsDetails();
    }
    if (!active) {
      if (state.active || document.getElementById(PANEL_ID)) {
        stopTicker();
        closeSocket();
        state.phase = getStoredKey() ? "paused" : "idle";
        document.getElementById(PANEL_ID)?.remove();
      }
      state.active = false;
      return;
    }
    const becameActive = !state.active;
    state.active = true;
    if (becameActive || !document.getElementById(PANEL_ID)) render();
    else if (attackTargetChanged) scheduleRender();
    if (becameActive) syncForegroundState();
  }

  function syncVisibilityState() {
    if (document.visibilityState === "hidden") {
      cancelScheduledRender();
      syncForegroundState();
      return;
    }
    state.nowMs = Date.now();
    syncPageActivation();
    syncForegroundState();
    scheduleRender();
  }

  registerMenuCommand("Warbuddy: show panel", () => {
    state.active = core.isWarbuddyPageUrl(window.location.href);
    if (!state.active) {
      window.alert(`Warbuddy v${SCRIPT_VERSION} is installed, but this is not a supported Torn faction or attack page.\n\n${window.location.href}`);
      return;
    }
    render();
    syncForegroundState();
  });

  registerMenuCommand("Warbuddy: diagnostics", () => {
    const routeMatches = core.isWarbuddyPageUrl(window.location.href);
    const panel = document.getElementById(PANEL_ID);
    window.alert([
      `Warbuddy v${SCRIPT_VERSION}`,
      `Route matched: ${routeMatches ? "yes" : "no"}`,
      `Document body: ${document.body ? "ready" : "missing"}`,
      `Panel mounted: ${panel ? "yes" : "no"}`,
      `Panel visible: ${panel ? getComputedStyle(panel).display !== "none" && getComputedStyle(panel).visibility !== "hidden" : "n/a"}`,
      `Phase: ${state.phase}`,
      `Page visibility: ${document.visibilityState}`,
      `Browser online: ${typeof navigator === "undefined" || navigator.onLine !== false ? "yes" : "no"}`,
      `WebSocket state: ${state.socket?.readyState ?? "none"}`,
      `Transport: ${state.phase === "fallback" ? "compatible HTTP fallback" : "WebSocket"}`,
      `Connect watchdog: ${state.socketConnectTimer ? "armed" : "idle"}`,
      `Last socket error: ${state.lastSocketErrorAt || "none"}`,
      `Last close: ${state.lastSocketClose ? `${state.lastSocketClose.code}${state.lastSocketClose.reason ? ` (${state.lastSocketClose.reason})` : ""} at ${state.lastSocketClose.at}` : "none"}`,
      `Last fallback update: ${state.lastFallbackAt || "none"}`,
      `Last fallback error: ${state.lastFallbackError || "none"}`,
      `Last live data: ${state.lastLiveDataAt ? new Date(state.lastLiveDataAt).toISOString() : "none"}`,
      `Roster updates: ${state.rosterDataAt.size ? Array.from(state.rosterDataAt.entries()).map(([factionId, updatedAt]) => `${factionId}=${new Date(updatedAt).toISOString()}`).join(", ") : "none"}`,
      `Data stale: ${dataIsStale() ? "yes" : "no"}`,
      `Authentication needs attention: ${state.authTerminal ? "yes" : "no"}`,
      `Attack-page target: ${state.attackTargetId || "none"}`,
      `Endpoint: ${socketUrl()}`,
      window.location.href,
    ].join("\n"));
  });

  registerMenuCommand("Warbuddy: reset position", () => {
    resetPanelPosition();
    applyStoredPanelPosition();
  });

  registerMenuCommand("Warbuddy: change API key", () => {
    if (!core.isWarbuddyPageUrl(window.location.href)) {
      window.alert("Open a Torn faction or attack page first, then run this command again.");
      return;
    }
    state.active = true;
    state.attackTargetId = core.attackPageTargetId(window.location.href);
    state.attackQueueOpen = false;
    state.collapsed = false;
    storage.set(COLLAPSED_STORAGE, "0");
    state.keyEditorOpen = true;
    state.keyDraft = "";
    state.keyEditorError = "";
    render();
    syncForegroundState();
  });

  document.addEventListener("visibilitychange", syncVisibilityState);
  document.addEventListener("pointerdown", (event) => {
    if (!state.dibsInspectTargetId) return;
    const target = event.target;
    if (target && typeof target.closest === "function" && target.closest(`#${PANEL_ID} .wc-dibs-wrap`)) return;
    closeDibsDetails();
    scheduleRender();
  }, true);
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !state.dibsInspectTargetId) return;
    closeDibsDetails();
    scheduleRender();
  });
  window.addEventListener("focus", syncVisibilityState);
  window.addEventListener("online", syncForegroundState);
  window.addEventListener("offline", syncForegroundState);
  window.addEventListener("resize", () => {
    applyStoredPanelPosition();
    const panel = document.getElementById(PANEL_ID);
    if (panel) positionOpenDibsTip(panel);
  });
  window.visualViewport?.addEventListener?.("resize", () => {
    const panel = document.getElementById(PANEL_ID);
    if (panel) positionOpenDibsTip(panel);
  });
  window.addEventListener("hashchange", syncPageActivation);
  window.addEventListener("popstate", syncPageActivation);
  window.addEventListener("pageshow", start);
  window.addEventListener("pagehide", () => {
    if (state.routeTimer) clearInterval(state.routeTimer);
    state.routeTimer = 0;
    stopTicker();
    closeSocket();
    cancelScheduledRender();
    state.active = false;
    state.pageObserver?.disconnect();
    state.pageObserver = null;
    state.observedBody = null;
  });

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
