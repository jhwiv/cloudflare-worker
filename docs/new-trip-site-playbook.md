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
- **Hero**: a real photo background via a **hotlinked remote URL**
  (`background: url('https://images.unsplash.com/...') center/cover
  no-repeat`), not a local asset or API-key-gated embed. A sandboxed session
  can't browse to find/verify photo URLs — ask the user for real ones
  up front rather than guessing; fall back to a solid navy/gold color-block
  banner (zurich's own pattern for non-hero section transitions) for
  anything not supplied.
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
- **JS pitfall already hit once:** `navigator.geolocation.getCurrentPosition`'s
  own `timeout` option is not a hard guarantee — some browsers only start
  that clock once the permission prompt is answered, so an unanswered
  prompt can hang forever. Wrap it in your own `setTimeout` fallback too.

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

See `docs/cloudflare-wiki.md` for the Cloudflare-platform-specific
counterpart to this file, including an explicit log of wrong guesses
already made and corrected — read both before starting a new build.
