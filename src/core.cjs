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
