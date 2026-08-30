// ==UserScript==
// @name         Warbuddy
// @namespace    https://grusmedia.no/warbuddy
// @version      0.1.67
// @description  Shows a war action queue, shared target Dibs, watched targets, and live retaliation opportunities inside Torn.
// @author       SneipLadd [2813921]
// @homepageURL  https://github.com/Grussniffer/Warbuddy
// @supportURL   https://github.com/Grussniffer/Warbuddy/issues
// @downloadURL  https://raw.githubusercontent.com/Grussniffer/Warbuddy/main/warbuddy.user.js
// @updateURL    https://raw.githubusercontent.com/Grussniffer/Warbuddy/main/warbuddy.meta.js
// @match        https://www.torn.com/factions.php*
// @match        https://torn.com/factions.php*
// @match        https://www.torn.com/profiles.php*
// @match        https://torn.com/profiles.php*
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

  const trustedClockOffset = (value, deviceNowMs = Date.now(), maxSkewMs = 24 * 60 * 60 * 1000) => {
    const serverNowMs = toTimestampMs(value);
    const deviceNow = Number(deviceNowMs);
    const maximumSkew = Math.max(0, Number(maxSkewMs) || 0);
    if (!serverNowMs || !Number.isFinite(deviceNow)) return undefined;
    const offset = serverNowMs - deviceNow;
    return Math.abs(offset) <= maximumSkew ? offset : undefined;
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
    String(value || "").trim().toLowerCase() === "floating" ? "floating" : "native";

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
    if (!/^\/(?:page|loader)\.php$/i.test(url.pathname) || String(url.searchParams.get("sid") || "").toLowerCase() !== "attack") {
      return 0;
    }
    const memberId = Number(url.searchParams.get("user2ID") || url.searchParams.get("user2id") || 0);
    return Number.isSafeInteger(memberId) && memberId > 0 ? memberId : 0;
  };

  const profilePageTargetId = (value) => {
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

  const isWarbuddyPageUrl = (value) => {
    if (isFactionPageUrl(value)) return true;
    if (profilePageTargetId(value)) return true;
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

  const isOwnRankedWarPageUrl = (value, ownFactionId = 0) => {
    if (!isRankedWarPageUrl(value)) return false;
    let url;
    try {
      url = new URL(String(value || ""), "https://www.torn.com/");
    } catch {
      return false;
    }
    const step = String(url.searchParams.get("step") || "").trim().toLowerCase();
    if (step === "your") return true;
    if (step !== "profile") return false;
    const pageFactionId = Number(url.searchParams.get("ID") || url.searchParams.get("id") || 0);
    const authenticatedFactionId = Number(ownFactionId || 0);
    return Number.isSafeInteger(pageFactionId)
      && pageFactionId > 0
      && Number.isSafeInteger(authenticatedFactionId)
      && authenticatedFactionId > 0
      && pageFactionId === authenticatedFactionId;
  };

  const rankedWarPageFactionId = (value) => {
    if (!isRankedWarPageUrl(value)) return 0;
    let url;
    try {
      url = new URL(String(value || ""), "https://www.torn.com/");
    } catch {
      return 0;
    }
    if (String(url.searchParams.get("step") || "").trim().toLowerCase() !== "profile") return 0;
    const factionId = Number(url.searchParams.get("ID") || url.searchParams.get("id") || 0);
    return Number.isSafeInteger(factionId) && factionId > 0 ? factionId : 0;
  };

  const profileMemberIdFromUrl = profilePageTargetId;

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

  const availabilityCategory = (availability) => {
    const state = String(availability?.state || "").toLowerCase();
    if (/hospital|jail/.test(state)) return "hospital";
    if (["incoming", "outgoing", "traveling", "abroad"].includes(state)) return "traveling";
    if (["available", "okay"].includes(state)) return "available";
    return "";
  };

  const rosterPriorityAllowedForSort = (column) => {
    const normalized = String(column || "").trim().toLowerCase();
    return !normalized || normalized === "status";
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

  const normalizedDibsLocationLabel = (value) =>
    String(value || "").normalize("NFKC").trim().replace(/\s+/g, " ");

  const normalizedDibsCountry = (value) =>
    normalizedDibsLocationLabel(value).toLocaleLowerCase("en-US");

  const dibsSettledLocation = (member) => {
    const statusValue = member?.status && typeof member.status === "object" ? member.status : undefined;
    const status = String(
      statusValue?.userStatus
      || statusValue?.user_status
      || statusValue?.state
      || ""
    ).trim().toLowerCase();
    if (!status) return { state: "unknown", cause: "status" };

    const location = member?.location && typeof member.location === "object" ? member.location : undefined;
    const destination = normalizedDibsCountry(location?.destination);
    if (status.includes("travel") || status.includes("return") || destination) {
      return { state: "traveling" };
    }

    const country = normalizedDibsLocationLabel(location?.current);
    const normalizedCountry = normalizedDibsCountry(country);
    if (!country || !normalizedCountry || ["unknown", "none", "n/a", "-"].includes(normalizedCountry)) {
      return { state: "unknown", cause: "location" };
    }
    if (status.includes("abroad") && normalizedCountry === "torn") {
      return { state: "unknown", cause: "location" };
    }
    return { state: "settled", country, normalizedCountry, status };
  };

  const dibsEligibility = (member, nowMs = Date.now()) => {
    const targetLocation = dibsSettledLocation(member);
    if (targetLocation.state === "traveling") {
      return { eligible: false, state: "target_traveling", reason: "Target is traveling." };
    }
    if (targetLocation.state === "unknown") {
      return targetLocation.cause === "status"
        ? { eligible: false, state: "target_status_unknown", reason: "Target status is unknown." }
        : { eligible: false, state: "target_location_unknown", reason: "Target location is unknown." };
    }
    if (targetLocation.status.includes("hospital")) {
      const hospitalUntil = toTimestampMs(member?.status?.untill ?? member?.status?.until);
      const remainingMs = hospitalUntil - nowMs;
      if (hospitalUntil > nowMs && remainingMs <= DIBS_HOSPITAL_WINDOW_MS) {
        return {
          eligible: true,
          state: "hospitalized",
          reason: `Target leaves hospital in ${duration(remainingMs)}.`,
          hospitalUntil,
          targetLocation: targetLocation.country,
        };
      }
      return {
        eligible: false,
        state: hospitalUntil > nowMs ? "hospital_too_early" : "target_unavailable",
        reason: hospitalUntil > nowMs
          ? `Dibs opens five minutes before hospital release (${duration(remainingMs)} remaining).`
          : "Target hospital status is no longer current.",
        hospitalUntil,
        targetLocation: targetLocation.country,
      };
    }
    const isOkay = targetLocation.status === "okay"
      || targetLocation.status.startsWith("okay ")
      || targetLocation.status.startsWith("okay -");
    const isAbroad = targetLocation.status === "abroad" || targetLocation.status.startsWith("abroad ");
    if (isOkay || isAbroad) {
      return {
        eligible: true,
        state: "available",
        reason: `Target is settled in ${targetLocation.country}.`,
        targetLocation: targetLocation.country,
      };
    }
    return {
      eligible: false,
      state: "target_unavailable",
      reason: "Target is not currently attackable.",
      targetLocation: targetLocation.country,
    };
  };

  const dibsClaimEligibility = ({
    claimant,
    target,
    claimantName = "You",
    claimantRosterFresh = false,
    targetRosterFresh = false,
  } = {}, nowMs = Date.now()) => {
    if (!claimantRosterFresh || !targetRosterFresh) {
      const state = !claimantRosterFresh && !targetRosterFresh
        ? "rosters_stale"
        : !claimantRosterFresh ? "claimant_roster_stale" : "target_roster_stale";
      const reason = state === "rosters_stale"
        ? "Waiting for fresh faction location data."
        : state === "claimant_roster_stale"
          ? "Waiting for your faction location data."
          : "Waiting for fresh enemy location data.";
      return { eligible: false, state, reason };
    }

    const name = normalizedDibsLocationLabel(claimantName) || "You";
    const isViewer = name.toLocaleLowerCase("en-US") === "you";
    const subject = isViewer ? "You are" : `${name} is`;
    const possessive = isViewer ? "Your" : `${name}'s`;
    const claimantLocation = dibsSettledLocation(claimant);
    if (claimantLocation.state === "traveling") {
      return { eligible: false, state: "claimant_traveling", reason: `${subject} traveling.` };
    }
    if (claimantLocation.state === "unknown") {
      return claimantLocation.cause === "status"
        ? { eligible: false, state: "claimant_status_unknown", reason: `${possessive} status is unknown.` }
        : { eligible: false, state: "claimant_location_unknown", reason: `${possessive} location is unknown.` };
    }

    const targetLocation = dibsSettledLocation(target);
    if (targetLocation.state === "traveling") {
      return {
        eligible: false,
        state: "target_traveling",
        reason: "Target is traveling.",
        claimantLocation: claimantLocation.country,
      };
    }
    if (targetLocation.state === "unknown") {
      return targetLocation.cause === "status"
        ? {
          eligible: false,
          state: "target_status_unknown",
          reason: "Target status is unknown.",
          claimantLocation: claimantLocation.country,
        }
        : {
          eligible: false,
          state: "target_location_unknown",
          reason: "Target location is unknown.",
          claimantLocation: claimantLocation.country,
        };
    }
    if (claimantLocation.normalizedCountry !== targetLocation.normalizedCountry) {
      return {
        eligible: false,
        state: "location_mismatch",
        reason: `Locations differ: ${subject} in ${claimantLocation.country}; target is in ${targetLocation.country}.`,
        claimantLocation: claimantLocation.country,
        targetLocation: targetLocation.country,
      };
    }

    const targetReadiness = dibsEligibility(target, nowMs);
    if (!targetReadiness.eligible) {
      return {
        ...targetReadiness,
        claimantLocation: claimantLocation.country,
        targetLocation: targetLocation.country,
      };
    }
    return {
      ...targetReadiness,
      reason: `Same location: ${targetLocation.country}.`,
      claimantLocation: claimantLocation.country,
      targetLocation: targetLocation.country,
    };
  };

  const activeDibsClaim = (payload, targetMemberId, nowMs = Date.now()) =>
    (Array.isArray(payload?.claims) ? payload.claims : []).find((claim) => (
      Number(claim?.targetMemberId || 0) === Number(targetMemberId || 0)
      && toTimestampMs(claim?.expiresAt) > nowMs
    ));

  const stableDibsValue = (value) => {
    if (Array.isArray(value)) return value.map(stableDibsValue);
    if (!value || typeof value !== "object") return value;
    return Object.keys(value).sort().reduce((normalized, key) => {
      normalized[key] = stableDibsValue(value[key]);
      return normalized;
    }, {});
  };

  const sameDibsSnapshot = (left, right) => {
    try {
      return JSON.stringify(stableDibsValue(left)) === JSON.stringify(stableDibsValue(right));
    } catch {
      return left === right;
    }
  };

  const reconcileDibsSnapshot = (current, payload, options = {}) => {
    const existing = current && typeof current === "object" ? current : { claims: [] };
    const next = payload && typeof payload === "object" ? payload : { claims: [] };
    const applicationSequence = Number.isSafeInteger(Number(options.applicationSequence))
      && Number(options.applicationSequence) >= 0
      ? Number(options.applicationSequence)
      : 0;
    if (sameDibsSnapshot(existing, next)) {
      return { snapshot: existing, applicationSequence, applied: false };
    }
    const currentGeneratedAt = Date.parse(String(existing?.generatedAt || ""));
    const nextGeneratedAt = Date.parse(String(next?.generatedAt || ""));
    if (Number.isFinite(currentGeneratedAt)) {
      if (!Number.isFinite(nextGeneratedAt) || nextGeneratedAt < currentGeneratedAt) {
        return { snapshot: existing, applicationSequence, applied: false };
      }
      if (nextGeneratedAt === currentGeneratedAt) {
        const source = String(options.source || "");
        const orderedLiveEvent = source === "websocket" || source === "shared-live-event";
        const mutationStillCurrent = source === "mutation-response"
          && Number(options.baselineSequence) === applicationSequence;
        if (!orderedLiveEvent && !mutationStillCurrent) {
          return { snapshot: existing, applicationSequence, applied: false };
        }
      }
    }
    return {
      snapshot: next,
      applicationSequence: applicationSequence + 1,
      applied: true,
    };
  };

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
    availabilityCategory,
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
    dibsClaimEligibility,
    dibsEligibility,
    dibsFeatureEnabled,
    duration,
    fallbackPollDelayMs,
    formatBsp,
    inferEnemyFactionId,
    isFactionPageUrl,
    isOwnRankedWarPageUrl,
    isRankedWarPageUrl,
    rankedWarPageFactionId,
    isWarbuddyPageUrl,
    locationCode,
    memberAvailability,
    reconcileDibsSnapshot,
    normalizeDisplayMode,
    normalizeRosterFilter,
    normalizeTargetGroups,
    notificationCandidates,
    profilePageTargetId,
    profileMemberIdFromUrl,
    rosterFilterMatches,
    rosterOrder,
    rosterPriority,
    rosterPriorityAllowedForSort,
    scoreForFaction,
    toTimestampMs,
    trustedClockOffset,
  };
});

