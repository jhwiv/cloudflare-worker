# Cloudflare platform wiki

Everything confirmed about how Cloudflare Pages/Workers actually behave for
this account, plus an explicit log of wrong guesses already made and
corrected — so the same mistake doesn't get made twice. Read this before
giving any Cloudflare instruction or writing any Cloudflare-touching code.

## How to use this document

- **CONFIRMED** = verified live (a real command ran, a real screen was seen,
  a real API response was checked).
- **WRONG GUESS, CORRECTED** = something stated with confidence that turned
  out to be false. These are not embarrassing footnotes to skip — they are
  the most valuable entries in this file, because they're the exact
  shape of mistake that's cheap to repeat and expensive to make twice.
- Cloudflare's dashboard UI changes. Anything screen-shaped here has a date;
  if it's more than a few months old, don't trust it blindly — re-verify
  the first time it matters, then update this file with what's actually
  there now.

## Corrected agent mistakes (read this section first)

1. **WRONG GUESS: "Cloudflare Pages creation is under Workers & Pages →
   Create → a Pages tab → Connect to Git."** This was stated confidently
   and was stale. What's actually there (2026-08-09): a unified "Create a
   Worker" / "Ship something new" screen. The Pages path is a small link
   at the bottom — **"Looking to deploy Pages? Get started"** — not a tab,
   not reachable via "Continue with GitHub" at the top (that's the Worker
   path). Caught only because the user pasted a real screenshot and
   pushed back — not caught by re-checking assumptions proactively. **The
   lesson: don't describe a multi-step Cloudflare dashboard flow from
   memory/training data as current fact — either verify it live first, or
   caveat it explicitly as unconfirmed and ask the user to confirm the
   first screen before describing the rest.**
2. **WRONG GUESS (adjacent, same incident): assumed the "Build output
   directory" field would need a value typed into it.** The real field has
   a static `/` prefix shown next to an empty input — the input itself
   should be left blank. Would have told the user to type a redundant
   second `/` if not corrected by the actual screenshot.
3. **WRONG GUESS: assumed zurich-pwa had Apple Maps / Waze buttons "just
   like" a described reference site**, before checking. Grepping the real
   file showed zero matches for `waze`/`apple maps`/`comgooglemaps` — it
   only ever had Google Maps text-search links. Caught by actually reading
   the source file instead of answering from the general impression of
   "a site like this would probably have that." **The lesson: "just like
   X" claims about a specific sibling build are a claim about actual code,
   not vibes — check the file before agreeing or building to match it.**
