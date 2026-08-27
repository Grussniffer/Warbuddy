// ==UserScript==
// @name         Warbuddy
// @namespace    https://grusmedia.no/warbuddy
// @version      0.1.41
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
// @grant        GM_notification
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
  const TARGET_GROUPS = ["priority", "chain", "later"];

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

  const normalizeDisplayMode = (value) =>
    String(value || "").trim().toLowerCase() === "integrated" ? "integrated" : "floating";

  const normalizeRosterFilter = (value) => {
    const normalized = String(value || "").trim().toLowerCase();
    return ["watched", "actionable", "retaliations"].includes(normalized) ? normalized : "all";
  };

  const rosterFilterMatches = (filter, flags = {}) => {
    switch (normalizeRosterFilter(filter)) {
      case "watched": return flags.watched === true;
      case "actionable": return flags.actionable === true || flags.retaliation === true;
      case "retaliations": return flags.retaliation === true;
      default: return true;
    }
  };

  const rosterPriority = (flags = {}) => {
    if (flags.retaliation === true) return 0;
    if (flags.dibsMine === true) return 1;
    if (flags.actionable === true) return 2;
    const group = String(flags.targetGroup || "").trim().toLowerCase();
    if (flags.watched === true && group === "priority") return 3;
    if (flags.watched === true && group === "chain") return 4;
    if (flags.watched === true && group === "later") return 5;
    if (flags.watched === true) return 6;
    if (flags.dibsTaken === true) return 8;
    return 7;
  };

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

  const isRankedWarPageUrl = (value) => {
    if (!isFactionPageUrl(value)) return false;
    let url;
    try {
      url = new URL(String(value || ""), "https://www.torn.com/");
    } catch {
      return false;
    }
    return /(?:^|\/)war\/rank(?:[/?#]|$)/i.test(decodeURIComponent(String(url.hash || "")).replace(/^#\/?/, ""));
  };

  const profileMemberIdFromUrl = (value) => {
    let url;
    try {
      url = new URL(String(value || ""), "https://www.torn.com/");
    } catch {
      return 0;
    }
    if (url.hostname.toLowerCase().replace(/^www\./, "") !== "torn.com") return 0;
    if (!/^\/profiles\.php$/i.test(url.pathname)) return 0;
    const memberId = Number(
      url.searchParams.get("XID")
      || url.searchParams.get("xid")
      || url.searchParams.get("ID")
      || url.searchParams.get("id")
      || 0
    );
    return Number.isSafeInteger(memberId) && memberId > 0 ? memberId : 0;
  };

  const memberStatus = (member) =>
    String(member?.status?.userStatus || member?.status?.state || member?.status?.status || "").toLowerCase();

  const memberLocation = (member) =>
    String(member?.location?.current || member?.location?.name || member?.location || "").toLowerCase();

  const memberActivity = (member) => String(member?.activity || "").toLowerCase();

  const memberDestination = (member) =>
    String(member?.location?.destination || member?.destination || "").toLowerCase();

  const locationCode = (value) => {
    const normalized = String(value || "").trim().toLowerCase();
    const codes = {
      argentina: "AR",
      canada: "CA",
      "cayman islands": "KY",
      china: "CN",
      hawaii: "HI",
      japan: "JP",
      mexico: "MX",
      "south africa": "ZA",
      switzerland: "CH",
      torn: "Torn",
      uae: "AE",
      "united arab emirates": "AE",
      "united kingdom": "UK",
    };
    if (codes[normalized]) return codes[normalized];
    return normalized
      .split(/\s+/)
      .filter(Boolean)
      .map((part) => part[0])
      .join("")
      .slice(0, 3)
      .toUpperCase();
  };

  const countdown = (milliseconds) => {
    const seconds = Math.max(0, Math.ceil(Number(milliseconds || 0) / 1000));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainder = seconds % 60;
    if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
    return `${minutes}:${String(remainder).padStart(2, "0")}`;
  };

  const memberAvailability = (member, nowMs = Date.now()) => {
    const status = memberStatus(member);
    const current = String(member?.location?.current || member?.location?.name || member?.location || "").trim();
    const destination = String(member?.location?.destination || member?.destination || "").trim();
    const until = toTimestampMs(member?.status?.untill || member?.status?.until);
    const remainingMs = Math.max(0, until - nowMs);

    if (status.includes("hospital")) {
      return {
        state: "hospital",
        label: until > nowMs ? `H ${countdown(remainingMs)}` : "H",
        title: until > nowMs ? `Hospital - ${duration(remainingMs)} remaining` : "Hospital",
        tone: remainingMs > 0 && remainingMs <= 5 * 60 * 1000 ? "soon" : "",
        until,
      };
    }

    if (status.includes("travel")) {
      const incoming = destination.toLowerCase().includes("torn");
      const outgoing = current.toLowerCase().includes("torn") && destination && !incoming;
      const place = locationCode(incoming ? current : destination || current);
      const timer = until > nowMs ? ` ${countdown(remainingMs)}` : "";
      if (incoming) {
        return {
          state: "incoming",
          label: `IN${place && place !== "Torn" ? ` ${place}` : ""}${timer}`,
          title: `Returning to Torn${current ? ` from ${current}` : ""}${until > nowMs ? ` - ${duration(remainingMs)} remaining` : ""}`,
          tone: remainingMs > 0 && remainingMs <= 60 * 1000 ? "soon" : "",
          until,
        };
      }
      if (outgoing) {
        return {
          state: "outgoing",
          label: `OUT${place ? ` ${place}` : ""}${timer}`,
          title: `Traveling from Torn${destination ? ` to ${destination}` : ""}${until > nowMs ? ` - ${duration(remainingMs)} remaining` : ""}`,
          tone: "",
          until,
        };
      }
      return {
        state: "traveling",
        label: `TRAVEL${place ? ` ${place}` : ""}${timer}`,
        title: `Traveling${destination ? ` to ${destination}` : ""}${until > nowMs ? ` - ${duration(remainingMs)} remaining` : ""}`,
        tone: "",
        until,
      };
    }

    const isOkay = status === "okay" || status.startsWith("okay ") || status.startsWith("okay -");
    const isAbroad = status.includes("abroad");
    if ((isOkay || isAbroad) && current && !current.toLowerCase().includes("torn")) {
      return {
        state: "abroad",
        label: locationCode(current) || "Abroad",
        title: `Abroad in ${current}`,
        tone: "",
        until: 0,
      };
    }

    if (isOkay) {
      return { state: "available", label: "", title: "Available in Torn", tone: "", until: 0 };
    }

    return {
      state: status || "unknown",
      label: status ? status.slice(0, 10).toUpperCase() : "",
      title: status || "Status unavailable",
      tone: "",
      until,
    };
  };

  const availabilityRank = (state) => {
    const ranks = {
      available: 0,
      hospital: 1,
      incoming: 2,
      abroad: 3,
      outgoing: 4,
      traveling: 4,
    };
    return ranks[String(state || "")] ?? 5;
  };

  const rosterOrder = (flags = {}, member, nowMs = Date.now()) => {
    const priority = rosterPriority(flags);
    const availability = memberAvailability(member, nowMs);
    const remainingSeconds = availability.until > nowMs
      ? Math.min(99_999, Math.ceil((availability.until - nowMs) / 1000))
      : 0;
    return priority * 1_000_000 + availabilityRank(availability.state) * 100_000 + remainingSeconds;
  };

  const chainDeadline = (score) => toTimestampMs(
    score?.chainEnd
    || score?.chain_end
    || score?.chainEndsAt
    || score?.chain_ends_at
    || score?.chain_timer
  );

  const chainPresentation = (score, nowMs = Date.now()) => {
    const chain = Math.max(0, Number(score?.chain || 0));
    if (!chain) return { active: false, chain: 0, label: "", compact: "", tone: "", endsAt: 0 };
    const endsAt = chainDeadline(score);
    if (!endsAt) {
      return { active: true, chain, label: `Chain ${chain}`, compact: `C${chain}`, tone: "", endsAt: 0 };
    }
    const remainingMs = endsAt - nowMs;
    if (remainingMs <= 0) {
      return {
        active: true,
        chain,
        label: `Chain ${chain} - timer syncing`,
        compact: `C${chain} sync`,
        tone: "wait",
        endsAt,
      };
    }
    const timer = countdown(remainingMs);
    return {
      active: true,
      chain,
      label: `Chain ${chain} - ${timer}`,
      compact: `C${chain} ${timer}`,
      tone: remainingMs <= 60_000 ? "urgent" : remainingMs <= URGENT_CHAIN_MS ? "wait" : "",
      endsAt,
    };
  };

  const normalizeMemberIds = (value) => new Set(
    (Array.isArray(value) ? value : [])
      .map((memberId) => Number(memberId))
      .filter((memberId) => Number.isSafeInteger(memberId) && memberId > 0)
  );

  const normalizeTargetGroups = (value) => {
    const source = value && typeof value === "object" ? value : {};
    const normalized = {};
    for (const [rawMemberId, rawGroup] of Object.entries(source)) {
      const memberId = Number(rawMemberId);
      const group = String(rawGroup || "").trim().toLowerCase();
      if (!Number.isSafeInteger(memberId) || memberId <= 0 || !TARGET_GROUPS.includes(group)) continue;
      normalized[String(memberId)] = group;
    }
    return normalized;
  };

  const targetGroupRank = (group) => {
    const rank = TARGET_GROUPS.indexOf(String(group || "").toLowerCase());
    return rank < 0 ? TARGET_GROUPS.length : rank;
  };

  const applyTargetGroups = (items, groups) => {
    const normalizedGroups = normalizeTargetGroups(groups);
    return (Array.isArray(items) ? items : [])
      .map((item, sourceOrder) => ({
        ...item,
        targetGroup: normalizedGroups[String(Number(item?.memberId || 0))] || "",
        sourceOrder,
      }))
      .sort((left, right) => {
        if (left.key === "chain-risk" || right.key === "chain-risk") {
          if (left.key === right.key) return left.sourceOrder - right.sourceOrder;
          return left.key === "chain-risk" ? -1 : 1;
        }
        return targetGroupRank(left.targetGroup) - targetGroupRank(right.targetGroup)
          || left.sourceOrder - right.sourceOrder;
      })
      .map(({ sourceOrder: _sourceOrder, ...item }) => item);
  };

  const buildFocusQueue = ({ actions = [], retaliations = [], limit = 3 } = {}) => {
    const entries = [
      ...(Array.isArray(retaliations) ? retaliations : []).map((item) => ({
        kind: "retaliation",
        key: `retaliation-${item?.id || item?.attackerId || item?.expiresAt || "unknown"}`,
        severity: "urgent",
        order: Number(item?.expiresAt || 0) * 1000,
        item,
      })),
      ...(Array.isArray(actions) ? actions : []).map((item) => ({
        kind: "action",
        key: String(item?.key || "action"),
        severity: String(item?.severity || "info"),
        order: Number(item?.order || Number.MAX_SAFE_INTEGER),
        item,
      })),
    ];
    const severityRank = { urgent: 0, watch: 1, info: 2 };
    return entries
      .sort((left, right) => (
        (severityRank[left.severity] ?? 3) - (severityRank[right.severity] ?? 3)
        || left.order - right.order
        || left.key.localeCompare(right.key)
      ))
      .slice(0, Math.max(1, Math.min(9, Number(limit) || 3)));
  };

  const notificationCandidates = ({ actions = [], retaliations = [] } = {}) => [
    ...(Array.isArray(retaliations) ? retaliations : []).map((attack) => ({
      key: `retaliation-${attack?.id || attack?.attackerId || attack?.expiresAt || "unknown"}`,
      kind: "retaliation",
      title: `Retaliation on ${attack?.attackerName || `Player ${attack?.attackerId || "?"}`}`,
      text: attack?.defenderName ? `Hit ${attack.defenderName}` : "Faction retaliation available",
      url: attack?.attackUrl || attackUrl(attack?.attackerId),
    })),
    ...(Array.isArray(actions) ? actions : [])
      .filter((item) => String(item?.key || "").startsWith("watched-"))
      .map((item) => ({
        key: String(item.key),
        kind: String(item.key).startsWith("watched-flight-")
          ? "landing"
          : String(item.key).startsWith("watched-hospital-") ? "hospital" : "attackable",
        title: String(item.title || "Watched target update"),
        text: String(item.detail || ""),
        url: item.url,
      })),
  ];

  const attackOutcomeFromText = (value) => {
    const text = String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
    if (!text) return undefined;
    if (/\byou\s+hospitali[sz]ed\b/.test(text) || /\bwas hospitali[sz]ed\b/.test(text)) {
      return { kind: "hospitalized", label: "Target hospitalized", releaseDibs: true };
    }
    if (/\b(?:you\s+)?mugged\b/.test(text)) {
      return { kind: "mugged", label: "Target mugged", releaseDibs: false };
    }
    if (/\bleft\b.{0,80}\b(?:on the street|for dead)\b/.test(text)) {
      return { kind: "left", label: "Target left", releaseDibs: false };
    }
    if (/\b(?:attack failed|you lost|you were defeated|escaped from you)\b/.test(text)) {
      return { kind: "failed", label: "Attack did not finish", releaseDibs: false };
    }
    return undefined;
  };

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
    const chainEndsAt = chainDeadline(alliedScore);
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

  const fallbackPollDelayMs = ({
    baseMs = 2_000,
    maxMs = 10_000,
    failureCount = 0,
    unchangedCount = 0,
    urgent = false,
    activeWar = false,
  } = {}) => {
    const base = Math.max(250, Number(baseMs) || 2_000);
    const maximum = Math.max(base, Number(maxMs) || 10_000);
    if (Number(failureCount) > 0) {
      return Math.min(maximum, base * (2 ** Math.min(Number(failureCount), 3)));
    }
    if (urgent || Number(unchangedCount) < 3) return base;
    return activeWar ? Math.min(maximum, 5_000) : maximum;
  };

  return {
    activeDibsClaim,
    activeRetaliations,
    applyTargetGroups,
    attackOutcomeFromText,
    attackPageTargetId,
    applyRosterUpdate,
    attackUrl,
    buildActionQueue,
    buildFocusQueue,
    chainDeadline,
    chainPresentation,
    countdown,
    dibsAttackPresentation,
    dibsEligibility,
    dibsFeatureEnabled,
    duration,
    fallbackPollDelayMs,
    formatBsp,
    inferEnemyFactionId,
    isFactionPageUrl,
    isRankedWarPageUrl,
    isWarbuddyPageUrl,
    locationCode,
    memberAvailability,
    normalizeDisplayMode,
    normalizeRosterFilter,
    normalizeTargetGroups,
    notificationCandidates,
    profileMemberIdFromUrl,
    rosterFilterMatches,
    rosterOrder,
    rosterPriority,
    scoreForFaction,
    toTimestampMs,
  };
});

