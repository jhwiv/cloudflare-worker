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
