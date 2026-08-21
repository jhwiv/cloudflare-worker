# cloudflare-worker

Multi-site trip-concierge worker for the Maritimes Grand Loop, Zürich
Weekend, and London/Normandy/Porto (`wwii2026`) trip sites.
Streams from Cloudflare Workers AI (Llama 3.3) with weather from
Open-Meteo, nearby-places from OpenStreetMap/Overpass, and live ferry
status from Marine Atlantic (Maritimes only).

Auto-deploys from `main` via GitHub Actions (`cloudflare/wrangler-action@v3`).

## Routes

| Path | Method | Description |
|------|--------|-------------|
| `/api/health` | GET | Liveness check. Returns `{status, time}`. |
| `/api/ferry-status` | GET | Live Marine Atlantic advisory. Parses [marineatlantic.ca/travel-advisory](https://www.marineatlantic.ca/travel-advisory) and returns structured JSON. KV-cached 15 min. Add `?force` to bypass cache. |
| `/api/chat/maritimes` | POST | Concierge chat for the Maritimes site. Body: `{message, history, latitude?, longitude?, gpsStatus?, localTime?, activeTab?}`. Returns a streaming text response. |
| `/api/chat/zurich` | POST | Same as above for the Zürich site. |
| `/api/chat/wwii2026` | POST | Same as above for the London/Normandy/Porto trip site (aripshitadventure repo, Oct 2026). Note: `resolveQueryLocation`'s explicit day/place-name override (e.g. "before the ferry", "Day 4") is Maritimes-only — this site falls back to GPS/itinerary-inferred location for all queries, so a chat asking about a specific future day by name will still answer using the traveler's *current* inferred location rather than that day's city. |

### `/api/ferry-status` response shape

```json
{
  "fetchedAt": "2026-06-24T02:15:42.422Z",
  "source": "https://www.marineatlantic.ca/travel-advisory",
  "cancelled": {
    "count": 1,
    "intro": "Due to adverse weather conditions, …",
    "rows": [
      {
        "date": "06/24/2026",
        "time": "7:45",
        "route": "Port aux Basques to North Sydney",
        "vessel": "Leif Ericson",
        "status": "Cancelled",
        "sailingMode": "Restricted, Commercial Only",
        "terminalTz": "NDT",
        "iso": "2026-06-24T07:45:00-02:30"
      }
    ]
  },
  "rescheduled": {
    "count": 3,
    "intro": "Due to adverse weather conditions, the following sailings have been rescheduled; …",
    "rows": [
      {
        "date": "06/23/2026", "time": "23:45",
        "route": "North Sydney to Port aux Basques",
        "vessel": "Blue Puttees", "status": "Departing early",
        "sailingMode": "Unrestricted",
        "revisedDate": "06/23/2026", "revisedTime": "22:45",
        "checkIn": "20:45",
        "terminalTz": "ADT",
        "iso": "2026-06-23T23:45:00-03:00",
        "revisedIso": "2026-06-23T22:45:00-03:00"
      }
    ]
  },
  "hasAdvisories": true,
  "cacheStatus": "hit"
}
```

`cacheStatus` is `"hit"`, `"miss"`, `"no-kv"` (binding not configured), or `"error"`.

## Concierge live-status injection

For Maritimes chats whose message references ferries, Marine Atlantic, a
terminal, a vessel, or the trip's ferry days (June 30 / July 5–6), the
worker fetches `/api/ferry-status` and splices a `LIVE FERRY STATUS:` block
into the system prompt before the LLM runs. The LLM is instructed to:

- treat it as the authoritative source for Marine Atlantic sailings,
- cite the source URL,
- proactively surface changes that affect the booked Day 4 outbound or
  Day 9 return.

If the fetch fails, the chat still works — the LLM falls back to advising
the user to check the operator's site directly.

## Local dev

```bash
npm install --global wrangler   # or use npx
wrangler dev                    # localhost:8787
```

Test endpoints:

```bash
curl http://localhost:8787/api/health
curl http://localhost:8787/api/ferry-status | jq
curl -X POST http://localhost:8787/api/chat/maritimes \
  -H 'Content-Type: application/json' \
  -d '{"message":"What about dinner before the June 30 ferry?"}'
```

## Enabling KV cache for ferry status (optional)

The ferry-status code works without KV — it just fetches marineatlantic.ca
on every concierge request that mentions ferries. To reduce origin load to
roughly four fetches per hour, enable the cache:

```bash
wrangler kv namespace create FERRY_KV
# prints:  id = "abc123..."
```

Then in `wrangler.toml` uncomment the `[[kv_namespaces]]` block and paste
the printed id. Redeploy.

## Files

- `src/index.js` — router, weather, Overpass nearby-places, prompt building, streaming.
- `src/ferry-status.js` — Marine Atlantic advisory fetch + parse + KV cache + prompt formatter.