(function runWarbuddy() {
  "use strict";

  const core = globalThis.WarbuddyCore;
  if (!core) return;

  const BACKEND_BASE_URL = "https://backend.grusmedia.no";
  const SCRIPT_VERSION = "0.1.41";
  const PANEL_ID = "warbuddy-panel";
  const KEY_STORAGE = "warbuddy_api_key";
  const COLLAPSED_STORAGE = "warbuddy_collapsed";
  const POSITION_STORAGE = "warbuddy_position";
  const DISPLAY_MODE_STORAGE = "warbuddy_display_mode";
  const FOCUS_STORAGE = "warbuddy_focus_mode";
  const NOTIFICATION_STORAGE = "warbuddy_notifications";
  const TARGET_GROUP_STORAGE = "warbuddy_target_groups";
  const ROSTER_CONTROLS_STORAGE = "warbuddy_roster_controls_open";
  const ROSTER_FILTER_STORAGE = "warbuddy_roster_filter";
  const ROSTER_SORT_STORAGE = "warbuddy_roster_priority_sort";
  const INTEGRATED_HOST_ID = "warbuddy-integrated-host";
  const INTEGRATED_WRAPPER_ID = "warbuddy-integrated-wrapper";
  const INLINE_TOOLS_CLASS = "warbuddy-inline-tools";
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
    socketRequests: new Map(),
    socketRequestSequence: 0,
    socketOpenedAt: 0,
    socketConnectTimer: 0,
    reconnectTimer: 0,
    reconnectAttempt: 0,
    fallbackTimer: 0,
    fallbackInFlight: false,
    fallbackActive: false,
    fallbackGeneration: 0,
    fallbackFailureCount: 0,
    fallbackRevision: "",
    fallbackUnchangedCount: 0,
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
    loadouts: new Map(),
    loadoutRequestFactionId: "",
    loadoutRequestAt: 0,
    loadoutOpenTargetId: 0,
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
    displayMode: core.normalizeDisplayMode(storage.get(DISPLAY_MODE_STORAGE, "")),
    panelPlacement: "floating",
    integratedFallback: false,
    rosterControlsOpen: String(storage.get(ROSTER_CONTROLS_STORAGE, "")) === "1",
    rosterFilter: core.normalizeRosterFilter(storage.get(ROSTER_FILTER_STORAGE, "")),
    rosterPrioritySort: String(storage.get(ROSTER_SORT_STORAGE, "")) === "1",
    privacyOpen: false,
    targetsOpen: false,
    targetDraft: [],
    targetsDirty: false,
    targetsSaving: false,
    targetError: "",
    targetListScrollTop: 0,
    targetSearch: "",
    targetFilter: "all",
    targetGroups: {},
    targetQuickBusyId: 0,
    targetQuickError: "",
    attackTargetId: 0,
    attackOutcome: null,
    attackOutcomeArmedAt: 0,
    attackOutcomeReleaseKey: "",
    attackOutcomeScanTimer: 0,
    attackOutcomeObserver: null,
    attackQueueOpen: false,
    moreActionsOpen: false,
    focusMode: String(storage.get(FOCUS_STORAGE, "")) === "1",
    optionsOpen: false,
    notificationSettings: { landing: false, hospital: false, attackable: false, retaliation: false },
    notificationKeys: new Set(),
    notificationsPrimed: false,
    active: false,
    renderQueued: false,
    renderFrame: 0,
    dragging: false,
    lastSocketErrorAt: "",
    lastSocketClose: null,
  };

  const notificationKinds = ["landing", "hospital", "attackable", "retaliation"];
  try {
    const savedNotifications = JSON.parse(String(storage.get(NOTIFICATION_STORAGE, "") || "{}"));
    for (const kind of notificationKinds) {
      state.notificationSettings[kind] = savedNotifications?.[kind] === true;
    }
  } catch {
    storage.remove(NOTIFICATION_STORAGE);
  }

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
    #${INTEGRATED_WRAPPER_ID} { position:relative; z-index:1; display:block; width:100%; min-width:0; max-width:100%; flex:0 0 100%; grid-column:1 / -1 !important; clear:both; align-self:stretch; margin:7px 0; list-style:none; }
    #${INTEGRATED_HOST_ID} { position:relative; z-index:1; display:block; width:100%; min-width:0; max-width:100%; font:12px/1.35 Arial,Helvetica,sans-serif; }
    #${INTEGRATED_HOST_ID}.wc-rank-host { box-sizing:border-box; }
    #${INTEGRATED_HOST_ID}.wc-attack-host { display:inline-flex; width:auto; margin-left:8px; vertical-align:middle; }
    #${PANEL_ID}.wc-integrated-inline.wc-roster-mode { position:relative !important; inset:auto !important; width:100%; max-width:none; max-height:none; margin:0; border-color:#4d612a; border-radius:3px; box-shadow:0 2px 8px rgba(0,0,0,.3); }
    #${PANEL_ID}.wc-roster-mode .wc-body { max-height:none; overflow:visible; overscroll-behavior:auto; border-top:1px solid #3f4f25; background:#202020; }
    #${PANEL_ID}.wc-roster-mode:not(.wc-roster-open) .wc-body { display:none; }
    #${PANEL_ID} .wc-roster-summary { display:flex; min-height:34px; align-items:center; gap:8px; background:linear-gradient(180deg,#5a7625,#41571a); color:#f4f4f5; padding:0 8px; }
    #${PANEL_ID} .wc-roster-summary-button { display:flex; min-width:0; flex:1; align-items:center; gap:7px; border:0; background:transparent; color:inherit; padding:7px 0; text-align:left; font:inherit; cursor:pointer; }
    #${PANEL_ID} .wc-roster-chevron { width:10px; flex:0 0 10px; color:#f4f4f5; }
    #${PANEL_ID} .wc-roster-name { flex:0 0 auto; font-weight:700; }
    #${PANEL_ID} .wc-roster-beta { flex:0 0 auto; border-radius:3px; background:rgba(0,0,0,.28); color:#e4e4e7; padding:1px 4px; font-size:9px; font-weight:700; text-transform:uppercase; }
    #${PANEL_ID} .wc-roster-matchup { min-width:0; overflow:hidden; color:#e4e4e7; font-size:10px; text-overflow:ellipsis; white-space:nowrap; }
    #${PANEL_ID} .wc-roster-status { display:inline-flex; flex:0 0 auto; align-items:center; gap:4px; font-size:10px; font-weight:700; }
    #${PANEL_ID} .wc-roster-counts { display:flex; flex:0 0 auto; align-items:center; gap:7px; color:#e4e4e7; font-size:10px; }
    #${PANEL_ID} .wc-chains, #${PANEL_ID} .wc-roster-chains { display:flex; flex:0 0 auto; align-items:center; gap:6px; }
    #${PANEL_ID} .wc-roster-chain, #${PANEL_ID} .wc-chain { display:inline-flex; flex:0 0 auto; align-items:center; gap:3px; color:#d4d4d8; font-weight:700; white-space:nowrap; }
    #${PANEL_ID} .wc-chain-side { color:#a1a1aa; font-size:9px; font-weight:700; text-transform:uppercase; }
    #${PANEL_ID} .wc-roster-chain.wait, #${PANEL_ID} .wc-chain.wait { color:#fbbf24; }
    #${PANEL_ID} .wc-roster-chain.urgent, #${PANEL_ID} .wc-chain.urgent { color:#f87171; }
    #${PANEL_ID} .wc-roster-controls { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:6px; border:1px solid #3f3f46; border-radius:4px; background:#18181b; }
    #${PANEL_ID} .wc-roster-filters { display:flex; min-width:0; flex-wrap:wrap; gap:4px; }
    #${PANEL_ID} .wc-roster-filter { border:1px solid #52525b; border-radius:3px; background:#27272a; color:#d4d4d8; padding:4px 7px; font:inherit; font-weight:700; cursor:pointer; }
    #${PANEL_ID} .wc-roster-filter.active { border-color:#84a83b; background:#405719; color:#fff; }
    #${PANEL_ID} .wc-roster-sort { display:inline-flex; flex:0 0 auto; align-items:center; gap:5px; color:#d4d4d8; font-weight:700; white-space:nowrap; }
    #${PANEL_ID} .wc-roster-sort.paused { color:#fbbf24; }
    #${PANEL_ID} .wc-roster-sort input { margin:0; accent-color:#84a83b; }
    #${PANEL_ID}.wc-integrated-toolbar { position:absolute !important; top:calc(100% + 6px) !important; right:0 !important; bottom:auto !important; left:auto !important; width:min(320px,92vw); }
    #${PANEL_ID}.wc-integrated-toolbar.wc-collapsed { position:relative !important; top:auto !important; right:auto !important; width:auto; }
    #${PANEL_ID}.wc-integrated-inline .wc-header, #${PANEL_ID}.wc-integrated-toolbar .wc-header { cursor:default; touch-action:auto; }
    #${PANEL_ID} .wc-integrated-notice { margin-bottom:6px; padding:5px 6px; border:1px solid #3f3f46; border-radius:5px; background:#18181b; color:#a1a1aa; }
    .warbuddy-roster-hidden { display:none !important; }
    .warbuddy-roster-sort-parent { display:flex !important; flex-direction:column !important; }
    .warbuddy-roster-sort-parent > [data-warbuddy-member-row] { width:100%; }
    [data-warbuddy-member-row].warbuddy-row-retal { box-shadow:inset 3px 0 #38bdf8 !important; }
    [data-warbuddy-member-row].warbuddy-row-actionable { box-shadow:inset 3px 0 #ef4444; }
    a.warbuddy-attack-dibs-mine { border-color:#10b981 !important; background:#047857 !important; color:#ecfdf5 !important; }
    a.warbuddy-attack-dibs-taken { border-color:#71717a !important; background:#52525b !important; color:#fafafa !important; opacity:.78; }
    a.warbuddy-attack-retal { box-shadow:0 0 0 2px rgba(56,189,248,.55) !important; }
    .${INLINE_TOOLS_CLASS} { display:inline-flex; align-items:center; gap:2px; margin-left:4px; vertical-align:middle; }
    .${INLINE_TOOLS_CLASS} button, .${INLINE_TOOLS_CLASS} a { display:inline-flex; width:18px; height:18px; align-items:center; justify-content:center; border:1px solid transparent; border-radius:3px; background:transparent; color:#a1a1aa; padding:0; text-decoration:none; font:12px/1 Arial,Helvetica,sans-serif; cursor:pointer; }
    .${INLINE_TOOLS_CLASS} button:hover, .${INLINE_TOOLS_CLASS} button:focus-visible, .${INLINE_TOOLS_CLASS} a:hover, .${INLINE_TOOLS_CLASS} a:focus-visible { border-color:#52525b; background:#27272a; color:#f4f4f5; outline:0; }
    .${INLINE_TOOLS_CLASS} .wc-inline-watch.active { color:#fbbf24; }
    .${INLINE_TOOLS_CLASS} .wc-inline-dibs.free { color:#d4d4d8; }
    .${INLINE_TOOLS_CLASS} .wc-inline-dibs.mine { color:#10b981; }
    .${INLINE_TOOLS_CLASS} .wc-inline-dibs.taken { color:#a1a1aa; }
    .${INLINE_TOOLS_CLASS} .wc-inline-retal { width:auto; min-width:18px; color:#38bdf8; padding:0 3px; font-size:10px; font-weight:700; }
    .${INLINE_TOOLS_CLASS} .wc-inline-status { display:inline-flex; min-height:17px; align-items:center; border:1px solid #52525b; border-radius:3px; background:#27272a; color:#d4d4d8; padding:0 3px; font:700 9px/1 Arial,Helvetica,sans-serif; white-space:nowrap; }
    .${INLINE_TOOLS_CLASS} .wc-inline-status.soon { border-color:#b45309; background:#451a03; color:#fde68a; }
    .${INLINE_TOOLS_CLASS} button:disabled { opacity:.45; cursor:wait; }
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
    #${PANEL_ID} .wc-context { display:flex; min-width:0; align-items:center; justify-content:space-between; gap:7px; margin-top:1px; font-size:10px; }
    #${PANEL_ID} .wc-matchup { min-width:0; overflow:hidden; color:#a1a1aa; text-overflow:ellipsis; white-space:nowrap; }
    #${PANEL_ID} .wc-body { max-height:calc(min(70vh,620px) - 42px); max-height:calc(min(70dvh,620px) - 42px); overflow:auto; overscroll-behavior:contain; padding:7px; }
    #${PANEL_ID} .wc-dot { width:7px; height:7px; flex:0 0 auto; border-radius:50%; background:#71717a; }
    #${PANEL_ID} .wc-dot.live { background:#10b981; }
    #${PANEL_ID} .wc-dot.wait { background:#f59e0b; }
    #${PANEL_ID} .wc-muted { color:#a1a1aa; }
    #${PANEL_ID} .wc-error { margin-bottom:6px; padding:6px; border:1px solid #7f1d1d; border-radius:5px; background:#2a1114; color:#fecaca; }
    #${PANEL_ID} .wc-section { margin-top:6px; border:1px solid #27272a; border-radius:5px; overflow:hidden; }
    #${PANEL_ID} .wc-section-title { display:flex; align-items:center; justify-content:space-between; gap:6px; padding:5px 6px; background:#18181b; font-weight:700; }
    #${PANEL_ID} .wc-section-controls { display:flex; align-items:center; gap:5px; }
    #${PANEL_ID} .wc-mini-toggle { display:inline-flex; align-items:center; gap:3px; border:0; border-radius:4px; background:#27272a; color:#a1a1aa; padding:2px 5px; font:700 10px/1.4 Arial,Helvetica,sans-serif; cursor:pointer; }
    #${PANEL_ID} .wc-mini-toggle.active { background:#064e3b; color:#a7f3d0; }
    #${PANEL_ID} .wc-count { color:#a1a1aa; font-size:10px; font-weight:400; }
    #${PANEL_ID} .wc-empty { padding:7px; color:#a1a1aa; }
    #${PANEL_ID} .wc-item { display:flex; align-items:center; justify-content:space-between; gap:7px; min-height:38px; padding:5px 6px; border-top:1px solid #27272a; }
    #${PANEL_ID} .wc-item:first-child { border-top:0; }
    #${PANEL_ID} .wc-item-text { min-width:0; }
    #${PANEL_ID} .wc-item-title { overflow:hidden; color:#e4e4e7; font-weight:700; text-overflow:ellipsis; white-space:nowrap; }
    #${PANEL_ID} .wc-item-detail { overflow:hidden; color:#a1a1aa; font-size:10px; text-overflow:ellipsis; white-space:nowrap; }
    #${PANEL_ID} .wc-group-tag { display:inline-flex; margin-right:4px; border-radius:3px; background:#27272a; color:#d4d4d8; padding:0 3px; font-size:9px; text-transform:uppercase; }
    #${PANEL_ID} .wc-group-tag.priority { background:#4c1d1d; color:#fecaca; }
    #${PANEL_ID} .wc-group-tag.chain { background:#422006; color:#fde68a; }
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
    #${PANEL_ID} .wc-group-select { width:72px; flex:0 0 72px; border:1px solid #3f3f46; border-radius:4px; background:#09090b; color:#d4d4d8; padding:3px; font:10px Arial,Helvetica,sans-serif; }
    #${PANEL_ID} .wc-target-actions { display:flex; align-items:center; justify-content:flex-end; gap:6px; padding:6px; border-top:1px solid #27272a; }
    #${PANEL_ID} .wc-target-error { flex:1; color:#fca5a5; font-size:10px; }
    #${PANEL_ID} .wc-unsaved { color:#fbbf24; font-size:10px; font-weight:700; }
    #${PANEL_ID} .wc-attack-card { padding:7px; border:1px solid #065f46; border-radius:5px; background:#09251f; }
    #${PANEL_ID} .wc-attack-kicker { color:#6ee7b7; font-size:10px; font-weight:700; text-transform:uppercase; }
    #${PANEL_ID} .wc-attack-row { display:flex; align-items:center; justify-content:space-between; gap:7px; margin-top:3px; }
    #${PANEL_ID} .wc-attack-name { min-width:0; overflow:hidden; color:#ecfdf5; font-weight:700; text-overflow:ellipsis; white-space:nowrap; }
    #${PANEL_ID} .wc-attack-detail { margin-top:2px; color:#a7f3d0; font-size:10px; }
    #${PANEL_ID} .wc-attack-result { display:flex; align-items:center; justify-content:space-between; gap:6px; margin-top:5px; border-top:1px solid rgba(167,243,208,.22); padding-top:5px; color:#d1fae5; font-weight:700; }
    #${PANEL_ID} .wc-loadout { position:relative; display:inline-flex; }
    #${PANEL_ID} .wc-loadout-button { width:18px; height:18px; border:0; border-radius:3px; background:transparent; color:#22d3ee; padding:0; cursor:pointer; }
    #${PANEL_ID} .wc-loadout-tip { position:absolute; right:0; top:22px; z-index:5; display:none; width:215px; border:1px solid #3f3f46; border-radius:4px; background:#09090b; color:#e4e4e7; padding:5px 6px; box-shadow:0 6px 18px rgba(0,0,0,.45); font-size:10px; font-weight:400; }
    #${PANEL_ID} .wc-loadout.open .wc-loadout-tip { display:block; }
    #${PANEL_ID} .wc-loadout-line { display:grid; grid-template-columns:42px minmax(0,1fr); gap:3px; }
    #${PANEL_ID} .wc-loadout-label { color:#71717a; font-weight:700; }
    #${PANEL_ID} .wc-loadout-value { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    #${PANEL_ID} .wc-options { display:grid; grid-template-columns:1fr 1fr; gap:5px; padding:0 6px 6px; }
    #${PANEL_ID} .wc-option { display:flex; align-items:center; gap:5px; color:#d4d4d8; }
    #${PANEL_ID} .wc-option input { margin:0; accent-color:#10b981; }
    #${PANEL_ID} .wc-display-setting { padding:0 6px 6px; }
    #${PANEL_ID} .wc-display-label { margin-bottom:4px; color:#a1a1aa; font-size:10px; }
    #${PANEL_ID} .wc-display-modes { display:grid; grid-template-columns:1fr 1fr; gap:4px; }
    #${PANEL_ID} .wc-display-mode { border:1px solid #3f3f46; border-radius:4px; background:#18181b; color:#a1a1aa; padding:5px 6px; font:inherit; font-weight:700; cursor:pointer; }
    #${PANEL_ID} .wc-display-mode.active { border-color:#047857; background:#064e3b; color:#d1fae5; }
    #${PANEL_ID} .wc-stale { margin-bottom:6px; padding:5px 6px; border:1px solid #78350f; border-radius:5px; background:#29170b; color:#fde68a; }
    #${PANEL_ID} .wc-queue-details { overflow:hidden; }
    #${PANEL_ID} .wc-queue-details > .wc-section { margin:0; border:0; border-top:1px solid #27272a; border-radius:0; }
    #${PANEL_ID} .wc-more-actions { margin:0; border:0; border-top:1px solid #27272a; border-radius:0; }
    #${PANEL_ID} .wc-privacy { padding:0 6px 6px; }
    #${PANEL_ID} .wc-private-actions { display:flex; gap:5px; padding:0 6px 6px; }
    @media (max-width:520px) { #${PANEL_ID} { right:6px; right:max(6px,env(safe-area-inset-right)); bottom:6px; bottom:max(6px,env(safe-area-inset-bottom)); width:calc(100vw - 12px); width:calc(100vw - 12px - env(safe-area-inset-left) - env(safe-area-inset-right)); max-height:58vh; max-height:58dvh; } #${PANEL_ID}.wc-collapsed { width:auto; } #${PANEL_ID}.wc-integrated-inline { width:100%; max-height:58vh; max-height:58dvh; } #${PANEL_ID}.wc-integrated-inline.wc-collapsed { width:100%; } #${PANEL_ID}.wc-roster-mode { max-height:none; } #${PANEL_ID}.wc-roster-mode .wc-body { max-height:none; overflow:visible; overscroll-behavior:auto; } #${PANEL_ID} .wc-roster-summary { gap:5px; padding:0 6px; } #${PANEL_ID} .wc-roster-matchup { display:none; } #${PANEL_ID} .wc-roster-watched { display:none; } #${PANEL_ID} .wc-roster-controls { align-items:stretch; flex-direction:column; } #${PANEL_ID} .wc-roster-sort { min-height:34px; } #${INTEGRATED_HOST_ID}.wc-attack-host #${PANEL_ID}:not(.wc-collapsed) { position:fixed !important; top:auto !important; right:6px !important; right:max(6px,env(safe-area-inset-right)) !important; bottom:6px !important; bottom:max(6px,env(safe-area-inset-bottom)) !important; left:auto !important; width:calc(100vw - 12px - env(safe-area-inset-left) - env(safe-area-inset-right)); } #${PANEL_ID} .wc-body { max-height:calc(58vh - 42px); max-height:calc(58dvh - 42px); padding-bottom:7px; padding-bottom:max(7px,env(safe-area-inset-bottom)); } #${PANEL_ID} .wc-item-detail { white-space:normal; } }
    @media (pointer:coarse) { #${PANEL_ID} .wc-button, #${PANEL_ID} .wc-link { min-height:40px; padding:8px 10px; } #${PANEL_ID} .wc-icon { width:40px; padding:0; } #${PANEL_ID} .wc-dibs, #${PANEL_ID} .wc-dibs-close { width:40px; height:40px; font-size:16px; } #${PANEL_ID} .wc-loadout-button { width:40px; height:40px; } #${PANEL_ID} .wc-target-option-row { min-height:44px; } #${PANEL_ID} .wc-target-option input { width:18px; height:18px; } #${PANEL_ID} summary { min-height:40px; padding:11px 8px; } .${INLINE_TOOLS_CLASS} button, .${INLINE_TOOLS_CLASS} a { width:30px; height:30px; } .${INLINE_TOOLS_CLASS} .wc-inline-retal { width:auto; min-width:30px; padding:0 5px; } }
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
  const targetGroupScope = () => `${String(state.session?.factionId || "")}:${String(state.session?.playerId || "")}`;
  const loadTargetGroups = () => {
    try {
      const allGroups = JSON.parse(String(storage.get(TARGET_GROUP_STORAGE, "") || "{}"));
      state.targetGroups = core.normalizeTargetGroups(allGroups?.[targetGroupScope()]);
    } catch {
      state.targetGroups = {};
    }
  };
  const saveTargetGroups = () => {
    let allGroups = {};
    try { allGroups = JSON.parse(String(storage.get(TARGET_GROUP_STORAGE, "") || "{}")) || {}; }
    catch { allGroups = {}; }
    allGroups[targetGroupScope()] = core.normalizeTargetGroups(state.targetGroups);
    storage.set(TARGET_GROUP_STORAGE, JSON.stringify(allGroups));
  };
  const targetGroupFor = (memberId) => String(state.targetGroups[String(Number(memberId || 0))] || "");
  const setTargetGroup = (memberId, group) => {
    const id = Number(memberId || 0);
    if (!Number.isSafeInteger(id) || id <= 0) return;
    const next = core.normalizeTargetGroups({ ...state.targetGroups, [String(id)]: group });
    if (!String(group || "")) delete next[String(id)];
    state.targetGroups = next;
    saveTargetGroups();
  };
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
  const liveDataAgeMs = () => Math.max(0, state.nowMs - Number(state.lastLiveDataAt || 0));
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
  const persistNotificationSettings = () => {
    storage.set(NOTIFICATION_STORAGE, JSON.stringify(state.notificationSettings));
  };
  const notifyUser = (candidate) => {
    if (typeof GM_notification !== "function" || !candidate?.url) return;
    GM_notification({
      title: String(candidate.title || "Warbuddy"),
      text: String(candidate.text || ""),
      tag: `warbuddy-${candidate.key}`,
      timeout: 8_000,
      onclick: () => window.open(candidate.url, "_blank", "noopener,noreferrer"),
    });
  };
  const evaluateNotifications = () => {
    if (!isForeground() || !currentEnemyRosterIsFresh()) return;
    const view = sessionView();
    const candidates = core.notificationCandidates({ actions: view.actions, retaliations: view.retaliation });
    const nextKeys = new Set(candidates.map((candidate) => candidate.key));
    if (!state.notificationsPrimed) {
      state.notificationKeys = nextKeys;
      state.notificationsPrimed = true;
      return;
    }
    for (const candidate of candidates) {
      if (state.notificationKeys.has(candidate.key) || state.notificationSettings[candidate.kind] !== true) continue;
      notifyUser(candidate);
    }
    state.notificationKeys = nextKeys;
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
    state.loadouts.clear();
    state.loadoutRequestFactionId = "";
    state.loadoutRequestAt = 0;
    state.dibs = { claims: [] };
    closeDibsDetails();
    state.dibsError = "";
    state.dibsErrorTargetId = 0;
    state.lastLiveDataAt = 0;
    state.fallbackRevision = "";
    state.fallbackUnchangedCount = 0;
    state.rosterDataAt.clear();
    state.targetQuickError = "";
    state.notificationsPrimed = false;
    state.notificationKeys.clear();
    state.attackOutcome = null;
    stopAttackOutcomeDetection();
    state.attackOutcomeReleaseKey = "";
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
  const isRosterModePage = () => state.displayMode === "integrated"
    && core.isRankedWarPageUrl(window.location.href);
  const isForeground = () => state.active
    && (!state.collapsed || isRosterModePage())
    && document.visibilityState !== "hidden"
    && (typeof navigator === "undefined" || navigator.onLine !== false);
  const backendUrl = (path) => `${BACKEND_BASE_URL.replace(/\/$/, "")}${path}`;
  const socketUrl = () => `${BACKEND_BASE_URL.replace(/^http/i, "ws").replace(/\/$/, "")}/ws`;
  const fallbackIsFresh = () => state.fallbackActive
    && Number.isFinite(Date.parse(state.lastFallbackAt))
    && Date.parse(state.lastFallbackAt) > Date.now() - (FALLBACK_POLL_MAX_MS * 3);

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
    if (state.panelPlacement !== "floating") return;
    const position = getStoredPanelPosition();
    if (panel && position) setPanelPosition(panel, position);
  }

  function clearPanelPositionStyles(panel) {
    if (!panel) return;
    for (const property of ["left", "top", "right", "bottom"]) panel.style.removeProperty(property);
  }

  function resetPanelPosition() {
    storage.remove(POSITION_STORAGE);
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    clearPanelPositionStyles(panel);
  }

  function removeInlineMemberTools() {
    document.querySelectorAll?.(`.${INLINE_TOOLS_CLASS}`).forEach((element) => element.remove());
    document.querySelectorAll?.("[data-warbuddy-member-row]").forEach((row) => {
      row.classList.remove("warbuddy-roster-hidden", "warbuddy-row-retal", "warbuddy-row-actionable");
      row.style?.removeProperty?.("order");
      delete row.dataset.warbuddyMemberRow;
      delete row.dataset.warbuddyMemberId;
      delete row.dataset.warbuddyPriority;
      delete row.dataset.warbuddyAvailability;
    });
    document.querySelectorAll?.(".warbuddy-roster-sort-parent").forEach((parent) => {
      parent.classList.remove("warbuddy-roster-sort-parent");
    });
    document.querySelectorAll?.("[data-warbuddy-attack-state]").forEach((link) => {
      link.classList.remove("warbuddy-attack-dibs-mine", "warbuddy-attack-dibs-taken", "warbuddy-attack-retal");
      link.title = String(link.title || "").replace(/\s*-?\s*Warbuddy:.*$/i, "").trim();
      delete link.dataset.warbuddyAttackState;
    });
  }

  function removeIntegratedMount(preservePanel = true) {
    const panel = document.getElementById(PANEL_ID);
    const host = document.getElementById(INTEGRATED_HOST_ID);
    const wrapper = document.getElementById(INTEGRATED_WRAPPER_ID);
    if (preservePanel && panel && host?.contains?.(panel) && document.body) document.body.appendChild(panel);
    if (wrapper) wrapper.remove();
    else host?.remove();
    document.querySelectorAll?.("[data-warbuddy-roster-board]").forEach((board) => {
      delete board.dataset.warbuddyRosterBoard;
    });
  }

  function rosterProfileAnchors(roster, root = document) {
    const memberIds = new Set((Array.isArray(roster) ? roster : [])
      .map((member) => Number(member?.member_id || 0))
      .filter((memberId) => Number.isSafeInteger(memberId) && memberId > 0));
    if (!memberIds.size) return [];
    const seen = new Set();
    return Array.from(root?.querySelectorAll?.("a[href*='profiles.php']") || []).filter((anchor) => {
      if (anchor.closest?.(`#${PANEL_ID}, #${INTEGRATED_HOST_ID}, .${INLINE_TOOLS_CLASS}`)) return false;
      const memberId = core.profileMemberIdFromUrl(anchor.getAttribute?.("href") || anchor.href || "");
      if (!memberIds.has(memberId) || seen.has(memberId)) return false;
      seen.add(memberId);
      return true;
    });
  }

  function enemyProfileAnchors(view) {
    const enemyIds = new Set((view?.enemyRoster || [])
      .map((member) => Number(member?.member_id || 0))
      .filter((memberId) => Number.isSafeInteger(memberId) && memberId > 0));
    const seen = new Set();
    return Array.from(document.querySelectorAll?.("a[href*='profiles.php']") || []).filter((anchor) => {
      if (anchor.closest?.(`#${PANEL_ID}, #${INTEGRATED_HOST_ID}, .${INLINE_TOOLS_CLASS}`)) return false;
      const memberId = core.profileMemberIdFromUrl(anchor.getAttribute?.("href") || anchor.href || "");
      if (!enemyIds.has(memberId) || seen.has(memberId) || !rankedWarRowForAnchor(anchor)) return false;
      seen.add(memberId);
      return true;
    });
  }

  function rankedWarRowForAnchor(anchor) {
    let candidate = anchor?.parentElement;
    for (let depth = 0; candidate && depth < 10; depth += 1, candidate = candidate.parentElement) {
      if (candidate === document.body || candidate === document.documentElement) return null;
      const profileLinks = Array.from(candidate.querySelectorAll?.("a[href*='profiles.php']") || [])
        .filter((link) => core.profileMemberIdFromUrl(link.getAttribute?.("href") || link.href || "") > 0);
      if (profileLinks.length > 1) return null;
      if (profileLinks.length === 1 && candidate.querySelector?.("a[href*='sid=attack']")) return candidate;
    }

    return null;
  }

  function rankedWarOwnRowForAnchor(anchor) {
    let candidate = anchor?.parentElement;
    let singleMemberContainer = null;
    for (let depth = 0; candidate && depth < 10; depth += 1, candidate = candidate.parentElement) {
      if (candidate === document.body || candidate === document.documentElement) break;
      const profileLinks = Array.from(candidate.querySelectorAll?.("a[href*='profiles.php']") || [])
        .filter((link) => core.profileMemberIdFromUrl(link.getAttribute?.("href") || link.href || "") > 0);
      if (profileLinks.length > 1) return singleMemberContainer;
      if (profileLinks.length === 1) singleMemberContainer = candidate;
    }
    return singleMemberContainer;
  }

  function lowestCommonAncestor(left, right) {
    if (!left || !right) return null;
    const leftAncestors = new Set();
    for (let candidate = left, depth = 0; candidate && depth < 16; candidate = candidate.parentElement, depth += 1) {
      leftAncestors.add(candidate);
    }
    for (let candidate = right, depth = 0; candidate && depth < 16; candidate = candidate.parentElement, depth += 1) {
      if (leftAncestors.has(candidate)) return candidate;
    }
    return null;
  }

  function rankedWarBoardForView(view) {
    const expectedMembers = Number(view?.ownRoster?.length || 0) + Number(view?.enemyRoster?.length || 0);
    const invalidParents = new Set(["TABLE", "TBODY", "THEAD", "TFOOT", "TR"]);
    let best = null;
    let bestProfileCount = Number.POSITIVE_INFINITY;
    for (const ownAnchor of rosterProfileAnchors(view?.ownRoster).slice(0, 16)) {
      const ownRow = rankedWarOwnRowForAnchor(ownAnchor);
      if (!ownRow) continue;
      for (const enemyAnchor of enemyProfileAnchors(view).slice(0, 8)) {
        const enemyRow = rankedWarRowForAnchor(enemyAnchor);
        let board = lowestCommonAncestor(ownRow, enemyRow);
        if (!board || board === document.body || board === document.documentElement) continue;
        while (board?.parentElement && invalidParents.has(String(board.parentElement.tagName || "").toUpperCase())) {
          board = board.parentElement;
        }
        if (!board?.parentElement || board === document.body || board === document.documentElement) continue;
        if (!board.contains?.(ownRow) || !board.contains?.(enemyRow)) continue;
        const profileCount = Array.from(board.querySelectorAll?.("a[href*='profiles.php']") || [])
          .filter((anchor) => core.profileMemberIdFromUrl(anchor.getAttribute?.("href") || anchor.href || "") > 0)
          .length;
        if (profileCount < 2 || profileCount > Math.max(220, expectedMembers + 24)) continue;
        if (profileCount < bestProfileCount) {
          best = board;
          bestProfileCount = profileCount;
        }
      }
    }
    return best;
  }

  function createRankedWarHost(view) {
    const board = rankedWarBoardForView(view);
    const parent = board?.parentNode;
    if (!board || !parent) return null;

    document.querySelectorAll?.("[data-warbuddy-roster-board]").forEach((candidate) => {
      delete candidate.dataset.warbuddyRosterBoard;
    });
    board.dataset.warbuddyRosterBoard = "1";

    const wrapper = document.createElement("div");
    wrapper.id = INTEGRATED_WRAPPER_ID;
    wrapper.className = "warbuddy-integrated-rank-host";
    const host = document.createElement("div");
    host.id = INTEGRATED_HOST_ID;
    host.className = "wc-rank-host";
    host.dataset.placement = "rank";
    wrapper.appendChild(host);
    parent.insertBefore(wrapper, board);
    return host;
  }

  function resolvePanelMount(view) {
    if (state.attackTargetId) {
      removeIntegratedMount(true);
      return { mount: document.body, placement: "floating", fallback: false };
    }

    if (state.displayMode !== "integrated") {
      removeIntegratedMount(true);
      return { mount: document.body, placement: "floating", fallback: false };
    }

    const desiredPlacement = core.isRankedWarPageUrl(window.location.href) ? "rank" : "";
    let host = document.getElementById(INTEGRATED_HOST_ID);
    if (host && host.dataset?.placement !== desiredPlacement) {
      removeIntegratedMount(true);
      host = null;
    }

    if (desiredPlacement === "rank") {
      host ||= createRankedWarHost(view);
      if (host) return { mount: host, placement: "inline", fallback: false };
    }

    removeIntegratedMount(true);
    return { mount: document.body, placement: "floating", fallback: true };
  }

  function setDisplayMode(value) {
    const nextMode = core.normalizeDisplayMode(value);
    state.displayMode = nextMode;
    storage.set(DISPLAY_MODE_STORAGE, nextMode);
    state.integratedFallback = false;
    state.panelPlacement = "floating";
    removeInlineMemberTools();
    removeIntegratedMount(true);
    scheduleRender();
  }

  function attachPanelDragHandler(panel) {
    if (state.panelPlacement !== "floating") return;
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
    loadTargetGroups();
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

  function rejectSocketRequests(message = "Live connection closed") {
    for (const request of state.socketRequests.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(message));
    }
    state.socketRequests.clear();
  }

  function requestSocketAction(action, payload = {}, timeoutMs = 10_000) {
    const socket = state.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Live connection is unavailable"));
    const id = `wc-action-${++state.socketRequestSequence}-${Date.now()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        state.socketRequests.delete(id);
        reject(new Error(`${action} timed out`));
      }, timeoutMs);
      state.socketRequests.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ type: "request", id, action, payload: { ...payload, wsSessionToken: state.token } }));
    });
  }

  function maybeLoadEnemyLoadouts() {
    const enemyFactionId = currentEnemyFactionId();
    if (!enemyFactionId || !socketIsOpen() || state.settings?.enabled === false) return;
    if (state.loadouts.has(enemyFactionId)) return;
    if (state.loadoutRequestFactionId === enemyFactionId && Date.now() - state.loadoutRequestAt < 60_000) return;
    state.loadoutRequestFactionId = enemyFactionId;
    state.loadoutRequestAt = Date.now();
    requestSocketAction("war_tracker:loadouts", { factionId: enemyFactionId })
      .then((snapshot) => {
        if (snapshot?.factionId) state.loadouts.set(String(snapshot.factionId), snapshot);
      })
      .catch(() => undefined)
      .finally(() => {
        if (state.loadoutRequestFactionId === enemyFactionId) state.loadoutRequestFactionId = "";
        scheduleRender();
      });
  }

  function closeSocket() {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = 0;
    stopFallbackPolling();
    clearSocketConnectTimer();
    const socket = state.socket;
    state.socket = null;
    state.socketOpenedAt = 0;
    rejectSocketRequests();
    if (socket && socket.readyState < WebSocket.CLOSING) {
      socket.close(1000, "Paused");
    }
  }

  function recoverFailedSocket(socket, reason = "Connection failed") {
    if (socket !== state.socket) return;
    clearSocketConnectTimer();
    state.socket = null;
    state.socketOpenedAt = 0;
    rejectSocketRequests(reason);
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
    setTimeout(() => {
      maybeLoadEnemyLoadouts();
      evaluateNotifications();
    }, 0);
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
    state.fallbackRevision = String(snapshot?.revision || "");
    state.fallbackUnchangedCount = 0;
    scheduleRender();
    setTimeout(evaluateNotifications, 0);
  }

  function markFallbackSnapshotUnchanged(snapshot) {
    if (!snapshot?.unchanged || !state.fallbackRevision || snapshot.revision !== state.fallbackRevision) return false;
    state.lastLiveDataAt = Date.now();
    for (const factionId of state.rosters.keys()) state.rosterDataAt.set(factionId, state.lastLiveDataAt);
    state.fallbackUnchangedCount += 1;
    return true;
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
    const view = sessionView();
    const delay = core.fallbackPollDelayMs({
      baseMs: FALLBACK_POLL_MS,
      maxMs: FALLBACK_POLL_MAX_MS,
      failureCount: state.fallbackFailureCount,
      unchangedCount: state.fallbackUnchangedCount,
      urgent: view.actions.some((item) => item.severity === "urgent") || view.retaliation.length > 0,
      activeWar: !!view.enemyFactionId,
    });
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
      const revision = state.fallbackRevision
        ? `&revision=${encodeURIComponent(state.fallbackRevision)}`
        : "";
      const snapshot = await requestJson({
        method: "GET",
        url: backendUrl(`/api/v1/factions/${encodeURIComponent(factionId)}/war-companion/snapshot?timestamp=${Date.now()}${revision}`),
        headers: { Authorization: `Bearer ${state.token}` },
        label: "Warbuddy snapshot",
      });
      if (generation !== state.fallbackGeneration || !state.fallbackActive || !isForeground()) return;
      state.nowMs = Date.now();
      if (!markFallbackSnapshotUnchanged(snapshot)) applyFallbackSnapshot(snapshot);
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
    if (message?.type === "response" && message.id && state.socketRequests.has(String(message.id))) {
      const request = state.socketRequests.get(String(message.id));
      state.socketRequests.delete(String(message.id));
      clearTimeout(request.timer);
      if (message.success === false || message.error) {
        request.reject(new Error(message?.error?.error || message?.error?.message || "Live request failed"));
      } else {
        request.resolve(message.payload);
      }
      return;
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
        setTimeout(maybeLoadEnemyLoadouts, 0);
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
        rejectSocketRequests();
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
    const enemyScore = core.scoreForFaction(state.scores, enemyFactionId);
    const actionQueueEnabled = state.settings?.enabled !== false && state.settings?.showActionQueue !== false;
    const genericSuggestionsEnabled = rosterIsFresh(ownFactionId) && rosterIsFresh(enemyFactionId);
    const actions = !actionQueueEnabled ? [] : core.applyTargetGroups(core.buildActionQueue({
      enemies: enemyRoster,
      alliedScore,
      ownBsp: ownMember?.bsp || 0,
      watchedEnemyMemberIds: state.settings?.watchedEnemyMemberIds || [],
      nowMs: state.nowMs,
    }).filter((item) => genericSuggestionsEnabled || !String(item.key || "").startsWith("online-")), state.targetGroups);
    const retaliation = core.activeRetaliations(state.retaliation, Math.floor(state.nowMs / 1000));
    const focusItems = core.buildFocusQueue({ actions, retaliations: retaliation, limit: 3 });
    return { ownFactionId, ownFactionName, enemyFactionId, enemyFactionName, ownRoster, enemyRoster, alliedScore, enemyScore, actions, retaliation, focusItems, dibs: state.dibs, actionQueueEnabled };
  }

  const statusView = () => {
    if (!getStoredKey()) return { label: "API key needed", tone: "" };
    if (state.authTerminal) return { label: "Key needs attention", tone: "wait" };
    if (state.collapsed && !isRosterModePage()) return { label: "Paused", tone: "" };
    if (!isOnline()) return { label: "Offline", tone: "wait" };
    if (document.visibilityState === "hidden") return { label: "Paused while hidden", tone: "" };
    if (transportIsLive() && state.settings?.enabled !== false && currentEnemyFactionId() && !currentEnemyRosterIsFresh()) return { label: "Syncing targets", tone: "wait" };
    if (transportIsLive() && dataIsStale()) return { label: `Stale ${core.duration(liveDataAgeMs())}`, tone: "wait" };
    if (state.phase === "connected") return { label: "Live", tone: "live" };
    if (state.phase === "fallback") return { label: "Live (compatible)", tone: "live" };
    if (state.phase === "paused") return { label: "Paused", tone: "" };
    if (state.phase === "error") return { label: "Connection error", tone: "wait" };
    if (state.phase === "authenticating") return { label: "Checking key", tone: "wait" };
    return { label: "Connecting", tone: "wait" };
  };

  const ffscouterFilterActive = () => !!document.querySelector?.(
    '[data-ffscouter-active-filter="true"], [data-ffscouter-active-filter="1"]'
  );

  function syncIntegratedMemberTools(view = sessionView()) {
    const canDecorate = state.active
      && state.displayMode === "integrated"
      && core.isRankedWarPageUrl(window.location.href)
      && Array.isArray(view?.enemyRoster)
      && view.enemyRoster.length > 0;
    if (!canDecorate) {
      removeInlineMemberTools();
      return;
    }

    const members = new Map(view.enemyRoster.map((member) => [Number(member?.member_id || 0), member]));
    const watchedIds = new Set(savedTargetIds());
    const retaliations = new Map((view.retaliation || []).map((attack) => [Number(attack?.attackerId || 0), attack]));
    const actionableIds = new Set((view.actions || [])
      .map((action) => Number(action?.memberId || 0))
      .filter((memberId) => Number.isSafeInteger(memberId) && memberId > 0));
    const keep = new Set();
    const keepRows = new Set();
    const keepAttackLinks = new Set();
    const decoratedRows = [];
    const board = document.querySelector?.("[data-warbuddy-roster-board='1']");
    const enemyAnchors = board?.isConnected
      ? rosterProfileAnchors(view.enemyRoster, board)
      : enemyProfileAnchors(view);

    for (const anchor of enemyAnchors) {
      const memberId = core.profileMemberIdFromUrl(anchor.getAttribute?.("href") || anchor.href || "");
      const member = members.get(memberId);
      if (!member) continue;
      keep.add(memberId);
      const parent = anchor.parentElement;
      if (!parent) continue;
      let tools = Array.from(parent.querySelectorAll?.(`.${INLINE_TOOLS_CLASS}`) || [])
        .find((candidate) => Number(candidate.dataset?.memberId || 0) === memberId);
      if (!tools) {
        tools = document.createElement("span");
        tools.className = INLINE_TOOLS_CLASS;
        tools.dataset.memberId = String(memberId);
        if (typeof anchor.insertAdjacentElement === "function") anchor.insertAdjacentElement("afterend", tools);
        else parent.insertBefore(tools, anchor.nextSibling || null);
      }

      const watched = watchedIds.has(memberId);
      const watchBusy = state.targetQuickBusyId === memberId;
      const claim = core.dibsFeatureEnabled(state.settings)
        ? core.activeDibsClaim(view.dibs, memberId, state.nowMs)
        : undefined;
      const eligibility = claim ? undefined : core.dibsEligibility(member, state.nowMs);
      const isMine = !!claim && String(claim.claimedByPlayerId || "") === String(state.session?.playerId || "");
      const dibsTone = isMine ? "mine" : claim ? "taken" : "free";
      const dibsRemaining = claim ? core.duration(core.toTimestampMs(claim.expiresAt) - state.nowMs) : "";
      const dibsLabel = claim
        ? `${isMine ? "Your Dibs" : `Dibs: ${claim.claimedByPlayerName || claim.claimedByPlayerId}`} - ${dibsRemaining} left`
        : eligibility?.state === "hospitalized"
          ? `Claim Dibs - leaves hospital in ${core.duration(Number(eligibility.hospitalUntil || 0) - state.nowMs)}`
          : "Claim Dibs - attackable now";
      const canClaim = !claim
        && eligibility?.eligible === true
        && rosterIsFresh(view.enemyFactionId)
        && isOnline()
        && !state.authTerminal
        && !state.keySaving
        && !state.targetsSaving
        && !state.targetQuickBusyId
        && !state.dibsBusyTargetId;
      const retaliation = retaliations.get(memberId);
      const retaliationLabel = retaliation
        ? `Retaliation - ${core.duration((Number(retaliation.expiresAt || 0) * 1000) - state.nowMs)} left`
        : "";
      const row = board?.contains?.(anchor)
        ? rankedWarOwnRowForAnchor(anchor)
        : rankedWarRowForAnchor(anchor);
      const actionable = actionableIds.has(memberId) || !!retaliation;
      const availability = core.memberAvailability(member, state.nowMs);
      const flags = {
        watched,
        actionable,
        retaliation: !!retaliation,
        dibsMine: isMine,
        dibsTaken: !!claim && !isMine,
        targetGroup: targetGroupFor(memberId),
      };

      if (row) {
        keepRows.add(row);
        decoratedRows.push(row);
        row.dataset.warbuddyMemberRow = "1";
        row.dataset.warbuddyMemberId = String(memberId);
        row.classList.toggle("warbuddy-row-retal", flags.retaliation);
        row.classList.toggle("warbuddy-row-actionable", flags.actionable && !flags.retaliation);
        row.classList.toggle("warbuddy-roster-hidden", !core.rosterFilterMatches(state.rosterFilter, flags));
        row.dataset.warbuddyPriority = String(core.rosterOrder(flags, member, state.nowMs));
        row.dataset.warbuddyAvailability = availability.state;
      }

      const attackLink = row?.querySelector?.("a[href*='sid=attack']");
      if (attackLink) {
        keepAttackLinks.add(attackLink);
        const baseTitle = String(attackLink.title || "").replace(/\s*-?\s*Warbuddy:.*$/i, "").trim();
        attackLink.dataset.warbuddyAttackState = isMine ? "mine" : claim ? "taken" : retaliation ? "retaliation" : "free";
        attackLink.classList.toggle("warbuddy-attack-dibs-mine", isMine);
        attackLink.classList.toggle("warbuddy-attack-dibs-taken", !!claim && !isMine);
        attackLink.classList.toggle("warbuddy-attack-retal", !!retaliation);
        attackLink.title = claim || retaliation
          ? [baseTitle, `Warbuddy: ${claim ? dibsLabel : retaliationLabel}`].filter(Boolean).join(" - ")
          : baseTitle;
      }

      const retaliationRemaining = retaliation
        ? core.duration((Number(retaliation.expiresAt || 0) * 1000) - state.nowMs)
        : "";
      const availabilityMarkup = availability.label
        ? `<span class="wc-inline-status ${escapeHtml(availability.tone || "")}" title="${escapeHtml(availability.title)}">${escapeHtml(availability.label)}</span>`
        : "";
      tools.innerHTML = `${availabilityMarkup}<button type="button" class="wc-inline-watch${watched ? " active" : ""}" data-inline-action="watch" aria-label="${watched ? "Stop watching" : "Watch"} ${escapeHtml(member.member_name || `Player ${memberId}`)}" title="${watched ? "Stop watching" : "Watch target"}"${watchBusy ? " disabled" : ""}>${watched ? "&#9733;" : "&#9734;"}</button>${core.dibsFeatureEnabled(state.settings) && (claim || eligibility?.eligible) ? `<button type="button" class="wc-inline-dibs ${dibsTone}" data-inline-action="${canClaim ? "claim" : "inspect"}" aria-label="${escapeHtml(dibsLabel)}" title="${escapeHtml(dibsLabel)}"${state.dibsBusyTargetId === memberId ? " disabled" : ""}>&#9995;</button>` : ""}${retaliation ? `<a class="wc-inline-retal" href="${escapeHtml(retaliation.attackUrl || core.attackUrl(memberId))}" target="_blank" rel="noopener noreferrer" aria-label="${escapeHtml(retaliationLabel)}" title="${escapeHtml(retaliationLabel)}">Retal ${escapeHtml(retaliationRemaining)}</a>` : ""}`;

      tools.querySelector?.('[data-inline-action="watch"]')?.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void toggleWatchedTarget(memberId);
      });
      tools.querySelector?.('[data-inline-action="claim"]')?.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void updateDibs("claim", memberId, `inline-${memberId}`);
      });
    }

    let activeSortParent = null;
    const ffscouterOwnsOrder = state.rosterPrioritySort && ffscouterFilterActive();
    const sortLabel = document.querySelector?.(`#${PANEL_ID} .wc-roster-sort`);
    sortLabel?.classList.toggle("paused", ffscouterOwnsOrder);
    if (sortLabel) {
      sortLabel.title = ffscouterOwnsOrder
        ? "Warbuddy ordering is paused while FFScouter filtering is active."
        : "Prioritize Retals, Dibs, watched targets, and useful availability states.";
    }
    if (state.rosterPrioritySort && !ffscouterOwnsOrder && decoratedRows.length > 1) {
      const parents = new Set(decoratedRows.map((row) => row.parentElement).filter(Boolean));
      if (parents.size === 1) {
        const parent = parents.values().next().value;
        const parentTag = String(parent.tagName || "").toUpperCase();
        const rowSet = new Set(decoratedRows);
        const memberChildren = Array.from(parent.children || []).filter((child) => (
          child.querySelector?.("a[href*='profiles.php']")
        ));
        if (["DIV", "UL", "OL"].includes(parentTag) && memberChildren.every((child) => rowSet.has(child))) {
          activeSortParent = parent;
          parent.classList.add("warbuddy-roster-sort-parent");
          decoratedRows.forEach((row) => {
            row.style.order = String(Number(row.dataset.warbuddyPriority || 0));
          });
        }
      }
    }

    document.querySelectorAll?.(`.${INLINE_TOOLS_CLASS}`).forEach((tools) => {
      if (!keep.has(Number(tools.dataset?.memberId || 0))) tools.remove();
    });
    document.querySelectorAll?.("[data-warbuddy-member-row]").forEach((row) => {
      if (keepRows.has(row)) {
        if (!activeSortParent) row.style?.removeProperty?.("order");
        return;
      }
      row.classList.remove("warbuddy-roster-hidden", "warbuddy-row-retal", "warbuddy-row-actionable");
      row.style?.removeProperty?.("order");
      delete row.dataset.warbuddyMemberRow;
      delete row.dataset.warbuddyMemberId;
      delete row.dataset.warbuddyPriority;
      delete row.dataset.warbuddyAvailability;
    });
    document.querySelectorAll?.(".warbuddy-roster-sort-parent").forEach((parent) => {
      if (parent !== activeSortParent) parent.classList.remove("warbuddy-roster-sort-parent");
    });
    document.querySelectorAll?.("[data-warbuddy-attack-state]").forEach((link) => {
      if (keepAttackLinks.has(link)) return;
      link.classList.remove("warbuddy-attack-dibs-mine", "warbuddy-attack-dibs-taken", "warbuddy-attack-retal");
      link.title = String(link.title || "").replace(/\s*-?\s*Warbuddy:.*$/i, "").trim();
      delete link.dataset.warbuddyAttackState;
    });
  }

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
    const canRelease = isOnline()
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
      ? `<button type="button" class="wc-dibs-release" data-dibs-action="release" data-dibs-target="${memberId}" data-dibs-instance="${escapeHtml(dibsInstanceKey)}" data-focus-key="dibs-release-${escapeHtml(dibsInstanceKey)}"${!canRelease || anyBusy ? " disabled" : ""}>${busy && state.dibsBusyAction === "release" ? "Releasing..." : "Release & unwatch"}</button>`
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
    const group = String(item.targetGroup || "");
    const groupLabel = group ? `<span class="wc-group-tag ${escapeHtml(group)}">${escapeHtml(group)}</span>` : "";
    return `<div class="wc-item ${escapeHtml(item.severity)}">
      <div class="wc-item-text"><div class="wc-item-title">${groupLabel}${escapeHtml(item.title)}</div><div class="wc-item-detail" title="${escapeHtml(item.detail)}">${escapeHtml(item.detail)}</div></div>
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
      const kept = new Set(memberIds.map(String));
      state.targetGroups = Object.fromEntries(Object.entries(state.targetGroups).filter(([memberId]) => kept.has(memberId)));
      saveTargetGroups();
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
      if (wasWatched) setTargetGroup(memberId, "");
      else if (!targetGroupFor(memberId)) setTargetGroup(memberId, "priority");
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
    setTargetGroup(memberId, "");
  }

  async function updateDibs(action, targetMemberId, instanceKey = "") {
    const memberId = Number(targetMemberId || 0);
    if (!core.dibsFeatureEnabled(state.settings) || state.dibsBusyTargetId || state.targetsSaving || state.targetQuickBusyId || !Number.isSafeInteger(memberId) || memberId <= 0) return false;
    if (!isOnline() || state.authTerminal || state.keySaving || (action === "claim" && !currentEnemyRosterIsFresh())) {
      showDibsError("Dibs is unavailable until Warbuddy has a fresh live connection.", memberId);
      scheduleRender();
      return false;
    }
    const expectsSocketSnapshot = socketIsOpen();
    const resumeFallback = !expectsSocketSnapshot && state.fallbackActive;
    state.dibsBusyTargetId = memberId;
    state.dibsBusyAction = action;
    state.dibsError = "";
    state.dibsErrorTargetId = 0;
    let succeeded = false;
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
      succeeded = true;
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
    return succeeded;
  }

  function armAttackOutcomeDetection() {
    if (!state.attackTargetId) return;
    state.attackOutcome = null;
    state.attackOutcomeArmedAt = Date.now();
    state.attackOutcomeReleaseKey = "";
    startAttackOutcomeObserver();
    scheduleRender();
  }

  function stopAttackOutcomeDetection() {
    state.attackOutcomeArmedAt = 0;
    if (state.attackOutcomeScanTimer) clearTimeout(state.attackOutcomeScanTimer);
    state.attackOutcomeScanTimer = 0;
    state.attackOutcomeObserver?.disconnect();
    state.attackOutcomeObserver = null;
  }

  function startAttackOutcomeObserver() {
    state.attackOutcomeObserver?.disconnect();
    if (typeof MutationObserver !== "function" || !document.body) return;
    state.attackOutcomeObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations || []) {
        for (const node of mutation.addedNodes || []) queueAttackOutcomeScan(node);
        if (mutation.type === "characterData") queueAttackOutcomeScan(mutation.target);
      }
    });
    state.attackOutcomeObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
    setTimeout(() => {
      if (state.attackOutcomeArmedAt && Date.now() - state.attackOutcomeArmedAt >= 2 * 60_000) {
        stopAttackOutcomeDetection();
      }
    }, 2 * 60_000 + 100);
  }

  async function recordAttackOutcome(outcome) {
    const targetMemberId = Number(state.attackTargetId || 0);
    if (!targetMemberId || !outcome || state.attackOutcome?.kind === outcome.kind) return;
    state.attackOutcome = {
      ...outcome,
      targetMemberId,
      observedAt: new Date().toISOString(),
      dibsReleased: false,
    };
    stopAttackOutcomeDetection();
    scheduleRender();

    if (!outcome.releaseDibs) return;
    const claim = core.activeDibsClaim(state.dibs, targetMemberId, Date.now());
    if (!claim || String(claim.claimedByPlayerId || "") !== String(state.session?.playerId || "")) return;
    const releaseKey = `${targetMemberId}:${String(claim.claimedAt || "")}`;
    if (state.attackOutcomeReleaseKey === releaseKey) return;
    state.attackOutcomeReleaseKey = releaseKey;
    const released = await updateDibs("release", targetMemberId, `attack-${targetMemberId}`);
    if (state.attackOutcome?.targetMemberId !== targetMemberId || state.attackOutcome?.kind !== outcome.kind) return;
    state.attackOutcome = { ...state.attackOutcome, dibsReleased: released };
    scheduleRender();
  }

  function inspectAttackOutcomeNode(node) {
    if (!state.attackTargetId || !state.attackOutcomeArmedAt) return;
    if (Date.now() - state.attackOutcomeArmedAt > 2 * 60_000) {
      stopAttackOutcomeDetection();
      return;
    }
    const element = node?.nodeType === 3 ? node.parentElement : node;
    if (element?.closest?.(`#${PANEL_ID}`)) return;
    const outcome = core.attackOutcomeFromText(String(element?.innerText || element?.textContent || ""));
    if (outcome) void recordAttackOutcome(outcome);
  }

  function queueAttackOutcomeScan(node) {
    if (!state.attackOutcomeArmedAt) return;
    if (state.attackOutcomeScanTimer) clearTimeout(state.attackOutcomeScanTimer);
    state.attackOutcomeScanTimer = setTimeout(() => {
      state.attackOutcomeScanTimer = 0;
      inspectAttackOutcomeNode(node || document.body);
    }, 120);
  }

  function actionQueueMarkup(view, trackerDisabled, noWar) {
    if (trackerDisabled) return "";
    if (!view.actionQueueEnabled) return "";
    const focusItems = state.focusMode ? view.focusItems : [];
    const visible = state.focusMode ? focusItems : view.actions.slice(0, 9);
    const remaining = state.focusMode ? [] : view.actions.slice(9);
    const items = noWar
      ? `<div class="wc-empty">No active war.</div>`
      : visible.length
        ? visible.map((entry) => state.focusMode
          ? entry.kind === "retaliation" ? retaliationMarkup(entry.item, view) : actionMarkup(entry.item, view)
          : actionMarkup(entry, view)).join("")
        : `<div class="wc-empty">No immediate actions.</div>`;
    const more = remaining.length
      ? `<details class="wc-more-actions" data-section="more-actions"${state.moreActionsOpen ? " open" : ""}><summary>More actions <span class="wc-summary-count">${remaining.length}</span></summary>${remaining.map((item) => actionMarkup(item, view)).join("")}</details>`
      : "";
    const count = state.focusMode ? focusItems.length : view.actions.length;
    return `<div class="wc-section wc-action-section"><div class="wc-section-title"><span>${state.focusMode ? "Focus" : "Action queue"}</span><span class="wc-section-controls"><button type="button" class="wc-mini-toggle${state.focusMode ? " active" : ""}" data-action="toggle-focus" title="Show only the three most urgent actions">Focus</button><span class="wc-count">${count}</span></span></div>${items}${more}</div>`;
  }

  const loadoutRarityColor = (rarity) => {
    const normalized = String(rarity || "").trim().toLowerCase();
    if (/legendary|red/.test(normalized)) return "#ef4444";
    if (/epic|orange/.test(normalized)) return "#f97316";
    if (/very rare|purple/.test(normalized)) return "#a855f7";
    if (/rare|blue/.test(normalized)) return "#3b82f6";
    if (/uncommon|green/.test(normalized)) return "#22c55e";
    if (/special|yellow/.test(normalized)) return "#eab308";
    return "#a1a1aa";
  };

  function memberLoadout(view, memberId) {
    const snapshot = state.loadouts.get(String(view.enemyFactionId || ""));
    return (Array.isArray(snapshot?.members) ? snapshot.members : []).find((entry) => Number(entry?.memberId || 0) === Number(memberId || 0));
  }

  const loadoutItemText = (item) => {
    if (!item) return "-";
    const bonuses = (Array.isArray(item.bonuses) ? item.bonuses : [])
      .map((bonus) => typeof bonus === "string" ? bonus : String(bonus?.name || bonus?.title || ""))
      .filter(Boolean)
      .slice(0, 2);
    return `${String(item.itemName || "Unknown")}${bonuses.length ? ` (${bonuses.join(", ")})` : ""}`;
  };

  function loadoutMarkup(view, memberId) {
    const loadout = memberLoadout(view, memberId);
    if (!loadout) return "";
    const slots = loadout.slots || {};
    const rows = [["Prim", slots["1"]], ["Sec", slots["2"]], ["Helm", slots["6"]], ["Chest", slots["4"]], ["Gloves", slots["8"]], ["Boots", slots["7"]], ["Pants", slots["9"]]]
      .filter(([, item]) => !!item)
      .map(([label, item]) => `<div class="wc-loadout-line"><span class="wc-loadout-label">${label}</span><span class="wc-loadout-value" style="color:${loadoutRarityColor(item.rarity)}" title="${escapeHtml(loadoutItemText(item))}">${escapeHtml(loadoutItemText(item))}</span></div>`)
      .join("");
    const open = state.loadoutOpenTargetId === Number(memberId || 0);
    return `<span class="wc-loadout${open ? " open" : ""}"><button type="button" class="wc-loadout-button" data-action="toggle-loadout" data-loadout-target="${Number(memberId || 0)}" aria-label="Known loadout" aria-expanded="${open ? "true" : "false"}" title="Known loadout">&#128737;</button><span class="wc-loadout-tip">${rows}</span></span>`;
  }

  function attackTargetMarkup(view) {
    if (!state.attackTargetId) return "";
    const memberId = state.attackTargetId;
    const member = view.enemyRoster.find((candidate) => Number(candidate?.member_id || 0) === memberId);
    const watched = savedTargetIds().includes(memberId);
    const atLimit = !watched && savedTargetIds().length >= MAX_WATCHED_TARGETS;
    const busy = state.targetQuickBusyId === memberId;
    const watchUnavailable = !isOnline() || state.authTerminal || state.targetQuickBusyId > 0 || state.targetsSaving || !currentEnemyRosterIsFresh();
    const name = String(member?.member_name || `Player ${memberId}`);
    const rawStatus = String(member?.status?.userStatus || member?.status?.state || member?.status?.status || "").trim();
    const location = String(member?.location?.current || member?.location?.name || member?.location || "").trim();
    const statusUntil = core.toTimestampMs(member?.status?.untill || member?.status?.until);
    const statusDetail = rawStatus && statusUntil > state.nowMs
      ? `${rawStatus} ${core.duration(statusUntil - state.nowMs)}`
      : rawStatus || (member ? "Status unknown" : "Waiting for roster data");
    const activeRetaliation = view.retaliation.find((attack) => Number(attack?.attackerId || 0) === memberId);
    const details = [
      statusDetail,
      member?.bsp ? `${core.formatBsp(member.bsp)} BSP` : "BSP unknown",
      location,
      activeRetaliation ? `Retal ${core.duration((Number(activeRetaliation.expiresAt || 0) * 1000) - state.nowMs)}` : "",
    ].filter(Boolean).join(" · ");
    const claim = member && core.dibsFeatureEnabled(state.settings)
      ? core.activeDibsClaim(view.dibs, memberId, state.nowMs)
      : undefined;
    const quickError = state.targetQuickError
      ? `<div class="wc-target-error" role="alert">${escapeHtml(state.targetQuickError)}</div>`
      : "";
    const outcome = state.attackOutcome?.targetMemberId === memberId ? state.attackOutcome : undefined;
    const outcomeMarkup = outcome
      ? `<div class="wc-attack-result"><span>${escapeHtml(outcome.label)}${outcome.dibsReleased ? " · Dibs released" : outcome.kind === "hospitalized" ? " · releasing Dibs" : " · Dibs kept"}</span><a class="wc-link" href="https://www.torn.com/factions.php?step=your&type=1#/war/rank">War</a></div>`
      : "";
    return `<div class="wc-attack-card"><div class="wc-attack-kicker">Current Torn target</div><div class="wc-attack-row"><div class="wc-attack-name" title="${escapeHtml(name)}">${escapeHtml(name)}</div><div class="wc-item-actions">${loadoutMarkup(view, memberId)}${member ? dibsMarkup(member, view, claim, `attack-${memberId}`) : ""}<button type="button" class="wc-button${watched ? " primary" : ""}" data-action="toggle-watch" data-target-member="${memberId}" data-focus-key="watch-${memberId}"${watchUnavailable || atLimit ? " disabled" : ""}>${busy ? "Saving..." : watched ? "Unwatch" : "Watch"}</button></div></div><div class="wc-attack-detail">${escapeHtml(details)}</div>${outcomeMarkup}${quickError}</div>`;
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
    if (!document.body) return;
    if (!state.active) {
      document.getElementById(PANEL_ID)?.remove();
      removeInlineMemberTools();
      removeIntegratedMount(false);
      return;
    }
    const view = sessionView();
    const mountState = resolvePanelMount(view);
    const mount = mountState.mount || document.body;
    let panel = document.getElementById(PANEL_ID);
    if (!panel) {
      panel = document.createElement("div");
      panel.id = PANEL_ID;
    }
    if (panel.parentNode !== mount) mount.appendChild(panel);
    state.panelPlacement = mountState.placement;
    state.integratedFallback = mountState.fallback;
    const rosterMode = mountState.placement === "inline" && isRosterModePage();
    panel.classList.toggle("wc-integrated-inline", mountState.placement === "inline");
    panel.classList.toggle("wc-integrated-toolbar", mountState.placement === "toolbar");
    panel.classList.toggle("wc-integrated-fallback", mountState.fallback);
    panel.classList.toggle("wc-roster-mode", rosterMode);
    panel.classList.toggle("wc-roster-open", rosterMode && state.rosterControlsOpen);
    if (mountState.placement !== "floating") clearPanelPositionStyles(panel);
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
    const optionsDisclosure = panel.querySelector('[data-section="options"]');
    if (optionsDisclosure) state.optionsOpen = optionsDisclosure.open;
    panel.classList.toggle("wc-collapsed", !rosterMode && state.collapsed);

    const status = statusView();
    const savedKey = getStoredKey();
    const mutationBusy = state.targetsSaving || state.targetQuickBusyId > 0 || state.dibsBusyTargetId > 0;
    const trackerDisabled = state.settings?.enabled === false;
    const hasCachedData = state.rosters.size > 0 || state.scores.size > 0;
    const visibleError = state.error && (!hasCachedData || state.authTerminal) ? state.error : "";
    const noWar = transportIsLive() && !trackerDisabled && !view.enemyFactionId;
    const queueSection = actionQueueMarkup(view, trackerDisabled, noWar);
    const retaliationSection = !state.focusMode && view.retaliation.length
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
    const chainEntries = [
      { side: "Us", faction: ownFactionLabel, chain: core.chainPresentation(view.alliedScore, state.nowMs) },
      { side: "Them", faction: enemyFactionLabel, chain: core.chainPresentation(view.enemyScore, state.nowMs) },
    ].filter((entry) => entry.chain.active);
    const chainMarkup = (className) => chainEntries.map(({ side, faction, chain }) => {
      const syncing = chain.endsAt && chain.tone === "wait" && chain.compact.endsWith("sync");
      const title = `${faction || side}: ${chain.label}${syncing ? ". Waiting for the next backend score sample." : ""}`;
      return `<span class="${className} ${escapeHtml(chain.tone)}" title="${escapeHtml(title)}"><span class="wc-chain-side">${side}</span>${escapeHtml(chain.compact)}</span>`;
    }).join("");
    const standardChainMarkup = chainMarkup("wc-chain");
    const rosterChainMarkup = chainMarkup("wc-roster-chain");
    const actionableMemberIds = new Set([
      ...(view.actions || []).map((action) => Number(action?.memberId || 0)),
      ...(view.retaliation || []).map((attack) => Number(attack?.attackerId || 0)),
    ].filter((memberId) => Number.isSafeInteger(memberId) && memberId > 0));
    const rosterFilterOptions = [
      ["all", "All"],
      ["watched", "Watched"],
      ["actionable", "Queue"],
      ["retaliations", "Retals"],
    ].map(([value, label]) => `<button type="button" class="wc-roster-filter${state.rosterFilter === value ? " active" : ""}" data-roster-filter="${value}" aria-pressed="${state.rosterFilter === value ? "true" : "false"}">${label}</button>`).join("");
    const rosterControls = rosterMode
      ? `<div class="wc-roster-controls"><div class="wc-roster-filters" role="group" aria-label="Filter enemy roster">${rosterFilterOptions}</div><label class="wc-roster-sort" title="Prioritize Retals, Dibs, watched targets, and useful availability states."><input type="checkbox" data-field="roster-priority-sort"${state.rosterPrioritySort ? " checked" : ""}>Warbuddy priority</label></div>`
      : "";

    const targetIds = state.targetsOpen || state.targetsDirty ? normalizeTargetIds(state.targetDraft) : savedTargetIds();
    const targetIdSet = new Set(targetIds);
    const allTargetOptions = watchedTargetOptions(view, targetIds);
    const targetOptions = filteredWatchedTargetOptions(view, targetIds);
    const targetOptionsMarkup = targetOptions.length
      ? `<div class="wc-target-list">${targetOptions.map((option) => {
          const checked = targetIdSet.has(option.memberId);
          const disabled = state.targetsSaving || (!checked && targetIds.length >= MAX_WATCHED_TARGETS);
          const label = option.current ? option.name : `${option.name} (not in current roster)`;
          const selectedGroup = targetGroupFor(option.memberId);
          const groupOptions = [["", "Normal"], ["priority", "Priority"], ["chain", "Chain"], ["later", "Later"]]
            .map(([value, text]) => `<option value="${value}"${selectedGroup === value ? " selected" : ""}>${text}</option>`).join("");
          return `<div class="wc-target-option-row"><label class="wc-target-option" title="${escapeHtml(label)}"><input type="checkbox" data-target-id="${option.memberId}" data-focus-key="target-${option.memberId}"${checked ? " checked" : ""}${disabled ? " disabled" : ""}><span>${escapeHtml(label)}</span></label><select class="wc-group-select" data-target-group="${option.memberId}" data-focus-key="target-group-${option.memberId}" aria-label="Target group for ${escapeHtml(label)}"${checked ? "" : " disabled"}>${groupOptions}</select>${option.member ? dibsMarkup(option.member, view, undefined, `picker-${option.memberId}`) : ""}</div>`;
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
    const notificationSupported = typeof GM_notification === "function";
    const notificationOptions = [
      ["landing", "Landing soon"],
      ["hospital", "Hospital release"],
      ["attackable", "Attackable now"],
      ["retaliation", "Retaliation"],
    ].map(([kind, label]) => `<label class="wc-option"><input type="checkbox" data-notification-kind="${kind}"${state.notificationSettings[kind] ? " checked" : ""}${notificationSupported ? "" : " disabled"}>${label}</label>`).join("");
    const displayModeOptions = [
      ["floating", "Floating"],
      ["integrated", "Roster (beta)"],
    ].map(([value, label]) => `<button type="button" class="wc-display-mode${state.displayMode === value ? " active" : ""}" data-display-mode="${value}" aria-pressed="${state.displayMode === value ? "true" : "false"}">${label}</button>`).join("");
    const optionsSection = savedKey
      ? `<details data-section="options"${state.optionsOpen ? " open" : ""}><summary>Options</summary><div class="wc-display-setting"><div class="wc-display-label">Display</div><div class="wc-display-modes" role="group" aria-label="Warbuddy display mode">${displayModeOptions}</div></div><div class="wc-options">${notificationOptions}</div>${notificationSupported ? "" : `<div class="wc-privacy">Desktop notifications are not available in this userscript host.</div>`}</details>`
      : "";

    const showKeyEditor = !savedKey || state.keyEditorOpen || state.authTerminal;
    const keyEditor = showKeyEditor
      ? `${state.keyEditorError ? `<div class="wc-error" role="alert">${escapeHtml(state.keyEditorError)}</div>` : ""}<div class="wc-row"><input class="wc-input wc-secret-input" data-field="api-key" data-focus-key="api-key" type="text" inputmode="text" autocomplete="one-time-code" autocapitalize="none" autocorrect="off" spellcheck="false" data-1p-ignore data-lpignore="true" data-bwignore="true" data-protonpass-ignore="true" data-form-type="other" aria-label="Torn API key" placeholder="${savedKey ? "Replacement Torn API key" : "Torn API key"}" value="${escapeHtml(state.keyDraft)}"${state.keySaving ? " disabled" : ""}><button class="wc-button primary" data-action="connect"${state.keySaving || mutationBusy ? " disabled" : ""}>${state.keySaving ? "Checking..." : savedKey ? "Replace" : "Connect"}</button>${savedKey && !state.authTerminal ? `<button class="wc-button" data-action="cancel-key"${state.keySaving ? " disabled" : ""}>Cancel</button>` : ""}</div>`
      : "";

    const panelBody = `${rosterControls}
      ${state.integratedFallback ? `<div class="wc-integrated-notice" role="status">Roster mode is unavailable here. Using Floating.</div>` : ""}
      ${visibleError ? `<div class="wc-error" role="alert">${escapeHtml(visibleError)}</div>` : ""}
      ${state.dibsError ? `<div class="wc-error" role="alert">${escapeHtml(state.dibsError)}</div>` : ""}
      ${hasCachedData && (!transportIsLive() || dataIsStale() || (state.settings?.enabled !== false && currentEnemyFactionId() && !currentEnemyRosterIsFresh())) ? `<div class="wc-stale" role="status">Showing cached data from ${escapeHtml(core.duration(liveDataAgeMs()))} ago. Live-only suggestions and changes are paused.</div>` : ""}
      ${keyEditor}
      ${savedKey ? liveSections : ""}
      ${watchedTargetsSection}
      ${optionsSection}
      <details data-section="privacy"${state.privacyOpen ? " open" : ""}><summary>Privacy</summary><div class="wc-privacy">The key stays in your userscript storage. Torn and the backend use it to verify your profile and faction. Warbuddy records your version, connection mode, and last use for faction admins. Its scoped session can save only your watched-target list and Dibs actions.</div>${savedKey ? `<div class="wc-private-actions"><button class="wc-button" data-action="refresh"${mutationBusy || state.keySaving ? " disabled" : ""}>Reconnect</button><button class="wc-button" data-action="change-key"${mutationBusy || state.keySaving ? " disabled" : ""}>Change key</button><button class="wc-button" data-action="forget"${mutationBusy || state.keySaving ? " disabled" : ""}>${state.forgetConfirm ? "Confirm forget" : "Forget key"}</button></div>` : ""}</details>
    `;
    const standardHeader = `<div class="wc-header">
      <div class="wc-heading"><div class="wc-title-row"><span class="wc-player">${escapeHtml(state.session?.playerName || "Warbuddy")}</span><span class="wc-version">v${SCRIPT_VERSION}</span><span class="wc-header-status"><span class="wc-dot ${status.tone}"></span>${escapeHtml(status.label)}</span></div>${matchupLabel || standardChainMarkup ? `<div class="wc-context">${matchupLabel ? `<span class="wc-matchup" title="${escapeHtml(matchupTitle)}">${escapeHtml(matchupLabel)}</span>` : ""}${standardChainMarkup ? `<span class="wc-chains">${standardChainMarkup}</span>` : ""}</div>` : ""}</div>
      <button class="wc-button wc-icon" data-action="collapse" aria-expanded="${state.collapsed ? "false" : "true"}" aria-label="${state.collapsed ? "Expand and resume Warbuddy" : "Collapse and pause Warbuddy"}" title="${state.collapsed ? "Expand and resume" : "Collapse and pause"}">${state.collapsed ? "+" : "-"}</button>
    </div>`;
    const rosterHeader = `<div class="wc-roster-summary"><button type="button" class="wc-roster-summary-button" data-action="toggle-roster-controls" aria-expanded="${state.rosterControlsOpen ? "true" : "false"}"><span class="wc-roster-chevron">${state.rosterControlsOpen ? "&#9660;" : "&#9654;"}</span><span class="wc-roster-name">Warbuddy</span><span class="wc-roster-beta">Beta</span>${matchupLabel ? `<span class="wc-roster-matchup" title="${escapeHtml(matchupTitle)}">${escapeHtml(matchupLabel)}</span>` : ""}</button><span class="wc-roster-status"><span class="wc-dot ${status.tone}"></span>${escapeHtml(status.label)}</span><span class="wc-roster-counts">${rosterChainMarkup ? `<span class="wc-roster-chains">${rosterChainMarkup}</span>` : ""}<span class="wc-roster-watched">Watched ${savedTargetIds().length}</span><span>Queue ${actionableMemberIds.size}</span><span>Retals ${view.retaliation.length}</span></span></div>`;
    panel.innerHTML = `${rosterMode ? rosterHeader : standardHeader}<div class="wc-body">${panelBody}</div>`;

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
    panel.querySelector('[data-section="options"]')?.addEventListener("toggle", (event) => {
      state.optionsOpen = event.currentTarget.open;
    });
    applyStoredPanelPosition();
    attachPanelDragHandler(panel);

    panel.querySelector('[data-action="toggle-roster-controls"]')?.addEventListener("click", () => {
      state.rosterControlsOpen = !state.rosterControlsOpen;
      storage.set(ROSTER_CONTROLS_STORAGE, state.rosterControlsOpen ? "1" : "0");
      scheduleRender();
    });
    panel.querySelectorAll("[data-roster-filter]").forEach((button) => {
      button.addEventListener("click", (event) => {
        state.rosterFilter = core.normalizeRosterFilter(event.currentTarget?.dataset?.rosterFilter);
        storage.set(ROSTER_FILTER_STORAGE, state.rosterFilter);
        syncIntegratedMemberTools(view);
        scheduleRender();
      });
    });
    panel.querySelector('[data-field="roster-priority-sort"]')?.addEventListener("change", (event) => {
      state.rosterPrioritySort = event.currentTarget.checked === true;
      storage.set(ROSTER_SORT_STORAGE, state.rosterPrioritySort ? "1" : "0");
      syncIntegratedMemberTools(view);
      scheduleRender();
    });
    panel.querySelector('[data-action="collapse"]')?.addEventListener("click", () => {
      state.collapsed = !state.collapsed;
      storage.set(COLLAPSED_STORAGE, state.collapsed ? "1" : "0");
      syncForegroundState();
      scheduleRender();
    });
    panel.querySelector('[data-action="toggle-focus"]')?.addEventListener("click", () => {
      state.focusMode = !state.focusMode;
      storage.set(FOCUS_STORAGE, state.focusMode ? "1" : "0");
      state.moreActionsOpen = false;
      scheduleRender();
    });
    panel.querySelectorAll('[data-action="toggle-loadout"]').forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const memberId = Number(event.currentTarget?.dataset?.loadoutTarget || 0);
        state.loadoutOpenTargetId = state.loadoutOpenTargetId === memberId ? 0 : memberId;
        scheduleRender();
      });
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
        if (event.currentTarget.checked && next.size < MAX_WATCHED_TARGETS) {
          next.add(memberId);
          if (!targetGroupFor(memberId)) setTargetGroup(memberId, "priority");
        }
        if (!event.currentTarget.checked) {
          next.delete(memberId);
          setTargetGroup(memberId, "");
        }
        state.targetDraft = normalizeTargetIds(Array.from(next));
        state.targetsDirty = !sameTargetIds(state.targetDraft, savedTargetIds());
        state.targetError = "";
        scheduleRender();
      });
    });
    panel.querySelectorAll('[data-target-group]').forEach((select) => {
      select.addEventListener("change", (event) => {
        setTargetGroup(event.currentTarget?.dataset?.targetGroup, event.currentTarget?.value || "");
        scheduleRender();
      });
    });
    panel.querySelectorAll('[data-notification-kind]').forEach((input) => {
      input.addEventListener("change", (event) => {
        const kind = String(event.currentTarget?.dataset?.notificationKind || "");
        if (!notificationKinds.includes(kind)) return;
        state.notificationSettings[kind] = event.currentTarget.checked === true;
        persistNotificationSettings();
      });
    });
    panel.querySelectorAll('[data-display-mode]').forEach((button) => {
      button.addEventListener("click", (event) => setDisplayMode(event.currentTarget?.dataset?.displayMode));
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
    syncIntegratedMemberTools(view);
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
      state.loadoutOpenTargetId = 0;
      state.attackOutcome = null;
      stopAttackOutcomeDetection();
      state.attackOutcomeReleaseKey = "";
      closeDibsDetails();
    }
    if (!active) {
      if (state.active || document.getElementById(PANEL_ID)) {
        stopTicker();
        closeSocket();
        state.phase = getStoredKey() ? "paused" : "idle";
        document.getElementById(PANEL_ID)?.remove();
        removeInlineMemberTools();
        removeIntegratedMount(false);
      }
      state.active = false;
      return;
    }
    const becameActive = !state.active;
    state.active = true;
    if (becameActive || !document.getElementById(PANEL_ID)) render();
    else if (attackTargetChanged) scheduleRender();
    else syncIntegratedMemberTools(sessionView());
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

  registerMenuCommand("Warbuddy: use floating mode", () => setDisplayMode("floating"));
  registerMenuCommand("Warbuddy: use roster beta", () => setDisplayMode("integrated"));

  registerMenuCommand("Warbuddy: diagnostics", () => {
    const routeMatches = core.isWarbuddyPageUrl(window.location.href);
    const panel = document.getElementById(PANEL_ID);
    window.alert([
      `Warbuddy v${SCRIPT_VERSION}`,
      `Route matched: ${routeMatches ? "yes" : "no"}`,
      `Document body: ${document.body ? "ready" : "missing"}`,
      `Panel mounted: ${panel ? "yes" : "no"}`,
      `Panel visible: ${panel ? getComputedStyle(panel).display !== "none" && getComputedStyle(panel).visibility !== "hidden" : "n/a"}`,
      `Display mode: ${state.displayMode}`,
      `Effective placement: ${state.panelPlacement}${state.integratedFallback ? " (fallback)" : ""}`,
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
    const target = event.target;
    const closest = target && typeof target.closest === "function" ? target.closest.bind(target) : null;
    if (state.loadoutOpenTargetId && !closest?.(`#${PANEL_ID} .wc-loadout`)) {
      state.loadoutOpenTargetId = 0;
      scheduleRender();
    }
    if (state.dibsInspectTargetId && !closest?.(`#${PANEL_ID} .wc-dibs-wrap`)) {
      closeDibsDetails();
      scheduleRender();
    }
    if (!state.attackTargetId || closest?.(`#${PANEL_ID}`)) return;
    const action = closest?.('button, a, [role="button"], input[type="button"], input[type="submit"]');
    const label = String(action?.innerText || action?.textContent || action?.value || action?.getAttribute?.("aria-label") || "")
      .replace(/\s+/g, " ")
      .trim();
    if (/\b(?:attack|start fight|continue|mug|hospitali[sz]e|leave)\b/i.test(label)) armAttackOutcomeDetection();
  }, true);
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || (!state.dibsInspectTargetId && !state.loadoutOpenTargetId)) return;
    closeDibsDetails();
    state.loadoutOpenTargetId = 0;
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
    stopAttackOutcomeDetection();
    removeInlineMemberTools();
  });

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
