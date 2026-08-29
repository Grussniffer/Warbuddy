# Warbuddy

## 0.1.55

- Keeps profile and attack pages completely untouched until the backend confirms a registered faction with an active ranked-war opponent.
- Performs only the existing silent session/live-state check before eligibility is known; no target badge or floating panel is mounted while ineligible.
- Removes an existing target-page surface immediately when the active war ends or the authenticated faction changes.
- Stops retrying when the backend explicitly reports that the faction is not registered.

## 0.1.54

- Restricts native roster integration to your authenticated faction's ranked-war page; other factions' war profiles are never decorated, sorted, or rearranged.
- Leaves unrelated player profiles untouched and mounts the compact profile chip only for a current opponent, Retal, active Dibs, known loadout, or existing watched target.
- Uses a target-specific native Attack control to verify the profile Actions container and overlays an auto-sized badge without entering Torn's layout flow.
- Tightens enemy-row detection and notices SPA route changes immediately so old roster decorations cannot leak into the next faction page.

## 0.1.53

- Replaces the wrapping profile card with one stable compact toolbar inside Torn's completed profile Actions container.
- Waits for the verified two-faction board before mounting or decorating the ranked-war roster, eliminating provisional load-time moves.
- Keeps roster Retal and Dibs indicators on one clipped line so live data cannot increase member-row height.
- Leaves the compact attack HUD, optional floating tools, live connection, and backend behavior unchanged.

## 0.1.52

- Replaces the full-width attack-page target strip with a tiny inline HUD beside Torn's verified defender labels.
- Keeps Retaliation and Dibs state visible with compact Dibs, Watch, and optional floating-tools controls.
- Refuses to guess or fall back over the combat window when Torn's target label is not available yet.
- Keeps the full profile context, ranked-war layout, and optional floating panel unchanged.

## 0.1.51

- Prevents the native ranked-war strip from being inserted inside either faction roster and splitting Torn's two-column layout.
- Mounts provisionally at the safe page boundary until both faction rosters identify their verified common board.
- Revalidates and re-anchors the strip when Torn rebuilds or replaces the ranked-war DOM.
- Removes forced flex and grid spanning from the strip wrapper while preserving the native and optional floating layouts.

## 0.1.50

- Keeps the native profile, attack, and ranked-war roster presentation as the default.
- Restores the full floating tools panel as an explicit opt-in from the native target context, Warbuddy Options, or the userscript menu.
- Keeps Retaliation and Dibs state in Torn's native target and roster DOM even while the floating panel is enabled.
- Reuses the existing shared live session when switching layouts, with no additional connection, request, polling, or event delay.

## 0.1.49

- Embeds a compact Warbuddy target context directly in Torn profile and attack pages instead of opening a floating panel.
- Keeps the full Warbuddy controls in one inline strip above the ranked-war roster and removes the floating, collapse, drag, and display-mode workflow.
- Shows independent Retal and Dibs state and actions beside every recognized enemy roster row's native Attack action.
- Restores missing native contexts and roster controls after Torn rebuilds its page DOM, without adding backend changes, requests, polling, or live-event delay.

## 0.1.48

- Reconciles every successful Dibs claim or release immediately through source-aware timestamp and application-sequence ordering, even when a socket event was expected.
- Keeps same-millisecond live events in arrival order while rejecting reordered mutation responses and differing shared hydration that started from older state.
- Binds shared traffic to a fresh term for each leadership tenure so delayed responses from a former tenure cannot restore stale Dibs owners.
- Preserves the existing busy/error experience and server authority without adding backend changes, requests, polling, or delay.

## 0.1.47

- Enables Dibs only when fresh cached rosters place the claimant and target in the same settled country, including the same foreign country.
- Explains stale, traveling, unknown-location, and different-location states without hiding existing claims.
- Uses the already-live roster data with no added request or delay; the backend remains authoritative when a claim is submitted.
- Treats the client's received-update freshness as an optimistic UI guard; backend successful-sample freshness remains authoritative.

## 0.1.46

- Shares one live WebSocket or compatible fallback across Warbuddy tabs for the same verified player and faction.
- Delivers live events and follower actions directly between tabs without putting a heartbeat or polling delay in the normal update path.
- Keeps the elected owner connected across ordinary tab switches, then transfers ownership automatically if that tab closes or stops responding.
- Uses a private per-install channel and never sends the Torn API key, companion session token, or authorization header between tabs.
- Retains the previous per-tab connection behavior when BroadcastChannel is unavailable.