(function initializeWarbuddyTabBroker(globalScope, factory) {
  const api = factory();
  if (typeof module === "object" && module?.exports) module.exports = api;
  if (globalScope && typeof globalScope === "object") globalScope.WarbuddyTabBroker = api;
})(typeof globalThis === "object" ? globalThis : this, function createWarbuddyTabBrokerApi() {
  "use strict";

  const PROTOCOL = "warbuddy-tab-broker-v2";
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
    let leaderTerm = "";
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
    const setLeader = (nextLeader, seenAt = now(), nextLeaderTerm = "") => {
      const normalized = normalizeId(nextLeader);
      const normalizedTerm = normalized ? normalizeId(nextLeaderTerm) : "";
      const changed = normalized !== leader || normalizedTerm !== leaderTerm;
      if (changed) {
        for (const [requestId, pending] of pendingRequests) {
          if (pending.leaderId === normalized && pending.leaderTerm === normalizedTerm) continue;
          pendingRequests.delete(requestId);
          clearTimeoutFn(pending.timer);
          pending.reject(new Error("Shared live connection changed"));
        }
      }
      leader = normalized;
      leaderTerm = normalizedTerm;
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
    const announceLeader = () => {
      if (role !== "leader" || leader !== tabId || !leaderTerm) return false;
      leaderSeenAt = now();
      return post({ kind: "leader", leaderTerm });
    };
    const resign = () => {
      if (role === "leader") post({ kind: "resign", leaderTerm });
      setRole("follower");
      if (leader === tabId) setLeader("");
      idleUntil = 0;
    };
    const becomeLeader = () => {
      if (closed || !scope || !currentDemand()) return;
      setLeader(tabId, now(), randomId());
      setRole("leader");
      idleUntil = 0;
      announceLeader();
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
      const requestLeaderTerm = normalizeId(message.leaderTerm);
      if (
        !requestId || !message.requestType || !requestLeaderTerm
        || requestLeaderTerm !== leaderTerm || containsSecretField(message.payload)
      ) return;
      const canRespond = () => role === "leader" && leader === tabId && leaderTerm === requestLeaderTerm;
      Promise.resolve()
        .then(() => onRequest(String(message.requestType), message.payload, normalizeId(message.from)))
        .then((payload) => {
          if (!canRespond()) return;
          if (post({
            kind: "response",
            to: message.from,
            requestId,
            leaderTerm: requestLeaderTerm,
            success: true,
            payload,
          })) return;
          post({
            kind: "response",
            to: message.from,
            requestId,
            leaderTerm: requestLeaderTerm,
            success: false,
            error: "Shared response could not be sent safely",
          });
        })
        .catch((error) => {
          if (!canRespond()) return;
          post({
            kind: "response",
            to: message.from,
            requestId,
            leaderTerm: requestLeaderTerm,
            success: false,
            error: String(error?.message || "Shared request failed"),
          });
        });
    };
    const handleResponse = (message) => {
      if (normalizeId(message.to) !== tabId) return;
      const requestId = normalizeId(message.requestId);
      const pending = pendingRequests.get(requestId);
      if (!pending) return;
      if (normalizeId(message.from) !== pending.leaderId) return;
      const responseLeaderTerm = normalizeId(message.leaderTerm);
      const leaseIsFresh = pending.leaderId === leader
        && pending.leaderTerm === leaderTerm
        && now() - leaderSeenAt <= leaderTimeoutMs;
      if (!responseLeaderTerm || responseLeaderTerm !== pending.leaderTerm || !leaseIsFresh) {
        pendingRequests.delete(requestId);
        clearTimeoutFn(pending.timer);
        pending.reject(new Error("Shared live connection changed"));
        return;
      }
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
        if (leader === sender && normalizeId(message.leaderTerm) !== leaderTerm) return;
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
        announceLeader();
        return;
      }
      if (message.kind === "leader") {
        const announcedLeaderTerm = normalizeId(message.leaderTerm);
        if (!announcedLeaderTerm) return;
        const leaderIsFresh = leader && now() - leaderSeenAt <= leaderTimeoutMs;
        if (role === "leader" && sender !== tabId) {
          if (sender < tabId) {
            post({ kind: "resign", leaderTerm });
            setRole("follower");
            setLeader(sender, seenAt, announcedLeaderTerm);
          } else announceLeader();
          return;
        }
        if (!leaderIsFresh || leader === sender || (leader && sender < leader)) {
          setLeader(sender, seenAt, announcedLeaderTerm);
        }
        return;
      }
      if (message.kind === "probe") {
        if (role === "leader" && normalizeId(message.to) === tabId) announceLeader();
        return;
      }
      if (message.kind === "resign") {
        if (leader === sender && normalizeId(message.leaderTerm) === leaderTerm) {
          setLeader("");
          scheduleElection(0);
        }
        return;
      }
      if (message.kind === "request") return handleRequest(message);
      if (message.kind === "response") return handleResponse(message);
      if (
        message.kind === "data" && sender === leader
        && normalizeId(message.leaderTerm) === leaderTerm
      ) {
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
        announceLeader();
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
        if (role === "leader") {
          post({ kind: "resign", leaderTerm });
          post({ kind: "bye", leaderTerm });
        } else post({ kind: "bye" });
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
      if (!leader || !leaderTerm || now() - leaderSeenAt > leaderTimeoutMs) {
        return Promise.reject(new Error("Shared live connection is unavailable"));
      }
      const requestLeader = leader;
      const requestLeaderTerm = leaderTerm;
      const requestId = `${tabId}-${++requestSequence}-${now()}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeoutFn(() => {
          pendingRequests.delete(requestId);
          reject(new Error(`${String(requestType || "Request")} timed out`));
        }, Math.max(10, Number(timeout || requestTimeoutMs)));
        pendingRequests.set(requestId, {
          resolve,
          reject,
          timer,
          leaderId: requestLeader,
          leaderTerm: requestLeaderTerm,
        });
        if (!post({
          kind: "request",
          to: requestLeader,
          requestId,
          requestType: String(requestType || ""),
          leaderTerm: requestLeaderTerm,
          payload,
        })) {
          pendingRequests.delete(requestId);
          clearTimeoutFn(timer);
          reject(new Error("Shared request could not be sent"));
        }
      });
    };
    const close = () => {
      if (closed) return;
      if (role === "leader") {
        post({ kind: "resign", leaderTerm });
        post({ kind: "bye", leaderTerm });
      } else post({ kind: "bye" });
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
        return post({ kind: "data", dataType: String(dataType || ""), leaderTerm, payload });
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

(function runWarbuddy() {
  "use strict";

  const core = globalThis.WarbuddyCore;
  if (!core) return;

  const BACKEND_BASE_URL = "https://backend.grusmedia.no";
  const SCRIPT_VERSION = "0.1.67";
  const PANEL_ID = "warbuddy-panel";
  const KEY_STORAGE = "warbuddy_api_key";
  const DISPLAY_MODE_STORAGE = "warbuddy_display_mode";
  const FOCUS_STORAGE = "warbuddy_focus_mode";
  const NOTIFICATION_STORAGE = "warbuddy_notifications";
  const TARGET_GROUP_STORAGE = "warbuddy_target_groups";
  const ROSTER_CONTROLS_STORAGE = "warbuddy_roster_controls_open";
  const ROSTER_FILTER_STORAGE = "warbuddy_roster_filter";
  const ROSTER_SORT_STORAGE = "warbuddy_roster_priority_sort";
  const ROSTER_DIBS_STORAGE = "warbuddy_roster_dibs_buttons";
  const BROKER_NONCE_STORAGE = "warbuddy_connection_channel_nonce";
  const INTEGRATED_HOST_ID = "warbuddy-integrated-host";
  const INTEGRATED_WRAPPER_ID = "warbuddy-integrated-wrapper";
  const INLINE_TOOLS_CLASS = "warbuddy-inline-tools";
  const ROSTER_ACTIONS_CLASS = "warbuddy-roster-actions";
  const TARGET_CONTEXT_ID = "warbuddy-target-context";
  const ROSTER_CONTEXT_ID = "warbuddy-roster-context";
  const SAFE_INTEGRATED_PARENT_DISPLAYS = new Set(["block", "flow-root", "list-item"]);
  const STATUS_CELL_CLASS = "warbuddy-status-cell";
  const STATUS_DETAIL_CLASS = "warbuddy-status-detail";
  const STATUS_MISMATCH_CLASS = "warbuddy-status-mismatch";
  const LEGACY_STORAGE_KEYS = {
    [KEY_STORAGE]: "lads_war_companion_api_key",
  };
  const REQUEST_TIMEOUT_MS = 30_000;
  const SOCKET_CONNECT_TIMEOUT_MS = 15_000;
  const FALLBACK_POLL_MS = 2_000;
  const FALLBACK_POLL_MAX_MS = 10_000;
  const FALLBACK_SOCKET_RETRY_MS = 60_000;
  const TICKER_INTERVAL_MS = 2_000;
  const IDLE_RENDER_INTERVAL_MS = 10_000;
  const ROUTE_HEARTBEAT_MS = 2_000;
  const DATA_STALE_MS = 45_000;
  const CLOCK_BACKWARD_TOLERANCE_MS = 250;
  const BROKER_NONCE_RECHECK_MS = 2_000;
  const SCRIPT_CHECK_IN_INTERVAL_MS = 10 * 60 * 1000;
  const SCRIPT_CHECK_IN_RETRY_MS = 60_000;
  const isTornPda = typeof window.PDA_httpGet === "function" || typeof window.PDA_httpPost === "function";
  const MAX_WATCHED_TARGETS = 25;
  const TOPICS = ["war_tracker_settings", "war_tracker", "score", "retaliation", "war_dibs"];
  const inlineMarkupCache = new WeakMap();
  const panelMarkupCache = new WeakMap();
  const targetMarkupCache = new WeakMap();

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

  const createBrokerNonce = () => {
    try {
      const bytes = new Uint32Array(4);
      globalThis.crypto?.getRandomValues?.(bytes);
      if (bytes.some((value) => value !== 0)) {
        return Array.from(bytes, (value) => value.toString(16).padStart(8, "0")).join("");
      }
    } catch {
      // Fall through to userscript-local entropy in older browser sandboxes.
    }
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
  };
  const validBrokerNonce = (value) => /^[a-z0-9_-]{24,128}$/i.test(String(value || ""));
  const storedBrokerNonce = () => {
    const existing = String(storage.get(BROKER_NONCE_STORAGE, "") || "");
    if (validBrokerNonce(existing)) return existing;
    const created = createBrokerNonce();
    storage.set(BROKER_NONCE_STORAGE, created);
    const persisted = String(storage.get(BROKER_NONCE_STORAGE, created) || created);
    return validBrokerNonce(persisted) ? persisted : created;
  };

  const state = {
    phase: "idle",
    error: "",
    session: null,
    token: "",
    socket: null,
    socketRequests: new Map(),
    socketRequestSequence: 0,
    sharedStateRequestSequence: 0,
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
    lastPageHref: "",
    lastRenderAt: 0,
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
    dibsApplicationSequence: 0,
    dibsBusyTargetId: 0,
    dibsBusyAction: "",
    dibsInspectTargetId: 0,
    dibsInspectKey: "",
    dibsError: "",
    dibsErrorTargetId: 0,
    dibsErrorTimer: 0,
    nowMs: Date.now(),
    clockOffsetMs: 0,
    clockSource: "device",
    clockReady: false,
    clockAnchorServerMs: 0,
    clockAnchorMonotonicMs: Number.NaN,
    displayMode: core.normalizeDisplayMode(storage.get(DISPLAY_MODE_STORAGE, "")),
    rosterControlsOpen: String(storage.get(ROSTER_CONTROLS_STORAGE, "")) === "1",
    rosterFilter: core.normalizeRosterFilter(storage.get(ROSTER_FILTER_STORAGE, "")),
    rosterPrioritySort: String(storage.get(ROSTER_SORT_STORAGE, "")) === "1",
    rosterDibsButtons: String(storage.get(ROSTER_DIBS_STORAGE, "1")) !== "0",
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
    profileTargetId: 0,
    attackOutcome: null,
    attackOutcomeArmedAt: 0,
    attackOutcomeReleaseKey: "",
    attackOutcomeScanTimer: 0,
    attackOutcomeObserver: null,
    integratedDecorationsActive: false,
    moreActionsOpen: false,
    focusMode: String(storage.get(FOCUS_STORAGE, "")) === "1",
    optionsOpen: false,
    notificationSettings: { landing: false, hospital: false, attackable: false, retaliation: false },
    notificationKeys: new Set(),
    notificationsPrimed: false,
    active: false,
    renderQueued: false,
    renderFrame: 0,
    overlayFrame: 0,
    lastSocketErrorAt: "",
    lastSocketClose: null,
    sharedSocketOpen: false,
    sharedTransportPhase: "",
    brokerNonce: "",
    lastBrokerNonceCheckAt: 0,
  };

  let tabBroker = null;

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
    #${INTEGRATED_WRAPPER_ID} { position:relative; z-index:1; display:block; box-sizing:border-box; width:100%; min-width:0; max-width:100%; margin:7px 0; list-style:none; }
    #${INTEGRATED_HOST_ID} { position:relative; z-index:1; display:block; width:100%; min-width:0; max-width:100%; font:12px/1.35 Arial,Helvetica,sans-serif; }
    #${INTEGRATED_HOST_ID}.wc-rank-host { box-sizing:border-box; }
    #${INTEGRATED_HOST_ID}.wc-attack-host { display:inline-flex; width:auto; margin-left:8px; vertical-align:middle; }
    #${PANEL_ID}.wc-integrated-inline.wc-roster-mode { position:relative !important; inset:auto !important; width:100%; max-width:none; max-height:none; margin:0; border-color:#4d612a; border-radius:3px; box-shadow:0 2px 8px rgba(0,0,0,.3); }
    #${PANEL_ID}.wc-roster-mode .wc-body { max-height:none; overflow:visible; overscroll-behavior:auto; border-top:1px solid #3f4f25; background:#202020; }
    #${PANEL_ID}.wc-roster-mode:not(.wc-roster-open) .wc-body { display:none; }
    #${PANEL_ID}.wc-inline-accordion { margin:0; border:0; border-radius:0; box-shadow:none; }
    #${PANEL_ID}.wc-inline-accordion .wc-body { display:block !important; border-top:1px solid #3f4f25; padding:7px; }
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
    .${INLINE_TOOLS_CLASS} .wc-inline-retal { width:auto; min-width:18px; color:#38bdf8; padding:0 3px; font-size:10px; font-weight:700; }
    .${INLINE_TOOLS_CLASS} button:disabled { opacity:.45; cursor:wait; }
    .warbuddy-roster-action-cell { position:relative !important; }
    .${ROSTER_ACTIONS_CLASS} { position:absolute; left:2px; top:50%; z-index:4; display:inline-flex; width:20px; height:20px; align-items:center; justify-content:center; overflow:visible; margin:0; transform:translateY(-50%); font:9px/1.2 Arial,Helvetica,sans-serif; }
    .${ROSTER_ACTIONS_CLASS}:empty { display:none; }
    .${ROSTER_ACTIONS_CLASS} .wc-dibs { width:20px !important; height:20px !important; border-color:#52525b !important; background:#18181b !important; }
    a.warbuddy-attack-has-dibs { box-sizing:border-box !important; padding-left:24px !important; }
    :is(.${ROSTER_ACTIONS_CLASS}, .${INLINE_TOOLS_CLASS}) .wc-native-state { display:inline-flex; min-height:18px; align-items:center; border:1px solid #52525b; border-radius:3px; padding:1px 4px; background:#27272a; color:#e4e4e7; font-weight:700; white-space:nowrap; }
    .${ROSTER_ACTIONS_CLASS} .wc-native-state { min-width:0; max-width:86px; flex:0 1 auto; overflow:hidden; text-overflow:ellipsis; }
    :is(.${ROSTER_ACTIONS_CLASS}, .${INLINE_TOOLS_CLASS}) .wc-native-retal { border-color:#0284c7; background:#0c4a6e; color:#e0f2fe; }
    :is(.${ROSTER_ACTIONS_CLASS}, .${INLINE_TOOLS_CLASS}) .wc-native-dibs.mine { border-color:#059669; background:#065f46; color:#d1fae5; }
    :is(.${ROSTER_ACTIONS_CLASS}, .${INLINE_TOOLS_CLASS}) .wc-native-dibs.taken { border-color:#71717a; background:#52525b; color:#fafafa; }
    #${TARGET_CONTEXT_ID} { box-sizing:border-box; min-width:0; color:var(--default-color,#e4e4e7); font:12px/1.35 Arial,Helvetica,sans-serif; }
    #${TARGET_CONTEXT_ID} * { box-sizing:border-box; letter-spacing:0; }
    #${TARGET_CONTEXT_ID} .wc-native-brand { flex:0 0 auto; color:#9fbd57; font-size:10px; font-weight:800; letter-spacing:.04em; text-transform:uppercase; }
    #${TARGET_CONTEXT_ID} .wc-native-target { min-width:105px; flex:0 1 auto; overflow:hidden; font-weight:800; text-overflow:ellipsis; white-space:nowrap; }
    #${TARGET_CONTEXT_ID} .wc-native-details { min-width:150px; flex:1 1 240px; overflow:hidden; color:var(--default-color,#d4d4d8); font-size:11px; text-overflow:ellipsis; white-space:nowrap; }
    #${TARGET_CONTEXT_ID} .wc-native-states, #${TARGET_CONTEXT_ID} .wc-native-actions { display:inline-flex; flex:0 0 auto; flex-wrap:wrap; align-items:center; gap:4px; }
    #${TARGET_CONTEXT_ID} .wc-native-state { display:inline-flex; min-height:24px; align-items:center; border:1px solid #52525b; border-radius:4px; background:#27272a; color:#e4e4e7; padding:3px 6px; font-size:10px; font-weight:800; white-space:nowrap; }
    #${TARGET_CONTEXT_ID} .wc-native-retal { border-color:#0284c7; background:#0c4a6e; color:#e0f2fe; }
    #${TARGET_CONTEXT_ID} .wc-native-dibs.mine { border-color:#059669; background:#065f46; color:#d1fae5; }
    #${TARGET_CONTEXT_ID} .wc-native-dibs.taken { border-color:#71717a; background:#52525b; color:#fafafa; }
    #${TARGET_CONTEXT_ID} .wc-native-muted { color:#a1a1aa; }
    #${TARGET_CONTEXT_ID} .wc-native-error { flex:1 0 100%; color:#fca5a5; font-size:10px; }
    #${TARGET_CONTEXT_ID} .wc-native-result { display:flex; flex:1 0 100%; align-items:center; justify-content:space-between; gap:6px; border-top:1px solid #3f3f46; padding-top:5px; color:#d1fae5; font-weight:700; }
    #${TARGET_CONTEXT_ID} .wc-native-key { display:flex; min-width:260px; flex:1 0 100%; gap:5px; }
    #${TARGET_CONTEXT_ID} .wc-input { min-width:0; flex:1; border:1px solid #52525b; border-radius:4px; background:#09090b; color:#f4f4f5; padding:6px; font:inherit; }
    #${TARGET_CONTEXT_ID} .wc-secret-input { -webkit-text-security:disc; }
    #${TARGET_CONTEXT_ID} .wc-button, #${TARGET_CONTEXT_ID} .wc-link { display:inline-flex; min-height:26px; flex:0 0 auto; align-items:center; justify-content:center; border:1px solid #52525b; border-radius:4px; background:#27272a; color:#f4f4f5; padding:4px 7px; text-decoration:none; font:inherit; font-weight:700; cursor:pointer; }
    #${TARGET_CONTEXT_ID} .wc-button:hover, #${TARGET_CONTEXT_ID} .wc-link:hover { background:#3f3f46; }
    #${TARGET_CONTEXT_ID} .wc-button.primary { border-color:#059669; background:#065f46; color:#d1fae5; }
    #${TARGET_CONTEXT_ID} .wc-button:disabled { opacity:.45; cursor:wait; }
    :is(#${TARGET_CONTEXT_ID}, .${ROSTER_ACTIONS_CLASS}, .${INLINE_TOOLS_CLASS}) .wc-dibs-wrap { position:relative; display:inline-flex; flex:0 0 auto; align-items:center; }
    :is(#${TARGET_CONTEXT_ID}, .${ROSTER_ACTIONS_CLASS}, .${INLINE_TOOLS_CLASS}) .wc-dibs { display:inline-flex; width:24px; height:24px; flex:0 0 auto; align-items:center; justify-content:center; border:1px solid transparent; border-radius:4px; background:transparent; color:#a1a1aa; padding:0; font:12px/1 Arial,Helvetica,sans-serif; cursor:pointer; }
    :is(#${TARGET_CONTEXT_ID}, .${ROSTER_ACTIONS_CLASS}, .${INLINE_TOOLS_CLASS}) .wc-dibs:hover, :is(#${TARGET_CONTEXT_ID}, .${ROSTER_ACTIONS_CLASS}, .${INLINE_TOOLS_CLASS}) .wc-dibs:focus-visible { border-color:#71717a; background:#27272a; color:#fff; outline:0; }
    :is(#${TARGET_CONTEXT_ID}, .${ROSTER_ACTIONS_CLASS}, .${INLINE_TOOLS_CLASS}) .wc-dibs.mine { color:#10b981; }
    :is(#${TARGET_CONTEXT_ID}, .${ROSTER_ACTIONS_CLASS}, .${INLINE_TOOLS_CLASS}) .wc-dibs.taken { color:#f59e0b; }
    :is(#${TARGET_CONTEXT_ID}, .${ROSTER_ACTIONS_CLASS}, .${INLINE_TOOLS_CLASS}) .wc-dibs.unavailable { opacity:.55; color:#71717a; cursor:help; }
    :is(#${TARGET_CONTEXT_ID}, .${ROSTER_ACTIONS_CLASS}, .${INLINE_TOOLS_CLASS}) .wc-dibs:disabled { opacity:.45; cursor:wait; }
    :is(#${TARGET_CONTEXT_ID}, .${ROSTER_ACTIONS_CLASS}, .${INLINE_TOOLS_CLASS}) .wc-dibs-tip { position:fixed; z-index:2147483647; display:none; width:max-content; max-width:min(240px,calc(100vw - 28px)); border:1px solid #3f3f46; border-radius:4px; background:#09090b; color:#e4e4e7; padding:6px; box-shadow:0 6px 18px rgba(0,0,0,.45); font-size:10px; font-weight:400; white-space:normal; }
    :is(#${TARGET_CONTEXT_ID}, .${ROSTER_ACTIONS_CLASS}, .${INLINE_TOOLS_CLASS}) .wc-dibs-wrap.open .wc-dibs-tip { display:block; }
    :is(#${TARGET_CONTEXT_ID}, .${ROSTER_ACTIONS_CLASS}, .${INLINE_TOOLS_CLASS}) .wc-dibs-close { float:right; width:18px; height:18px; margin:-2px -2px 1px 5px; border:0; border-radius:3px; background:transparent; color:#a1a1aa; padding:0; font:700 14px/18px Arial,Helvetica,sans-serif; cursor:pointer; }
    :is(#${TARGET_CONTEXT_ID}, .${ROSTER_ACTIONS_CLASS}, .${INLINE_TOOLS_CLASS}) .wc-dibs-release { display:block; width:100%; margin-top:5px; border:1px solid #52525b; border-radius:3px; background:#27272a; color:#f4f4f5; padding:4px 6px; font:inherit; font-weight:700; cursor:pointer; }
    #${TARGET_CONTEXT_ID} .wc-loadout { position:relative; display:inline-flex; }
    #${TARGET_CONTEXT_ID} .wc-loadout-button { display:inline-flex; width:26px; height:26px; align-items:center; justify-content:center; border:1px solid #52525b; border-radius:4px; background:#27272a; color:#22d3ee; padding:0; cursor:pointer; }
    #${TARGET_CONTEXT_ID} .wc-loadout-tip { position:absolute; right:0; top:30px; z-index:25; display:none; width:220px; border:1px solid #3f3f46; border-radius:4px; background:#09090b; color:#e4e4e7; padding:6px; box-shadow:0 6px 18px rgba(0,0,0,.45); font-size:10px; font-weight:400; }
    #${TARGET_CONTEXT_ID} .wc-loadout.open .wc-loadout-tip { display:block; }
    #${TARGET_CONTEXT_ID} .wc-loadout-line { display:grid; grid-template-columns:42px minmax(0,1fr); gap:3px; }
    #${TARGET_CONTEXT_ID} .wc-loadout-label { color:#71717a; font-weight:700; }
    #${TARGET_CONTEXT_ID} .wc-loadout-value { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    #${TARGET_CONTEXT_ID}.wc-compact-context { position:static !important; inset:auto !important; z-index:auto; min-width:0; flex-wrap:nowrap; align-items:center; gap:2px; border:1px solid rgba(113,113,122,.65); border-left-width:1px; border-radius:4px; background:rgba(24,24,27,.72); box-shadow:none; font-size:10px; line-height:1.2; vertical-align:middle; }
    #${TARGET_CONTEXT_ID}.wc-attack-context { display:inline-flex; width:auto; max-width:min(260px,100%); flex:0 1 auto; overflow:hidden; margin:1px 0 1px 4px; padding:1px 3px; }
    body > #${TARGET_CONTEXT_ID}.wc-profile-context { position:fixed !important; inset:auto; z-index:2147483000 !important; display:inline-flex; width:max-content; max-width:min(340px,calc(100vw - 16px)); min-height:18px; max-height:20px; flex:0 1 auto; overflow:visible; margin:0; padding:0 2px; transform:none; vertical-align:middle; }
    :is(body > #${TARGET_CONTEXT_ID}.wc-profile-context).wc-native-overlay-fallback { position:fixed !important; inset:58px 12px auto auto !important; }
    #${ROSTER_CONTEXT_ID}.wc-native-roster-context { position:relative !important; inset:auto !important; z-index:5 !important; display:block; box-sizing:border-box; width:100%; min-width:0; max-width:100%; margin:5px 0; overflow:visible; border:1px solid #526b24; border-radius:3px; background:#202020; color:#e4e4e7; box-shadow:0 1px 4px rgba(0,0,0,.3); font:700 10px/1.25 Arial,Helvetica,sans-serif; }
    #${ROSTER_CONTEXT_ID} > summary { display:flex; min-height:32px; align-items:center; gap:6px; overflow:hidden; background:linear-gradient(180deg,#5a7625,#41571a); color:#f4f4f5; padding:5px 8px; cursor:pointer; list-style:none; user-select:none; }
    #${ROSTER_CONTEXT_ID} > summary::-webkit-details-marker { display:none; }
    #${ROSTER_CONTEXT_ID} .wc-native-roster-chevron { flex:0 0 auto; font-size:11px; transition:transform .12s ease; }
    #${ROSTER_CONTEXT_ID}[open] .wc-native-roster-chevron { transform:rotate(90deg); }
    #${ROSTER_CONTEXT_ID} .wc-native-brand { flex:0 0 auto; color:#f4f4f5; font-size:11px; font-weight:900; letter-spacing:.02em; }
    #${ROSTER_CONTEXT_ID} .wc-native-beta { flex:0 0 auto; border-radius:2px; background:rgba(0,0,0,.3); color:#ecfccb; padding:1px 3px; font-size:7px; font-weight:900; text-transform:uppercase; }
    #${ROSTER_CONTEXT_ID} .wc-native-roster-matchup { min-width:0; flex:1 1 auto; overflow:hidden; color:#e4e4e7; text-overflow:ellipsis; white-space:nowrap; }
    #${ROSTER_CONTEXT_ID} .wc-native-roster-status { display:inline-flex; min-width:0; flex:0 0 auto; align-items:center; gap:3px; overflow:hidden; color:#e4e4e7; text-overflow:ellipsis; white-space:nowrap; }
    #${ROSTER_CONTEXT_ID} .wc-native-roster-counts { display:inline-flex; flex:0 0 auto; align-items:center; gap:7px; color:#e4e4e7; white-space:nowrap; }
    #${ROSTER_CONTEXT_ID} .wc-native-roster-panel-host { display:block; width:100%; min-width:0; }
    #${ROSTER_CONTEXT_ID} .wc-native-roster-filter, #${ROSTER_CONTEXT_ID} .wc-native-roster-toggle, #${ROSTER_CONTEXT_ID} .wc-button { display:inline-flex; min-width:24px; min-height:24px; flex:0 0 auto; align-items:center; justify-content:center; border:1px solid #52525b; border-radius:3px; background:#27272a; color:#d4d4d8; padding:4px 7px; font:700 10px/1 Arial,Helvetica,sans-serif; cursor:pointer; white-space:nowrap; }
    #${ROSTER_CONTEXT_ID} .wc-native-roster-filter.active, #${ROSTER_CONTEXT_ID} .wc-native-roster-toggle.active { border-color:#84a83b; background:#405719; color:#fff; }
    #${ROSTER_CONTEXT_ID} :is(.wc-button,.wc-native-roster-filter,.wc-native-roster-toggle):hover, #${ROSTER_CONTEXT_ID} :is(.wc-button,.wc-native-roster-filter,.wc-native-roster-toggle):focus-visible { border-color:#71717a; color:#f4f4f5; outline:0; }
    #${TARGET_CONTEXT_ID}.wc-compact-context .wc-attack-brand { display:inline-flex; height:20px; align-items:center; color:#9fbd57; font-size:9px; font-weight:900; letter-spacing:.02em; }
    #${TARGET_CONTEXT_ID}.wc-compact-context .wc-native-states { min-width:0; max-width:100%; flex:1 1 auto; flex-wrap:nowrap; gap:2px; overflow:hidden; }
    #${TARGET_CONTEXT_ID}.wc-compact-context .wc-native-actions { min-width:0; flex:0 0 auto; flex-wrap:nowrap; gap:2px; margin-left:auto; }
    #${TARGET_CONTEXT_ID}.wc-compact-context .wc-native-states:empty, #${TARGET_CONTEXT_ID}.wc-compact-context .wc-native-actions:empty { display:none; }
    #${TARGET_CONTEXT_ID}.wc-compact-context .wc-native-state { min-width:0; min-height:20px; max-width:145px; flex:0 1 auto; overflow:hidden; border-radius:3px; padding:1px 4px; font-size:9px; text-overflow:ellipsis; }
    #${TARGET_CONTEXT_ID}.wc-compact-context .wc-button, #${TARGET_CONTEXT_ID}.wc-compact-context .wc-attack-icon { display:inline-flex; width:auto; min-width:20px; min-height:20px; align-items:center; justify-content:center; border:1px solid transparent; border-radius:3px; background:transparent; color:#a1a1aa; padding:1px 4px; font:700 9px/1 Arial,Helvetica,sans-serif; cursor:pointer; }
    #${TARGET_CONTEXT_ID}.wc-compact-context .wc-button:hover, #${TARGET_CONTEXT_ID}.wc-compact-context .wc-button:focus-visible, #${TARGET_CONTEXT_ID}.wc-compact-context .wc-attack-icon:hover, #${TARGET_CONTEXT_ID}.wc-compact-context .wc-attack-icon:focus-visible { border-color:#52525b; background:#27272a; color:#f4f4f5; outline:0; }
    #${TARGET_CONTEXT_ID}.wc-compact-context .wc-attack-icon.active, #${TARGET_CONTEXT_ID}.wc-compact-context .wc-attack-tools.active { color:#9fbd57; }
    #${TARGET_CONTEXT_ID}.wc-compact-context .wc-dibs { width:20px; height:20px; }
    #${TARGET_CONTEXT_ID}.wc-compact-context .wc-loadout-button { width:20px; height:20px; border-color:transparent; background:transparent; }
    #${TARGET_CONTEXT_ID}.wc-compact-context .wc-attack-result { display:inline-flex; min-width:0; min-height:20px; max-width:150px; flex:0 1 auto; align-items:center; overflow:hidden; color:#86efac; padding:1px 3px; font-size:9px; font-weight:700; text-overflow:ellipsis; white-space:nowrap; }
    #${TARGET_CONTEXT_ID}.wc-compact-context .wc-attack-error { display:inline-flex; width:18px; height:18px; flex:0 0 auto; align-items:center; justify-content:center; border:1px solid #b91c1c; border-radius:50%; color:#fca5a5; font-size:10px; font-weight:900; cursor:help; }
    #${TARGET_CONTEXT_ID}.wc-profile-context .wc-attack-brand { height:18px; font-size:8px; }
    #${TARGET_CONTEXT_ID}.wc-profile-context .wc-native-state { min-height:18px; max-height:18px; max-width:120px; padding:0 3px; font-size:8px; }
    #${TARGET_CONTEXT_ID}.wc-profile-context .wc-button, #${TARGET_CONTEXT_ID}.wc-profile-context .wc-attack-icon, #${TARGET_CONTEXT_ID}.wc-profile-context .wc-loadout-button, #${TARGET_CONTEXT_ID}.wc-profile-context .wc-dibs { min-width:18px; min-height:18px; width:18px; height:18px; padding:0 2px; }
    #${TARGET_CONTEXT_ID}.wc-profile-context .wc-loadout-tip { top:calc(100% + 4px); bottom:auto; }
    @media (max-width:820px) { #${ROSTER_CONTEXT_ID} .wc-native-roster-status-label { display:none; } }
    @media (max-width:620px) { #${TARGET_CONTEXT_ID} .wc-native-details { order:5; flex-basis:100%; white-space:normal; } #${TARGET_CONTEXT_ID} .wc-native-states { margin-left:auto; } body > #${TARGET_CONTEXT_ID}.wc-profile-context { max-width:min(260px,calc(100vw - 16px)); } #${TARGET_CONTEXT_ID}.wc-profile-context .wc-native-state { max-width:80px; } #${ROSTER_CONTEXT_ID} .wc-native-roster-matchup, #${ROSTER_CONTEXT_ID} .wc-native-beta { display:none; } #${ROSTER_CONTEXT_ID} .wc-native-roster-counts { gap:4px; font-size:9px; } }
    @media (pointer:coarse) { #${TARGET_CONTEXT_ID} .wc-button, #${TARGET_CONTEXT_ID} .wc-link, #${TARGET_CONTEXT_ID} .wc-loadout-button, #${TARGET_CONTEXT_ID} .wc-attack-icon, :is(#${TARGET_CONTEXT_ID}, .${ROSTER_ACTIONS_CLASS}, .${INLINE_TOOLS_CLASS}) .wc-dibs { min-width:36px; min-height:36px; } body > #${TARGET_CONTEXT_ID}.wc-profile-context { min-height:20px; max-height:20px; } #${TARGET_CONTEXT_ID}.wc-profile-context .wc-button, #${TARGET_CONTEXT_ID}.wc-profile-context .wc-attack-icon, #${TARGET_CONTEXT_ID}.wc-profile-context .wc-loadout-button, #${TARGET_CONTEXT_ID}.wc-profile-context .wc-dibs { min-width:20px; min-height:20px; width:20px; height:20px; } #${ROSTER_CONTEXT_ID} .wc-button { min-width:24px; min-height:24px; width:24px; height:24px; } }
    .${STATUS_CELL_CLASS} { position:relative !important; color:transparent !important; text-shadow:none !important; }
    .${STATUS_CELL_CLASS} > :not(.${STATUS_DETAIL_CLASS}) { visibility:hidden !important; }
    .${STATUS_DETAIL_CLASS} { position:absolute; inset:0; z-index:2; display:flex; align-items:center; justify-content:center; color:var(--user-status-blue-color,#22d3ee) !important; font:inherit; font-weight:700; line-height:1.1; text-align:center; white-space:nowrap; visibility:visible !important; }
    .${STATUS_DETAIL_CLASS}.hospital, .${STATUS_DETAIL_CLASS}.jail { color:var(--user-status-red-color,#f87171) !important; }
    .${STATUS_DETAIL_CLASS}.soon { color:#fbbf24 !important; }
    .${STATUS_MISMATCH_CLASS} { box-shadow:inset 0 -2px var(--user-status-blue-color,#22d3ee) !important; }
    @media (hover:hover) and (pointer:fine) { [data-warbuddy-member-row]:not(:hover):not(:focus-within) .${INLINE_TOOLS_CLASS}.quiet { display:none; } [data-warbuddy-member-row]:not(:hover):not(:focus-within) .${INLINE_TOOLS_CLASS} .wc-inline-watch:not(.active) { display:none; } }
    #${PANEL_ID} * { box-sizing:border-box; letter-spacing:0; }
    #${PANEL_ID}.wc-collapsed .wc-body { display:none; }
    #${PANEL_ID}.wc-collapsed { width:auto; min-width:154px; max-width:calc(100vw - 20px); border-radius:999px; }
    #${PANEL_ID}.wc-collapsed .wc-header { min-height:34px; align-items:center; border:0; border-radius:999px; padding:4px 5px 4px 10px; }
    #${PANEL_ID}.wc-collapsed .wc-matchup, #${PANEL_ID}.wc-collapsed .wc-version { display:none; }
    #${PANEL_ID} .wc-header { display:flex; align-items:flex-start; justify-content:space-between; gap:8px; min-height:42px; padding:5px 7px; border-bottom:1px solid #27272a; background:#18181b; cursor:default; touch-action:auto; user-select:none; }
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
    #${PANEL_ID} .wc-dibs.unavailable { opacity:.55; color:#71717a; cursor:help; }
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
          const nestedError = body?.error && typeof body.error === "object" ? body.error : null;
          const topLevelError = typeof body?.error === "string" ? body.error : "";
          const message = nestedError?.error || nestedError?.message || topLevelError || body?.message || `HTTP ${status}`;
          const error = new Error(message);
          error.status = status;
          error.code = nestedError?.code || body?.code;
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
  const sharedBrokerEnabled = () => tabBroker?.enabled === true;
  const shouldRunOwnedTransport = () => sharedBrokerEnabled()
    ? tabBroker.shouldOwnTransport()
    : isForeground();
  const localSessionNeedsRefresh = () => {
    if (!isForeground()) return false;
    return sessionTokenNeedsRefresh();
  };
  const sessionTokenNeedsRefresh = () => {
    const expiresAt = Date.parse(String(state.session?.wsSessionTokenExpiresAt || state.session?.expiresAt || ""));
    return !state.session || !state.token || !Number.isFinite(expiresAt) || expiresAt <= trustedNowMs() + 30_000;
  };
  const directSocketIsOpen = () => Number(state.socket?.readyState) === 1;
  const socketIsOpen = () => directSocketIsOpen()
    || (sharedBrokerEnabled() && !tabBroker.isLeader() && state.sharedSocketOpen);
  const dataIsStale = () => socketIsOpen()
    ? state.lastLiveDataAt < state.socketOpenedAt
    : state.lastLiveDataAt > 0 && Date.now() - state.lastLiveDataAt > DATA_STALE_MS;
  const liveDataAgeMs = () => Math.max(0, Date.now() - Number(state.lastLiveDataAt || 0));
  const rosterIsFresh = (factionId) => {
    const normalizedFactionId = String(factionId || "");
    if (!normalizedFactionId) return false;
    if (!transportIsLive() || !isOnline()) return false;
    const updatedAt = Number(state.rosterDataAt.get(normalizedFactionId) || 0);
    if (socketIsOpen()) return updatedAt >= state.socketOpenedAt;
    return updatedAt > 0 && Date.now() - updatedAt <= DATA_STALE_MS;
  };
  const currentEnemyFactionId = () => core.inferEnemyFactionId(
    String(state.session?.factionId || ""),
    state.scores,
    state.rosters
  );
  const currentEnemyRosterIsFresh = () => rosterIsFresh(currentEnemyFactionId());
  const transientTornErrorCodes = new Set([0, 5, 9, 12, 13, 14, 15, 17]);
  const terminalCompanionErrorCodes = new Set(["FACTION_NOT_FOUND", "FACTION_NOT_MANAGED"]);
  const authenticationError = (message, properties = {}) => Object.assign(new Error(message), properties);
  const isTerminalAuthenticationError = (error) => error?.terminalAuth === true
    || [400, 401, 403, 422].includes(Number(error?.status || 0))
    || terminalCompanionErrorCodes.has(String(error?.code || "").toUpperCase());
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
  const clearDibsState = (resetSequence = false) => {
    const current = state.dibs && typeof state.dibs === "object" ? state.dibs : { claims: [] };
    const changed = (Array.isArray(current.claims) && current.claims.length > 0)
      || Object.keys(current).some((key) => key !== "claims");
    state.dibs = { claims: [] };
    if (resetSequence) state.dibsApplicationSequence = 0;
    else if (changed) state.dibsApplicationSequence += 1;
    return changed;
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
    clearDibsState(true);
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
  const isRosterBootstrapPage = () => core.isRankedWarPageUrl(window.location.href);
  const isRosterModePage = (view = null) => {
    const ownFactionId = view?.ownFactionId || state.session?.factionId || 0;
    if (core.isOwnRankedWarPageUrl(window.location.href, ownFactionId)) return true;
    if (!view || !targetPageFactionEligible(view)) return false;
    return Number(core.rankedWarPageFactionId(window.location.href) || 0) === Number(view.enemyFactionId || 0);
  };
  const targetPageMemberId = () => Number(state.attackTargetId || state.profileTargetId || 0);
  const hasWarbuddySurface = () => !!targetPageMemberId()
    || isRosterBootstrapPage()
    || state.displayMode === "floating";
  const isForeground = () => state.active
    && hasWarbuddySurface()
    && document.visibilityState !== "hidden"
    && (typeof navigator === "undefined" || navigator.onLine !== false);
  const backendUrl = (path) => `${BACKEND_BASE_URL.replace(/\/$/, "")}${path}`;
  const socketUrl = () => `${BACKEND_BASE_URL.replace(/^http/i, "ws").replace(/\/$/, "")}/ws`;
  const fallbackIsFresh = () => state.fallbackActive
    && Number.isFinite(Date.parse(state.lastFallbackAt))
    && Date.parse(state.lastFallbackAt) > Date.now() - (FALLBACK_POLL_MAX_MS * 3);

  function initializeTabBroker(nonce = storedBrokerNonce()) {
    const brokerApi = globalThis.WarbuddyTabBroker;
    state.brokerNonce = nonce;
    state.lastBrokerNonceCheckAt = Date.now();
    if (!brokerApi || typeof brokerApi.createConnectionBroker !== "function") {
      tabBroker = null;
      return;
    }
    tabBroker = brokerApi.createConnectionBroker({
      channelName: "warbuddy-live-" + nonce,
      BroadcastChannelCtor: globalThis.BroadcastChannel || window.BroadcastChannel,
      onRoleChange: handleTabBrokerRoleChange,
      onLeaderChange: handleTabBrokerLeaderChange,
      onDemandChange: handleTabBrokerDemandChange,
      onData: handleTabBrokerData,
      onRequest: handleTabBrokerRequest,
    });
  }

  function syncTabBrokerNonce(force = false) {
    const now = Date.now();
    if (!force && tabBroker && now - state.lastBrokerNonceCheckAt < BROKER_NONCE_RECHECK_MS) return false;
    state.lastBrokerNonceCheckAt = now;
    const nonce = storedBrokerNonce();
    if (tabBroker && nonce === state.brokerNonce) return false;
    tabBroker?.close();
    tabBroker = null;
    closeOwnedTransport("Shared channel changed");
    initializeTabBroker(nonce);
    syncTabBrokerIdentity();
    return true;
  }

  function syncTabBrokerIdentity() {
    if (!sharedBrokerEnabled()) return;
    const factionId = String(state.session?.factionId || "");
    const playerId = String(state.session?.playerId || "");
    tabBroker.setScope(factionId && playerId ? factionId + ":" + playerId : "");
    tabBroker.setActive(!!getStoredKey() && !state.authTerminal && isForeground());
  }

  function releaseTabBrokerIdentity() {
    if (!sharedBrokerEnabled()) return;
    tabBroker.setActive(false);
    tabBroker.setScope("");
    state.sharedSocketOpen = false;
    state.sharedTransportPhase = "";
  }

  function handleTabBrokerRoleChange(isLeader) {
    if (!sharedBrokerEnabled()) return;
    if (isLeader) {
      state.sharedSocketOpen = false;
      state.sharedTransportPhase = "";
      if (tabBroker.shouldOwnTransport()) void ensureConnected();
    } else {
      closeOwnedTransport("Shared connection transferred");
      state.sharedSocketOpen = false;
      state.sharedTransportPhase = "";
      if (isForeground() && tabBroker.hasLeader()) requestSharedState();
    }
    scheduleRender();
  }

  function handleTabBrokerLeaderChange(leaderId, isSelf) {
    if (isSelf || !leaderId) return;
    if (state.socket) closeOwnedTransport("Shared connection transferred");
    state.sharedSocketOpen = false;
    state.sharedTransportPhase = "";
    if (isForeground()) requestSharedState();
  }

  function handleTabBrokerDemandChange(hasDemand) {
    if (!sharedBrokerEnabled() || !tabBroker.isLeader()) return;
    if (hasDemand || tabBroker.shouldOwnTransport()) void ensureConnected();
  }

  function requestSharedState() {
    if (!sharedBrokerEnabled() || tabBroker.isLeader() || !tabBroker.hasLeader()) return;
    const leaderId = tabBroker.leaderId();
    const requestSequence = ++state.sharedStateRequestSequence;
    tabBroker.request("state", {}, 5_000)
      .then((payload) => {
        if (
          requestSequence !== state.sharedStateRequestSequence
          || tabBroker?.isLeader()
          || tabBroker?.leaderId() !== leaderId
        ) return;
        applySharedState(payload);
      })
      .catch(() => {
        if (
          requestSequence !== state.sharedStateRequestSequence
          || tabBroker?.isLeader()
          || tabBroker?.leaderId() !== leaderId
        ) return;
        if (isForeground() && !state.sharedSocketOpen) {
          state.phase = "connecting";
          scheduleRender();
        }
      });
  }

  function tornPageNowMs() {
    const pageWindow = globalThis.unsafeWindow && typeof globalThis.unsafeWindow === "object"
      ? globalThis.unsafeWindow
      : window;
    if (typeof pageWindow?.getCurrentTimestamp !== "function") return 0;
    try {
      return core.toTimestampMs(pageWindow.getCurrentTimestamp());
    } catch {
      return 0;
    }
  }

  function monotonicNowMs() {
    try {
      const value = Number(globalThis.performance?.now?.());
      return Number.isFinite(value) && value >= 0 ? value : Number.NaN;
    } catch {
      return Number.NaN;
    }
  }

  function trustedNowMs() {
    if (state.clockReady) {
      const monotonicNow = monotonicNowMs();
      const monotonicAnchor = Number(state.clockAnchorMonotonicMs);
      const monotonicElapsed = monotonicNow - monotonicAnchor;
      if (Number.isFinite(monotonicNow) && Number.isFinite(monotonicAnchor) && Number.isFinite(monotonicElapsed) && monotonicElapsed >= 0) {
        return Number(state.clockAnchorServerMs || 0) + monotonicElapsed;
      }
      return Date.now() + Number(state.clockOffsetMs || 0);
    }
    return tornPageNowMs() || Date.now();
  }

  function syncTrustedClock(value, source, sampleDeviceNowMs = Date.now()) {
    const serverSampleMs = core.toTimestampMs(value);
    const sampledAt = Number(sampleDeviceNowMs);
    const receivedAt = Date.now();
    if (
      serverSampleMs < Date.UTC(2020, 0, 1)
      || serverSampleMs > Date.UTC(2100, 0, 1)
      || !Number.isFinite(sampledAt)
    ) return false;
    const offsetMs = core.trustedClockOffset(serverSampleMs, sampledAt, Number.POSITIVE_INFINITY);
    if (!Number.isFinite(offsetMs)) return false;
    const elapsedSinceSample = Math.min(REQUEST_TIMEOUT_MS, Math.max(0, receivedAt - sampledAt));
    const candidateServerNowMs = serverSampleMs + elapsedSinceSample;
    const currentServerNowMs = state.clockReady ? trustedNowMs() : 0;
    if (state.clockReady && candidateServerNowMs + CLOCK_BACKWARD_TOLERANCE_MS < currentServerNowMs) return false;
    const serverNowMs = state.clockReady ? Math.max(candidateServerNowMs, currentServerNowMs) : candidateServerNowMs;
    state.clockOffsetMs = serverNowMs - receivedAt;
    state.clockAnchorServerMs = serverNowMs;
    state.clockAnchorMonotonicMs = monotonicNowMs();
    state.clockReady = true;
    state.clockSource = String(source || "backend");
    state.nowMs = trustedNowMs();
    return true;
  }

  function removeInlineMemberTools() {
    state.integratedDecorationsActive = false;
    document.querySelectorAll?.(`.${INLINE_TOOLS_CLASS}`).forEach((element) => element.remove());
    document.querySelectorAll?.(`.${ROSTER_ACTIONS_CLASS}`).forEach((element) => element.remove());
    document.querySelectorAll?.(".warbuddy-roster-action-cell").forEach((element) => element.classList.remove("warbuddy-roster-action-cell"));
    document.querySelectorAll?.(`.${STATUS_CELL_CLASS}, .${STATUS_MISMATCH_CLASS}`).forEach((cell) => {
      cell.classList.remove(STATUS_CELL_CLASS, STATUS_MISMATCH_CLASS);
      cell.querySelectorAll?.(`.${STATUS_DETAIL_CLASS}`).forEach((detail) => detail.remove());
      delete cell.dataset.warbuddyStatusMemberId;
      delete cell.dataset.warbuddyStatusMismatch;
    });
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
      link.classList.remove("warbuddy-attack-dibs-mine", "warbuddy-attack-dibs-taken", "warbuddy-attack-retal", "warbuddy-attack-has-dibs");
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

  function removeTargetContext() {
    document.getElementById(TARGET_CONTEXT_ID)?.remove();
  }

  function removeNativeRosterContext() {
    document.getElementById(ROSTER_CONTEXT_ID)?.remove();
  }

  function rosterProfileAnchors(roster, root = document) {
    const memberIds = new Set((Array.isArray(roster) ? roster : [])
      .map((member) => Number(member?.member_id || 0))
      .filter((memberId) => Number.isSafeInteger(memberId) && memberId > 0));
    if (!memberIds.size) return [];
    const seen = new Set();
    return Array.from(root?.querySelectorAll?.("a[href*='profiles.php']") || []).filter((anchor) => {
      if (anchor.closest?.(`#${PANEL_ID}, #${INTEGRATED_HOST_ID}, #${TARGET_CONTEXT_ID}, .${INLINE_TOOLS_CLASS}, .${ROSTER_ACTIONS_CLASS}`)) return false;
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
      if (anchor.closest?.(`#${PANEL_ID}, #${INTEGRATED_HOST_ID}, #${TARGET_CONTEXT_ID}, .${INLINE_TOOLS_CLASS}, .${ROSTER_ACTIONS_CLASS}`)) return false;
      const memberId = core.profileMemberIdFromUrl(anchor.getAttribute?.("href") || anchor.href || "");
      if (
        !enemyIds.has(memberId)
        || seen.has(memberId)
        || !rankedWarRowForAnchor(anchor)
      ) return false;
      seen.add(memberId);
      return true;
    });
  }

  function rankedWarAttackLinkForMember(row, memberId) {
    const targetId = Number(memberId || 0);
    if (!row || !Number.isSafeInteger(targetId) || targetId <= 0) return null;
    return Array.from(row.querySelectorAll?.("a[href*='sid=attack']") || [])
      .find((link) => core.attackPageTargetId(link.getAttribute?.("href") || link.href || "") === targetId) || null;
  }

  function rankedWarRowForAnchor(anchor) {
    const memberId = core.profileMemberIdFromUrl(anchor?.getAttribute?.("href") || anchor?.href || "");
    if (!memberId) return null;
    let candidate = anchor?.parentElement;
    let structuralRow = null;
    for (let depth = 0; candidate && depth < 10; depth += 1, candidate = candidate.parentElement) {
      if (candidate === document.body || candidate === document.documentElement) break;
      const profileIds = new Set(Array.from(candidate.querySelectorAll?.("a[href*='profiles.php']") || [])
        .map((link) => core.profileMemberIdFromUrl(link.getAttribute?.("href") || link.href || ""))
        .filter((profileId) => profileId > 0));
      if (profileIds.size > 1 || (profileIds.size === 1 && !profileIds.has(memberId))) break;
      if (!profileIds.size) continue;
      structuralRow = candidate;
      if (rankedWarAttackLinkForMember(candidate, memberId)) return candidate;
    }

    return structuralRow;
  }

  function rankedWarMainContent() {
    const scope = document.querySelector?.("#mainContainer, main, [role='main']") || null;
    if (!scope || scope === document.body || scope === document.documentElement) return null;
    return scope;
  }

  function rankedWarEnemyRowEntries(roster, root = rankedWarMainContent()) {
    const members = new Set((Array.isArray(roster) ? roster : [])
      .map((member) => Number(member?.member_id || 0))
      .filter((memberId) => Number.isSafeInteger(memberId) && memberId > 0));
    if (!members.size || !root?.querySelectorAll || root === document.body || root === document.documentElement) return [];
    const excludedSelector = [
      "#" + PANEL_ID,
      "#" + INTEGRATED_HOST_ID,
      "#" + TARGET_CONTEXT_ID,
      "." + INLINE_TOOLS_CLASS,
      "." + ROSTER_ACTIONS_CLASS,
      "aside",
      "[role='complementary']",
      "[class*='chat' i]",
      "[id*='chat' i]",
      "[class*='sidebar' i]",
      "[id*='sidebar' i]",
    ].join(", ");
    const entriesByMember = new Map();
    for (const anchor of Array.from(root.querySelectorAll("a[href*='profiles.php']") || [])) {
      if (anchor.closest?.(excludedSelector)) continue;
      const memberId = core.profileMemberIdFromUrl(anchor.getAttribute?.("href") || anchor.href || "");
      if (!members.has(memberId)) continue;
      const row = rankedWarRowForAnchor(anchor);
      if (!row || row.isConnected === false || !root.contains?.(row) || row.closest?.(excludedSelector)) continue;
      const rowProfileIds = new Set(Array.from(row.querySelectorAll?.("a[href*='profiles.php']") || [])
        .map((profileAnchor) => core.profileMemberIdFromUrl(profileAnchor.getAttribute?.("href") || profileAnchor.href || ""))
        .filter((profileId) => profileId > 0));
      if (rowProfileIds.size !== 1 || !rowProfileIds.has(memberId)) continue;
      let memberRows = entriesByMember.get(memberId);
      if (!memberRows) {
        memberRows = new Map();
        entriesByMember.set(memberId, memberRows);
      }
      const label = String(anchor.textContent || anchor.getAttribute?.("aria-label") || anchor.getAttribute?.("title") || "")
        .replace(/\s+/g, " ")
        .trim();
      const anchorScore = label ? 2 : anchor.querySelector?.("img, picture, svg") ? 0 : 1;
      const existing = memberRows.get(row);
      if (!existing || anchorScore > existing.anchorScore) {
        memberRows.set(row, { anchor, memberId, row, anchorScore });
      }
    }
    return Array.from(entriesByMember.values())
      .flatMap((memberRows) => Array.from(memberRows.values()))
      .map(({ anchor, memberId, row }) => ({ anchor, memberId, row }));
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

  function hasRankedWarRosterSignature(root) {
    const candidates = [root, root?.previousElementSibling].filter(Boolean);
    return candidates.some((candidate) => {
      const text = String(candidate?.textContent || "").replace(/\s+/g, " ").trim();
      return /\bmembers?\b/i.test(text)
        && /\bstatus\b/i.test(text)
        && /\b(?:level|est|score)\b/i.test(text);
    });
  }

  function rankedWarRosterCluster(roster, rowForAnchor = rankedWarRowForAnchor) {
    const memberIds = new Set((Array.isArray(roster) ? roster : [])
      .map((member) => Number(member?.member_id || 0))
      .filter((memberId) => Number.isSafeInteger(memberId) && memberId > 0));
    if (!memberIds.size) return null;
    const excludedSelector = [
      "#" + PANEL_ID,
      "#" + INTEGRATED_HOST_ID,
      "#" + TARGET_CONTEXT_ID,
      "." + INLINE_TOOLS_CLASS,
      "." + ROSTER_ACTIONS_CLASS,
      "aside",
      "[role='complementary']",
      "[class*='chat' i]",
      "[id*='chat' i]",
      "[class*='sidebar' i]",
      "[id*='sidebar' i]",
    ].join(", ");
    const mainScope = document.querySelector?.("#mainContainer, main, [role='main']") || null;
    const entries = Array.from(document.querySelectorAll?.("a[href*='profiles.php']") || [])
      .filter((anchor) => !anchor.closest?.(excludedSelector))
      .filter((anchor) => !mainScope || mainScope.contains?.(anchor))
      .map((anchor) => {
        const memberId = core.profileMemberIdFromUrl(anchor.getAttribute?.("href") || anchor.href || "");
        if (!memberIds.has(memberId)) return null;
        const row = rowForAnchor(anchor);
        if (!row || (mainScope && !mainScope.contains?.(row))) return null;
        const rowProfileIds = new Set(Array.from(row.querySelectorAll?.("a[href*='profiles.php']") || [])
          .map((profileAnchor) => core.profileMemberIdFromUrl(profileAnchor.getAttribute?.("href") || profileAnchor.href || ""))
          .filter((profileId) => profileId > 0));
        if (rowProfileIds.size !== 1 || !rowProfileIds.has(memberId)) return null;
        return { anchor, memberId, row };
      })
      .filter(Boolean);
    const requiredMatches = Math.min(2, memberIds.size);
    if (new Set(entries.map((entry) => entry.memberId)).size < requiredMatches) return null;

    const candidates = new Set();
    for (const { row } of entries) {
      for (let candidate = row.parentElement, depth = 0; candidate && depth < 8; depth += 1, candidate = candidate.parentElement) {
        if (candidate === document.body || candidate === document.documentElement) break;
        if (mainScope && !mainScope.contains?.(candidate)) break;
        if (candidate === mainScope) break;
        if (candidate.closest?.(excludedSelector)) break;
        candidates.add(candidate);
      }
    }

    let best = null;
    for (const root of candidates) {
      const matches = new Map();
      for (const entry of entries) {
        if (root.contains?.(entry.row) && !matches.has(entry.memberId)) matches.set(entry.memberId, entry);
      }
      if (matches.size < requiredMatches) continue;
      if (!hasRankedWarRosterSignature(root)) continue;
      const profileLinks = Array.from(root.querySelectorAll?.("a[href*='profiles.php']") || []);
      const profileIds = new Set(profileLinks
        .map((anchor) => core.profileMemberIdFromUrl(anchor.getAttribute?.("href") || anchor.href || ""))
        .filter((memberId) => memberId > 0));
      const profileIdLimit = Math.min(
        Math.max(160, memberIds.size + 32),
        Math.max((matches.size * 4), matches.size + 16)
      );
      const profileLinkLimit = Math.min(
        Math.max(240, (memberIds.size * 3) + 32),
        Math.max((profileIds.size * 3), (matches.size * 4) + 16)
      );
      if (
        profileIds.size < matches.size
        || profileIds.size > profileIdLimit
        || profileLinks.length > profileLinkLimit
      ) continue;
      const score = {
        root,
        matches: matches.size,
        profileCount: profileIds.size,
      };
      if (
        !best
        || score.matches > best.matches
        || (
          score.matches === best.matches
          && (
            score.profileCount < best.profileCount
            || (score.profileCount === best.profileCount && best.root.contains?.(score.root))
          )
        )
      ) best = score;
    }
    return best?.root || null;
  }

  function rankedWarBoardForView(view) {
    return rankedWarRosterCluster(view?.enemyRoster, rankedWarRowForAnchor);
  }

  function rankedWarUnsignedRosterCluster(roster) {
    const mainScope = rankedWarMainContent();
    if (!mainScope) return null;
    const entries = rankedWarEnemyRowEntries(roster, mainScope);
    const minimumMatches = 3;
    if (new Set(entries.map((entry) => entry.memberId)).size < minimumMatches) return null;
    const candidates = new Set();
    for (const { row } of entries) {
      for (let candidate = row.parentElement, depth = 0; candidate && depth < 8; depth += 1, candidate = candidate.parentElement) {
        if (candidate === mainScope || candidate === document.body || candidate === document.documentElement) break;
        if (!mainScope.contains?.(candidate)) break;
        candidates.add(candidate);
      }
    }

    let best = null;
    for (const root of candidates) {
      const matches = new Map();
      for (const entry of entries) {
        if (root.contains?.(entry.row) && !matches.has(entry.memberId)) matches.set(entry.memberId, entry);
      }
      if (matches.size < minimumMatches) continue;
      const profileLinks = Array.from(root.querySelectorAll?.("a[href*='profiles.php']") || []);
      const profileIds = new Set(profileLinks
        .map((anchor) => core.profileMemberIdFromUrl(anchor.getAttribute?.("href") || anchor.href || ""))
        .filter((memberId) => memberId > 0));
      const density = profileIds.size ? matches.size / profileIds.size : 0;
      if (
        profileIds.size < matches.size
        || profileIds.size > matches.size + 8
        || profileLinks.length > (matches.size * 3) + 12
        || density < 0.6
      ) continue;
      const score = { root, matches: matches.size, density, profileCount: profileIds.size };
      if (
        !best
        || score.matches > best.matches
        || (score.matches === best.matches && score.density > best.density)
        || (
          score.matches === best.matches
          && score.density === best.density
          && (
            score.profileCount < best.profileCount
            || (score.profileCount === best.profileCount && best.root.contains?.(score.root))
          )
        )
      ) best = score;
    }
    return best?.root || null;
  }

  function markRankedWarBoard(board) {
    const markedBoards = Array.from(document.querySelectorAll?.("[data-warbuddy-roster-board]") || []);
    if ((board && markedBoards.length === 1 && markedBoards[0] === board) || (!board && markedBoards.length === 0)) return;
    markedBoards.forEach((candidate) => {
      delete candidate.dataset.warbuddyRosterBoard;
    });
    if (board) board.dataset.warbuddyRosterBoard = "1";
  }

  function rankedWarSafeMountPoint(parent, before, wrapper = null) {
    let mountParent = parent;
    let mountBefore = before;
    for (let depth = 0; mountParent && depth < 12; depth += 1) {
      const atDocumentBoundary = mountParent === document.body || mountParent === document.documentElement;
      const display = atDocumentBoundary || typeof getComputedStyle !== "function"
        ? "block"
        : String(getComputedStyle(mountParent)?.display || "").toLowerCase();
      if (atDocumentBoundary || !display || SAFE_INTEGRATED_PARENT_DISPLAYS.has(display)) {
        const safeBefore = mountBefore === wrapper ? wrapper?.nextSibling : mountBefore;
        return { parent: mountParent, before: safeBefore || null };
      }
      mountBefore = mountParent;
      mountParent = mountParent.parentElement;
    }
    return null;
  }

  function rankedWarMountPoint(board, wrapper = null) {
    if (!board?.parentElement || board.isConnected === false) return null;
    return rankedWarSafeMountPoint(board.parentElement, board, wrapper);
  }

  function createRankedWarHost(view, board = rankedWarBoardForView(view)) {
    if (!board?.parentElement || board.isConnected === false) return null;
    const mountPoint = rankedWarMountPoint(board);
    if (!mountPoint?.parent) return null;

    markRankedWarBoard(board);

    const wrapper = document.createElement("div");
    wrapper.id = INTEGRATED_WRAPPER_ID;
    wrapper.className = "warbuddy-integrated-rank-host";
    wrapper.dataset.warbuddyBoardVerified = "1";
    const host = document.createElement("div");
    host.id = INTEGRATED_HOST_ID;
    host.className = "wc-rank-host";
    host.dataset.placement = "rank";
    wrapper.appendChild(host);
    mountPoint.parent.insertBefore(wrapper, mountPoint.before);
    return host;
  }

  function resolvePanelMount() {
    if (state.displayMode === "floating") {
      removeIntegratedMount(true);
      return { mount: document.body, placement: "floating", fallback: false };
    }
    document.getElementById(PANEL_ID)?.remove();
    removeIntegratedMount(false);
    return { mount: null, placement: "none", fallback: false };
  }

  function setDisplayMode(value) {
    const nextMode = core.normalizeDisplayMode(value);
    state.displayMode = nextMode;
    storage.set(DISPLAY_MODE_STORAGE, nextMode);
    if (nextMode === "floating") {
      removeIntegratedMount(true);
    } else {
      document.getElementById(PANEL_ID)?.remove();
      removeIntegratedMount(false);
    }
    scheduleRender();
    syncForegroundState();
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
    const responseReceivedAt = Date.now();
    if (!response?.session?.wsSessionToken) throw new Error("Backend did not return a companion session");
    syncTrustedClock(
      response?.serverTime || response?.session?.serverTime,
      "session",
      responseReceivedAt
    );
    return response.session;
  }

  function applyCompanionSession(session) {
    const previousFactionId = String(state.session?.factionId || "");
    const nextFactionId = String(session?.factionId || "");
    if (previousFactionId && nextFactionId && previousFactionId !== nextFactionId) clearLiveFactionData();
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
    syncTabBrokerIdentity();
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
      if (state.authTerminal) {
        state.keyEditorOpen = true;
        stopTicker();
      }
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

  function requestDirectSocketAction(action, payload = {}, timeoutMs = 10_000) {
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

  function requestSocketAction(action, payload = {}, timeoutMs = 10_000) {
    if (directSocketIsOpen()) return requestDirectSocketAction(action, payload, timeoutMs);
    if (sharedBrokerEnabled() && !tabBroker.isLeader() && state.sharedSocketOpen) {
      return tabBroker.request("socket-action", { action, payload }, timeoutMs);
    }
    return Promise.reject(new Error("Live connection is unavailable"));
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

  function closeOwnedTransport(message = "Live connection closed") {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = 0;
    stopFallbackPolling();
    clearSocketConnectTimer();
    const socket = state.socket;
    state.socket = null;
    state.socketOpenedAt = 0;
    rejectSocketRequests(message);
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
    state.phase = fallbackIsFresh() ? "fallback" : shouldRunOwnedTransport() ? "connecting" : "paused";
    try {
      if (socket.readyState < WebSocket.CLOSING) socket.close(4000, reason);
    } catch {
      // A rejected browser handshake may discard the socket before close() runs.
    }
    scheduleRender();
    publishSharedTransport();
    if (shouldRunOwnedTransport()) {
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

  function requestDirectRosterSnapshot() {
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

  function requestRosterSnapshot() {
    if (directSocketIsOpen()) {
      requestDirectRosterSnapshot();
      return;
    }
    if (sharedBrokerEnabled() && !tabBroker.isLeader() && state.sharedSocketOpen) {
      tabBroker.request("roster-snapshot", {}, 5_000).catch(() => undefined);
      return;
    }
    if (state.fallbackActive) pollFallbackSnapshot();
  }

  function applyDibsSnapshot(payload, { source, baselineSequence } = {}) {
    if (!core.dibsFeatureEnabled(state.settings)) {
      clearDibsState();
      return false;
    }
    const result = core.reconcileDibsSnapshot(state.dibs, payload, {
      source,
      applicationSequence: state.dibsApplicationSequence,
      baselineSequence,
    });
    if (!result.applied) return false;
    state.dibs = result.snapshot;
    state.dibsApplicationSequence = result.applicationSequence;
    return true;
  }

  function applyEvent(topic, payload, dibsSource, serverTime) {
    const eventServerTime = serverTime
      || payload?.serverTime
      || (topic === "war_dibs" ? payload?.generatedAt : undefined);
    syncTrustedClock(eventServerTime, `event:${topic}`);
    state.lastLiveDataAt = Date.now();
    if (topic === "war_tracker_settings") {
      state.settings = payload || null;
      if (!core.dibsFeatureEnabled(state.settings)) {
        clearDibsState();
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
    if (topic === "war_dibs") applyDibsSnapshot(payload, { source: dibsSource });
    scheduleRender();
    setTimeout(() => {
      maybeLoadEnemyLoadouts();
      evaluateNotifications();
    }, 0);
  }

  function applyFallbackSnapshot(snapshot) {
    syncTrustedClock(snapshot?.serverTime || snapshot?.generatedAt, "snapshot");
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
    applyDibsSnapshot(snapshot?.dibs, { source: "fallback-hydration" });
    state.fallbackRevision = String(snapshot?.revision || "");
    state.fallbackUnchangedCount = 0;
    scheduleRender();
    setTimeout(evaluateNotifications, 0);
  }

  function markFallbackSnapshotUnchanged(snapshot) {
    if (!snapshot?.unchanged || !state.fallbackRevision || snapshot.revision !== state.fallbackRevision) return false;
    syncTrustedClock(snapshot?.serverTime || snapshot?.generatedAt, "snapshot");
    state.lastLiveDataAt = Date.now();
    for (const factionId of state.rosters.keys()) state.rosterDataAt.set(factionId, state.lastLiveDataAt);
    state.fallbackUnchangedCount += 1;
    return true;
  }

  function sharedTransportPayload() {
    return {
      phase: state.phase,
      error: state.error,
      socketOpen: directSocketIsOpen(),
      socketOpenedAt: state.socketOpenedAt,
      fallbackActive: state.fallbackActive,
      lastFallbackAt: state.lastFallbackAt,
      lastFallbackError: state.lastFallbackError,
      lastLiveDataAt: state.lastLiveDataAt,
      generatedAt: new Date().toISOString(),
      serverTime: state.clockReady ? trustedNowMs() : null,
    };
  }

  function sharedStatePayload() {
    return {
      ...sharedTransportPayload(),
      settings: state.settings,
      rosters: Array.from(state.rosters.entries()),
      factionNames: Array.from(state.factionNames.entries()),
      scores: Array.from(state.scores.entries()),
      retaliation: state.retaliation,
      loadouts: Array.from(state.loadouts.entries()),
      dibs: state.dibs,
      rosterDataAt: Array.from(state.rosterDataAt.entries()),
      fallbackRevision: state.fallbackRevision,
    };
  }

  function publishSharedTransport() {
    if (sharedBrokerEnabled() && tabBroker.isLeader()) {
      tabBroker.broadcast("transport", sharedTransportPayload());
    }
  }

  function applySharedTransport(payload) {
    if (!payload || tabBroker?.isLeader()) return;
    const phase = String(payload.phase || "");
    state.sharedSocketOpen = payload.socketOpen === true && phase === "connected";
    state.sharedTransportPhase = phase;
    if (["connected", "fallback", "connecting", "authenticating", "error", "paused"].includes(phase)) {
      state.phase = phase;
    }
    state.error = String(payload.error || "");
    state.socketOpenedAt = Number(payload.socketOpenedAt || 0);
    state.lastLiveDataAt = Math.max(state.lastLiveDataAt, Number(payload.lastLiveDataAt || 0));
    state.lastFallbackAt = String(payload.lastFallbackAt || state.lastFallbackAt || "");
    state.lastFallbackError = String(payload.lastFallbackError || "");
    syncTrustedClock(payload.serverTime, "shared-tab");
    scheduleRender();
  }

  function applySharedState(payload) {
    if (!payload || tabBroker?.isLeader()) return;
    applySharedTransport(payload);
    state.settings = payload.settings || null;
    state.rosters = new Map(Array.isArray(payload.rosters) ? payload.rosters : []);
    state.factionNames = new Map(Array.isArray(payload.factionNames) ? payload.factionNames : []);
    state.scores = new Map(Array.isArray(payload.scores) ? payload.scores : []);
    state.retaliation = payload.retaliation || { attacks: [] };
    state.loadouts = new Map(Array.isArray(payload.loadouts) ? payload.loadouts : []);
    applyDibsSnapshot(payload.dibs, { source: "shared-hydration" });
    state.rosterDataAt = new Map(Array.isArray(payload.rosterDataAt) ? payload.rosterDataAt : []);
    state.fallbackRevision = String(payload.fallbackRevision || "");
    syncTargetDraft();
    scheduleRender();
    setTimeout(() => {
      maybeLoadEnemyLoadouts();
      evaluateNotifications();
    }, 0);
  }

  function handleTabBrokerData(type, payload) {
    if (type === "transport") {
      applySharedTransport(payload);
      return;
    }
    if (type === "state") {
      applySharedState(payload);
      return;
    }
    if (type === "event" && TOPICS.includes(String(payload?.topic || ""))) {
      applyEvent(String(payload.topic), payload.payload, "shared-live-event", payload.serverTime);
      return;
    }
    if (type === "snapshot") {
      applyFallbackSnapshot(payload);
      applySharedTransport({ phase: "fallback", socketOpen: false, generatedAt: payload?.generatedAt });
      return;
    }
    if (type === "snapshot-unchanged") {
      markFallbackSnapshotUnchanged(payload);
      applySharedTransport({ phase: "fallback", socketOpen: false, generatedAt: payload?.generatedAt });
    }
  }

  function handleTabBrokerRequest(type, payload) {
    if (!tabBroker?.isLeader()) throw new Error("This tab does not own the live connection");
    if (type === "state") return sharedStatePayload();
    if (type === "socket-action") {
      const action = String(payload?.action || "");
      if (!action) throw new Error("Live action is missing");
      return requestDirectSocketAction(action, payload?.payload || {});
    }
    if (type === "roster-snapshot") {
      requestDirectRosterSnapshot();
      return { accepted: true };
    }
    throw new Error("Unsupported shared Warbuddy request");
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
    if (!state.fallbackActive || !shouldRunOwnedTransport()) return;
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
    if (!state.session || !state.token || !shouldRunOwnedTransport()) return;
    if (!state.fallbackActive) state.fallbackFailureCount = 0;
    state.fallbackActive = true;
    pollFallbackSnapshot();
  }

  async function pollFallbackSnapshot() {
    if (!state.fallbackActive || state.fallbackInFlight || !shouldRunOwnedTransport()) return;
    const generation = state.fallbackGeneration;
    state.fallbackInFlight = true;
    clearFallbackTimer();
    try {
      if (sessionTokenNeedsRefresh()) {
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
      if (generation !== state.fallbackGeneration || !state.fallbackActive || !shouldRunOwnedTransport()) return;
      state.nowMs = trustedNowMs();
      const unchanged = markFallbackSnapshotUnchanged(snapshot);
      if (!unchanged) applyFallbackSnapshot(snapshot);
      state.phase = "fallback";
      state.error = "";
      state.lastFallbackAt = new Date().toISOString();
      state.lastFallbackError = "";
      state.fallbackFailureCount = 0;
      if (sharedBrokerEnabled() && tabBroker.isLeader()) {
        tabBroker.broadcast(unchanged ? "snapshot-unchanged" : "snapshot", snapshot);
      }
      publishSharedTransport();
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
      publishSharedTransport();
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
    const envelopeServerTime = message?.serverTime || message?.generatedAt;
    syncTrustedClock(envelopeServerTime, "websocket");
    if (message?.type === "event" && TOPICS.includes(String(message.topic || ""))) {
      applyEvent(String(message.topic), message.payload, "websocket", envelopeServerTime);
      if (sharedBrokerEnabled() && tabBroker.isLeader()) {
        tabBroker.broadcast("event", { topic: String(message.topic), payload: message.payload, serverTime: envelopeServerTime });
      }
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
      publishSharedTransport();
    }
  }

  function scheduleReconnect() {
    if (
      (!shouldRunOwnedTransport() && !localSessionNeedsRefresh())
      || state.reconnectTimer
      || state.authTerminal
    ) return;
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
    if (!getStoredKey() || state.authTerminal) return;
    syncTabBrokerNonce();
    const canAuthenticate = isForeground()
      || (sharedBrokerEnabled() && tabBroker.isLeader() && tabBroker.shouldOwnTransport());
    if (!canAuthenticate) return;
    if (state.socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(state.socket.readyState)) return;
    try {
      if (sessionTokenNeedsRefresh()) await authenticate();
      if (!getStoredKey() || !state.session || !state.token) return;
      syncTabBrokerIdentity();
      if (sharedBrokerEnabled() && !tabBroker.isLeader()) {
        state.phase = state.sharedTransportPhase || "connecting";
        if (tabBroker.hasLeader()) requestSharedState();
        scheduleRender();
        return;
      }
      if (!shouldRunOwnedTransport()) return;
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
        state.nowMs = trustedNowMs();
        state.socketOpenedAt = Date.now();
        state.authTerminal = false;
        state.reconnectAttempt = 0;
        state.error = "";
        state.lastSocketClose = null;
        subscribeTopics(socket);
        setTimeout(maybeLoadEnemyLoadouts, 0);
        void recordScriptCheckIn("websocket");
        scheduleRender();
        publishSharedTransport();
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
        if (!shouldRunOwnedTransport()) {
          state.phase = "paused";
          scheduleRender();
          publishSharedTransport();
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
        publishSharedTransport();
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
      publishSharedTransport();
      if (!state.authTerminal) scheduleReconnect();
    }
  }

  function hasTimeSensitiveState() {
    if (targetPageMemberId()) return targetPageFactionEligible(sessionView());
    if (state.settings?.enabled === false) return false;
    if (currentEnemyFactionId()) return true;
    if ((Array.isArray(state.dibs?.claims) ? state.dibs.claims : []).length > 0) return true;
    if ((Array.isArray(state.retaliation?.attacks) ? state.retaliation.attacks : []).length > 0) return true;
    return Array.from(state.scores.values()).some((score) => core.chainPresentation(score, state.nowMs).active);
  }

  function startTicker() {
    if (state.ticker) return;
    state.ticker = setInterval(() => {
      state.nowMs = trustedNowMs();
      if (syncTabBrokerNonce()) {
        syncTabBrokerIdentity();
        void ensureConnected();
      }
      if (
        sharedBrokerEnabled()
        && !tabBroker.isLeader()
        && tabBroker.hasLeader()
        && localSessionNeedsRefresh()
        && !state.authPromise
        && !state.reconnectTimer
      ) void ensureConnected();
      if (state.phase === "connected") void recordScriptCheckIn("websocket");
      if (state.phase === "fallback") void recordScriptCheckIn("compatible");
      const targetView = targetPageMemberId() ? sessionView() : null;
      if (targetView && !targetPageFactionEligible(targetView)) return;
      if (
        state.profileTargetId
        && !state.attackTargetId
        && state.displayMode !== "floating"
        && !targetPageContextRelevant(targetView)
      ) return;
      const renderInterval = hasTimeSensitiveState() ? TICKER_INTERVAL_MS : IDLE_RENDER_INTERVAL_MS;
      if ((!isTornPda || !state.fallbackActive) && Date.now() - state.lastRenderAt >= renderInterval) {
        scheduleRender();
      }
    }, TICKER_INTERVAL_MS);
  }

  function stopTicker() {
    if (state.ticker) clearInterval(state.ticker);
    state.ticker = 0;
  }

  function pauseLocalConnectionDemand() {
    if (sharedBrokerEnabled()) {
      tabBroker.setActive(false);
      if (tabBroker.shouldOwnTransport()) return true;
    }
    closeOwnedTransport("Paused");
    return false;
  }

  function syncForegroundState() {
    syncTabBrokerNonce();
    if (!state.active) {
      stopTicker();
      const retainedForPeer = pauseLocalConnectionDemand();
      if (!retainedForPeer) {
        state.phase = getStoredKey() ? "paused" : "idle";
        publishSharedTransport();
      }
      return;
    }
    if (isForeground()) {
      syncTabBrokerIdentity();
      if (getStoredKey() && !state.authTerminal) startTicker();
      else stopTicker();
      ensureConnected();
      return;
    }
    stopTicker();
    const retainedForPeer = pauseLocalConnectionDemand();
    if (!retainedForPeer) {
      state.phase = getStoredKey() ? "paused" : "idle";
      publishSharedTransport();
    }
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

  function tornRosterSortState(rows, board) {
    const rowParent = rows.find((row) => row?.parentElement)?.parentElement;
    const scope = rowParent?.parentElement || board;
    if (!scope?.querySelectorAll) return { column: "", order: "" };
    const definitions = [
      ["member", ["div.member > div", "div.name > div"]],
      ["level", ["div.level > div"]],
      ["points", ["div.points > div", "div.bsp > div", "div.est > div"]],
      ["status", ["div.status > div"]],
      ["activity", ["div.activity > div", "div.last-action > div", "div.lastAction > div"]],
      ["location", ["div.location > div"]],
    ];
    const activeNode = (node) => {
      const ariaSort = String(node?.getAttribute?.("aria-sort") || node?.closest?.("[aria-sort]")?.getAttribute?.("aria-sort") || "").toLowerCase();
      const className = String(node?.className || "");
      return ["ascending", "descending"].includes(ariaSort) || className.includes("activeIcon__");
    };
    for (const [column, selectors] of definitions) {
      for (const selector of selectors) {
        const node = Array.from(scope.querySelectorAll(selector)).find(activeNode);
        if (!node) continue;
        const signature = `${node.className || ""} ${node.closest?.("[aria-sort]")?.getAttribute?.("aria-sort") || ""}`;
        return {
          column,
          order: /asc__|ascending/i.test(signature) ? "asc" : "desc",
        };
      }
    }
    const active = scope.querySelector('[aria-sort="ascending"], [aria-sort="descending"], [class*="activeIcon__"]');
    if (!active) return { column: "", order: "" };
    let candidate = active;
    for (let depth = 0; candidate && candidate !== scope && depth < 4; depth += 1, candidate = candidate.parentElement) {
      const signature = `${candidate.className || ""} ${candidate.textContent || ""}`.toLowerCase();
      const matched = definitions.find(([column]) => signature.includes(column));
      if (matched) {
        return {
          column: matched[0],
          order: /asc__|ascending/i.test(`${active.className || ""} ${active.getAttribute?.("aria-sort") || ""}`) ? "asc" : "desc",
        };
      }
    }
    return { column: "other", order: "" };
  }

  function rankedWarStatusCell(row, attackLink) {
    if (!row || !attackLink || !row.contains?.(attackLink)) return null;
    for (let candidate = attackLink; candidate && candidate !== row; candidate = candidate.parentElement) {
      const parent = candidate.parentElement;
      if (!parent || !row.contains?.(parent)) continue;
      let previous = candidate.previousElementSibling;
      if (previous?.classList?.contains?.(ROSTER_ACTIONS_CLASS)) previous = previous.previousElementSibling;
      if (previous && Number(parent.children?.length || 0) >= 4) {
        return previous;
      }
    }
    return null;
  }

  function tornStatusCategory(statusCell) {
    if (!statusCell) return "";
    const originalText = Array.from(statusCell.childNodes || [])
      .filter((node) => !(node?.nodeType === 1 && node.classList?.contains?.(STATUS_DETAIL_CLASS)))
      .map((node) => String(node?.textContent || ""))
      .join(" ");
    const originalClasses = [statusCell, ...Array.from(statusCell.querySelectorAll?.("*") || [])]
      .filter((node) => !node.classList?.contains?.(STATUS_DETAIL_CLASS))
      .map((node) => String(node.className || ""))
      .join(" ");
    const signature = `${originalText} ${originalClasses}`.replace(/\s+/g, " ").trim().toLowerCase();
    if (/hospital|jail/.test(signature)) return "hospital";
    if (/travel|abroad|returning|flying/.test(signature)) return "traveling";
    if (/\bokay\b|available/.test(signature)) return "available";
    return "";
  }

  function clearIntegratedStatusCell(statusCell, clearMismatch = true) {
    if (!statusCell) return;
    statusCell.classList.remove(STATUS_CELL_CLASS);
    if (clearMismatch) statusCell.classList.remove(STATUS_MISMATCH_CLASS);
    statusCell.querySelectorAll?.(`.${STATUS_DETAIL_CLASS}`).forEach((detail) => detail.remove());
    delete statusCell.dataset.warbuddyStatusMemberId;
    if (clearMismatch) delete statusCell.dataset.warbuddyStatusMismatch;
  }

  function syncIntegratedStatusCell(row, attackLink, memberId, availability, keepStatusCells) {
    const statusCell = rankedWarStatusCell(row, attackLink);
    if (!statusCell) return;
    const tornCategory = tornStatusCategory(statusCell);
    const backendCategory = core.availabilityCategory(availability);
    const mismatch = !!tornCategory && !!backendCategory && tornCategory !== backendCategory;
    statusCell.classList.toggle(STATUS_MISMATCH_CLASS, mismatch);
    if (mismatch) {
      keepStatusCells.add(statusCell);
      clearIntegratedStatusCell(statusCell, false);
      statusCell.dataset.warbuddyStatusMismatch = `${tornCategory}:${backendCategory}`;
      return;
    }
    delete statusCell.dataset.warbuddyStatusMismatch;
    if (!availability?.label || (tornCategory && !backendCategory)) {
      clearIntegratedStatusCell(statusCell);
      return;
    }
    keepStatusCells.add(statusCell);
    statusCell.classList.add(STATUS_CELL_CLASS);
    if (statusCell.dataset.warbuddyStatusMemberId !== String(memberId)) {
      statusCell.dataset.warbuddyStatusMemberId = String(memberId);
    }
    let detail = statusCell.querySelector?.(`.${STATUS_DETAIL_CLASS}`);
    if (!detail) {
      detail = document.createElement("span");
      statusCell.appendChild(detail);
    }
    const className = `${STATUS_DETAIL_CLASS} ${String(availability.state || "")} ${String(availability.tone || "")}`.trim();
    const title = availability.title || availability.label;
    if (detail.className !== className) detail.className = className;
    if (detail.textContent !== availability.label) detail.textContent = availability.label;
    if (detail.title !== title) detail.title = title;
    if (detail.getAttribute?.("aria-label") !== title) detail.setAttribute("aria-label", title);
  }

  function handleDibsControlAction(event, control = event.target?.closest?.("[data-dibs-action]")) {
    if (!control || !event.currentTarget?.contains?.(control)) return false;
    event.preventDefault();
    event.stopPropagation();
    const memberId = Number(control.dataset?.dibsTarget || 0);
    const instanceKey = String(control.dataset?.dibsInstance || `member-${memberId}`);
    const action = String(control.dataset?.dibsAction || "");
    if (!Number.isSafeInteger(memberId) || memberId <= 0) return true;
    if (action === "close") {
      closeDibsDetails();
      control.blur?.();
      scheduleRender();
      return true;
    }
    if (action === "inspect") {
      if (state.dibsInspectTargetId === memberId && state.dibsInspectKey === instanceKey) {
        closeDibsDetails();
      } else {
        state.dibsInspectTargetId = memberId;
        state.dibsInspectKey = instanceKey;
      }
      scheduleRender();
      return true;
    }
    if (action === "claim" || action === "release") void updateDibs(action, memberId, instanceKey);
    return true;
  }

  function handleInlineToolAction(event) {
    if (handleDibsControlAction(event)) return;
    const control = event.target?.closest?.("[data-inline-action]");
    if (!control || !event.currentTarget?.contains?.(control)) return;
    const memberId = Number(event.currentTarget.dataset?.memberId || 0);
    if (!Number.isSafeInteger(memberId) || memberId <= 0) return;
    event.preventDefault();
    event.stopPropagation();
    const action = String(control.dataset?.inlineAction || "");
    if (action === "watch") void toggleWatchedTarget(memberId);
  }

  function dibsClaimContext(member, view, claim) {
    if (!state.clockReady) {
      return { eligible: false, state: "clock_syncing", reason: "Synchronizing server time." };
    }
    const claimantPlayerId = claim?.claimedByPlayerId || state.session?.playerId;
    const claimant = (view?.ownRoster || []).find((candidate) => (
      Number(candidate?.member_id || 0) === Number(claimantPlayerId || 0)
    ));
    return core.dibsClaimEligibility({
      claimant,
      target: member,
      claimantName: claim ? String(claim.claimedByPlayerName || claim.claimedByPlayerId || "Claim holder") : "You",
      claimantRosterFresh: rosterIsFresh(view?.ownFactionId),
      targetRosterFresh: rosterIsFresh(view?.enemyFactionId),
    }, state.nowMs);
  }

  function ensureInlineMemberTools(anchor, memberId) {
    const parent = anchor?.parentElement;
    if (!parent) return null;
    let tools = Array.from(parent.querySelectorAll?.(`.${INLINE_TOOLS_CLASS}`) || [])
      .find((candidate) => Number(candidate.dataset?.memberId || 0) === Number(memberId || 0));
    if (tools) return tools;
    tools = document.createElement("span");
    tools.className = INLINE_TOOLS_CLASS;
    tools.dataset.memberId = String(memberId);
    tools.addEventListener("click", handleInlineToolAction);
    if (typeof anchor.insertAdjacentElement === "function") anchor.insertAdjacentElement("afterend", tools);
    else parent.insertBefore(tools, anchor.nextSibling || null);
    return tools;
  }

  function syncIntegratedMemberTools(view = sessionView()) {
    const canFindBoard = state.active
      && isRosterModePage(view)
      && Array.isArray(view?.enemyRoster)
      && view.enemyRoster.length > 0;
    if (!canFindBoard) {
      if (state.integratedDecorationsActive) removeInlineMemberTools();
      return;
    }
    const signedBoard = rankedWarBoardForView(view);
    const board = signedBoard?.isConnected === false ? null : signedBoard;
    const verifiedBoard = board || rankedWarUnsignedRosterCluster(view.enemyRoster);
    markRankedWarBoard(verifiedBoard);
    const enemyEntries = rankedWarEnemyRowEntries(view.enemyRoster, verifiedBoard);
    if (!enemyEntries.length) {
      if (state.integratedDecorationsActive) removeInlineMemberTools();
      return;
    }
    state.integratedDecorationsActive = true;

    const members = new Map(view.enemyRoster.map((member) => [Number(member?.member_id || 0), member]));
    const watchedIds = new Set(savedTargetIds());
    const retaliations = new Map((view.retaliation || []).map((attack) => [Number(attack?.attackerId || 0), attack]));
    const actionableIds = new Set((view.actions || [])
      .map((action) => Number(action?.memberId || 0))
      .filter((memberId) => Number.isSafeInteger(memberId) && memberId > 0));
    const keep = new Set();
    const keepRows = new Set();
    const keepAttackLinks = new Set();
    const keepActionCells = new Set();
    const keepRosterActions = new Set();
    const keepStatusCells = new Set();
    const decoratedRows = [];
    for (const { anchor, memberId, row } of enemyEntries) {
      const member = members.get(memberId);
      if (!member) continue;
      keep.add(memberId);
      const parent = anchor.parentElement;
      if (!parent) continue;
      const tools = ensureInlineMemberTools(anchor, memberId);
      if (!tools) continue;

      const watched = watchedIds.has(memberId);
      const watchBusy = state.targetQuickBusyId === memberId;
      const claim = core.dibsFeatureEnabled(state.settings)
        ? core.activeDibsClaim(view.dibs, memberId, state.nowMs)
        : undefined;
      const isMine = !!claim && String(claim.claimedByPlayerId || "") === String(state.session?.playerId || "");
      const dibsRemaining = claim ? core.duration(core.toTimestampMs(claim.expiresAt) - state.nowMs) : "";
      const claimEligibility = claim ? dibsClaimContext(member, view, claim) : undefined;
      const claimWarning = claim && !claimEligibility?.eligible ? ` - ${claimEligibility.reason}` : "";
      const dibsLabel = claim
        ? `${isMine ? "Your Dibs" : `Dibs: ${claim.claimedByPlayerName || claim.claimedByPlayerId}`} - ${dibsRemaining} left${claimWarning}`
        : "";
      const retaliation = retaliations.get(memberId);
      const retaliationLabel = retaliation
        ? `Retaliation - ${core.duration((Number(retaliation.expiresAt || 0) * 1000) - state.nowMs)} left`
        : "";
      const retaliationTitle = retaliation
        ? `Hospitalizing ${member.member_name || `Player ${memberId}`} counts as a retaliation. ${retaliationLabel}`
        : "";
      const retaliationRemaining = retaliation
        ? core.duration((Number(retaliation.expiresAt || 0) * 1000) - state.nowMs)
        : "";
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
        if (row.dataset.warbuddyMemberRow !== "1") row.dataset.warbuddyMemberRow = "1";
        if (row.dataset.warbuddyMemberId !== String(memberId)) row.dataset.warbuddyMemberId = String(memberId);
        row.classList.toggle("warbuddy-row-retal", flags.retaliation);
        row.classList.toggle("warbuddy-row-actionable", flags.actionable && !flags.retaliation);
        row.classList.toggle("warbuddy-roster-hidden", !core.rosterFilterMatches(state.rosterFilter, flags));
        const priority = String(core.rosterOrder(flags, member, state.nowMs));
        if (row.dataset.warbuddyPriority !== priority) row.dataset.warbuddyPriority = priority;
        if (row.dataset.warbuddyAvailability !== availability.state) row.dataset.warbuddyAvailability = availability.state;
      }

      const attackLink = rankedWarAttackLinkForMember(row, memberId);
      syncIntegratedStatusCell(row, attackLink, memberId, availability, keepStatusCells);
      if (attackLink) {
        keepAttackLinks.add(attackLink);
        const baseTitle = String(attackLink.title || "").replace(/\s*-?\s*Warbuddy:.*$/i, "").trim();
        const attackState = isMine ? "mine" : claim ? "taken" : retaliation ? "retaliation" : "free";
        if (attackLink.dataset.warbuddyAttackState !== attackState) attackLink.dataset.warbuddyAttackState = attackState;
        attackLink.classList.toggle("warbuddy-attack-dibs-mine", isMine);
        attackLink.classList.toggle("warbuddy-attack-dibs-taken", !!claim && !isMine);
        attackLink.classList.toggle("warbuddy-attack-retal", !!retaliation);
        const attackTitle = claim || retaliation
          ? [baseTitle, `Warbuddy: ${[dibsLabel, retaliationLabel].filter(Boolean).join(" · ")}`].filter(Boolean).join(" - ")
          : baseTitle;
        if (attackLink.title !== attackTitle) attackLink.title = attackTitle;

        const actionParent = attackLink.parentElement;
        if (actionParent) {
          actionParent.classList.add("warbuddy-roster-action-cell");
          keepActionCells.add(actionParent);
        }
        let rosterActions = Array.from(actionParent?.querySelectorAll?.(`.${ROSTER_ACTIONS_CLASS}`) || [])
          .find((candidate) => Number(candidate.dataset?.memberId || 0) === memberId);
        if (!rosterActions && actionParent) {
          rosterActions = document.createElement("span");
          rosterActions.className = ROSTER_ACTIONS_CLASS;
          rosterActions.dataset.memberId = String(memberId);
          rosterActions.addEventListener("click", handleInlineToolAction);
          actionParent.insertBefore(rosterActions, attackLink);
        }
        if (rosterActions) {
          keepRosterActions.add(rosterActions);
          const rosterDibsControl = state.rosterDibsButtons
            ? dibsMarkup(member, view, claim, `roster-${memberId}`)
            : "";
          const rosterMarkup = rosterDibsControl;
          if (inlineMarkupCache.get(rosterActions) !== rosterMarkup) {
            rosterActions.innerHTML = rosterMarkup;
            inlineMarkupCache.set(rosterActions, rosterMarkup);
          }
        }
        attackLink.classList.toggle("warbuddy-attack-has-dibs", state.rosterDibsButtons);
      }
      tools.classList.toggle("quiet", !state.rosterDibsButtons && !watched && !retaliation && !claim);
      const fallbackDibsState = !attackLink && claim
        ? `<span class="wc-native-state wc-native-dibs ${isMine ? "mine" : "taken"}" title="${escapeHtml(dibsLabel)}">${escapeHtml(isMine ? `Your Dibs ${dibsRemaining}` : `Dibsed ${dibsRemaining}`)}</span>`
        : "";
      const fallbackDibsControl = !attackLink && state.rosterDibsButtons
        ? dibsMarkup(member, view, claim, `roster-fallback-${memberId}`)
        : "";
      const toolsMarkup = `<button type="button" class="wc-inline-watch${watched ? " active" : ""}" data-inline-action="watch" aria-label="${watched ? "Stop watching" : "Watch"} ${escapeHtml(member.member_name || `Player ${memberId}`)}" title="${watched ? "Stop watching" : "Watch target"}"${watchBusy ? " disabled" : ""}>${watched ? "&#9733;" : "&#9734;"}</button>${!attackLink && retaliation ? `<a class="wc-inline-retal" href="${escapeHtml(retaliation.attackUrl || core.attackUrl(memberId))}" target="_blank" rel="noopener noreferrer" aria-label="${escapeHtml(retaliationTitle)}" title="${escapeHtml(retaliationTitle)}">Hosp = Retal ${escapeHtml(retaliationRemaining)}</a>` : ""}${fallbackDibsState}${fallbackDibsControl}`;
      if (inlineMarkupCache.get(tools) !== toolsMarkup) {
        tools.innerHTML = toolsMarkup;
        inlineMarkupCache.set(tools, toolsMarkup);
      }
    }

    let activeSortParent = null;
    const tornSort = tornRosterSortState(decoratedRows, verifiedBoard);
    const ffscouterOwnsOrder = state.rosterPrioritySort && ffscouterFilterActive();
    const tornOwnsOrder = state.rosterPrioritySort && !core.rosterPriorityAllowedForSort(tornSort.column);
    const externalSortReason = ffscouterOwnsOrder
      ? "FFScouter filtering"
      : tornOwnsOrder
        ? `Torn's ${tornSort.column} sort`
        : "";
    const sortLabel = document.querySelector?.(`#${PANEL_ID} .wc-roster-sort`);
    sortLabel?.classList.toggle("paused", !!externalSortReason);
    if (sortLabel) {
      sortLabel.title = externalSortReason
        ? `Warbuddy ordering is paused while ${externalSortReason} is active.`
        : "Prioritize Retals, Dibs, watched targets, and useful availability states.";
    }
    if (state.rosterPrioritySort && !externalSortReason && decoratedRows.length > 1) {
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
            const order = String(Number(row.dataset.warbuddyPriority || 0));
            if (row.style.order !== order) row.style.order = order;
          });
        }
      }
    }

    document.querySelectorAll?.(`.${INLINE_TOOLS_CLASS}`).forEach((tools) => {
      if (!keep.has(Number(tools.dataset?.memberId || 0))) tools.remove();
    });
    document.querySelectorAll?.(`.${ROSTER_ACTIONS_CLASS}`).forEach((actions) => {
      if (!keepRosterActions.has(actions)) actions.remove();
    });
    document.querySelectorAll?.(".warbuddy-roster-action-cell").forEach((actionCell) => {
      if (!keepActionCells.has(actionCell)) actionCell.classList.remove("warbuddy-roster-action-cell");
    });
    document.querySelectorAll?.(`.${STATUS_CELL_CLASS}, .${STATUS_MISMATCH_CLASS}`).forEach((cell) => {
      if (keepStatusCells.has(cell)) return;
      clearIntegratedStatusCell(cell);
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
      link.classList.remove("warbuddy-attack-dibs-mine", "warbuddy-attack-dibs-taken", "warbuddy-attack-retal", "warbuddy-attack-has-dibs");
      link.title = String(link.title || "").replace(/\s*-?\s*Warbuddy:.*$/i, "").trim();
      delete link.dataset.warbuddyAttackState;
    });
  }

  function dibsMarkup(member, view, knownClaim, instanceKey) {
    if (!core.dibsFeatureEnabled(state.settings)) return "";
    const memberId = Number(member?.member_id || 0);
    if (!Number.isSafeInteger(memberId) || memberId <= 0) return "";
    const claim = knownClaim || core.activeDibsClaim(view.dibs, memberId, state.nowMs);
    const eligibility = dibsClaimContext(member, view, claim);
    const isMine = !!claim && String(claim.claimedByPlayerId || "") === String(state.session?.playerId || "");
    const busy = state.dibsBusyTargetId === memberId;
    const anyBusy = state.dibsBusyTargetId > 0 || state.targetsSaving || state.targetQuickBusyId > 0;
    const canMutate = isOnline()
      && rosterIsFresh(view.ownFactionId)
      && rosterIsFresh(view.enemyFactionId)
      && !state.authTerminal && !state.keySaving && !state.targetsSaving && !state.targetQuickBusyId;
    const canClaim = !claim && eligibility.eligible && canMutate;
    const tone = isMine ? "mine" : claim ? "taken" : canClaim ? "" : "unavailable";
    const canRelease = isOnline()
      && !state.authTerminal && !state.keySaving && !state.targetsSaving && !state.targetQuickBusyId;
    const remaining = claim ? core.duration(core.toTimestampMs(claim.expiresAt) - state.nowMs) : "";
    const unavailableReason = eligibility.eligible
      ? "Waiting for a fresh live connection."
      : eligibility.reason;
    const label = claim
      ? `Dibs: ${claim.claimedByPlayerName || claim.claimedByPlayerId} - ${remaining} left${eligibility.eligible ? "" : ` - ${eligibility.reason}`}`
      : canClaim
        ? eligibility.state === "hospitalized"
          ? `Claim Dibs - leaves hospital in ${core.duration(Number(eligibility.hospitalUntil || 0) - state.nowMs)} - ${eligibility.reason}`
          : `Claim Dibs - attackable now - ${eligibility.reason}`
        : `Dibs unavailable - ${unavailableReason}`;
    const action = claim || !canClaim ? "inspect" : "claim";
    const dibsInstanceKey = String(instanceKey || `member-${memberId}`);
    const open = state.dibsInspectTargetId === memberId && state.dibsInspectKey === dibsInstanceKey ? " open" : "";
    const disabled = anyBusy;
    const release = isMine
      ? `<button type="button" class="wc-dibs-release" data-dibs-action="release" data-dibs-target="${memberId}" data-dibs-instance="${escapeHtml(dibsInstanceKey)}" data-focus-key="dibs-release-${escapeHtml(dibsInstanceKey)}"${!canRelease || anyBusy ? " disabled" : ""}>${busy && state.dibsBusyAction === "release" ? "Releasing..." : "Release & unwatch"}</button>`
      : "";
    const error = state.dibsError && state.dibsErrorTargetId === memberId
      ? `<div class="wc-target-error" role="alert">${escapeHtml(state.dibsError)}</div>`
      : "";
    const busyLabel = busy && state.dibsBusyAction === "claim" ? "Claiming Dibs" : label;
    return `<span class="wc-dibs-wrap${open}" data-dibs-instance="${escapeHtml(dibsInstanceKey)}"><button type="button" class="wc-dibs ${tone}" data-dibs-action="${action}" data-dibs-target="${memberId}" data-dibs-instance="${escapeHtml(dibsInstanceKey)}" data-focus-key="dibs-${escapeHtml(dibsInstanceKey)}" aria-label="${escapeHtml(busyLabel)}" aria-expanded="${open ? "true" : "false"}"${busy ? ' aria-busy="true"' : ""} title="${escapeHtml(label)}"${disabled ? " disabled" : ""}>&#9995;</button><span class="wc-dibs-tip" role="status"><button type="button" class="wc-dibs-close" data-dibs-action="close" data-dibs-target="${memberId}" data-dibs-instance="${escapeHtml(dibsInstanceKey)}" aria-label="Close Dibs details" title="Close">&times;</button>${escapeHtml(label)}${error}${release}</span></span>`;
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
        const eligibility = option.member ? dibsClaimContext(option.member, view) : undefined;
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
    if (sessionTokenNeedsRefresh()) await authenticate();
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
    const currentEnemy = sessionView().enemyRoster.some((member) => Number(member?.member_id || 0) === memberId);
    if (!wasWatched && !currentEnemy) {
      state.targetQuickError = "Only current war opponents can be added to watched targets.";
      scheduleRender();
      return;
    }
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
    if (!isOnline() || state.authTerminal || state.keySaving) {
      showDibsError("Dibs is unavailable until Warbuddy has a fresh live connection.", memberId);
      scheduleRender();
      return false;
    }
    if (action === "claim") {
      state.nowMs = trustedNowMs();
      const view = sessionView();
      const target = view.enemyRoster.find((member) => Number(member?.member_id || 0) === memberId);
      const eligibility = dibsClaimContext(target, view);
      if (!eligibility.eligible) {
        showDibsError(eligibility.reason, memberId);
        scheduleRender();
        return false;
      }
    }
    const dibsMutationBaselineSequence = state.dibsApplicationSequence;
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
      if (sessionTokenNeedsRefresh()) await authenticate();
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
      syncTrustedClock(response?.serverTime, "dibs-response");
      applyDibsSnapshot(response, {
        source: "mutation-response",
        baselineSequence: dibsMutationBaselineSequence,
      });
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
    const claim = core.activeDibsClaim(state.dibs, targetMemberId, trustedNowMs());
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
    if (element?.closest?.(`#${PANEL_ID}, #${TARGET_CONTEXT_ID}`)) return;
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

  function targetPageFactionEligible(view = sessionView()) {
    const registeredFactionId = String(state.session?.factionId || "");
    const ownFactionId = String(view?.ownFactionId || "");
    const enemyFactionId = String(view?.enemyFactionId || "");
    return !!registeredFactionId
      && !!state.token
      && state.authTerminal !== true
      && state.session?.access === "war_companion"
      && state.session?.enabledModules?.war_planner !== false
      && registeredFactionId === ownFactionId
      && state.settings?.enabled !== false
      && !!view?.alliedScore?.start
      && !!enemyFactionId
      && enemyFactionId !== ownFactionId;
  }

  function targetPageContextRelevant(view = sessionView()) {
    const memberId = targetPageMemberId();
    if (!memberId || !targetPageFactionEligible(view)) return false;
    if (state.attackTargetId) return true;
    return !!state.profileTargetId;
  }

  function attackTargetLabelsContainer() {
    const targetId = Number(state.attackTargetId || 0);
    const candidates = Array.from(document.querySelectorAll?.("[class*='labelsContainer']") || [])
      .filter((candidate) => candidate?.isConnected !== false);
    const matchesTargetProfile = (scope) => Array.from(scope?.querySelectorAll?.("a[href*='profiles.php']") || [])
        .some((anchor) => core.profileMemberIdFromUrl(anchor.getAttribute?.("href") || anchor.href || "") === targetId);
    const defenderCandidates = candidates
      .map((candidate) => ({ candidate, defender: candidate.closest?.("[class*='defender']") || null }))
      .filter(({ defender }) => !!defender);
    const matchedDefender = defenderCandidates.find(({ defender }) => matchesTargetProfile(defender));
    if (matchedDefender) return matchedDefender.candidate;
    if (defenderCandidates.length === 1) return defenderCandidates[0].candidate;
    const locallyMatched = candidates.filter((candidate) => matchesTargetProfile(candidate.parentElement));
    return locallyMatched.length === 1 ? locallyMatched[0] : null;
  }

  function nativeAnchorRect(node) {
    const rect = node?.getBoundingClientRect?.();
    if (!rect) return null;
    const left = Number(rect.left);
    const right = Number(rect.right);
    const top = Number(rect.top);
    const bottom = Number(rect.bottom);
    const width = Number(rect.width ?? (right - left));
    const height = Number(rect.height ?? (bottom - top));
    if (![left, right, top, bottom, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
    return { left, right, top, bottom, width, height };
  }

  function profileNameAnchor() {
    const memberId = Number(state.profileTargetId || 0);
    if (!memberId) return null;
    const idToken = `[${memberId}]`;
    const candidates = Array.from(document.querySelectorAll?.("h1, h2, h3, h4, [role='heading']") || [])
      .filter((candidate) => candidate?.isConnected !== false)
      .filter((candidate) => !candidate.closest?.(`#${TARGET_CONTEXT_ID}, #${ROSTER_CONTEXT_ID}`))
      .map((candidate) => ({
        candidate,
        text: String(candidate.textContent || "").replace(/\s+/g, " ").trim(),
        rect: nativeAnchorRect(candidate),
      }))
      .filter(({ text, rect }) => !!rect && text.includes(idToken));
    candidates.sort((left, right) => (
      Number(!/^H[1-4]$/i.test(String(left.candidate?.tagName || "")))
      - Number(!/^H[1-4]$/i.test(String(right.candidate?.tagName || "")))
      || left.text.length - right.text.length
      || left.rect.top - right.rect.top
    ));
    if (candidates.length) return candidates[0].candidate;
    const main = document.querySelector?.("#mainContainer, main, [role='main']") || null;
    const fallback = main?.querySelector?.("h1, h2, h3, h4, [role='heading']") || null;
    return nativeAnchorRect(fallback) ? fallback : null;
  }

  function rankedWarFilterAnchor() {
    const scope = rankedWarMainContent() || document;
    const candidates = Array.from(scope?.querySelectorAll?.(
      "h1, h2, h3, h4, [role='heading'], [class*='title'], [class*='header']"
    ) || [])
      .filter((candidate) => candidate?.isConnected !== false)
      .filter((candidate) => !candidate.closest?.(`#${PANEL_ID}, #${TARGET_CONTEXT_ID}, #${ROSTER_CONTEXT_ID}`))
      .map((candidate) => ({
        candidate,
        text: String(candidate.textContent || "").replace(/\s+/g, " ").trim(),
        rect: nativeAnchorRect(candidate),
      }))
      .filter(({ text, rect }) => !!rect && /^ranked\s+war\s+filter(?:\s*&\s*sort\s+controls)?$/i.test(text));
    candidates.sort((left, right) => (
      (left.rect.width * left.rect.height) - (right.rect.width * right.rect.height)
      || left.rect.top - right.rect.top
    ));
    return candidates[0]?.candidate || null;
  }

  function rankedWarFilterBar(anchor = rankedWarFilterAnchor()) {
    const main = rankedWarMainContent();
    if (!anchor || !main?.contains?.(anchor)) return null;
    let bar = anchor;
    for (let candidate = anchor, depth = 0; candidate && candidate !== main && depth < 6; depth += 1, candidate = candidate.parentElement) {
      const text = String(candidate.textContent || "").replace(/\s+/g, " ").trim();
      const rect = nativeAnchorRect(candidate);
      if (!rect || !/^ranked\s+war\s+filter(?:\s*&\s*sort\s+controls)?$/i.test(text) || rect.height > 64) break;
      bar = candidate;
    }
    return bar;
  }

  function rankedWarRosterContextMountPoint() {
    const bar = rankedWarFilterBar();
    if (!bar?.parentElement || bar.isConnected === false) return null;
    let child = bar;
    let parent = bar.parentElement;
    for (let depth = 0; parent && depth < 5; depth += 1) {
      if (parent === document.body || parent === document.documentElement) break;
      const display = typeof getComputedStyle === "function"
        ? String(getComputedStyle(parent)?.display || "").toLowerCase()
        : "block";
      if (!display || SAFE_INTEGRATED_PARENT_DISPLAYS.has(display)) {
        let before = child.nextSibling || null;
        if (before?.id === ROSTER_CONTEXT_ID) before = before.nextSibling || null;
        return { parent, before, anchor: bar };
      }
      child = parent;
      parent = parent.parentElement;
    }
    return null;
  }

  function positionNativeOverlay(context, anchor, placement) {
    if (!context) return false;
    const anchorRect = nativeAnchorRect(anchor);
    context.classList?.toggle?.("wc-native-overlay-fallback", !anchorRect);
    if (!anchorRect) {
      context.style?.removeProperty?.("left");
      context.style?.removeProperty?.("top");
      context.style?.removeProperty?.("right");
      if (context.style) context.style.visibility = "visible";
      return false;
    }
    if (context.style) context.style.visibility = "hidden";
    const contextRect = context.getBoundingClientRect?.();
    const width = Math.max(18, Number(context.offsetWidth || contextRect?.width || 0));
    const height = Math.max(18, Number(context.offsetHeight || contextRect?.height || 0));
    const viewport = window.visualViewport;
    const viewportLeft = Number(viewport?.offsetLeft || 0);
    const viewportTop = Number(viewport?.offsetTop || 0);
    const viewportWidth = Number(viewport?.width || window.innerWidth || document.documentElement?.clientWidth || 320);
    const viewportHeight = Number(viewport?.height || window.innerHeight || document.documentElement?.clientHeight || 480);
    const viewportRight = viewportLeft + viewportWidth;
    const viewportBottom = viewportTop + viewportHeight;
    if (
      anchorRect.bottom < viewportTop
      || anchorRect.top > viewportBottom
      || anchorRect.right < viewportLeft
      || anchorRect.left > viewportRight
    ) {
      if (context.style) context.style.visibility = "hidden";
      return true;
    }
    let left;
    let top;
    if (placement === "profile") {
      left = anchorRect.right + 8;
      top = anchorRect.top + ((anchorRect.height - height) / 2);
    } else if (placement === "roster-main") {
      left = anchorRect.right - width - 8;
      top = anchorRect.top + 8;
    } else if (placement === "roster") {
      const rosterMainRect = nativeAnchorRect(rankedWarMainContent());
      left = (rosterMainRect?.right || anchorRect.right) - width - 6;
      top = anchorRect.top + ((anchorRect.height - height) / 2);
    } else {
      left = anchorRect.right - width - 6;
      top = anchorRect.top + ((anchorRect.height - height) / 2);
    }
    left = Math.max(viewportLeft + 8, Math.min(left, viewportRight - width - 8));
    top = Math.max(viewportTop + 4, Math.min(top, viewportBottom - height - 4));
    context.style?.removeProperty?.("right");
    context.style?.removeProperty?.("bottom");
    if (context.style) {
      const setCoordinate = (property, value) => {
        if (typeof context.style.setProperty === "function") context.style.setProperty(property, value, "important");
        else context.style[property] = value;
      };
      setCoordinate("left", `${Math.round(left)}px`);
      setCoordinate("top", `${Math.round(top)}px`);
      context.style.visibility = "visible";
    }
    return true;
  }

  function repositionNativeOverlays() {
    const targetContext = document.getElementById(TARGET_CONTEXT_ID);
    if (targetContext && state.profileTargetId) {
      positionNativeOverlay(targetContext, profileNameAnchor(), "profile");
      positionOpenDibsTip(targetContext);
    }
  }

  function scheduleNativeOverlayPosition() {
    if (state.overlayFrame || document.visibilityState === "hidden") return;
    state.overlayFrame = requestAnimationFrame(() => {
      state.overlayFrame = 0;
      repositionNativeOverlays();
    });
  }

  function targetContextMountPoint() {
    if (state.attackTargetId) {
      const attackMount = attackTargetLabelsContainer();
      if (!attackMount) return null;
      return { parent: attackMount, before: null, placement: "attack" };
    }
    if (!state.profileTargetId) return null;
    if (!document.body) return null;
    return {
      parent: document.body,
      before: null,
      placement: "profile",
      tagName: "div",
      anchor: profileNameAnchor(),
      overlay: true,
    };
  }

  function targetContextMarkup(view) {
    const memberId = targetPageMemberId();
    if (!memberId) return "";
    const enemyMember = view.enemyRoster.find((candidate) => Number(candidate?.member_id || 0) === memberId);
    const member = enemyMember
      || Array.from(state.rosters.values())
        .flatMap((snapshot) => Array.isArray(snapshot) ? snapshot : Array.isArray(snapshot?.members) ? snapshot.members : [])
        .find((candidate) => Number(candidate?.member_id || 0) === memberId);
    const watched = savedTargetIds().includes(memberId);
    const atLimit = !watched && savedTargetIds().length >= MAX_WATCHED_TARGETS;
    const busy = state.targetQuickBusyId === memberId;
    const watchUnavailable = !isOnline()
      || state.authTerminal
      || state.targetQuickBusyId > 0
      || state.targetsSaving
      || (!watched && !currentEnemyRosterIsFresh());
    const activeRetaliation = view.retaliation.find((attack) => Number(attack?.attackerId || 0) === memberId);
    const name = String(member?.member_name || activeRetaliation?.attackerName || `Player ${memberId}`);
    const claim = core.dibsFeatureEnabled(state.settings)
      ? core.activeDibsClaim(view.dibs, memberId, state.nowMs)
      : undefined;
    const targetRecord = member || { member_id: memberId, member_name: name };
    const isMine = !!claim && String(claim.claimedByPlayerId || "") === String(state.session?.playerId || "");
    const dibsRemaining = claim ? core.duration(core.toTimestampMs(claim.expiresAt) - state.nowMs) : "";
    const dibsOwner = String(claim?.claimedByPlayerName || claim?.claimedByPlayerId || "another member");
    const dibsTitle = claim
      ? `${isMine ? "Your Dibs" : `Dibsed by ${dibsOwner}`} - ${dibsRemaining} left`
      : "";
    const retaliationRemaining = activeRetaliation
      ? core.duration((Number(activeRetaliation.expiresAt || 0) * 1000) - state.nowMs)
      : "";
    const retaliationTitle = activeRetaliation
      ? `Hospitalizing ${name} counts as a retaliation. ${retaliationRemaining} left.`
      : "";
    const outcome = state.attackOutcome?.targetMemberId === memberId ? state.attackOutcome : undefined;
    const status = statusView();
    const savedKey = getStoredKey();
    if (state.attackTargetId || state.profileTargetId) {
      const surface = state.attackTargetId ? "attack" : "profile";
      const compactDibsState = claim
        ? `<span class="wc-native-state wc-native-dibs ${isMine ? "mine" : "taken"}" title="${escapeHtml(dibsTitle)}">${escapeHtml(isMine ? `DIBS YOU · ${dibsRemaining}` : `DIBS ${dibsOwner} · ${dibsRemaining}`)}</span>`
        : "";
      const compactRetaliationState = activeRetaliation
        ? `<span class="wc-native-state wc-native-retal" title="${escapeHtml(retaliationTitle)}">RETAL · ${escapeHtml(retaliationRemaining)}</span>`
        : "";
      const compactDibsControl = savedKey && (enemyMember || claim)
        ? dibsMarkup(targetRecord, view, claim, `${surface}-${memberId}`)
        : "";
      const compactWatchControl = savedKey && (enemyMember || watched)
        ? `<button type="button" class="wc-attack-icon${watched ? " active" : ""}" data-action="toggle-watch" data-target-member="${memberId}" data-focus-key="watch-${memberId}" aria-label="${watched ? "Unwatch" : "Watch"} ${escapeHtml(name)}" title="${watched ? "Remove from watched targets" : "Watch this target"}"${watchUnavailable || atLimit ? " disabled" : ""}>${busy ? "…" : watched ? "&#9733;" : "&#9734;"}</button>`
        : "";
      const compactLoadoutControl = state.profileTargetId && savedKey ? loadoutMarkup(view, memberId) : "";
      const floating = state.displayMode === "floating";
      const toolsControl = `<button type="button" class="wc-button wc-attack-tools${floating ? " active" : ""}" data-action="set-display-mode" data-display-mode="${floating ? "native" : "floating"}" aria-label="${floating ? "Hide floating Warbuddy tools" : "Open floating Warbuddy tools"}" aria-pressed="${floating ? "true" : "false"}" title="${floating ? "Hide floating Warbuddy tools" : savedKey ? "Open floating Warbuddy tools" : "Open Warbuddy to connect"}">&#8942;</button>`;
      const compactOutcomeMarkup = outcome
        ? `<span class="wc-attack-result" title="${escapeHtml(outcome.label)}">${escapeHtml(outcome.dibsReleased ? "✓ Dibs released" : outcome.kind === "hospitalized" ? "✓ Releasing Dibs" : `✓ ${outcome.label}`)}</span>`
        : "";
      const compactErrorMessage = [
        state.targetQuickError,
        state.dibsError && state.dibsErrorTargetId === memberId ? state.dibsError : "",
      ].filter(Boolean).join(" · ");
      const compactError = compactErrorMessage
        ? `<span class="wc-attack-error" role="alert" title="${escapeHtml(compactErrorMessage)}">!</span>`
        : "";
      return `<span class="wc-native-brand wc-attack-brand" title="Warbuddy · ${escapeHtml(status.label)}">WB</span><span class="wc-native-states">${compactRetaliationState}${compactDibsState}${compactOutcomeMarkup}${compactError}</span><span class="wc-native-actions">${compactLoadoutControl}${compactDibsControl}${compactWatchControl}${toolsControl}</span>`;
    }
    return "";
  }

  function handleTargetContextAction(event) {
    if (event.currentTarget?.classList?.contains("wc-compact-context")) event.stopPropagation();
    if (handleDibsControlAction(event)) return;
    const control = event.target?.closest?.("[data-action]");
    if (!control || !event.currentTarget?.contains?.(control)) return;
    const action = String(control.dataset?.action || "");
    if (action === "toggle-watch") {
      event.preventDefault();
      void toggleWatchedTarget(control.dataset?.targetMember);
      return;
    }
    if (action === "toggle-loadout") {
      event.preventDefault();
      event.stopPropagation();
      const memberId = Number(control.dataset?.loadoutTarget || 0);
      state.loadoutOpenTargetId = state.loadoutOpenTargetId === memberId ? 0 : memberId;
      scheduleRender();
      return;
    }
    if (action === "set-display-mode") {
      event.preventDefault();
      setDisplayMode(control.dataset?.displayMode);
      return;
    }
    if (action === "set-roster-filter") {
      event.preventDefault();
      state.rosterFilter = core.normalizeRosterFilter(control.dataset?.rosterFilter);
      storage.set(ROSTER_FILTER_STORAGE, state.rosterFilter);
      syncIntegratedMemberTools(sessionView());
      scheduleRender();
      return;
    }
    if (action === "toggle-roster-dibs") {
      event.preventDefault();
      state.rosterDibsButtons = !state.rosterDibsButtons;
      storage.set(ROSTER_DIBS_STORAGE, state.rosterDibsButtons ? "1" : "0");
      closeDibsDetails();
      syncIntegratedMemberTools(sessionView());
      scheduleRender();
      return;
    }
    if (action === "toggle-roster-priority") {
      event.preventDefault();
      state.rosterPrioritySort = !state.rosterPrioritySort;
      storage.set(ROSTER_SORT_STORAGE, state.rosterPrioritySort ? "1" : "0");
      syncIntegratedMemberTools(sessionView());
      scheduleRender();
      return;
    }
    if (action === "connect") {
      event.preventDefault();
      void connectFromInput();
      return;
    }
    if (action === "cancel-key") {
      event.preventDefault();
      state.keyEditorOpen = false;
      state.keyDraft = "";
      state.keyEditorError = "";
      scheduleRender();
    }
  }

  function syncTargetPageContext(view = sessionView()) {
    const memberId = targetPageMemberId();
    if (!state.active || !memberId || !targetPageContextRelevant(view)) {
      removeTargetContext();
      return false;
    }
    const mountPoint = targetContextMountPoint();
    if (!mountPoint?.parent) {
      removeTargetContext();
      return false;
    }
    let context = document.getElementById(TARGET_CONTEXT_ID);
    const expectedTagName = String(mountPoint.tagName || (mountPoint.placement === "attack" ? "span" : "div")).toUpperCase();
    if (context && String(context.tagName || "").toUpperCase() !== expectedTagName) {
      context.remove();
      context = null;
    }
    if (!context) {
      context = document.createElement(expectedTagName.toLowerCase());
      context.id = TARGET_CONTEXT_ID;
      context.addEventListener("click", handleTargetContextAction);
      context.addEventListener("pointerdown", (event) => {
        if (event.currentTarget?.classList?.contains("wc-compact-context")) event.stopPropagation();
      });
      context.addEventListener("input", (event) => {
        if (!event.target?.matches?.('[data-field="api-key"]')) return;
        state.keyDraft = String(event.target.value || "");
        state.keyEditorError = "";
      });
      context.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && event.target?.matches?.('[data-field="api-key"]')) void connectFromInput();
      });
    }
    context.className = `warbuddy-target-context wc-compact-context wc-${mountPoint.placement}-context`;
    context.dataset.memberId = String(memberId);
    if (context.parentNode !== mountPoint.parent) {
      mountPoint.parent.insertBefore(context, mountPoint.before || null);
    }
    const markup = targetContextMarkup(view);
    if (targetMarkupCache.get(context) !== markup || !context.querySelector?.(".wc-native-brand")) {
      const focusSnapshot = capturePanelFocus(context);
      context.innerHTML = markup;
      targetMarkupCache.set(context, markup);
      restorePanelFocus(context, focusSnapshot);
    }
    if (mountPoint.overlay) positionNativeOverlay(context, mountPoint.anchor, mountPoint.placement);
    positionOpenDibsTip(context);
    return true;
  }

  function nativeRosterContextMarkup(view = sessionView()) {
    const status = statusView();
    const label = /^Live\b/i.test(status.label) ? "Live" : status.label;
    const ownFactionLabel = view.ownFactionName || (view.ownFactionId ? `Faction ${view.ownFactionId}` : "");
    const enemyFactionLabel = view.enemyFactionName || (view.enemyFactionId ? `Faction ${view.enemyFactionId}` : "");
    const matchupLabel = enemyFactionLabel ? `${ownFactionLabel} vs ${enemyFactionLabel}` : ownFactionLabel;
    const watchedCount = savedTargetIds().length;
    const actionableCount = new Set((view.actions || [])
      .map((action) => Number(action?.memberId || 0))
      .filter((memberId) => Number.isSafeInteger(memberId) && memberId > 0)).size;
    const retaliationCount = Array.isArray(view.retaliation) ? view.retaliation.length : 0;
    return `<summary><span class="wc-native-roster-chevron" aria-hidden="true">&#9654;</span><span class="wc-native-brand" title="Warbuddy · ${escapeHtml(status.label)}">Warbuddy</span><span class="wc-native-beta">Beta</span>${matchupLabel ? `<span class="wc-native-roster-matchup" title="${escapeHtml(matchupLabel)}">${escapeHtml(matchupLabel)}</span>` : ""}<span class="wc-native-roster-status"><span class="wc-dot ${status.tone}"></span><span class="wc-native-roster-status-label">${escapeHtml(label)}</span></span><span class="wc-native-roster-counts"><span>Watched ${watchedCount}</span><span>Queue ${actionableCount}</span><span>Retals ${retaliationCount}</span></span></summary><div id="${INTEGRATED_HOST_ID}" class="wc-native-roster-panel-host"></div>`;
  }

  function syncNativeRosterContext(view = sessionView()) {
    if (
      !state.active
      || state.displayMode === "floating"
      || !isRosterModePage(view)
      || !targetPageFactionEligible(view)
      || !document.body
    ) {
      removeNativeRosterContext();
      return false;
    }
    const mountPoint = rankedWarRosterContextMountPoint();
    if (!mountPoint?.parent) {
      removeNativeRosterContext();
      return false;
    }
    let context = document.getElementById(ROSTER_CONTEXT_ID);
    if (context && String(context.tagName || "").toUpperCase() !== "DETAILS") {
      context.remove();
      context = null;
    }
    if (!context) {
      context = document.createElement("details");
      context.id = ROSTER_CONTEXT_ID;
      context.addEventListener("toggle", (event) => {
        state.rosterControlsOpen = event.currentTarget.open === true;
        storage.set(ROSTER_CONTROLS_STORAGE, state.rosterControlsOpen ? "1" : "0");
      });
    }
    context.className = "warbuddy-roster-context wc-native-roster-context";
    if (context.parentNode !== mountPoint.parent || context.nextSibling !== mountPoint.before) {
      mountPoint.parent.insertBefore(context, mountPoint.before);
    }
    const markup = nativeRosterContextMarkup(view);
    if (targetMarkupCache.get(context) !== markup || !context.querySelector?.(".wc-native-brand")) {
      const retainedPanel = context.querySelector?.(`#${PANEL_ID}`) || null;
      context.innerHTML = markup;
      const panelHost = context.querySelector?.(`#${INTEGRATED_HOST_ID}`);
      if (retainedPanel && panelHost) panelHost.appendChild(retainedPanel);
      targetMarkupCache.set(context, markup);
    }
    if (context.open !== state.rosterControlsOpen) context.open = state.rosterControlsOpen;
    return true;
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
    if (!document.body) return;
    state.nowMs = trustedNowMs();
    if (!state.active) {
      document.getElementById(PANEL_ID)?.remove();
      removeTargetContext();
      removeNativeRosterContext();
      removeInlineMemberTools();
      removeIntegratedMount(false);
      return;
    }
    state.lastRenderAt = Date.now();
    const view = sessionView();
    const targetPage = !!targetPageMemberId();
    const rankedWarPage = isRosterModePage(view);
    if (targetPage && !targetPageFactionEligible(view)) {
      document.getElementById(PANEL_ID)?.remove();
      removeTargetContext();
      removeNativeRosterContext();
      removeInlineMemberTools();
      removeIntegratedMount(false);
      stopAttackOutcomeDetection();
      return;
    }
    if (targetPage) syncTargetPageContext(view);
    else removeTargetContext();
    let mountState;
    if (state.displayMode !== "floating") {
      if (!rankedWarPage) {
        document.getElementById(PANEL_ID)?.remove();
        removeNativeRosterContext();
        removeInlineMemberTools();
        removeIntegratedMount(false);
        return;
      }
      const rosterContextReady = syncNativeRosterContext(view);
      syncIntegratedMemberTools(view);
      const inlineMount = rosterContextReady
        ? document.querySelector?.(`#${ROSTER_CONTEXT_ID} #${INTEGRATED_HOST_ID}`)
        : null;
      if (!inlineMount) return;
      mountState = { mount: inlineMount, placement: "accordion", fallback: false };
    } else {
      removeNativeRosterContext();
      if (!rankedWarPage) removeInlineMemberTools();
      mountState = resolvePanelMount(view);
    }
    const mount = mountState.mount;
    if (!mount) {
      syncIntegratedMemberTools(view);
      return;
    }
    let panel = document.getElementById(PANEL_ID);
    if (!panel) {
      panel = document.createElement("div");
      panel.id = PANEL_ID;
    }
    if (panel.parentNode !== mount) mount.appendChild(panel);
    const inlineAccordion = mountState.placement === "accordion";
    const rosterMode = (mountState.placement === "inline" || inlineAccordion) && isRosterModePage(view);
    const floatingMode = mountState.placement === "floating";
    panel.classList.toggle("wc-floating", floatingMode);
    panel.classList.toggle("wc-integrated-inline", mountState.placement === "inline" || inlineAccordion);
    panel.classList.toggle("wc-inline-accordion", inlineAccordion);
    panel.classList.toggle("wc-integrated-toolbar", mountState.placement === "toolbar");
    panel.classList.toggle("wc-integrated-fallback", mountState.fallback);
    panel.classList.toggle("wc-roster-mode", rosterMode);
    panel.classList.toggle("wc-roster-open", rosterMode && state.rosterControlsOpen);
    const focusSnapshot = capturePanelFocus(panel);
    const currentBody = panel.querySelector(".wc-body");
    const bodyScrollTop = Number(currentBody?.scrollTop || 0);
    const currentTargetList = panel.querySelector(".wc-target-list");
    if (currentTargetList) state.targetListScrollTop = Number(currentTargetList.scrollTop || 0);
    const privacyDisclosure = panel.querySelector('[data-section="privacy"]');
    if (privacyDisclosure) state.privacyOpen = privacyDisclosure.open;
    const targetsDisclosure = panel.querySelector('[data-section="targets"]');
    if (targetsDisclosure) state.targetsOpen = targetsDisclosure.open;
    const moreActionsDisclosure = panel.querySelector('[data-section="more-actions"]');
    if (moreActionsDisclosure) state.moreActionsOpen = moreActionsDisclosure.open;
    const optionsDisclosure = panel.querySelector('[data-section="options"]');
    if (optionsDisclosure) state.optionsOpen = optionsDisclosure.open;

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
    const liveSections = `${trackerDisabledNotice}${queueSection}${retaliationSection}`;

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
    const rosterControls = rankedWarPage
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
      ["native", "Native (default)"],
      ["floating", "Floating"],
    ].map(([value, label]) => `<button type="button" class="wc-display-mode${state.displayMode === value ? " active" : ""}" data-display-mode="${value}" aria-pressed="${state.displayMode === value ? "true" : "false"}">${label}</button>`).join("");
    const optionsSection = savedKey
      ? `<details data-section="options"${state.optionsOpen ? " open" : ""}><summary>Options</summary><div class="wc-display-setting"><div class="wc-display-label">Layout</div><div class="wc-display-modes" role="group" aria-label="Warbuddy layout">${displayModeOptions}</div></div><div class="wc-options"><label class="wc-option"><input type="checkbox" data-field="roster-dibs-buttons"${state.rosterDibsButtons ? " checked" : ""}>Dibs buttons on war roster rows</label>${notificationOptions}</div>${notificationSupported ? "" : `<div class="wc-privacy">Desktop notifications are not available in this userscript host.</div>`}</details>`
      : "";

    const showKeyEditor = !savedKey || state.keyEditorOpen || state.authTerminal;
    const keyEditor = showKeyEditor
      ? `${state.keyEditorError ? `<div class="wc-error" role="alert">${escapeHtml(state.keyEditorError)}</div>` : ""}<div class="wc-row"><input class="wc-input wc-secret-input" data-field="api-key" data-focus-key="api-key" type="text" inputmode="text" autocomplete="one-time-code" autocapitalize="none" autocorrect="off" spellcheck="false" data-1p-ignore data-lpignore="true" data-bwignore="true" data-protonpass-ignore="true" data-form-type="other" aria-label="Torn API key" placeholder="${savedKey ? "Replacement Torn API key" : "Torn API key"}" value="${escapeHtml(state.keyDraft)}"${state.keySaving ? " disabled" : ""}><button class="wc-button primary" data-action="connect"${state.keySaving || mutationBusy ? " disabled" : ""}>${state.keySaving ? "Checking..." : savedKey ? "Replace" : "Connect"}</button>${savedKey && !state.authTerminal ? `<button class="wc-button" data-action="cancel-key"${state.keySaving ? " disabled" : ""}>Cancel</button>` : ""}</div>`
      : "";

    const panelBody = `${rosterControls}
      ${visibleError ? `<div class="wc-error" role="alert">${escapeHtml(visibleError)}</div>` : ""}
      ${state.dibsError ? `<div class="wc-error" role="alert">${escapeHtml(state.dibsError)}</div>` : ""}
      ${state.targetQuickError ? `<div class="wc-error" role="alert">${escapeHtml(state.targetQuickError)}</div>` : ""}
      ${hasCachedData && (!transportIsLive() || dataIsStale() || (state.settings?.enabled !== false && currentEnemyFactionId() && !currentEnemyRosterIsFresh())) ? `<div class="wc-stale" role="status">Showing cached data from ${escapeHtml(core.duration(liveDataAgeMs()))} ago. Live-only suggestions and changes are paused.</div>` : ""}
      ${keyEditor}
      ${savedKey ? liveSections : ""}
      ${watchedTargetsSection}
      ${optionsSection}
      <details data-section="privacy"${state.privacyOpen ? " open" : ""}><summary>Privacy</summary><div class="wc-privacy">The key stays in your userscript storage. Torn and the backend use it to verify your profile and faction. Warbuddy records your version, connection mode, and last use for faction admins. Its scoped session can save only your watched-target list and Dibs actions.</div>${savedKey ? `<div class="wc-private-actions"><button class="wc-button" data-action="refresh"${mutationBusy || state.keySaving ? " disabled" : ""}>Reconnect</button><button class="wc-button" data-action="change-key"${mutationBusy || state.keySaving ? " disabled" : ""}>Change key</button><button class="wc-button" data-action="forget"${mutationBusy || state.keySaving ? " disabled" : ""}>${state.forgetConfirm ? "Confirm forget" : "Forget key"}</button></div>` : ""}</details>
    `;
    const standardHeader = `<div class="wc-header">
      <div class="wc-heading"><div class="wc-title-row"><span class="wc-player">${escapeHtml(state.session?.playerName || "Warbuddy")}</span><span class="wc-version">v${SCRIPT_VERSION}</span><span class="wc-header-status"><span class="wc-dot ${status.tone}"></span>${escapeHtml(status.label)}</span></div>${matchupLabel || standardChainMarkup ? `<div class="wc-context">${matchupLabel ? `<span class="wc-matchup" title="${escapeHtml(matchupTitle)}">${escapeHtml(matchupLabel)}</span>` : ""}${standardChainMarkup ? `<span class="wc-chains">${standardChainMarkup}</span>` : ""}</div>` : ""}</div>
      <button type="button" class="wc-button wc-icon" data-display-mode="native" aria-label="Use native layout" title="Close floating panel and use the native layout">&times;</button>
    </div>`;
    const rosterHeader = `<div class="wc-roster-summary"><button type="button" class="wc-roster-summary-button" data-action="toggle-roster-controls" aria-expanded="${state.rosterControlsOpen ? "true" : "false"}"><span class="wc-roster-chevron">${state.rosterControlsOpen ? "&#9660;" : "&#9654;"}</span><span class="wc-roster-name">Warbuddy</span><span class="wc-roster-beta">Beta</span>${matchupLabel ? `<span class="wc-roster-matchup" title="${escapeHtml(matchupTitle)}">${escapeHtml(matchupLabel)}</span>` : ""}</button><span class="wc-roster-status"><span class="wc-dot ${status.tone}"></span>${escapeHtml(status.label)}</span><span class="wc-roster-counts">${rosterChainMarkup ? `<span class="wc-roster-chains">${rosterChainMarkup}</span>` : ""}<span class="wc-roster-watched">Watched ${savedTargetIds().length}</span><span>Queue ${actionableMemberIds.size}</span><span>Retals ${view.retaliation.length}</span></span></div>`;
    const panelMarkup = `${inlineAccordion ? "" : rosterMode ? rosterHeader : standardHeader}<div class="wc-body">${panelBody}</div>`;
    if (panelMarkupCache.get(panel) === panelMarkup && panel.querySelector(".wc-body")) {
      syncIntegratedMemberTools(view);
      positionOpenDibsTip(document);
      return;
    }
    panel.innerHTML = panelMarkup;
    panelMarkupCache.set(panel, panelMarkup);

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
    panel.querySelector('[data-section="more-actions"]')?.addEventListener("toggle", (event) => {
      state.moreActionsOpen = event.currentTarget.open;
    });
    panel.querySelector('[data-section="options"]')?.addEventListener("toggle", (event) => {
      state.optionsOpen = event.currentTarget.open;
    });
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
    panel.querySelector('[data-field="roster-dibs-buttons"]')?.addEventListener("change", (event) => {
      state.rosterDibsButtons = event.currentTarget.checked === true;
      storage.set(ROSTER_DIBS_STORAGE, state.rosterDibsButtons ? "1" : "0");
      closeDibsDetails();
      syncIntegratedMemberTools(view);
      scheduleRender();
    });
    panel.querySelectorAll("[data-display-mode]").forEach((button) => {
      button.addEventListener("click", (event) => setDisplayMode(event.currentTarget?.dataset?.displayMode));
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
      button.addEventListener("click", handleDibsControlAction);
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
      closeOwnedTransport("Manual reconnect");
      prepareSameKeyReconnect();
      state.phase = "connecting";
      publishSharedTransport();
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
    syncIntegratedMemberTools(view);
    positionOpenDibsTip(document);
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
    releaseTabBrokerIdentity();
    closeOwnedTransport("API key removed");
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
    const input = document.querySelector(`#${TARGET_CONTEXT_ID} [data-field="api-key"], #${PANEL_ID} [data-field="api-key"]`);
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
      releaseTabBrokerIdentity();
      storage.set(KEY_STORAGE, key);
      closeOwnedTransport("API key changed");
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
    if (!state.routeTimer) state.routeTimer = setInterval(pollPageActivation, ROUTE_HEARTBEAT_MS);
  }

  function activeSurfaceMissing(view = sessionView()) {
    if (!state.active) return false;
    const floatingPanelMissing = state.displayMode === "floating" && !document.getElementById(PANEL_ID);
    if (targetPageMemberId()) {
      const context = document.getElementById(TARGET_CONTEXT_ID);
      if (!targetPageFactionEligible(view)) return !!context || !!document.getElementById(PANEL_ID);
      if (!targetPageContextRelevant(view)) return !!context || floatingPanelMissing;
      const mountPoint = targetContextMountPoint();
      return !context
        || !mountPoint?.parent
        || context.parentNode !== mountPoint.parent
        || Number(context.dataset?.memberId || 0) !== targetPageMemberId()
        || !context.querySelector?.(".wc-native-brand")
        || floatingPanelMissing;
    }
    if (!isRosterModePage(view)) return floatingPanelMissing;
    if (state.displayMode === "floating") return floatingPanelMissing;
    const rosterContext = document.getElementById(ROSTER_CONTEXT_ID);
    if (!targetPageFactionEligible(view)) return !!rosterContext;
    const rosterMountPoint = rankedWarRosterContextMountPoint();
    if (
      !rosterContext
      || String(rosterContext.tagName || "").toUpperCase() !== "DETAILS"
      || !rosterMountPoint?.parent
      || rosterContext.parentNode !== rosterMountPoint.parent
      || !rosterContext.querySelector?.(".wc-native-brand")
      || !rosterContext.querySelector?.(`#${INTEGRATED_HOST_ID} > #${PANEL_ID}`)
    ) return true;
    const signedBoard = rankedWarBoardForView(view);
    const board = signedBoard?.parentElement && signedBoard.isConnected !== false
      ? signedBoard
      : rankedWarUnsignedRosterCluster(view.enemyRoster);
    const entries = rankedWarEnemyRowEntries(view.enemyRoster, board);
    if (!entries.length) return true;
    return entries.some(({ anchor, memberId, row }) => {
      const tools = Array.from(anchor.parentElement?.querySelectorAll?.(`.${INLINE_TOOLS_CLASS}`) || [])
        .find((candidate) => Number(candidate.dataset?.memberId || 0) === memberId);
      const attackLink = rankedWarAttackLinkForMember(row, memberId);
      const rosterActions = attackLink
        ? Array.from(attackLink.parentElement?.querySelectorAll?.(`.${ROSTER_ACTIONS_CLASS}`) || [])
          .find((candidate) => Number(candidate.dataset?.memberId || 0) === memberId)
        : true;
      const dibsControlMissing = state.rosterDibsButtons
        && core.dibsFeatureEnabled(state.settings)
        && !rosterActions?.querySelector?.(".wc-dibs");
      return !tools || !rosterActions || dibsControlMissing;
    });
  }

  function startPageObserver() {
    if (typeof MutationObserver !== "function" || !document.body) return;
    if (state.pageObserver && state.observedBody === document.body) return;
    state.pageObserver?.disconnect();
    state.observedBody = document.body;
    state.pageObserver = new MutationObserver((mutations = []) => {
      if (window.location.href !== state.lastPageHref) {
        syncPageActivation();
        return;
      }
      const outsideWarbuddy = mutations.some((mutation) => !mutation?.target?.closest?.(
        `#${PANEL_ID}, #${TARGET_CONTEXT_ID}, #${ROSTER_CONTEXT_ID}, #${INTEGRATED_WRAPPER_ID}, .${INLINE_TOOLS_CLASS}, .${ROSTER_ACTIONS_CLASS}`
      ));
      if (!outsideWarbuddy) return;
      if (activeSurfaceMissing()) scheduleRender();
    });
    state.pageObserver.observe(document.body, { childList: true, subtree: true });
  }

  function pollPageActivation() {
    if (document.visibilityState === "hidden") return;
    const href = window.location.href;
    if (href !== state.lastPageHref || activeSurfaceMissing()) {
      syncPageActivation();
    }
  }

  function syncPageActivation() {
    if (document.visibilityState === "hidden") return;
    startPageObserver();
    const href = window.location.href;
    const hrefChanged = href !== state.lastPageHref;
    state.lastPageHref = href;
    const active = core.isWarbuddyPageUrl(href);
    const nextAttackTargetId = active ? core.attackPageTargetId(href) : 0;
    const nextProfileTargetId = active ? core.profilePageTargetId(href) : 0;
    const targetChanged = nextAttackTargetId !== state.attackTargetId
      || nextProfileTargetId !== state.profileTargetId;
    if (targetChanged) {
      state.attackTargetId = nextAttackTargetId;
      state.profileTargetId = nextProfileTargetId;
      state.targetQuickError = "";
      state.loadoutOpenTargetId = 0;
      state.attackOutcome = null;
      stopAttackOutcomeDetection();
      state.attackOutcomeReleaseKey = "";
      closeDibsDetails();
    }
    if (!active) {
      if (
        state.active
        || document.getElementById(PANEL_ID)
        || document.getElementById(TARGET_CONTEXT_ID)
        || document.getElementById(ROSTER_CONTEXT_ID)
      ) {
        stopTicker();
        const retainedForPeer = pauseLocalConnectionDemand();
        if (!retainedForPeer) {
          state.phase = getStoredKey() ? "paused" : "idle";
          publishSharedTransport();
        }
        document.getElementById(PANEL_ID)?.remove();
        removeTargetContext();
        removeNativeRosterContext();
        removeInlineMemberTools();
        removeIntegratedMount(false);
      }
      state.active = false;
      return;
    }
    const becameActive = !state.active;
    state.active = true;
    if (becameActive || targetChanged || hrefChanged || activeSurfaceMissing()) render();
    else syncIntegratedMemberTools(sessionView());
    if (becameActive || hrefChanged || targetChanged) syncForegroundState();
  }

  function syncVisibilityState() {
    if (document.visibilityState === "hidden") {
      cancelScheduledRender();
      syncForegroundState();
      return;
    }
    state.nowMs = trustedNowMs();
    syncPageActivation();
    syncForegroundState();
    scheduleRender();
  }

  registerMenuCommand("Warbuddy: show tools", () => {
    state.active = core.isWarbuddyPageUrl(window.location.href);
    state.attackTargetId = core.attackPageTargetId(window.location.href);
    state.profileTargetId = core.profilePageTargetId(window.location.href);
    if (!state.active) {
      window.alert(`Warbuddy v${SCRIPT_VERSION} is installed, but this is not a supported Torn faction, profile, or attack page.\n\n${window.location.href}`);
      return;
    }
    if (!targetPageMemberId() && !isRosterModePage()) {
      setDisplayMode("floating");
      return;
    }
    render();
    syncForegroundState();
  });

  registerMenuCommand("Warbuddy: use native layout", () => setDisplayMode("native"));
  registerMenuCommand("Warbuddy: use floating panel", () => setDisplayMode("floating"));

  registerMenuCommand("Warbuddy: diagnostics", () => {
    const routeMatches = core.isWarbuddyPageUrl(window.location.href);
    const diagnosticView = sessionView();
    const targetEligible = targetPageFactionEligible(diagnosticView);
    const targetMount = targetPageMemberId() ? targetContextMountPoint() : null;
    const panel = document.getElementById(PANEL_ID);
    const targetContext = document.getElementById(TARGET_CONTEXT_ID);
    const rosterContext = document.getElementById(ROSTER_CONTEXT_ID);
    const targetContextRect = nativeAnchorRect(targetContext);
    const rosterContextRect = nativeAnchorRect(rosterContext);
    const brokerDebug = tabBroker?.diagnostics?.() || { enabled: false, role: "standalone", leaderId: "", peerCount: 0 };
    const brokerLeader = !brokerDebug.enabled
      ? "n/a"
      : brokerDebug.leaderId
        ? brokerDebug.leaderId === tabBroker?.tabId ? "this tab" : "peer tab"
        : "none";
    const socketDebug = state.socket
      ? `${state.socket.readyState} (direct owner)`
      : state.sharedSocketOpen
        ? "open (shared from leader)"
        : "none";
    const transportDebug = state.phase === "fallback"
      ? brokerDebug.enabled && brokerDebug.role === "follower" ? "shared compatible fallback" : "compatible HTTP fallback owner"
      : brokerDebug.enabled && brokerDebug.role === "follower" ? "shared WebSocket" : "direct WebSocket owner";
    window.alert([
      `Warbuddy v${SCRIPT_VERSION}`,
      `Route matched: ${routeMatches ? "yes" : "no"}`,
      `Document body: ${document.body ? "ready" : "missing"}`,
      `Panel mounted: ${panel ? "yes" : "no"}`,
      `Panel visible: ${panel ? getComputedStyle(panel).display !== "none" && getComputedStyle(panel).visibility !== "hidden" : "n/a"}`,
      `Native target context: ${targetContext ? "mounted" : "not mounted"}`,
      `Native roster context: ${rosterContext ? "mounted" : "not mounted"}`,
      `Target/war eligible: ${targetEligible ? "yes" : "no"}`,
      `Registered faction: ${state.session?.factionId || "none"}`,
      `View factions: own ${diagnosticView.ownFactionId || "none"}; enemy ${diagnosticView.enemyFactionId || "none"}`,
      `War start: ${diagnosticView.alliedScore?.start || "none"}`,
      `Tracker enabled value: ${String(state.settings?.enabled)}`,
      `Profile name anchor: ${state.profileTargetId ? profileNameAnchor() ? "found" : "missing" : "n/a"}`,
      `Roster filter anchor: ${isRosterModePage(diagnosticView) ? rankedWarFilterAnchor() ? "found" : "missing" : "n/a"}`,
      `Target mount: ${targetMount?.parent ? targetMount.parent === document.body ? "body overlay" : "inline" : "none"}`,
      `Target rectangle: ${targetContextRect ? `${Math.round(targetContextRect.left)},${Math.round(targetContextRect.top)} ${Math.round(targetContextRect.width)}x${Math.round(targetContextRect.height)}` : "none"}`,
      `Roster rectangle: ${rosterContextRect ? `${Math.round(rosterContextRect.left)},${Math.round(rosterContextRect.top)} ${Math.round(rosterContextRect.width)}x${Math.round(rosterContextRect.height)}` : "none"}`,
      `Layout: ${state.displayMode}`,
      `Effective surface: ${state.displayMode === "floating" ? "floating panel with native indicators" : targetPageMemberId() ? "native target context" : isRosterModePage() ? "ranked-war roster" : "none"}`,
      `Phase: ${state.phase}`,
      `Page visibility: ${document.visibilityState}`,
      `Browser online: ${typeof navigator === "undefined" || navigator.onLine !== false ? "yes" : "no"}`,
      `Tab broker: ${brokerDebug.enabled ? `${brokerDebug.role}; leader ${brokerLeader}; peers ${Number(brokerDebug.peerCount || 0)}` : "unavailable; standalone"}`,
      `WebSocket state: ${socketDebug}`,
      `Transport: ${transportDebug}`,
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
      `Profile-page target: ${state.profileTargetId || "none"}`,
      `Endpoint: ${socketUrl()}`,
      window.location.href,
    ].join("\n"));
  });

  registerMenuCommand("Warbuddy: change API key", () => {
    const menuAttackTargetId = core.attackPageTargetId(window.location.href);
    const menuProfileTargetId = core.profilePageTargetId(window.location.href);
    if (!isRosterModePage() && !menuAttackTargetId && !menuProfileTargetId) {
      window.alert("Open the ranked-war roster, a Torn profile, or an attack page first, then run this command again.");
      return;
    }
    state.active = true;
    state.attackTargetId = menuAttackTargetId;
    state.profileTargetId = menuProfileTargetId;
    state.keyEditorOpen = true;
    state.keyDraft = "";
    state.keyEditorError = "";
    render();
    syncForegroundState();
  });

  initializeTabBroker();
  setTimeout(() => {
    if (syncTabBrokerNonce(true)) syncForegroundState();
  }, 150);

  document.addEventListener("visibilitychange", syncVisibilityState);
  document.addEventListener("pointerdown", (event) => {
    const target = event.target;
    const closest = target && typeof target.closest === "function" ? target.closest.bind(target) : null;
    if (state.loadoutOpenTargetId && !closest?.(".wc-loadout")) {
      state.loadoutOpenTargetId = 0;
      scheduleRender();
    }
    if (state.dibsInspectTargetId && !closest?.(".wc-dibs-wrap")) {
      closeDibsDetails();
      scheduleRender();
    }
    if (
      !state.attackTargetId
      || !targetPageFactionEligible(sessionView())
      || closest?.(`#${PANEL_ID}, #${TARGET_CONTEXT_ID}`)
    ) return;
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
  const handleViewportResize = () => {
    positionOpenDibsTip(document);
    scheduleNativeOverlayPosition();
    if (targetPageMemberId() || (state.displayMode !== "floating" && isRosterModePage())) scheduleRender();
  };
  window.addEventListener("resize", handleViewportResize);
  window.visualViewport?.addEventListener?.("resize", handleViewportResize);
  window.addEventListener("scroll", scheduleNativeOverlayPosition, { passive: true });
  window.visualViewport?.addEventListener?.("scroll", scheduleNativeOverlayPosition, { passive: true });
  window.addEventListener("hashchange", syncPageActivation);
  window.addEventListener("popstate", syncPageActivation);
  window.addEventListener("pageshow", start);
  window.addEventListener("pagehide", () => {
    if (state.routeTimer) clearInterval(state.routeTimer);
    state.routeTimer = 0;
    if (state.overlayFrame) cancelAnimationFrame(state.overlayFrame);
    state.overlayFrame = 0;
    stopTicker();
    tabBroker?.close();
    tabBroker = null;
    closeOwnedTransport("Tab closed");
    cancelScheduledRender();
    state.active = false;
    state.pageObserver?.disconnect();
    state.pageObserver = null;
    state.observedBody = null;
    stopAttackOutcomeDetection();
    document.getElementById(PANEL_ID)?.remove();
    removeTargetContext();
    removeInlineMemberTools();
    removeIntegratedMount(false);
  });

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
