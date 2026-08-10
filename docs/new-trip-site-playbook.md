# Playbook: adding a new trip site

Reusable process for building a new trip guide site (like `zurich-weekend.com`,
the Maritimes PWA, or `aripshitadventure`) and wiring it into this shared
worker. Follow this instead of re-deriving the steps from scratch.

Each numbered step is marked with how solid the information is:
- **CONFIRMED** — verified live (a real command ran, a real screen was seen)
- **UNCONFIRMED** — described but not yet walked through live; verify before
  trusting blindly, especially anything Cloudflare-dashboard-UI-shaped, since
  that UI has already changed once during this playbook's own creation
  (2026-08-09: Pages creation moved from a "Workers & Pages → Pages tab" flow
  to a unified "Create a Worker" screen with a "Looking to deploy Pages? Get
  started" link → "Import an existing Git repository").

## Master checklist — run this in order, every build

The sections below are reference material; this is the actual procedure.
Everything in it was written because skipping it once already cost real
time or a real, avoidable user correction on this account. Don't treat any
step as optional because "this trip seems simple."

**Before writing any code:**
1. Get the real trip data from a verified source (§1) — never hand-type or
   guess venue facts.
2. If referencing a sibling "reference" site by name, check `git log -1`
   across every similarly-named repo (an `-archive` suffix, a bare name, a
   `-pwa` suffix) before treating any one of them as ground truth — go by
   commit date, not by which one you found first (`cloudflare-wiki.md`
   corrected-mistake #6).
3. Ask the user up front for real photo files/URLs — a sandboxed session
   usually cannot fetch or hotlink from any image host (§9's hero/banner
   note). Don't guess or placeholder-and-forget; track what's still needed.
4. **Don't infer a traveler's personal facts (home city, home timezone,
   home base) from trip-adjacent data (a departure airport, a stated
   preference) — ask, or leave it explicitly unconfirmed.** Concretely
   caused a wrong "Eastern (home)" timezone label on `aripshitadventure`
   (2026-08-10), guessed from the EWR departure airport, when the
   traveler's real home was Dallas/Central — a fact the trip data never
   stated and had no way to imply correctly.
5. Decide the nav architecture explicitly (continuous-scroll + scroll-spy,
   confirmed as the real zurich-pwa pattern — see §2's correction) rather
   than assuming either that or a click-to-switch pattern from memory.
6. Check `travel-app-components` and `trip-restaurants` for any requested
   feature before building it from scratch (§10) — both are real,
   actively-used libraries, not aspirational.

**While building:**
7. Fork zurich-pwa's real `index.html` as the literal starting point (§2) —
   re-read the actual current source, don't work from a memory of what a
   past summary of it said.
8. Run through the confirmed feature checklist (§2) and check the real data
   schema before building any status/badge UI that implies structured data.
9. Run the 7-point itinerary-data QA checklist (§7) BEFORE building the
   site, not reactively after a user reports a problem.
10. Verify every supplied photo's actual license before wiring it in (§8) —
    a user handing over a file is not proof it's usable.
11. Include a print stylesheet and a `localStorage`-backed packing list by
    default — both are confirmed present in 2+ independent prior builds,
    treat as standard rather than optional (§10). If building an AI
    concierge chat, include a user-facing hallucination disclaimer — a
    confirmed, still-open gap on every prior build that has one (§10).

**Before calling it done:**
12. Serve locally (`python3 -m http.server`) and drive it with Playwright,
    mocking every external API call — screenshot **every** tab, not just
    the ones that changed, at both desktop and a real mobile width (375px).
13. If the build included any navigation-architecture change, grep the
    stylesheet and JS for comments referencing tab-switch/scroll-reset
    behavior and re-verify each hit live — that behavior changing is a
    landmine for anything that assumed it (§9).
14. Check the print stylesheet — a JS-toggled collapsed/expanded UI element
    needs an explicit `display: block !important` override in `@media
    print`, or its content silently vanishes from anything printed/exported
    (confirmed live on `aripshitadventure`'s weather-chip redesign,
    2026-08-10).
15. Confirm zero JS console errors (`page.on('pageerror')`), not just that
    the page rendered something.
16. If the site has a service worker, confirm the cache-busting step also
    re-stamps its `CACHE_VERSION` (or equivalent) constant, not just HTML
    `?v=` strings (`cloudflare-wiki.md` lesson #18) — a stale service
    worker keeps serving broken JS/CSS regardless of what the HTML now
    points at.
17. Add the site to the shared worker if it needs chat (§3), via a **PR**,
    never a direct push to `main` (that repo auto-deploys to shared prod).
18. Deploy to Cloudflare Pages (§4) and confirm the live URL actually shows
    the new build — a push timestamp is not confirmation (see
    `cloudflare-wiki.md`'s "Deployed ≠ confirmed live").
19. **If this build taught a new lesson, add it back to this file (or
    `cloudflare-wiki.md`) before ending the session.** The entire value of
    this document is that lessons compound instead of repeating — every
    section below exists because a prior build hit it and wrote it down.

## 1. Get the source itinerary data — CONFIRMED

The most reliable source is the structured JSON embedded in a trip-planning
app's "Export as Web App" HTML download (look for
`<script id="trip-data" type="application/json">...</script>`). Extract it
with the exact opening/closing `<script>` line numbers (verify with `grep -n`
or `awk`, don't guess the range) and validate with `json.load()` before using
it. This is real, already-verified data — prefer it over hand-typing or
guessing venue facts.

## 2. Build the static site — CONFIRMED (this pattern works)

**Fork zurich-pwa's real `index.html` as the literal starting point.** The
first `aripshitadventure` build was written as a new, much lighter design
from scratch instead of adapting the proven file — the result was missing
most of zurich's actual richness (single-scroll layout instead of tabs, no
photo hero, thin weather card, no Street View, no font system) and had to be
rebuilt. Don't repeat that: start from a copy of
`/workspace/jhwiv/zurich-pwa/index.html` (or wherever it's cloned), then
replace zurich's content with the new trip's, using the checklist below to
confirm nothing structural got dropped along the way.

### Confirmed zurich-pwa feature checklist (verified 2026-08-09 by reading the real file, not guessed)

- **Nav — 12 chips across two markup-level `<nav>` rows**, `flex-wrap: wrap`
  (no horizontal scroll): Condensed, Thursday, Friday, Saturday, Sunday /
  Monday, Essentials, Transit, Street Views, History, Map, Air & Hotel.
  Adapt the row-1 tabs to the new trip's actual day/city structure (a
  4-city trip reads better as city tabs than day-of-week tabs — see the
  `aripshitadventure` rebuild for that variant).
  **CORRECTION (2026-08-10, confirmed by reading zurich-pwa's live source
  directly, not this doc's own 2026-08-09 first draft):** the nav is
  **continuous-scroll with a scroll-spy active chip, NOT click-to-switch
  hide/show tabs.** All `.tab-section`s render inline at all times; the
  active nav chip is whichever section's top has scrolled past the sticky
  nav (iterate sections, take the last whose `getBoundingClientRect().top
  <= navHeaderHeight`); clicking a chip `scrollIntoView({behavior:'smooth',
  block:'start'})`s to it rather than toggling `display`. Getting this
  wrong (building click-switch instead) is exactly what triggered a sharp,
  justified user correction on this account once already — don't repeat
  it, and don't trust an older summary of this checklist over rereading
  the real file if the two ever seem to disagree.
- **Hero + city banners — real PHOTOS, not illustrated/generated scenes**,
  and NOT one single static image: a full-bleed `.hero-photo` background
  layer behind a top-light/bottom-dark gradient overlay for text legibility,
  PLUS a real `.location-banner`/`.location-banner-img` photo banner
  (image + darkening `filter:brightness()` + flag/city/nights label) at
  **every city transition**, full-bleed via a negative-margin trick
  (`margin:0 -20px; width:calc(100% + 40px)`) to escape the page's own
  container padding. Photos are hotlinked remote URLs in the real
  zurich-pwa/maritimes-grandloop-v2 source (`background:url('https://
  images.unsplash.com/...')`) — but a sandboxed build session usually
  *cannot* fetch or hotlink from any image host (confirmed repeatedly:
  images.unsplash.com, unsplash.com root, and pexels.com all return a
  network-egress-proxy 403 to `curl` and `WebFetch` alike), so the working
  pattern here is local files under `images/` sourced from the user (see
  §7/§8) rather than a live hotlink. **Do not tell a user these don't
  exist without first reading the actual current source of the reference
  site** — see the "stale archive" corrected mistake in
  `docs/cloudflare-wiki.md`.
- **Hero photo carousel (rotates a different photo per page load)** is a
  genuinely NEW feature, confirmed NOT present in either zurich-pwa or
  maritimes-grandloop-v2 (grepped both for "carousel"/"rotat"/"heroPhotos"
  /"setInterval.*hero" — zero matches in either). Build it as new work, and
  say so plainly rather than presenting it as "matching the reference."
- **Meals & Reservations**: zurich's CONFIRMED/RECOMMENDED/WALK-IN badges
  are **hand-authored per row from real bookings the traveler told the
  builder about at the time** — not driven by any JSON field. Do not copy
  that badge wording onto a different trip's data without checking first
  (see the schema-check rule below) — it will almost always be fabricated.
- **Street Views**: keyless embed —
  `https://www.google.com/maps?layer=c&cbll=<lat>,<lng>&output=svembed`
  in an iframe. No API key, confirmed by grepping the whole file for
  `AIzaSy`/`maps.googleapis`/`key=` (zero matches). A second small link
  (same URL without `output=svembed`) opens full Google Maps in a new tab.
- **Weather card**: temp, hi/lo, condition, rain %, wind, sunrise/sunset,
  plus a tap-to-expand modal with an hourly strip — all from Open-Meteo's
  `current`+`daily`+`hourly` fields. Don't under-fetch (the first
  `aripshitadventure` build only requested `current=temperature_2m,
  weather_code` and had to be expanded).
- **Fonts**: Playfair Display (headings), Crimson Pro (body), DM Mono
  (labels/timestamps/badges/UI chrome) via one Google Fonts `<link>`.
- **Directions**: only ever a Google Maps text-search link
  (`maps.google.com/?q=...`) in the real zurich-pwa file — it does **not**
  have Apple Maps or Waze buttons despite looking like the kind of site
  that would. If a user asks for "GPS buttons like zurich," check before
  building — say so if it isn't actually there, then build it anyway if
  still wanted (it's a reasonable addition either way: Apple Maps
  `maps.apple.com/?q=...` and Waze `waze.com/ul?q=...&navigate=yes` are
  both standard, keyless universal-link formats, no API key for either).
- **Essentials / Transit / History tabs**: a mix of real quick-reference
  data (hotel/flight cards — pull from the actual trip JSON) and
  AI-authored general destination knowledge (transit tips, historical
  context) — label the latter as general reference, not verified fact, per
  the account's existing "don't present unverified as fact" convention.
- Lower-priority zurich features not always worth the scope: an "Alter Day"
  AI itinerary-regenerator modal (needs a new worker endpoint), native app
  deep-links (`marriott://`, `flysas://` — scheme correctness depends on
  the actual carriers/hotels in the new trip), floating timezone pill,
  browser-native TTS pronunciation tables. Confirm scope with the user
  before including these — don't assume v1 needs the full set.

### Check the real data schema before building any status/badge UI

Before reusing a UI pattern that implies structured data (a CONFIRMED badge,
a status color, a count), grep the actual trip JSON for the field it would
need. `aripshitadventure`'s data had no reservation-confirmation field at
all (`restaurant.verify_status` was identically `"verify_before_booking"`
across all 14 restaurants — zero variance) — building zurich's badge wording
on top of it would have fabricated a status that isn't real. What *was* real
and usable: `restaurant.reservation.platform` (resy/opentable/phone/walkin —
the booking channel, not a confirmation state) and `restaurant.contact`
(fully populated). Use what the data actually says, worded honestly, rather
than reusing a sibling site's wording that implies something the data
doesn't back up.

No build step, no framework — plain HTML/CSS/JS, same shape as
`zurich-pwa`/`aripshitadventure`:
- Render day-by-day content from the trip JSON at runtime (don't hand-write
  15+ days of HTML — a small JS render function reading the embedded JSON is
  less error-prone and easier to keep in sync).
- Map: Leaflet + free CartoDB tiles. **Vendor Leaflet locally** (`npm install
  leaflet`, copy `dist/leaflet.js`, `dist/leaflet.css`, `dist/images/*.png`
  into `vendor/leaflet/`) rather than loading from unpkg — one less external
  dependency, and it's the only way to test the map at all from a sandboxed
  dev environment with restricted egress.
- Weather: Open-Meteo (`api.open-meteo.com/v1/forecast`) — free, no API key.
- Local search: Overpass API (`overpass-api.de/api/interpreter`) — free, no
  API key.
- Coordinates: if no live geocoding is available (common in a sandboxed dev
  session — check with a single `curl` to a geocoder first, don't assume),
  use well-known city-center/landmark coordinates from general knowledge,
  and say so explicitly in the repo (a `_note` field in the data file, plus
  the README) rather than presenting them as verified. Every "Directions"
  link should be a Google Maps **text search** (`maps.google.com/?q=...`),
  not the raw coordinates — that keeps navigation accurate even when a pin
  is approximate.
- **CSS pitfalls already hit once, check for both:**
  - A floating panel positioned near floating action buttons needs enough
    clearance (and the FAB row needs a higher `z-index`) or the panel can
    block clicks on the very buttons that toggle it.
  - Give the map container its own stacking context (`position: relative;
    z-index: 1; isolation: isolate;`) — otherwise Leaflet's internal panes
    (they set their own high z-index values) can visually bleed through
    other fixed-position UI on top of the map.
  - `content-visibility: auto` on a long scrolling section caused a real,
    confirmed scroll-height miscalculation on touch devices ("hits a wall
    then snaps") — removed entirely on `santafe-itinerary` rather than
    patched. Avoid it on any section a user scrolls through by touch until
    there's a specific, verified reason to use it.
- **JS pitfalls already hit once:**
  - `navigator.geolocation.getCurrentPosition`'s own `timeout` option is not
    a hard guarantee — some browsers only start that clock once the
    permission prompt is answered, so an unanswered prompt can hang
    forever. Wrap it in your own `setTimeout` fallback too.
  - A scroll-spy nav can be re-triggered mid-bounce by iOS's overscroll
    momentum, fighting the just-scrolled-to tab (`short-aruba`, "the
    vibration bug"). Guard the re-center/re-highlight logic with a check
    against the currently-active tab before acting, not just against the
    scroll position.
  - A regex-based cache-bust step that rewrites asset URLs can corrupt
    single-quoted import paths if the pattern isn't scoped tightly enough
    (`santafe-itinerary`, required a hotfix) — test the rewrite against a
    real file with both quote styles before trusting it in CI.

### Verify the site locally before pushing (CONFIRMED — do this, it finds real bugs)

```
python3 -m http.server 8910   # serve the site directory
```
Then drive it with Playwright (`/opt/pw-browsers/chromium`), **mocking**
`api.open-meteo.com`, `*.basemaps.cartocdn.com`, `overpass-api.de`, and the
worker's chat endpoint (`route.fulfill` with a matching content type — the
chat endpoint streams Server-Sent-Events-shaped lines, not JSON). Take real
screenshots, not just DOM assertions — a CSS stacking bug won't show up in a
`.count()` check. This exact process caught two real bugs on the first
attempt (see CSS/JS pitfalls above) that weren't visible from reading the
code.

## 3. Add the site to the shared worker (`jhwiv/cloudflare-worker`) — CONFIRMED

This repo already serves chat for multiple trips (`zurich`, `maritimes`,
`wwii2026`) from one Worker (`cloudflare-worker.jhwiv-online.workers.dev`),
using Cloudflare Workers AI — **no Anthropic key or other new secret needed**.
To add a new one, edit `src/index.js`:

1. Add a new array to `ITINERARY_SCHEDULE` keyed by a short site slug —
   calendar-day (local-midnight-to-midnight) segments per day, built from
   each day's own city, not invented clock times.
   **Gotcha (caused two real bugs, caught by Cursor Bugbot on the first PR):**
   when two adjacent days are in cities with *different* UTC offsets, each
   city's own true local midnight does NOT line up with the neighboring
   city's — computing each segment independently produces a gap (both
   segments end before the next starts → `getItineraryLocation` returns
   `null`) or an overlap (the wrong city keeps matching). **Fix:** at every
   transition, snap the outgoing segment's `to` to exactly equal the
   incoming segment's `from`. After writing the array, verify programmatically:
   ```js
   // parse the array, walk it, assert from[i+1] === to[i] for every i
   ```
   Same-city consecutive days are unaffected (same offset both sides).
2. Add a compact JSON itinerary blob (`const X_ITINERARY = \`{...}\`;`) near
   the existing `ZURICH_ITINERARY`/`MARITIMES_ITINERARY` constants, built
   from the same verified trip JSON from step 1 — not hand-typed.
   **Gotcha:** if this data reuses a "checkout-inclusive" day-range
   convention from the source app (e.g. `"Day 6–Day 8"` meaning "checked
   out the morning of Day 8"), that reads to an LLM as if Day 8 itself is
   spent there. Spell it out instead: which days are actually slept there,
   and name the handoff day explicitly.
3. Add a `SITES.<slug>` entry (weatherLocations, geoChecks, defaultGeoNote,
   localTimezone, `buildPrompt()`) — copy an existing site's shape.
4. Add the new slug to the route regex:
   `/^\/api\/chat(?:\/(zurich|maritimes|<newslug>))?$/`
5. Update the README's route table, and note if `resolveQueryLocation`'s
   explicit day/place-name override isn't wired up for the new site yet
   (it's currently Maritimes-only) — don't silently ship a claim it works.
6. Verify: `node --check src/index.js`, plus the contiguity check from
   step 1 above, plus `JSON.parse()` on the extracted itinerary blob.
7. **Open a PR, do not push straight to `main`.** `main` auto-deploys via
   GitHub Actions to the shared production Worker that live sites depend on.

## 4. Deploy the static site to Cloudflare Pages

**CONFIRMED, full screen-by-screen** (as of 2026-08-09 — Cloudflare's UI
moves; re-verify if this looks stale next time):
1. dash.cloudflare.com → **Workers & Pages** in the left sidebar → **Create**
2. Lands on a unified "Create a Worker" / "Ship something new" screen — do
   **not** use "Continue with GitHub" at the top (that's the Worker path).
   Instead click the small link at the bottom: **"Looking to deploy Pages?
   Get started"**
3. That leads to an import-method picker; select **"Import an existing Git
   repository"**
4. Repo picker (GitHub already connected from step 3's auth) → select the
   trip site's repo → lands on **"Set up builds and deployments"**:
   - **Project name:** prefilled from the repo name (e.g. `aripshitadventure`)
     — the resulting URL is shown live underneath, `<project-name>.pages.dev`
   - **Production branch:** prefilled `main` — leave it
   - **Framework preset:** defaults to **None** — correct for a plain
     static HTML/CSS/JS site with no build step, leave it
   - **Build command:** leave **completely empty**
   - **Build output directory:** the field has a static `/` prefix shown
     to the left of the input box — **leave the input itself blank**, do
     not type a second `/` into it
   - Two collapsed **"(advanced)"** sections (Root directory,
     Environment variables) — not needed for a plain static site, skip
   - Click **Save and Deploy** (bottom right)

## Alternative to steps 4–5: CLI-only deploy, no dashboard, no GitHub connection

```powershell
npm install -g wrangler
wrangler login
wrangler pages deploy . --project-name=<site-name>
```
Creates the Pages project and deploys in one command from a local clone.
Trade-off: doesn't auto-redeploy on future pushes — rerun the command, or
add a GitHub Actions workflow using `cloudflare/pages-action` (mirrors how
this repo's own Worker auto-deploys via `cloudflare/wrangler-action@v3`).

## 5. Cloudflare Pages/Workers deployment lessons — account-wide history

Mined from a full pass across ~26 repos on this account (2026-08-09) that
had never been consolidated anywhere — each one had already been paid for
once, in a real incident or debugging session, and was sitting undiscovered
in a README/VERSION.md/wrangler.toml comment in a repo nobody was looking
at. Check this list before assuming a Cloudflare deploy problem is new.

1. **Pages secret rotation doesn't auto-redeploy.** `wrangler pages secret
   put` doesn't propagate to the running deployment — trigger a fresh
   deploy afterward (an empty commit + push works), or the old value keeps
   serving. *(vigil-family-records)*
2. **Workers and Pages have entirely separate secret stores.** A companion
   Worker needs its own copy of a secret even when the identical value is
   already set on the Pages project it calls. *(vigil-family-records)*
3. **Pages Functions (V8 isolates) can't run child processes or native
   modules**, and have a hard ~30s CPU budget plus Cloudflare's own ~100s
   edge timeout per request. CLI-based tooling (e.g. `pdftoppm`/`tesseract`)
   silently fails — route heavy work through a Queue + dedicated Worker, or
   use a hosted API instead of a CLI dependency. *(vigil-family-records)*
4. **Pages' `wrangler.toml` doesn't support `[triggers]` (cron) at all.**
   Scheduled jobs need a separate companion Worker hitting Pages HTTP
   endpoints with a shared bearer secret. *(vigil-family-records)*
5. **The account default silently changed from classic Pages to "Workers
   with static assets."** New Git-connected projects can create as Workers
   (`wrangler deploy`, `wrangler.jsonc` with bindings declared directly) —
   confirm which mode a new project actually landed in with `--dry-run`
   rather than assuming. *(multihomes-command)*
6. **A custom domain attached via `wrangler.jsonc`/`routes` is a standing
   account-level resource** — removing the `routes` entry and redeploying
   does NOT clean it up; it needs an explicit `DELETE
   /accounts/{id}/workers/domains/{id}` API call. *(daily-dashboard)*
7. **`workers_dev` toggling interacts destructively with Cloudflare
   Access.** Adding a custom-domain `routes` entry can silently flip
   `workers_dev` to `false` (killing the working `*.workers.dev` URL);
   flipping it back on can silently drop a previously configured Access
   policy on that hostname — leaving it live and unauthenticated with a
   plain `200`. `wrangler.jsonc`'s `workers_dev` field and the account's
   real subdomain-enabled flag can also desync — check
   `GET/POST /accounts/{id}/workers/scripts/{name}/subdomain` directly,
   don't trust deploy output. **Never call an Access-gated URL "safe" from
   a `200` status alone — check the response body.** This was a real
   incident with genuinely sensitive data briefly exposed. *(daily-dashboard)*
8. **Cloudflare Access gates static assets too**, which breaks iOS "Add to
   Home Screen" icon fetches (no authenticated session carried by iOS's
   icon-loading mechanism). Also: **Workers Static Assets serves matching
   requests directly at the edge by default, bypassing the Worker's own
   `fetch()` handler** — `"run_worker_first": true` is required if the
   Worker needs to guard those requests. Also: a `manifest.json`'s
   `start_url` must be absolute if the manifest is served from a different
   hostname than the app. *(daily-dashboard)*
9. **Missing/misconfigured `_headers` cache rules let Cloudflare's *edge*
   cache — not just the browser — serve stale content to every visitor.**
   `immutable`/1-year caching is only safe for content-hashed build output;
   statically-named files (favicon, icons) need short `max-age` +
   `must-revalidate`, and a policy fix can't retroactively bust what's
   already cached under an old `immutable` promise — rename the file to
   force a new URL. A three-layer pattern (SW fetch with `cache:'no-store'`
   on navigations + `_headers` no-cache on `/`/`index.html`/`sw.js`/
   manifest + a `controllerchange` listener that force-reloads once) has
   already been independently rediscovered and copied verbatim across two
   sibling repos. *(family-transition-tracker, daily-dashboard)*
10. **Workers Cron Triggers are capped at 5 per Cloudflare account.** A 6th
    `[triggers].crons` block fails at deploy time — confirm against the
    account's live schedules, work around with an on-request
    `ctx.waitUntil` background refresh if the cap is hit. *(daily-dashboard)*
11. **Some third-party APIs platform-block Cloudflare's Workers outbound IP
    range specifically**, even when identical requests succeed from
    elsewhere (e.g. Google News RSS returning 503 only from a Worker).
    `wrangler dev` runs on a different network than the real edge and
    cannot reproduce this — only a live deployed Worker can confirm it.
    *(daily-dashboard, ne-racing)*
12. **`caches.default` is partitioned per Cloudflare colo** — a cold colo's
    first visitor pays full uncached upstream cost even when other colos
    are warm. A scheduled Cron Trigger that proactively warms the cache
    globally ahead of real traffic fixes this. *(ne-racing)*
13. **A Worker's isolate can be killed the instant the response stream
    finishes**, silently truncating an in-flight async `cache.put()`. Wrap
    cache writes in `ctx.waitUntil()` so the isolate stays alive until the
    write actually completes. *(ne-racing)*
14. **Split deploy pipelines are a recurring trap**: Pages/frontend
    auto-deploys from git via CI, but a companion Worker often needs a
    separate, manual `wrangler deploy` with no CI coverage — a stale Worker
    missing new endpoints is a repeat failure mode. *(ne-racing)*
15. **GitHub Pages cannot execute Cloudflare Pages Functions at all** — any
    fetch to a Functions-only path 405s there. Never point both GitHub
    Pages' `CNAME` and a Cloudflare Pages custom domain at the same apex
    simultaneously — they fight over it. *(maritimes-grandloop-v2)*
16. **"Deployed" ≠ "confirmed live."** A `modified_on` timestamp only
    proves Cloudflare *received* a push, not that the build succeeded or
    new assets are serving. Cloudflare Access gating a production domain
    returns 403 to an unauthenticated agent-sandbox request — expected
    behavior, not evidence of a failed deploy. The only real confirmation
    is a human checking the live site — this mirrors the identical rule
    already in `trip-optimizer`'s own CLAUDE.md. *(multihomes-command,
    daily-dashboard)*
17. **Never put secrets in `wrangler.toml`/`wrangler.jsonc`.** `wrangler
    secret put` / `wrangler pages secret put` only — enforced by explicit
    "do NOT add the secret value here" comments across essentially every
    repo checked on this account.

## 6. Post-launch corrections found by actually using the site (aripshitadventure, 2026-08-09)

Three more real gaps, found only after the user actually looked at the live
build — add these to the pre-launch checklist for the next trip site instead
of waiting for them to be reported again:

1. **Times default to 12-hour, not 24-hour.** The source plan JSON's `time`/
   `end_time`/`depart_time`/`arrive_time` fields are all 24-hour `"HH:MM"`
   strings — render them through a `formatTime12()` helper everywhere a time
   appears (item cards, condensed list, meals, transport reference, flight
   times, weather sunrise/sunset), don't leave them as raw 24-hour text.
2. **A consolidated "how do I get from A to B" view is not optional.**
   zurich's Transit tab has a literal "Transport Quick Reference" table —
   the first pass at this rebuild dropped it and only kept generic per-city
   transit tips, even though every Transport/Flight item's own `text` field
   already contains the real duration (e.g. "Drive to Juno Beach — 45 min
   via D514"). Build a chronological list of every Transport/Flight item
   across all days as its own section — don't assume it's covered by transit
   info being present somewhere inside each day's card stack.
3. **The itinerary map needs a route line, not just pins.** Isolated markers
   don't convey the shape of the trip. Add a polyline connecting the
   sequence of city centers in visiting order (derived from each day's own
   `city` field) — but label it honestly as an overview/straight-line
   connector, not a real driving route, since no routing API or key is used
   or available in this environment. Don't imply turn-by-turn accuracy that
   isn't there.

## 7. Itinerary-data QA checklist — run this BEFORE building the site, not after being asked

This is the actual methodology that found real, confirmed defects in the
`aripshitadventure` trip data (a restaurant booked on its own closed day, an
entire missing international transition, four unverified flight numbers
presented as fact) — found reactively, one at a time, only because the user
kept pushing after an initial pass said "looks mostly clean." Run all of
these upfront, unprompted, before telling anyone an itinerary is sound.

1. **Date/weekday check.** Recompute every day's actual weekday from the
   trip's start date and compare against what the label claims. Cheap,
   scriptable, zero excuse to skip.
2. **Within-day time ordering.** Every item's `time` must be ≥ the previous
   item's `end_time` (or `time` if no `end_time`). Flag any item that starts
   before the previous one plausibly ends.
3. **Flight time math against real timezones**, not just "does duration
   match depart/arrive as printed." Convert both to UTC using the ACTUAL
   timezone offset for each airport's country/date (DST matters — check
   whether the trip's dates fall before or after the relevant DST changes)
   and confirm the elapsed time matches the stated duration. Internally
   consistent numbers are necessary but NOT sufficient — see point 6.
4. **Night-count reconciliation using hotel check-in/check-out events, not
   `day.city`.** `day.city` reflects where a day's ACTIVITIES happen, which
   on a transit day is not the same city the NIGHT is spent in (the transit
   day's night is wherever the traveler checks into a hotel that evening).
   Build the city→hotel mapping from actual Hotel-type items with
   check-in/check-out text, then count nights per city from that — cross
   check against the trip's own claimed `cities[].nights` and the meta
   summary line. Do this by tracing hotel NAME → city (via a coordinates
   file or similar), not by re-using the day's own city label, or the
   count will silently misattribute transit-day nights (confirmed by
   getting this wrong twice while checking this exact data, before
   landing on the correct hotel-name-based method).
5. **Inter-city transition continuity.** For every day where `city`
   changes from the previous day, confirm there is an actual Flight or
   Transport item (or sequence of items) that plausibly gets the traveler
   from the old city to the new one. A day that just starts already in the
   new city, with full-day activities and no transition items anywhere,
   is a real missing-leg bug — cross-check against any summary metadata
   (e.g. `cities[].transport_in`) that claims a specific flight/transfer,
   since that claim not appearing anywhere in the actual `days[]` items is
   itself the tell. This is the single most consequential check — it
   surfaces "this itinerary is missing a whole travel day," not just a
   cosmetic error.
6. **Scan every venue object for the plan's own internal QC flags** —
   fields starting with `_` (e.g. `_weekdayMismatch`, `_isReturnVisit`,
   `_missingBackup`, `_modelEstimatedFlightNumber`) and any `closure_note`/
   `verify_status` field. These are the plan's own admissions of
   uncertainty or unresolved conflicts — a `closure_note` that says "won't
   work, moved to Day N" on an item that's STILL scheduled where it said
   it wouldn't work is a confirmed, present bug, not a hypothetical one.
   **`_modelEstimatedFlightNumber: true` on a flight means the number
   AND time were never checked against a real schedule — treat this as a
   headline risk, not a footnote.** Under-weighting exactly this in a
   first-pass summary (listing it as "worth knowing, not necessarily an
   error" instead of leading with it) is a real mistake already made once
   on this account — don't repeat it.
7. **Once a defect is found, check whether the same UI element renders
   in more than one place** before considering the fix complete — a
   warning/badge/flag added to only one of several render paths (e.g. an
   "unverified flight" warning that only showed in one tab out of four
   places flights render) is an incomplete fix, not a complete one. Grep
   for every call site of the thing being fixed, not just the one visible
   in whatever screenshot prompted the fix.

## 8. Photo sourcing — verify the license, not just the download

A user handing over "free" photos (their own downloads, a shared manifest of
Unsplash/Pexels URLs, anything not obviously their own camera roll) is not
proof they're actually license-clear. Confirmed on `aripshitadventure`
(2026-08-10): 3 of 4 initially-supplied "usable" photos turned out to be
unlicensed Adobe Stock / Getty-iStockphoto **preview/comp downloads** —
watermarked in one case, un-watermarked but still unpurchased in another.

**Check before wiring any supplied photo into a live site:**
```
strings images/photo.jpg | grep -iE "adobe|copyright|getty|shutterstock|istock|alamy|dreamstime|123rf|depositphotos|stock\.|licensor|creator"
```
- Adobe Stock preview downloads carry `adobe:docid:stock:<uuid>` in embedded
  XMP metadata, whether or not a visible watermark is also present.
- Getty/iStockphoto previews carry `photoshop:Credit="Getty Images/
  iStockphoto"` plus an **unpurchased** `xmpRights:LicensorURL` pointing at
  a license-purchase page, and often a `plus:DataMining` "prohibited"
  rights flag.
- **A visible tiled watermark is sufficient evidence of an unlicensed
  preview, but its absence is not evidence of a clean license** — check the
  metadata regardless of whether anything looks watermarked on screen.
- No stock-service metadata found is also not proof of a clear license,
  just an absence of the specific red flag this check looks for — say so
  explicitly rather than calling a metadata-clean file "confirmed licensed."

If a supplied photo fails this check, it's fine to ship it anyway if the
user explicitly says so (their call, their content) — but say so plainly,
record which files are still pending a real replacement (a short
`images/README.md` per-file credit/status list works well), and don't
silently treat "the user gave me a file" as "the file is licensed."

Real, verifiably free-license photos (Unsplash License / Pexels License,
both explicitly free for commercial use with no attribution required) are
the target — a photo manifest listing `sourceUrl`/`downloadUrl`/
`photographer`/`license` per image, built from a real search of those two
sites, is a good format for a user to hand off if they can't upload files
directly (see §7's image-attachment note in `cloudflare-wiki.md` for why
the session usually can't fetch the `downloadUrl` itself and needs the
files uploaded some other way).

## 9. A continuous-scroll rebuild invalidates every CSS assumption tied to click-tab behavior — audit, don't assume

Confirmed twice in one session (`aripshitadventure`, 2026-08-10) after
rebuilding from zurich-pwa's real click-to-switch-tabs pattern (each nav
chip click hides all other `.tab-section`s and resets scroll to top) into a
continuous-scroll pattern (all sections always rendered, a sticky nav
scroll-spies the active chip, clicking smooth-scrolls instead of toggling
`display`). Two separate pieces of CSS had been written with an *explicit,
commented* dependency on "every tab switch resets scroll to top," and both
silently broke the moment that stopped being true — not because the
architecture change itself was wrong, but because nothing re-audited CSS
comments elsewhere in the file that had baked in the old assumption:

1. A mobile-only rule padded a day-quick-jump nav row by 84px/172px "to
   clear the fixed FAB stack, since this row is always the first thing
   visible on a fresh tab load." Under continuous scroll that row can land
   anywhere on the page, and the leftover padding crushed 5 day-pills into
   a single ~79px column, stacking them one per row instead of wrapping.
2. A timezone pill was pinned top-right specifically because bottom-right
   "collided with whatever content the scroll-to-top() lands on for every
   tab switch." With no more scroll-to-top event, top-right instead
   visibly overlapped the new sticky nav bar — the exact kind of collision
   the original placement was chosen to avoid, just relocated.

**The pattern to watch for:** any CSS/JS comment that justifies a layout
choice by referencing tab-switch/scroll-reset behavior is a landmine the
moment that behavior changes — `grep -i "tab switch\|scroll.to.top\|resets scroll"`
across the stylesheet and app JS before/after a navigation-architecture
change, and re-verify each hit live (not just re-read the comment) rather
than assuming a rebuild that fixed the thing it was aimed at didn't also
quietly break something adjacent that depended on the old behavior.

## 10. Feature inventory — check these before building anything from scratch

Mined from a full pass across every remaining trip-site repo on this account
(2026-08-10) that hadn't yet been swept for this playbook. Three background
research passes covering ~13 repos, cross-checked against each other and
against what §1–§9 already documented, specifically to avoid re-listing
anything already covered.

### Check these two repos FIRST, before writing new code for what they already do

- **`jhwiv/travel-app-components`** — a real, actively-consumed copy-paste
  component library (not aspirational): `welcome-screen`, `packing-list-v2`,
  and `concierge-chat`, each with its own README/source/notes/snippets,
  extracted from zurich-weekend, maritimes-grandloop-v2, and
  santafe-itinerary. Confirmed actually adopted — `aripshitadventure`'s own
  source has explicit "adapted from travel-app-components/..." attribution
  comments for the first two. It also tracks a "parking lot" of ~12
  identified-but-not-yet-extracted patterns (print views, a time pill,
  per-activity Wear/Expect/Arrive rows, a feedback-mail flow) — check that
  list before building any of those from zero.
- **`jhwiv/trip-restaurants`** — a full, mature restaurant-reservation
  module, not a toy: tiered pricing ($$/$$$/$$$$), per-night backup-pick
  auto-suggestion, an OpenTable/Resy deep-link builder that prefills
  date/covers, a "mark as booked" flow, and a reservation-timeline widget
  ("3 of 7 nights picked · 1 booked"). Build-time Nominatim geocoding +
  OSRM walk-time routing (both free, no API key, resolved at build time not
  runtime). Live and in production use via `santafe-itinerary`/
  `santafe-demo` (santafejune.com) — bundled locally rather than
  CDN-loaded, deliberately, to avoid a third-party outage taking down a
  live trip site. Its own `scripts/verify.js` treats OpenTable/Resy WAF
  403s on automated checks as a soft-block warning, not a hard CI failure —
  copy that distinction if reusing the verify script, a hard-fail here
  produces constant false alarms.

### Confirmed independently in 2+ unrelated repos (strong signal — treat as standard, not optional)

- **A print stylesheet** (`@media print`, hiding nav/FABs/chat, forcing
  content to flow for paper) — present in `caribbean-escape`, `short-aruba`,
  `barrier-island-digital`/`naples` (the latter also sets
  `print-color-adjust: exact` so background colors survive printing), and
  flagged as a high-priority not-yet-extracted item in
  `travel-app-components`'s own parking lot. Build one by default, not as
  an afterthought — see §"Verify the site locally" for the print-specific
  gotcha this session already hit (a JS-toggled collapsed element needs an
  explicit `display: block !important` override or its content vanishes
  from print entirely).
- **A packing list with `localStorage`-persisted checkboxes** — present in
  `travel-app-components/packing-list-v2` (sourced from santafe-itinerary),
  `short-aruba`, and independently in `santafe-itinerary` itself. Treat as
  a standard tab, not an optional add-on.
- **A group priority poll / ranked-choice voting widget** (per-activity
  Yes/Maybe/Skip, drag-to-rank priorities, a live tallied results panel) —
  present in both `budvienna` and `barrier-island-digital`. Real caveat,
  confirmed in `budvienna`: results are `localStorage`-only per visitor's
  own browser, with **no backend sync across different travelers' devices**
  — tell the user this explicitly if they want a real shared group poll,
  don't let them assume it aggregates automatically.

### Notable single-repo patterns worth knowing exist

- **Offline service worker** with real dead-zone coverage (confirmed useful
  for e.g. a canyon hike or a dawn balloon launch with no signal) — deploy-
  version-tied auto-invalidating cache, not just a static precache list.
  *(santafe-itinerary — `aripshitadventure` already has its own version of
  this from this account's earlier work, see task history)*
- **A floating "live flight card"** on flight days: T-24h through landing,
  60s auto-refresh plus a manual refresh button once data goes >3 min
  stale, `pageshow`/`focus`-triggered re-check. Richer than a static status
  badge. *(santafe-itinerary)*
- **A "boarding-pass style" ticket card** deriving a host label + booking
  reference from a stored voucher URL — reusable pattern for any
  Viator/OpenTable/Resy confirmation, not just flights. *(santafe-itinerary)*
- **Contingency/branching itinerary tabs** ("Primary Plan" vs. "If X
  Cancels") for a trip with a real cancellation-contingent structure — a
  distinct pattern from the single-linear-itinerary shape every other repo
  assumes. *(fl-business-trip)*
- **Standalone PDF export**, two different real implementations depending
  on the need: a vendored PDF.js viewer linking to a pre-made static PDF
  file (`barrier-island-digital`, `vendor/pdfjs/`), vs. a Python/ReportLab
  script that *generates* a branded, custom-fonted PDF from the trip data
  (`fl-business-trip`) — pick based on whether the PDF is a fixed document
  or needs to be generated from the same data driving the site.
- **A restaurant menu modal** (bottom-sheet, real dish names/prices sourced
  from the venue's own site or OpenTable) and a **non-AI "contact your
  travel agent" modal** (a human-agent contact card with `tel:`/`mailto:`
  links, no AI backend) — a lightweight alternative to a full AI concierge
  when one isn't warranted. *(caribbean-escape)*
- **`prefers-reduced-motion` support and a manual dark-mode toggle**
  (default light regardless of OS setting) — accessibility/theming not
  covered anywhere else in this playbook. *(budvienna, caribbean-escape)*
- **Locally vendored per-attraction photos** instead of hotlinked Unsplash
  URLs (`budvienna/assets/attractions/`) — a working alternative to §2's
  hotlink pattern, directly relevant given this sandbox usually can't fetch
  external images at all (§9's hero/banner note, and the image-attachment
  lesson in `cloudflare-wiki.md`).
- **Drag-to-reorder "favorites" cards** with `localStorage` pin persistence
  and an accessible, keyboard-operable drag handle — from a curated
  restaurant-directory site rather than a day-by-day itinerary, but the
  interaction pattern (pointer-drag reorder + persisted order + keyboard
  fallback) is reusable anywhere a user needs to rank/prioritize a list.
  *(greenville-dining-guide)*
- **Privacy: no auth gate on Cloudflare Pages by default** means a public
  trip site publishes whatever it contains to anyone with the URL.
  `budvienna` anonymized full traveler names to initials for exactly this
  reason before going public — ask the user whether real names should
  appear on a shareable link, don't assume yes by default.

### AI concierge chat — one confirmed gap to close on every future build

`travel-app-components/concierge-chat`'s own notes flag that the shipped
Maritimes build has **no user-facing hallucination disclaimer** on the chat
UI — a known, acknowledged gap, not yet fixed anywhere on this account as
of this survey. Treat "the concierge chat should tell the user its answers
aren't guaranteed accurate" as a requirement for any new concierge build,
not optional polish.

### Cloudflare Workers AI cost reality (concierge chat backend)

Concrete numbers from `travel-app-components/concierge-chat`'s notes,
worth knowing before assuming the shared Worker's AI chat is free at any
volume: roughly $0.011 per 1,000 neurons; Llama-3.3-70b uses ~5,000–20,000
neurons per reply; worst-case volume on one trip's chat has been estimated
around $40. Two known mitigations if that ever matters: downgrade to
`llama-3.1-8b-instruct`, or cache common answers in KV instead of
re-generating them per request.

### Flight-verification gotchas (extends the existing FlightAware AeroAPI integration)

`santafe-itinerary` also added `mode=schedules` (a published-timetable
route/airline/date lookup, alongside the existing live-status endpoint,
sharing the same `AEROAPI_KEY` and edge cache) — check there before adding
a second, separate schedules integration. Two real, confirmed bugs already
found and fixed in that same integration, worth avoiding on any future
flight-verification feature:
- **AeroAPI's `scheduled_out` can drift 5–15 minutes from the airline's own
  officially published time.** Treat the airline-published wall-clock time
  as ground truth; use AeroAPI only for the live delta/status on top of it,
  not as the source of the scheduled time itself.
- **A naive UTC-day-window flight lookup misses an evening-local flight
  that spills into the next UTC day**, and can show a real flight as
  "Cancelled" by matching the wrong day's instance entirely. Use a ±12h
  window around the expected local time instead of a calendar-day
  boundary, plus an explicit `beyondHorizon` sentinel for AeroAPI's 2-day
  advance-lookup cap rather than treating "no result" as itself meaningful.

See `docs/cloudflare-wiki.md` for the Cloudflare-platform-specific
counterpart to this file, including an explicit log of wrong guesses
already made and corrected — read both before starting a new build.