4. **WRONG GUESS: assumed `flight.lounge_access` was an array of strings**
   (`.join(', ')`'d directly into a template). Real shape is an array of
   objects (`name`/`terminal`/`access`/`notes`). Rendered as literal
   `[object Object]` on the live page until caught by an actual screenshot
   — a DOM `.count()`-style check would not have caught this, only looking
   at the rendered page did.
5. **INCOMPLETE FIX, not a guess but the same failure shape: added an
   "unverified flight" warning but only wired it into ONE of four places
   a flight renders** (Air & Hotel tab), leaving the day-by-day item cards
   — the view people actually browse first — showing a confident,
   unflagged flight time with no arrival time shown either. Found only
   because the user sent a real screenshot of the live deployed page, not
   because a broader pass was made proactively before calling the feature
   done. **The lesson, repeated from the trip-site playbook because it
   keeps recurring: when a UI element appears in multiple render paths,
   grep for every call site before declaring a fix complete — "I fixed it
   in the place I was looking at" is not the same claim as "I fixed it
   everywhere it appears."**

## Confirmed: Cloudflare Pages deploy flow (2026-08-09, screen-by-screen)

1. dash.cloudflare.com → **Workers & Pages** (left sidebar) → **Create**
2. Unified "Create a Worker" screen. Do **not** use "Continue with GitHub"
   at top. Click the small **"Looking to deploy Pages? Get started"** link.
3. Import-method picker → **"Import an existing Git repository"**
4. Repo picker (GitHub already connected) → select repo → **"Set up builds
   and deployments"**:
   - Project name: prefilled from repo name; resulting URL shown live as
     `<project-name>.pages.dev`
   - Production branch: prefilled `main`
   - Framework preset: **None** (correct for a plain static site)
   - Build command: leave **empty**
   - Build output directory: has a static `/` prefix already shown — leave
     the input **blank**, don't type a second `/`
   - Two collapsed "(advanced)" sections (Root directory, Environment
     variables) — skip for a plain static site
   - **Save and Deploy**
5. Custom domain: project → **Custom domains** tab → **Set up a custom
   domain** → follow DNS prompts.

### Alternative: CLI-only, no dashboard, no GitHub connection
```powershell
npm install -g wrangler
wrangler login
wrangler pages deploy . --project-name=<site-name>
```
Doesn't auto-redeploy on future pushes — rerun manually, or add a GitHub
Actions workflow with `cloudflare/pages-action` (mirrors how this repo's
own Worker auto-deploys via `cloudflare/wrangler-action@v3`).

## Confirmed: 17 deployment lessons, mined from ~26 repos on this account (2026-08-09)

Each of these had already cost real debugging time once, in a real incident,
before being written down here. They were previously scattered across
individual repos' README/VERSION.md/wrangler.toml comments with nothing
connecting them.

1. **Pages secret rotation doesn't auto-redeploy.** `wrangler pages secret
   put` doesn't propagate to the running deployment — trigger a fresh
   deploy afterward (empty commit + push works). *(vigil-family-records)*
2. **Workers and Pages have entirely separate secret stores.** A companion
   Worker needs its own copy of a secret even if it's already set on the
   Pages project it calls. *(vigil-family-records)*
3. **Pages Functions (V8 isolates) can't run child processes or native
   modules**, ~30s CPU budget, ~100s edge timeout. CLI-based tooling
   silently fails — route heavy work through a Queue + dedicated Worker.
   *(vigil-family-records)*
4. **Pages' `wrangler.toml` doesn't support `[triggers]` (cron) at all.**
   Needs a companion Worker hitting Pages HTTP endpoints with a shared
   bearer secret. *(vigil-family-records)*
5. **The account default silently changed from classic Pages to "Workers
   with static assets."** New Git-connected projects can create as Workers
   — confirm with `--dry-run`, don't assume. *(multihomes-command)*
6. **A custom domain attached via `wrangler.jsonc`/`routes` is a standing
   account-level resource** — removing the `routes` entry doesn't clean it
   up; needs an explicit `DELETE /accounts/{id}/workers/domains/{id}`.
   *(daily-dashboard)*
7. **`workers_dev` toggling interacts destructively with Cloudflare
   Access** — can silently kill the `*.workers.dev` URL or silently drop
   an Access policy, leaving something live and unauthenticated with a
   plain `200`. **Never call an Access-gated URL "safe" from a `200`
   status alone — check the response body.** Real incident, real sensitive
   data briefly exposed. *(daily-dashboard)*
8. **Cloudflare Access gates static assets too** (breaks iOS "Add to Home
   Screen"). **Workers Static Assets bypasses the Worker's own `fetch()`
   handler by default** — `"run_worker_first": true` needed if the Worker
   must guard those requests. `manifest.json`'s `start_url` must be
   absolute if served cross-hostname. *(daily-dashboard)*
9. **Missing/misconfigured `_headers` cache rules let the *edge* cache
   serve stale content to every visitor**, not just the browser.
   `immutable` caching is only safe for content-hashed output; a policy
   fix can't retroactively bust an old `immutable` promise — rename the
   file. A three-layer cache-busting pattern has already been
   independently rediscovered twice. *(family-transition-tracker,
   daily-dashboard)*
10. **Workers Cron Triggers are capped at 5 per account.** Confirm against
    the live schedule API before assuming a slot is free.
    *(daily-dashboard)*
11. **Some third-party APIs block Cloudflare's Workers outbound IP range
    specifically** — `wrangler dev` runs on a different network and can't
    reproduce this; only a live deployed Worker can confirm it.
    *(daily-dashboard, ne-racing)*
12. **`caches.default` is partitioned per colo** — a cold colo's first
    visitor pays full uncached cost. A Cron Trigger that proactively warms
    the cache fixes this. *(ne-racing)*
13. **A Worker's isolate can die the instant the response stream
    finishes**, truncating an in-flight `cache.put()`. Wrap cache writes
    in `ctx.waitUntil()`. *(ne-racing)*
14. **Split deploy pipelines are a recurring trap**: Pages auto-deploys via
    CI, a companion Worker often needs a separate manual `wrangler deploy`
    with no CI coverage. *(ne-racing)*
15. **GitHub Pages cannot execute Cloudflare Pages Functions at all.**
    Never point GitHub Pages' `CNAME` and a Cloudflare Pages custom domain
    at the same apex simultaneously. *(maritimes-grandloop-v2)*
16. **"Deployed" ≠ "confirmed live."** A timestamp only proves Cloudflare
    *received* a push. Access gating a production domain correctly 403s an
    unauthenticated agent-sandbox request — that's expected, not proof of
    a failed deploy. **The only real confirmation is a human looking at
    the live site.** *(multihomes-command, daily-dashboard — mirrors the
    identical rule already in trip-optimizer's CLAUDE.md)*
17. **Never put secrets in `wrangler.toml`/`wrangler.jsonc`.** `wrangler
    secret put` / `wrangler pages secret put` only.

## Known real integrations already working on this account

- **`jhwiv/cloudflare-worker`** — shared multi-site concierge Worker
  (`cloudflare-worker.jhwiv-online.workers.dev`), Cloudflare Workers AI
  (Llama 3.3), no external LLM key needed. Serves `zurich`, `maritimes`,
  `wwii2026` chat routes from one Worker + `ITINERARY_SCHEDULE`/`SITES`
  config per trip. See `docs/new-trip-site-playbook.md` §3 for the exact
  pattern to add a new site.
- **`jhwiv/santafe-itinerary`** — has a real, working live flight-schedule
  verification endpoint: `functions/api/flight-status.js` (Cloudflare
  Pages Function) calling FlightAware AeroAPI, keyed by `AEROAPI_KEY` env
  var. Also a standalone `flight-status.jhwiv-online.workers.dev` Worker
  version. This is the pattern to reuse for verifying guessed flight
  numbers on any future trip site — don't rebuild from scratch, copy this.