## 0.1.45

- Removes the redundant Dibs hand beside Torn roster names so wide player banners cannot spill controls into the Level column.
- Keeps claim ownership visible on Torn's native Attack link: green for your Dibs, gray for another player's Dibs, with details in the tooltip.
- Keeps explicit claim and release controls in Warbuddy's queue, watched-target list, retaliation entries, and attack-page target card.

## 0.1.44

- Keeps WebSocket changes immediate while repainting live countdowns at most every two seconds.
- Drops static and no-war repainting to once every ten seconds.
- Reuses identical panel markup and avoids repeated full-page cleanup scans in Floating mode.
- Checks Torn's route only when the URL or panel actually changes.

## 0.1.43

- Pauses Warbuddy priority ordering while Torn is actively sorting a non-status column, while retaining the existing FFScouter handoff.
- Keeps Torn's visible status when it disagrees with the backend and marks the cell subtly until the two sources agree.
- Uses Torn or backend-synchronized time for live countdowns when available.
- Reuses Torn's native status colors and skips unchanged inline roster markup to reduce layout churn.

## 0.1.42

- Places compact hospital, travel, and abroad details inside Torn's existing Status column instead of beside member names.
- Keeps Torn's original status content intact underneath and restores it when Roster mode is disabled.
- Hides unclaimed Dibs and inactive Watch controls until row hover or keyboard focus on desktop, while retaining full touch access. Existing claims use the already-colored Attack link instead of another permanent hand beside the name.

## 0.1.41

- Keeps Warbuddy available on Torn attack pages without mounting it over Torn's combat controls.
- Always uses the draggable Floating panel on attack pages, even when Roster mode is selected for the ranked-war page.
- Preserves the current-target card, Dibs, watched targets, live state, and saved panel position without backend changes or extra requests.

## 0.1.40

- Shows both factions' active chain counts and timers as compact **Us** and **Them** labels in Floating and Roster mode.
- Adds compact hospital, inbound-flight, outbound-flight, and abroad state beside enemy names in Roster mode using the existing backend roster stream.
- Labels an expired saved chain deadline as syncing instead of showing a misleading zero.
- Extends the opt-in Warbuddy priority order with useful availability ordering while preserving Retals, Dibs, Queue, and watched-target priority.
- Pauses Warbuddy ordering automatically while FFScouter has an active roster filter.
- Adds no Torn polling, third-party cache traffic, database migration, or new stored API key.

- Filters every enemy roster row, including members for whom Torn currently hides the Attack link.
- Renames the vague **Actionable** roster filter to **Queue**; it shows members currently in Warbuddy's action queue plus active retaliation targets.
- Lets Torn's page continue scrolling while the pointer is over the expanded Roster strip.
- Keeps the watched-target list independently scrollable when that list itself is open.
- Keeps the current floating panel as the default presentation.
- Replaces **Integrated (beta)** with an opt-in **Roster (beta)** strip above both ranked-war faction lists.
- Keeps the strip collapsed by default while live Watch, Dibs, and retaliation state remains visible beside enemy names.
- Adds All, Watched, Queue, and Retals roster filters plus an optional Warbuddy priority order.
- Applies filtering and ordering with reversible CSS only; Torn's member rows are never moved or rewritten.
- Falls back to the proven floating panel when Torn does not expose a safe integration point.

> Historical note: version 0.1.49 replaced these older modes with native target contexts and the ranked-war strip. Version 0.1.50 later restored floating tools as an optional, non-default layout.

Warbuddy is a Torn userscript that places the live war action queue, shared Dibs, and retaliation opportunities supplied by the Grusmedia backend into Torn's relevant native page surfaces.

## Install

1. Install Tampermonkey or another userscript manager.
2. Open [Install Warbuddy](https://raw.githubusercontent.com/Grussniffer/Warbuddy/main/warbuddy.user.js).
3. Confirm the installation in your userscript manager.
4. Open Torn and enter a Torn API key when Warbuddy asks for one.

The install URL ends in `.user.js` and includes update metadata, so supported userscript managers can recognize it and receive later releases automatically.

## What It Shows

- Current chain-risk and hospital-exit opportunities from the faction War Tracker.
- Online enemy targets when they are relevant to the action queue.
- Personal watched enemies within one minute of landing or leaving hospital, and while attackable in Torn.
- A searchable, filterable personal-target picker with drafts that stay intact until Save or Cancel.
- A compact shared Dibs marker for same-location attackable enemies and enemies leaving hospital within five minutes.
- Active retaliation windows with explicit links to Torn.
- A compact target context inside Torn profile and attack pages, with status, Watch/Unwatch, Dibs, retaliation, and known loadout details when available.
- One full inline control strip above the ranked-war roster by default, with independent Retal and Dibs state/actions beside each recognized enemy row's native Attack action.
- An optional floating full-tools panel; native target and roster indicators remain visible while it is enabled.
- A stable empty state when there are no immediate actions.

Warbuddy displays information and links only. It never attacks, clicks, submits Torn actions, or notifies automatically. **Dibs** is an explicit coordination button that updates only the Grusmedia backend.

## Layout

**Native (default)** embeds the target context into profile and attack pages and places the full tools in the ranked-war strip. **Floating** opens the full tools as a fixed panel while retaining native Retaliation and Dibs indicators. Switch from the target context, **Options → Layout**, or the userscript menu. The preference is stored locally and switching layouts reuses the current live session.

## Access And Privacy

- The Torn API key is stored locally by the userscript manager.
- The key is used to identify the player and faction, then exchanged for a six-hour, faction-scoped companion session.
- The key is not saved to the backend during that exchange.
- New and replacement keys are verified before they replace the locally stored working key.
- Warbuddy keeps live transport active while at least one visible supported Warbuddy tab needs it and the device is online.
- Tabs for the same verified player and faction elect one connection owner and receive its events immediately through a private per-install browser channel.
- The Torn API key, companion session token, and authorization header never enter that cross-tab channel.
- Its backend session can read War Tracker settings, rosters, score, retaliation, and shared Dibs for the verified faction. It can save only that player's watched-target list and Dibs actions.
- Other players' watched-target lists are never returned to the script.
- WebSocket updates are preferred. If the browser rejects a third-party socket inside Torn, Warbuddy automatically uses a cached scoped snapshot without making extra Torn API calls.
- Torn PDA normally uses this compatible snapshot path and may therefore show **Live (compatible)** instead of **Live**.
- Warbuddy records player ID, player name, faction, script version, connection mode, first/last use, check-in count, and browser user agent for faction admins. The Torn API key is never included in a check-in.

If an earlier standalone war companion is installed separately, remove or disable it before installing Warbuddy so two copies do not run on the same Torn page.

## Development

```bash
npm test
npm run build
```

The build writes the canonical `warbuddy.user.js` and update-only `warbuddy.meta.js` files to the repository root and `dist/`. It also keeps the old `askelads-warbuddy.*` filenames as update-compatible aliases for existing installations.

Source files:

- `src/core.cjs` contains the deterministic queue and live-state logic.
- `src/tab-broker.cjs` contains credential-free cross-tab ownership, event delivery, action relay, and failover logic.
- `src/userscript.js` contains Torn UI, storage, authentication, and WebSocket integration.
- `userscript.header.txt` contains the userscript metadata.

Backend access is provided by `https://backend.grusmedia.no`; this repository contains no backend secrets.

## Releases

### 0.1.55 - 29 August 2026

- Uses the successful faction-scoped companion session as the registration proof and the backend's current opponent as the active-war proof.
- Fails closed on profile and attack pages before those proofs are available, including when Floating was previously selected, while retaining the silent connection needed to learn when a war becomes active.
- Stops target-page rendering and stale-surface restoration work while ineligible and cleans any previously mounted target UI when eligibility disappears.
- Accepts both Torn's nested error format and the backend gateway's top-level error format so unmanaged-faction responses stop reconnection work immediately.

### 0.1.54 - 29 August 2026

- Adds an authenticated-faction route guard around every native ranked-war DOM mutation while retaining explicitly selected floating tools on other faction pages.
- Removes stale integrated panels and row decorations immediately when Torn navigates from your war roster to another faction's war profile.
- Prevents unrelated player profiles from receiving a Warbuddy toolbar or offering a new watched-target action; active retaliation, Dibs, known loadout, and existing-watch contexts remain available.
- Replaces the generic profile control-count heuristic with a unique target-specific Actions mount, uses an out-of-flow 26px badge, and requires member-matching Attack controls for enemy rows and board discovery.

### 0.1.53 - 29 August 2026

- Removes the profile fallbacks through broad profile wrappers and `#mainContainer`; Warbuddy now waits for connected native profile content and mounts one fixed-height toolbar once.
- Keeps only WB, Retal/Dibs state, loadout, Dibs, Watch, outcome/error, and the floating-tools toggle on the profile surface, without duplicating the target name, status, key editor, or roster link.
- Removes the unverified ranked-war wrapper at the page boundary and never relocates an existing verified strip while Torn temporarily rebuilds the roster DOM.
- Restricts row decoration, filtering, status reconciliation, and priority ordering to the connected verified common board, with single-line clipped row indicators.

### 0.1.52 - 29 August 2026

- Mounts a compact attack-only span directly inside a verified target or defender label container instead of before Torn's entire combat section.
- Shows only Retal, Dibs, Dibs action, Watch, outcome, error, and a tiny floating-tools toggle; duplicated target details, key editor, roster link, and full card styling remain off the attack surface.
- Returns no native attack mount until the safe label exists, allowing the normal restoration heartbeat to retry without falling back to `#mainContainer`.
- Isolates compact-control clicks from Torn's combat handlers and keeps touch controls usable without changing profile, roster, floating, connection, or polling behavior.

### 0.1.51 - 29 August 2026

- Removes the attack-link-only DOM fallback that could mistake one faction list for the complete ranked-war board before live roster data arrived.
- Places provisional and verified native mounts at the nearest normal-flow boundary, climbing out of Torn's internal flex, grid, table, or contents layouts.
- Revalidates the common own/enemy board during reconciliation, allowing Torn SPA remounts and late roster hydration to correct placement.
- Removes unconditional wrapper flex and grid spanning so Warbuddy cannot create an extra full-width row between the two faction lists.

### 0.1.50 - 29 August 2026

- Keeps Torn-native profile, attack, and ranked-war surfaces as the default while restoring the full floating panel as an explicit opt-in.
- Keeps Retaliation and Dibs state in Torn's native DOM in either layout.
- Reuses the same authenticated session, shared tab connection, requests, polling, and live events while switching layouts.

### 0.1.49 - 29 August 2026

- Replaces the body-mounted floating presentation with Torn-native surfaces: `#warbuddy-target-context` on profile and attack targets, and a full inline strip only above the ranked-war roster.
- Removes the active display-mode, collapse, saved-position, drag, and floating-fallback workflow while preserving the existing authenticated session and live transport.
- Adds a dedicated roster action area immediately before each recognized enemy row's native Attack action. Retal and Dibs state remain independent, and Dibs claim/release or inspect controls stay available even when the other state is absent.
- Keeps fallback Dibs and retaliation controls beside the profile link when Torn omits an Attack action for that row.
- Uses `activeSurfaceMissing` from both DOM observation and the route heartbeat to restore a removed target context, ranked-war strip, row tools, or roster action area after Torn remounts its UI.
- Adds profile-route metadata and runtime target detection without changing backend authority, Torn API usage, polling, broker behavior, or live-event delivery timing.

### 0.1.48 - 29 August 2026

- Applies every successful claim/release response locally through a source-aware `generatedAt` reconciler.
- Uses an application-sequence baseline so an equal-millisecond mutation response applies only when no newer Dibs state arrived while that mutation was in flight.
- Preserves ordered equal-millisecond WebSocket events, treats identical snapshots as no-ops, and prevents differing equal-millisecond fallback or shared hydration from replacing current state.
- Gives every broker leadership tenure a fresh term and validates that term plus lease freshness across announcements, data, requests, responses, resignations, and handoff.
- Uses broker protocol v2; already-open older tabs must refresh before joining the v2 shared connection.
- Keeps Redis, database, backend authority, polling, and normal live-delivery timing unchanged.

### 0.1.47 - 29 August 2026

- Requires fresh cached own and enemy rosters before enabling a Dibs claim.
- Normalizes and compares the claimant and target's current settled countries, permits literal same-country foreign claims, and fails closed for blank or unknown locations.
- Rejects traveling, different-location, and unavailable targets in the UI with a concise inspectable explanation.
- Keeps active claims visible and releasable while adding a location warning when cached roster state no longer matches.
- Rechecks the same cached eligibility immediately before the existing backend mutation, without adding Torn calls, backend requests, timers, or polling.
- Keeps unavailable explanation controls keyboard- and assistive-technology-accessible, and treats client connection freshness as optimistic while backend successful-sample freshness remains authoritative.

### 0.1.46 - 28 August 2026

- Elects one Warbuddy tab to own the WebSocket, or compatible fallback where WebSockets are unsupported, for each verified player/faction browser session.
- Sends socket events and follower actions directly over BroadcastChannel; the liveness heartbeat is not part of normal event delivery.
- Retains a hidden owner while another visible tab advertises demand, avoiding reconnects during ordinary tab switches.
- Responds to presence and explicit liveness probes from the message handler, preventing hidden-tab timer throttling from causing false failover.
- Transfers ownership immediately on clean tab closure and deterministically converges short-lived split leadership on the lower lease ID.
- Uses a cryptographically random, userscript-storage channel nonce and refuses messages or responses containing API-key, token, or authorization fields.
- Falls back unchanged to one connection per tab when BroadcastChannel is unavailable.
- Adds no Torn API call, backend endpoint, or database migration.

### 0.1.45 - 27 August 2026

- Removes the eligible-target Dibs hand injected beside Torn roster names.
- Preserves shared Dibs behavior and the existing Attack-link ownership colors and tooltip.
- Leaves all claim/release controls available inside Warbuddy and on its attack-page target card.
- Adds no Torn API call, backend change, setting, or database migration.

### 0.1.44 - 27 August 2026

- Keeps roster, score, retaliation, and Dibs WebSocket messages event-driven and immediate.
- Reduces timer-driven panel rebuilds from every second to every two seconds during live timing, and every ten seconds while idle or outside a war.
- Skips replacing identical panel markup, preserving existing listeners and scroll state while avoiding needless layout and style work.
- Stops repeatedly scanning Torn's document for integrated controls when Floating mode has nothing mounted to remove.
- Replaces the unconditional route rescan with a lightweight URL and missing-panel check every two seconds.
- Leaves compatible fallback polling adaptive at 2-10 seconds, and keeps all socket, fallback, ticker, and render work paused while the Floating panel is collapsed or the tab is hidden.
- Adds no Torn API calls, backend endpoint, database migration, or cache traffic.

### 0.1.43 - 27 August 2026

- Yields optional Warbuddy ordering to Torn's active member, level, BSP, activity, or location sort; Status ordering and the existing action queue remain unchanged.
- Reconciles Torn's current row status with the backend before replacing the Status cell. On disagreement, Torn stays visible with a quiet sync marker instead of showing a confident but contradictory timer.
- Prefers Torn's synchronized page clock, then a validated backend snapshot clock, for hospital, flight, Dibs, retaliation, and chain countdowns.
- Uses Torn's native status color variables and preserves Torn's original status DOM.
- Updates inline Watch, Dibs, retaliation, status, title, dataset, and order markup only when its rendered value changes.
- Adds no direct Torn polling, backend endpoint, API call, setting, or database migration.

### 0.1.42 - 27 August 2026

- Reuses Torn's Status column for Warbuddy availability details, removing the overlapping travel badge from the member and level area.
- Keeps active watches, claimed Dibs, and retaliation state visible through their existing row and Attack-link states while making unused controls quiet until interaction on pointer-based devices.
- Preserves the original Torn status DOM, mobile controls, filtering, ordering, and backend request behavior.

### 0.1.41 - 27 August 2026

- Restricts Roster integration to Torn's ranked-war roster, where the layout was designed and verified.
- Restores the draggable Floating panel on attack pages so Warbuddy no longer covers combat information or becomes pinned to Torn's target-label area.
- Keeps attack-page target context and all existing live functionality unchanged.

### 0.1.40 - 27 August 2026

- Shows active chain counts and countdowns for both the verified faction and its current opponent in both compact headers.
- Reads both values from the existing faction-scoped backend score snapshot, adding no Torn requests, storage, or direct API access.

### 0.1.39 - 27 August 2026

- Brings the useful roster awareness from Torn War Stuff Enhanced into Warbuddy through data already supplied by the Grusmedia backend.
- Adds compact `H`, `IN`, `OUT`, and country state labels with live countdowns and full hover details.
- Adds backend-driven chain timing to the compact Floating and Roster headers; passed deadlines remain visible as syncing until the next score sample.
- Makes the optional priority order availability-aware and yields ordering to FFScouter whenever its roster filter is active.
- Deliberately avoids direct Torn API polling, `twse.dev`, local API-key duplication, React internals, and physical row movement.

### 0.1.38 - 26 August 2026

- Fixes Watched, Queue, and Retals filtering for flying, hospitalized, and other members whose Torn row has no Attack link.
- Applies filters to the complete enemy roster mounted inside the verified ranked-war board.
- Renames **Actionable** to **Queue** without changing or losing the saved filter setting.

### 0.1.37 - 26 August 2026

- Stops the expanded Roster strip from trapping wheel and trackpad scrolling.
- Treats Roster mode as ordinary Torn page content while retaining deliberate inner scrolling for the watched-target list.
- Leaves Floating mode's bounded internal scrolling unchanged.

### 0.1.36 - 26 August 2026

- Reworks the opt-in integrated presentation into a full-width **Roster beta** control strip mounted above the common two-faction board.
- Leaves the proven Floating mode as the default and keeps the existing attack-page panel unchanged.
- Shows compact Watch, Dibs, and timed Retal state directly beside recognized enemy names.
- Adds All, Watched, Queue, and Retals filters plus an opt-in priority order for the enemy roster.
- Keeps live updates running while the roster strip is closed; closing the Floating panel still pauses its connection as before.
- Uses reversible classes and CSS ordering only, with a Floating fallback when Torn's current markup cannot be verified safely.

### 0.1.35 - 26 August 2026

- Fixes Integrated mode choosing Torn's member cell as its mount point and covering existing roster information.
- Reserves a complete grid or table row for Warbuddy and keeps the expanded panel at a compact width.
- Removes the explanatory display-mode paragraph; the option is now simply labelled **Integrated (beta)**.
- Keeps Floating as the default and retains the same authenticated session, socket, polling, and inline actions.

### 0.1.34 - 26 August 2026

- Adds an optional **Integrated beta** presentation while retaining **Floating** as the default for every existing and new installation.
- Places the existing Warbuddy surface inside supported ranked-war and attack-page areas, and adds compact Watch, Dibs, and retaliation controls beside recognized enemy profile links.
- Reuses the same authenticated session, WebSocket, compatible polling, cached snapshot, and live state as floating mode. Switching layouts adds no Torn API calls and cannot create duplicate live connections.
- Falls back automatically to the floating panel if Torn changes its page markup or no safe integrated anchor is available.
- Adds userscript menu commands for switching modes even if an integrated control cannot be reached.
- Requires only a Warbuddy userscript update. No backend restart, SQL migration, environment change, or website deployment is required for the script behavior.

### 0.1.33 - 26 August 2026

- Adds an optional three-item Focus queue, personal target groups, userscript notifications, and compact attack-page target context.
- Keeps the last usable snapshot visible during brief disconnects while pausing live-only actions until recovery.
- Detects confirmed attack outcomes without treating ordinary Torn status text as a completed attack.

### 0.1.32 - 25 August 2026

- Adds revision-aware compatible snapshots so unchanged polls return a small acknowledgement instead of full rosters.
- Keeps urgent fallback updates at two seconds, backs quiet active wars off to five seconds, and uses ten seconds outside war.
- Continues to pause all live work while the panel is collapsed or the Torn page is hidden.

### 0.1.31 - 24 August 2026

- Adds a compact current-target card on Torn attack pages with immediate Watch/Unwatch and shared Dibs controls; the general queue stays available behind a disclosure.
- Adds name/ID search plus All, Selected, Attackable, Hospital, and Traveling filters to the watched-target picker.
- Preserves unsaved target edits across live renders and disclosure closes, restores field focus, keeps stable alphabetical ordering, and adds explicit Clear and Cancel actions.
- Validates a new or replacement Torn key before writing it to userscript storage, retains a working old key when replacement fails, and stops retry loops for terminal authentication failures.
- Honors the faction's Action Queue visibility setting without hiding retaliation, personal watched targets, or other companion features.
- Detects stale/offline live data, suppresses generic online suggestions when own BSP is unknown, and blocks Dibs mutations until the connection is fresh.
- Requests a full roster snapshot when the first received delta has an unmatched base version and clears the previous enemy when the stored score says the war ended.
- Adds Dibs to retaliation rows, globally locks Dibs controls during an update, labels release as **Release & unwatch**, and positions its detail popup inside the visible viewport.
- Adds a target quick-save path, a two-step Forget key confirmation, a Change key menu command, larger coarse-pointer controls, safe-area-aware sizing, and a compact collapsed pill.

### 0.1.30 - 22 August 2026

- Prefers Torn PDA's native request handlers so compatible mode does not depend on its userscript-manager shim.
- Lets successful compatible snapshots drive panel updates instead of repainting the full panel every second.
- Retries failed compatible snapshots after 4, 8, then at most 10 seconds; successful updates immediately return to the normal 2-second interval.
- Pauses route work and cancels queued animation frames while Torn is hidden, then performs a clean route and connection sync when it becomes visible.
- Narrows panel recovery observation to direct page-body changes, reducing work from Torn's frequently changing nested DOM.
- Adds no Torn API calls and requires no backend or database change.

### 0.1.29 - 21 August 2026

- Adds persistent faction-scoped version and last-used check-ins for the admin System Overview.
- Throttles foreground check-ins to once every ten minutes and pauses them with the rest of Warbuddy while hidden or collapsed.
- Keeps check-in failures silent so missing database setup or a temporary backend problem cannot interrupt live war data.
- Adds no Torn API calls and never includes the locally stored Torn API key in a check-in.

### 0.1.28 - 20 August 2026

- Keeps the hand marker and attack-link state synchronized from the same active claim.
- Adds an explicit close button and outside-click dismissal to Dibs details.
- Removes the sticky focus rule that could keep a Dibs popup visible after it was closed.
- Identifies the userscript author as SneipLadd [2813921].

### 0.1.27 - 20 August 2026

- Makes claimed targets unmistakable on Action Queue and retaliation links.
- Shows green `Your Dibs` for the viewer's own claim and muted gray `Dibsed` for another member's claim.
- Keeps every Torn action link available; Dibs remains coordination, never a lock.

### 0.1.26 - 20 August 2026

- Renames the standalone project and userscript to Warbuddy.
- Removes faction branding from metadata, visible fallback labels, runtime globals, panel IDs, and current storage keys.
- Fetches faction names from the signed backend session and live roster state, with only a neutral faction-ID fallback.
- Preserves updates through legacy generated filenames and migrates existing local userscript storage.

### 0.1.25 - 20 August 2026

- Honors the faction-wide Shared Dibs switch from the War Tracker Control Panel.
- Removes the hand, clears local claim state, and blocks stale client actions while disabled.
- Keeps personal watched targets and the rest of the action queue independent.

### 0.1.24 - 20 August 2026

- Makes Dibs release and personal target watching one consistent action.
- Removes the released target from only the releasing player's saved watch list.
- Preserves other players' lists, the player's other watched targets, and unrelated unsaved picker changes.

### 0.1.23 - 20 August 2026

- Moves the Action Queue Dibs detail below the hand marker and increases its small detail text to 11px.
- Prevents the top-target detail from being clipped while preserving the existing compact mobile layout.

### 0.1.22 - 20 August 2026

- Adds shared, faction-scoped Dibs without extra Torn API calls or database storage.
- Allows one active target per player for up to ten minutes; eligible targets are attackable now or leave hospital within five minutes.
- Keeps a hospital claim through its original stay, then clears it after a new hospitalization or 30 seconds after release.
- Adds the same compact grey, green, and amber hand marker to queue and watched-target rows.
- Runs the existing compact Warbuddy panel on Torn's attack page while keeping unrelated Torn pages inactive.
- Retains all existing mobile layout, watched-target, retaliation, drag, collapse, PDA, and fallback behavior.

### 0.1.21 - 20 August 2026

- Removes the informational sentence from the watched-target picker.
- Leaves target selection and live behavior unchanged.

### 0.1.20 - 20 August 2026

- Preserves the watched-target list scroll position across live renders.
- Resets that position only when the watched-target section is deliberately closed.

### 0.1.19 - 20 August 2026

- Removes the brief WebSocket rejection warning shown during normal compatible-mode startup.
- Requires three consecutive compatible snapshot failures before displaying a transport error.
- Keeps transport diagnostics available from the userscript menu without adding noise to the panel.

### 0.1.18 - 20 August 2026

- Reduces the visible compatible-mode snapshot interval from five seconds to two seconds.
- Collapsing Warbuddy now pauses its socket, fallback polling, and live countdown; expanding it resumes immediately.
- Native WebSocket updates remain immediate and no additional Torn API calls are introduced.

### 0.1.17 - 20 August 2026

- Moves watched-target selection from faction admins to each individual Warbuddy user.
- Identifies the owner from the verified Torn key and stores up to 25 targets separately per player.
- Synchronizes personal targets with both Warbuddy and the website action queue without additional Torn API calls.
- Keeps every other player's target list private.

### 0.1.16 - 20 August 2026

- Reduces the visible Torn PDA-compatible fallback interval from ten seconds to five seconds.
- Leaves native WebSocket delivery and Torn API sampling unchanged.

### 0.1.15 - 20 August 2026

- Introduced faction-scoped watched enemy targets; selection moved to each player in 0.1.17.
- Pins watched targets in the action queue within one minute of landing in Torn or leaving hospital, and while they are attackable in Torn.
- Reuses the live roster stream without additional recurring Torn API requests.

### 0.1.14 - 20 August 2026

- Torn PDA HTTP requests now retain their authorization headers.
- Warbuddy uses Torn PDA's HTTP bridge when its userscript transport is unavailable, while desktop userscript managers retain `GM_xmlhttpRequest`.
- Torn PDA skips the unsupported WebSocket attempt and begins compatible polling immediately.

### 0.1.13 - 20 August 2026

- Moves the live connection state beside the player name and version.
- Shows the named allied and enemy faction matchup in the compact header.
- Moves **Reconnect** and **Forget key** into Privacy so the normal panel stays focused on actions.

### 0.1.12 - 20 August 2026

- Stops the one-second live ticker until an API key has been submitted.
- Keeps an unsaved in-memory key draft intact if Torn remounts the panel while it is being entered.

### 0.1.11 - 20 August 2026

- A compatible HTTP snapshot now takes over automatically when Torn, Chrome, or a userscript environment rejects the native WebSocket.
- The fallback reads the same faction-scoped in-memory state as the socket and never sends the stored Torn key.
- Fallback requests pause with the tab, share a short gateway cache, and keep retrying the faster WebSocket in the background.

### 0.1.10 - 20 August 2026

- Warbuddy now requests Tampermonkey's isolated DOM sandbox instead of its default raw page context.
- The live WebSocket therefore bypasses Torn's page CSP and uses the gateway's restricted extension-origin path.

### 0.1.9 - 20 August 2026

- Tampermonkey extension-origin sockets now use the backend's restricted, signed Warbuddy session path.
- Rejected handshakes recover even when the browser reports `error` and `CLOSED` without a matching `close` event.
- The connection watchdog can no longer remain armed around an already-closed socket.

### 0.1.8 - 20 August 2026

- A 15-second watchdog replaces WebSockets that remain stuck in the browser's connecting state.
- Delayed close events from an older socket can no longer pause its replacement.
- Connection diagnostics now show whether the opening-handshake watchdog is active.

### 0.1.7 - 20 August 2026

- Drag the panel by its header; its position is saved locally and clamped to the current screen.
- A **Warbuddy: reset position** command restores the default lower-right placement.
- Visible tabs no longer tear down the live socket on brief browser-focus changes.
- Interrupted sockets reconnect automatically, while diagnostics now include connection state and close details.

### 0.1.6 - 20 August 2026

- The Torn API key entry no longer presents itself as a browser password field.
- Browser and password-manager autofill hints prevent Warbuddy from prompting for or inserting an email address elsewhere on Torn.
- The key remains visually masked while it is entered.

### 0.1.5 - 20 August 2026

- Warbuddy now uses the same body-mounted `div` and DOM-observer lifecycle pattern as the OC userscript.
- Torn faction styles can no longer hide the panel, and Torn DOM rebuilds restore it immediately.
- Tampermonkey now provides **Warbuddy: show panel** and **Warbuddy: diagnostics** menu commands for direct runtime checks.
- Script injection is limited to Torn faction URLs instead of every Torn page.

### 0.1.4 - 20 August 2026

- Warbuddy now remounts itself if Torn replaces the faction page shell or removes the panel.
- Browser back/forward cache restores restart route checks and the live connection cleanly.
- Faction path matching also supports extensionless Torn faction routes while Bazaar remains excluded.

### 0.1.3 - 20 August 2026

- Warbuddy is available throughout Torn's faction pages, including Torn's alternate and empty hash states.
- Bazaar and every other non-faction page still stop the panel, ticker, and live WebSocket.

### 0.1.2 - 20 August 2026

- Warbuddy now appears only on Torn faction war routes.
- Bazaar and other unrelated pages no longer keep the panel, ticker, or live WebSocket active.

### 0.1.1 - 20 August 2026

- Privacy now stays open while the live one-second countdown refreshes the panel.
- The panel keeps its scroll position across live updates.

### 0.1.0 - 20 August 2026

- Initial standalone release with the action queue and live retaliation opportunities.
