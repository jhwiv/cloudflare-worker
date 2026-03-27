// Multi-Site Trip Chat Concierge — Cloudflare Worker
// Uses Cloudflare Workers AI (streaming) + Open-Meteo (weather)
// Routes: /api/chat/zurich and /api/chat/maritimes

// ── CORS helpers ───────────────────────────────────────
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function corsResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

// ── Weather codes ──────────────────────────────────────
const WX_CODES = {
  0:'Clear', 1:'Mainly clear', 2:'Partly cloudy', 3:'Overcast',
  45:'Foggy', 48:'Rime fog',
  51:'Light drizzle', 53:'Drizzle', 55:'Dense drizzle',
  61:'Light rain', 63:'Rain', 65:'Heavy rain',
  71:'Light snow', 73:'Snow', 75:'Heavy snow',
  80:'Light showers', 81:'Showers', 82:'Heavy showers',
  95:'Thunderstorm',
};

async function getWeather(lat, lng, tz) {
  const url = `https://api.open-meteo.com/v1/forecast`
    + `?latitude=${lat}&longitude=${lng}`
    + `&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,precipitation`
    + `&hourly=temperature_2m,weather_code,precipitation_probability,wind_speed_10m`
    + `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset`
    + `&temperature_unit=fahrenheit&wind_speed_unit=mph`
    + `&timezone=${encodeURIComponent(tz)}&forecast_days=3`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const current = {
      temp: Math.round(data.current.temperature_2m),
      humidity: data.current.relative_humidity_2m,
      condition: WX_CODES[data.current.weather_code] || 'Mixed',
      windMph: Math.round(data.current.wind_speed_10m),
      precipitation: data.current.precipitation,
    };
    const now = new Date();
    const hourly = [];
    if (data.hourly?.time) {
      for (let i = 0; i < data.hourly.time.length && hourly.length < 6; i++) {
        const t = new Date(data.hourly.time[i]);
        if (t >= now) {
          hourly.push({
            hour: t.getHours(),
            temp: Math.round(data.hourly.temperature_2m[i]),
            condition: WX_CODES[data.hourly.weather_code[i]] || 'Mixed',
            rainChance: data.hourly.precipitation_probability[i],
            windMph: Math.round(data.hourly.wind_speed_10m[i]),
          });
        }
      }
    }
    const daily = [];
    if (data.daily?.time) {
      for (let i = 0; i < data.daily.time.length; i++) {
        daily.push({
          date: data.daily.time[i],
          hi: Math.round(data.daily.temperature_2m_max[i]),
          lo: Math.round(data.daily.temperature_2m_min[i]),
          condition: WX_CODES[data.daily.weather_code[i]] || 'Mixed',
          rainChance: data.daily.precipitation_probability_max[i],
        });
      }
    }
    return { current, hourly, daily };
  } catch { return null; }
}

function formatWeather(wx, label) {
  if (!wx) return '';
  let s = `\n\n${label} WEATHER: ${wx.current.temp}°F, ${wx.current.condition}, Wind ${wx.current.windMph} mph, Humidity ${wx.current.humidity}%.`;
  if (wx.hourly.length > 0) {
    s += '\nNEXT HOURS:';
    for (const h of wx.hourly)
      s += `\n  ${h.hour}:00 — ${h.temp}°F, ${h.condition}, ${h.rainChance}% rain, Wind ${h.windMph} mph`;
  }
  if (wx.daily.length > 0) {
    s += '\nDAILY FORECAST:';
    for (const d of wx.daily)
      s += `\n  ${d.date}: Hi ${d.hi}°F / Lo ${d.lo}°F, ${d.condition}, ${d.rainChance}% rain`;
  }
  return s;
}

// ── Itinerary-aware location inference ───────────────────
// Given the current UTC time, determine where the traveler SHOULD be per the itinerary.
// Each segment has a UTC-based time range (to avoid timezone ambiguity in comparisons).
const ITINERARY_SCHEDULE = {
  zurich: [
    // Wed 25 Mar night: departing home, overnight flight
    { from: '2026-03-25T22:00Z', to: '2026-03-26T06:00Z',
      city: 'In transit', timezone: 'Europe/Copenhagen', lat: 55.6761, lng: 12.5683,
      note: 'The traveler is on an overnight flight to Copenhagen. They arrive CPH around 7 AM Thursday.' },
    // Thu 26 Mar 6 AM CET through Fri 27 Mar ~5 PM CET (17:00 CET = 16:00 UTC)
    { from: '2026-03-26T06:00Z', to: '2026-03-27T16:00Z',
      city: 'Copenhagen', timezone: 'Europe/Copenhagen', lat: 55.6761, lng: 12.5683,
      note: 'The traveler should be in Copenhagen (hotel: Scandic Nørreport). They fly to Zürich Friday evening.' },
    // Fri 27 Mar ~5 PM–8 PM CET: in transit CPH → ZRH
    { from: '2026-03-27T16:00Z', to: '2026-03-27T19:40Z',
      city: 'In transit', timezone: 'Europe/Zurich', lat: 47.3769, lng: 8.5417,
      note: 'The traveler is flying from Copenhagen to Zürich. Arrives ZRH ~7:40 PM CET.' },
    // Fri 27 Mar 7:40 PM CET onward through Sun 29 Mar ~7 PM CET
    { from: '2026-03-27T19:40Z', to: '2026-03-29T17:00Z',
      city: 'Zürich', timezone: 'Europe/Zurich', lat: 47.3769, lng: 8.5417,
      note: 'The traveler should be in Zürich (hotel: Zürich Marriott Hotel).' },
    // Sun 29 Mar ~6 PM CET: heading to airport, flight 8:25 PM
    { from: '2026-03-29T17:00Z', to: '2026-03-29T20:30Z',
      city: 'Zürich (departing)', timezone: 'Europe/Zurich', lat: 47.3769, lng: 8.5417,
      note: 'The traveler should be heading to ZRH airport or at the airport. Flight departs 8:25 PM.' },
  ],
  maritimes: [
    { from: '2026-06-27T12:00Z', to: '2026-06-28T04:00Z',
      city: 'Portland, ME', timezone: 'America/New_York', lat: 43.6591, lng: -70.2568,
      note: 'Day 1: Arriving in Portland, meeting Molly & Bonie.' },
    { from: '2026-06-28T04:00Z', to: '2026-06-29T04:00Z',
      city: 'In transit / Digby, NS', timezone: 'America/Halifax', lat: 44.6206, lng: -65.7596,
      note: 'Day 2: Driving Portland → Saint John, ferry to Digby.' },
    { from: '2026-06-29T04:00Z', to: '2026-06-30T04:00Z',
      city: 'Lunenburg, NS', timezone: 'America/Halifax', lat: 44.3890, lng: -64.5205,
      note: 'Day 3: Driving Digby → Lunenburg via South Shore.' },
    { from: '2026-06-30T04:00Z', to: '2026-07-01T04:00Z',
      city: 'In transit / Ferry', timezone: 'America/Halifax', lat: 46.2382, lng: -60.1942,
      note: 'Day 4: Driving Lunenburg → North Sydney, overnight ferry to Newfoundland.' },
    { from: '2026-07-01T04:00Z', to: '2026-07-02T04:00Z',
      city: 'Twillingate, NL', timezone: 'America/St_Johns', lat: 49.6514, lng: -54.7681,
      note: 'Day 5: Driving across Newfoundland to Twillingate.' },
    { from: '2026-07-02T04:00Z', to: '2026-07-05T04:00Z',
      city: 'Fogo Island, NL', timezone: 'America/St_Johns', lat: 49.4817, lng: -54.7831,
      note: 'Days 6–8: At Fogo Island Inn.' },
    { from: '2026-07-05T04:00Z', to: '2026-07-06T04:00Z',
      city: 'In transit / Ferry', timezone: 'America/St_Johns', lat: 47.5714, lng: -59.1351,
      note: 'Day 9: Fogo → drive to Port aux Basques, overnight ferry back to Nova Scotia.' },
    { from: '2026-07-06T04:00Z', to: '2026-07-07T04:00Z',
      city: 'Pictou, NS', timezone: 'America/Halifax', lat: 45.6797, lng: -62.7126,
      note: 'Day 10: Arrive North Sydney, drive to Pictou.' },
    { from: '2026-07-07T04:00Z', to: '2026-07-08T04:00Z',
      city: 'Fredericton, NB', timezone: 'America/New_York', lat: 45.9636, lng: -66.6431,
      note: 'Day 11: Drive Pictou → Fredericton via Hopewell Rocks.' },
    { from: '2026-07-08T04:00Z', to: '2026-07-09T04:00Z',
      city: 'Portland, ME', timezone: 'America/New_York', lat: 43.6591, lng: -70.2568,
      note: 'Day 12: Final drive Fredericton → Portland. Trip complete.' },
  ],
};

function getItineraryLocation(siteKey, nowUTC) {
  const schedule = ITINERARY_SCHEDULE[siteKey];
  if (!schedule) return null;
  const nowISO = nowUTC.toISOString();
  for (const seg of schedule) {
    if (nowISO >= seg.from && nowISO < seg.to) {
      return { city: seg.city, timezone: seg.timezone, lat: seg.lat, lng: seg.lng, note: seg.note };
    }
  }
  // Before or after the trip
  const firstStart = schedule[0].from;
  const lastEnd = schedule[schedule.length - 1].to;
  if (nowISO < firstStart) {
    return { city: null, timezone: null, lat: null, lng: null, note: 'The trip has not started yet. The traveler is likely planning ahead.' };
  }
  if (nowISO >= lastEnd) {
    return { city: null, timezone: null, lat: null, lng: null, note: 'The trip is over. The traveler has returned home.' };
  }
  return null;
}

// ── Site configurations ────────────────────────────────
const SITES = {
  zurich: {
    weatherLocations: [
      { lat: 47.3769, lng: 8.5417, tz: 'Europe/Zurich', label: 'ZÜRICH' },
      { lat: 55.6761, lng: 12.5683, tz: 'Europe/Copenhagen', label: 'COPENHAGEN' },
    ],
    geoChecks: [
      { lat: 47.3769, lng: 8.5417, radius: 0.5, label: 'They appear to be IN Zürich right now.' },
      { lat: 55.6761, lng: 12.5683, radius: 0.5, label: 'They appear to be IN Copenhagen right now.' },
    ],
    defaultGeoNote: 'They are NOT currently in Zürich or Copenhagen — they may be planning ahead.',
    localTimezone: 'Europe/Zurich',
    buildPrompt: (wxSummary, locationNote, localTime, inferredLocation) => {
      const timeLabel = inferredLocation?.city || 'Zürich';
      return `You are a knowledgeable, friendly travel concierge for a Zürich & Copenhagen trip (25–29 March 2026). You are embedded in the trip's PWA guide.

CRITICAL: Pay close attention to the user's CURRENT LOCATION and TIME. Do NOT assume they are in Zürich unless the location data confirms it. If they are in Copenhagen, give Copenhagen-relevant advice. The user may be browsing any tab of the itinerary regardless of where they physically are.

CURRENT DATE/TIME (${timeLabel}): ${localTime}
${locationNote}
${wxSummary}

FULL ITINERARY:
${ZURICH_ITINERARY}

YOUR ROLE:
- Help the traveler decide what to do next based on: the itinerary, current time, weather, and their location.
- If it's going to rain during an outdoor activity, proactively suggest the indoor alternative from the itinerary.
- Be specific — use times, names, addresses, and walking distances from the itinerary.
- For Uetliberg: if foggy/rainy, suggest Polybahn + ETH Terrace or Landesmuseum instead.
- For Sunday: always remind them about the 6:00 PM hotel departure and 8:25 PM flight if relevant.
- Reference restaurants by name and confirmed reservation times.
- You can respond in English or match the traveler's language.

LOCAL RECOMMENDATIONS (IMPORTANT):
- When the traveler asks about restaurants, cafés, bars, activities, or anything NOT explicitly in the itinerary, you MUST give specific, actionable recommendations using your general knowledge of the city.
- Provide exactly 3 options, each formatted as a clickable link with a one-line description and estimated walk time from their current location (hotel or last known position).
- Format each recommendation like this:
  [Name of Place](https://maps.google.com/?q=Place+Name+City) — Brief one-sentence description. ~X min walk.
- Pick well-known, highly-rated, real establishments. Prioritize places that are likely open at the current time of day.
- For Copenhagen near Scandic Nørreport: you know the Nørreport/Torvehallerne/Nørrebro area well. Recommend real places like Torvehallerne food hall, Café Norden, Kompasset, The Coffee Collective, Paludan Bogcafé, etc.
- For Zürich near Marriott Hotel (Neumühlequai 42): you know the HB/Sihlquai area. Recommend real places like Sprüngli, Hiltl, Zeughauskeller, etc.
- NEVER say "I don't have specific recommendations" or "ask the hotel staff" — you are the concierge, give real answers.
- Keep answers concise — 2-4 short paragraphs max, with the 3 linked recommendations clearly presented.
- Do NOT fabricate place names, but DO use your real knowledge of well-known establishments in these cities.`;
    },
  },

  maritimes: {
    weatherLocations: [
      { lat: 43.6591, lng: -70.2568, tz: 'America/New_York', label: 'PORTLAND ME' },
      { lat: 49.4817, lng: -54.7831, tz: 'America/St_Johns', label: 'FOGO ISLAND' },
    ],
    geoChecks: [
      { lat: 43.6591, lng: -70.2568, radius: 0.5, label: 'They appear to be IN Portland, ME right now.' },
      { lat: 44.3890, lng: -64.5205, tz: 'America/Halifax', radius: 0.5, label: 'They appear to be near Lunenburg, NS right now.' },
      { lat: 49.4817, lng: -54.7831, radius: 0.8, label: 'They appear to be on Fogo Island right now.' },
      { lat: 45.9636, lng: -66.6431, radius: 0.5, label: 'They appear to be in Fredericton, NB right now.' },
    ],
    defaultGeoNote: 'They are NOT currently near any of the itinerary stops — they may be planning ahead.',
    localTimezone: 'America/New_York',
    buildPrompt: (wxSummary, locationNote, localTime, inferredLocation) => {
      const timeLabel = inferredLocation?.city || 'local time';
      return `You are a knowledgeable, friendly travel concierge for a 12-day Maritimes Grand Loop road trip (Newfoundland & Nova Scotia, Summer 2026). You are embedded in the trip's PWA guide.

CRITICAL: Pay close attention to the travelers' CURRENT LOCATION and TIME. Do NOT assume they are at any particular stop unless the location data confirms it. The travelers may be browsing any tab of the itinerary regardless of where they physically are.

CURRENT DATE/TIME (${timeLabel}): ${localTime}
${locationNote}
${wxSummary}

FULL ITINERARY:
${MARITIMES_ITINERARY}

YOUR ROLE:
- Help the travelers decide what to do next based on: the itinerary, current time, weather, and their location.
- Be specific — use place names, driving distances, ferry times, and hotel names from the itinerary.
- For ferry crossings: remind them of departure times and that they should arrive early.
- For Fogo Island days (6–8): suggest activities, hikes, and local experiences.
- Reference hotels by name and location.
- For driving days: mention approximate drive times and suggested stops.
- Keep answers concise — 2-4 short paragraphs max. Use natural language, not bullet lists.
- You can respond in English or match the traveler's language.
- The travelers are a group including Molly and Bonie.
LOCAL RECOMMENDATIONS (IMPORTANT):
- When the travelers ask about restaurants, cafés, bars, activities, or anything NOT explicitly in the itinerary, you MUST give specific, actionable recommendations using your general knowledge of the area.
- Provide exactly 3 options, each formatted as a clickable link with a one-line description and estimated walk/drive time from their current location.
- Format each recommendation like this:
  [Name of Place](https://maps.google.com/?q=Place+Name+City) — Brief one-sentence description. ~X min walk/drive.
- Pick well-known, highly-rated, real establishments. Prioritize places that are likely open at the current time of day.
- NEVER say "I don't have specific recommendations" or "ask the hotel staff" — you are the concierge, give real answers.
- Keep answers concise — 2-4 short paragraphs max, with the 3 linked recommendations clearly presented.
- Do NOT fabricate place names, but DO use your real knowledge of well-known establishments in these areas.`;
    },
  },
};

// ── Main fetch handler ─────────────────────────────────
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    // Health check
    if (url.pathname === '/api/health') {
      return corsResponse({ status: 'ok', time: new Date().toISOString() });
    }

    // Chat endpoints: /api/chat/zurich or /api/chat/maritimes
    // Also support legacy /api/chat (defaults to zurich)
    const chatMatch = url.pathname.match(/^\/api\/chat(?:\/(zurich|maritimes))?$/);
    if (chatMatch && request.method === 'POST') {
      const siteKey = chatMatch[1] || 'zurich';
      const site = SITES[siteKey];

      try {
        const body = await request.json();
        const { message, activeTab, history } = body;
        // Support both lat/lng and latitude/longitude field names
        const lat = body.lat ?? body.latitude ?? null;
        const lng = body.lng ?? body.longitude ?? null;
        const clientLocalTime = body.localTime ?? null;
        const gpsStatus = body.gpsStatus ?? null; // 'granted', 'denied', 'unavailable', or null
        if (!message || typeof message !== 'string') {
          return corsResponse({ error: 'Missing message' }, 400);
        }

        // Determine where the traveler should be right now per itinerary
        const now = new Date();
        const inferredLocation = getItineraryLocation(siteKey, now);

        // Get weather for this site's configured locations
        const weatherPromises = site.weatherLocations.map(
          loc => getWeather(loc.lat, loc.lng, loc.tz)
        );

        // Also fetch weather for the user's ACTUAL location (GPS or itinerary-inferred)
        let actualLocationWeatherPromise = null;
        let actualLocationLabel = null;
        if (lat != null && lng != null) {
          // GPS available — fetch weather for their actual coordinates
          const gpstz = inferredLocation?.timezone || site.localTimezone;
          const alreadyCovered = site.weatherLocations.some(
            loc => Math.hypot(lat - loc.lat, lng - loc.lng) < 0.3
          );
          if (!alreadyCovered) {
            actualLocationWeatherPromise = getWeather(lat, lng, gpstz);
            actualLocationLabel = 'YOUR CURRENT LOCATION';
          }
        } else if (inferredLocation?.lat != null) {
          // No GPS — fetch weather for itinerary-inferred location if not already covered
          const alreadyCovered = site.weatherLocations.some(
            loc => Math.hypot(inferredLocation.lat - loc.lat, inferredLocation.lng - loc.lng) < 0.3
          );
          if (!alreadyCovered) {
            actualLocationWeatherPromise = getWeather(
              inferredLocation.lat, inferredLocation.lng, inferredLocation.timezone
            );
            actualLocationLabel = `${inferredLocation.city.toUpperCase()} (CURRENT LOCATION)`;
          }
        }

        const [weatherResults, actualLocationWeather] = await Promise.all([
          Promise.all(weatherPromises),
          actualLocationWeatherPromise,
        ]);

        let wxSummary = '';
        for (let i = 0; i < weatherResults.length; i++) {
          if (weatherResults[i]) {
            wxSummary += formatWeather(weatherResults[i], site.weatherLocations[i].label);
          }
        }
        if (actualLocationWeather && actualLocationLabel) {
          wxSummary += formatWeather(actualLocationWeather, actualLocationLabel);
        }

        // Location context — priority: GPS > itinerary inference > unknown
        let locationNote = '';
        if (lat != null && lng != null) {
          // GPS available — include raw coordinates + geofence check
          locationNote = `USER'S CURRENT GPS: ${Number(lat).toFixed(4)}, ${Number(lng).toFixed(4)}.`;
          let matched = false;
          for (const check of site.geoChecks) {
            if (Math.hypot(lat - check.lat, lng - check.lng) < check.radius) {
              locationNote += ` ${check.label}`;
              matched = true;
              break;
            }
          }
          if (!matched && inferredLocation?.city) {
            locationNote += ` Based on itinerary, they should be in/near ${inferredLocation.city}. ${inferredLocation.note}`;
          } else if (!matched) {
            locationNote += ' They are not near a known itinerary stop.';
          }
        } else if (inferredLocation?.city) {
          // No GPS — use itinerary-based inference
          const gpsReason = gpsStatus === 'denied'
            ? 'GPS permission was denied by the user — do NOT ask them to share their location.'
            : 'GPS is not available.';
          locationNote = `USER LOCATION: ${gpsReason} Based on the itinerary schedule, the traveler should currently be in ${inferredLocation.city}. ${inferredLocation.note}`;
        } else {
          // No GPS, no itinerary match
          const gpsReason = gpsStatus === 'denied'
            ? 'GPS permission was denied by the user — do NOT ask them to share their location.'
            : 'GPS is not available.';
          locationNote = `USER LOCATION: ${gpsReason} ${inferredLocation?.note || 'Location is unknown — make reasonable assumptions based on the itinerary and current date.'}`;
        }
        if (activeTab) {
          locationNote += `\nThe user is currently viewing the "${activeTab}" section of the itinerary (this does NOT necessarily reflect their physical location).`;
        }

        // Compute local time using the actual timezone for where the user is
        const effectiveTz = inferredLocation?.timezone || site.localTimezone;
        const serverLocalTime = now.toLocaleString('en-US', {
          timeZone: effectiveTz, weekday: 'long', year: 'numeric',
          month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
        });
        const localTime = clientLocalTime
          ? `${clientLocalTime} (reported by user's device)`
          : serverLocalTime;

        const systemPrompt = site.buildPrompt(wxSummary, locationNote, localTime, inferredLocation);

        // Build messages array
        const msgs = [{ role: 'system', content: systemPrompt }];
        if (history && Array.isArray(history)) {
          for (const h of history.slice(-8))
            msgs.push({ role: h.role, content: h.content });
        }
        msgs.push({ role: 'user', content: message });

        // Stream from Workers AI
        const stream = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
          messages: msgs,
          max_tokens: 800,
          stream: true,
        });

        return new Response(stream, {
          headers: {
            ...CORS_HEADERS,
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          },
        });

      } catch (err) {
        console.error('Chat error:', err);
        return corsResponse({ error: 'Something went wrong. Please try again.' }, 500);
      }
    }

    return corsResponse({ error: 'Not found' }, 404);
  },
};

// ── ZÜRICH ITINERARY ───────────────────────────────────
const ZURICH_ITINERARY = `{
  "trip": {
    "title": "Zürich · March 2026",
    "dates": "26–29 March 2026",
    "hotel": { "name": "Zürich Marriott Hotel", "address": "Neumühlequai 42", "phone": "+41 44 360 70 70", "homeStop": "Sihlquai/HB — 3 min walk" },
    "emergency": { "any": 112, "ambulance": 144, "police": 117 },
    "zurichCard": "72-hr, CHF 56 pp — all trams, trains, buses, boats, Uetliberg, 40+ museums",
    "flight": { "code": "ZRH", "time": "8:25 PM Sunday 29 March", "leaveHotel": "6:00 PM sharp", "airportExpress": "25 min from HB" }
  },
  "days": [
    {
      "id": "denmark", "label": "Copenhagen Stopover", "dateRange": "Wed 25 – Fri 27 March",
      "stops": [
        { "time": "Wed Night", "title": "Departure → Copenhagen", "desc": "Overnight flight. Arrive CPH Thu 7 AM." },
        { "time": "7:00 AM Thu", "title": "Arrive CPH → Scandic Nørreport", "desc": "Metro M2 Terminal 3 → Nørreport 13 min, 30 DKK. Hotel across the street." },
        { "time": "Hotel", "title": "Scandic Nørreport", "desc": "4-star, rooftop bar Level Six, free happy hour 4–5 PM. +45 7231 5001." },
        { "time": "Charlotte", "title": "Charlotte's Place · Amager", "desc": "Holmbladsgade 70B. M2 → Amagerbro 15 min from hotel." },
        { "time": "Fri Evening", "title": "CPH → ZRH", "desc": "Fly Friday evening. M2 to airport 13 min." }
      ]
    },
    {
      "id": "friday", "label": "Day 1 · Friday 27 March", "title": "Arrival & White Elephant",
      "stops": [
        { "time": "7:40 PM", "title": "Airport → Marriott", "desc": "Airport Express + Tram 13. Arrive ~8:30–8:45 PM." },
        { "time": "9:00 PM", "title": "Dinner: White Elephant", "desc": "Hotel's Michelin-listed Thai. +41 44 360 73 22." },
        { "time": "10:30 PM", "title": "Lenox Bar Nightcap", "desc": "Hotel bar. Optional." }
      ]
    },
    {
      "id": "saturday", "label": "Day 2 · Saturday 28 March",
      "summary": "Uetliberg → Sprüngli → Kunsthaus → Old Town → Lindenhof → aperitivo → Zeughauskeller.",
      "stops": [
        { "time": "10:00 AM", "title": "Uetliberg Summit", "desc": "S10 from HB 20 min. Zürich Card. Felsenegg cable car CLOSED 2 Mar–10 Apr.", "alt": { "foggy": "Polybahn + ETH Terrace", "rainy": "Landesmuseum — free with Zürich Card, Sat 10–5." } },
        { "time": "12:45 PM", "title": "Café Sprüngli", "desc": "Bahnhofstrasse 21. Hot chocolate, Luxemburgerli." },
        { "time": "1:30 PM", "title": "Kunsthaus Zürich", "desc": "Heimplatz 1. Free w/ Zürich Card. Sat 10–6." },
        { "time": "3:00 PM", "title": "Lunch: Kunsthaus Café", "desc": "On-site. Sat 9–9." },
        { "time": "4:15 PM", "title": "Old Town", "desc": "Grossmünster, Fraumünster (Chagall glass), Münsterhof." },
        { "time": "5:45 PM", "title": "Lindenhof Hill", "desc": "Panorama, Roman fort park. 5 min from Fraumünster." },
        { "time": "6:30 PM", "title": "Café Bar Münsterhof", "desc": "Pre-dinner drinks. Münsterhof 6." },
        { "time": "7:30 PM", "title": "Dinner: Zeughauskeller CONFIRMED", "desc": "Bahnhofstrasse 28A. +41 44 220 15 15. CHF 35–55 pp." }
      ]
    },
    {
      "id": "sunday", "label": "Day 3 · Sunday 29 March · Palm Sunday",
      "summary": "Leave hotel by 6:00 PM. Full city window 10 AM–4:30 PM.",
      "stops": [
        { "time": "10:00 AM", "title": "Hiltl Brunch", "desc": "Sihlstrasse 28. CHF 57 pp." },
        { "time": "11:15 AM", "title": "Lake Zürich Promenade", "desc": "Quaianlagen from Bürkliplatz." },
        { "time": "11:45 AM", "title": "Lake Cruise (optional)", "desc": "ZSG ~40 min. Zürich Card." },
        { "time": "1:00 PM", "title": "Lunch: Fischerstube Zürihorn", "desc": "Bellerivestrasse 160. +41 44 422 25 20." },
        { "time": "2:30 PM", "title": "Museum Rietberg", "desc": "Gablerstrasse 15. Free w/ Zürich Card. Sun 10–5." },
        { "time": "5:15 PM", "title": "Farewell Dinner: eCHo", "desc": "Hotel restaurant. Finish by 6 PM." },
        { "time": "6:00 PM", "title": "DEPART for ZRH", "desc": "Walk to HB → Airport Express 25 min. Flight 8:25 PM.", "critical": true }
      ],
      "warnings": ["All shops closed Sunday.", "Palm Sunday — Old Town processions.", "Leave hotel by 6:00 PM."]
    }
  ],
  "dining": [
    { "time": "Fri 9 PM", "venue": "White Elephant", "status": "Recommended" },
    { "time": "Sat 12:45", "venue": "Sprüngli", "status": "Walk-in" },
    { "time": "Sat 7:30", "venue": "Zeughauskeller", "status": "Confirmed" },
    { "time": "Sun 10 AM", "venue": "Hiltl", "status": "Walk-in, arrive early" },
    { "time": "Sun 1 PM", "venue": "Fischerstube", "status": "Recommended" },
    { "time": "Sun 5:15", "venue": "eCHo", "status": "Book via hotel" }
  ]
}`;

// ── MARITIMES ITINERARY ────────────────────────────────
const MARITIMES_ITINERARY = `{
  "trip": {
    "title": "Newfoundland & Nova Scotia · Summer 2026",
    "duration": "12 days",
    "travelers": "Group including Molly & Bonie",
    "startEnd": "Portland, ME (round trip)",
    "totalDistance": "~4,000 km",
    "ferryCrossings": 3
  },
  "hotels": [
    { "nights": "1 & 12", "location": "Portland, ME", "name": "Courtyard Marriott", "address": "321 Commercial St" },
    { "nights": "2", "location": "Digby, NS", "name": "Fundy Complex Dockside", "address": "34 Water St" },
    { "nights": "3", "location": "Lunenburg, NS", "name": "Smugglers Cove Inn", "address": "139 Montague St" },
    { "nights": "5", "location": "Twillingate, NL", "name": "Anchor Inn Hotel", "address": "3 Path End" },
    { "nights": "6–8", "location": "Fogo Island, NL", "name": "Fogo Island Inn", "address": "Joe Batt's Arm" },
    { "nights": "10", "location": "Pictou, NS", "name": "The Scotsman Inn", "address": "78 Coleraine St", "phone": "902-485-1924" },
    { "nights": "11", "location": "Fredericton, NB", "name": "Delta Hotels Marriott", "address": "225 Woodstock Rd" }
  ],
  "days": [
    {
      "day": 1, "label": "Portland",
      "stops": [
        { "time": "Afternoon", "title": "Meet Molly & Bonie", "desc": "Arrive in Portland. Stroll the Old Port — cobblestone streets, galleries, waterfront." },
        { "time": "Evening", "title": "Dinner in Portland", "desc": "Fresh seafood, farm-to-table, craft breweries." }
      ]
    },
    {
      "day": 2, "label": "Portland → Saint John → Digby",
      "stops": [
        { "time": "Morning", "title": "Drive: Portland → Saint John, NB", "desc": "~4.5-hour drive north through Maine into New Brunswick. Border at Calais/St. Stephen. Passports needed." },
        { "time": "En Route", "title": "Suggested Stops", "desc": "Coffee in Bangor, ME (~2 hrs). After border, St. Andrews by-the-Sea — charming seaside town." },
        { "time": "2:15 PM AT", "title": "Fundy Rose Ferry", "desc": "Board ferry for 2.5-hour Bay of Fundy crossing. Arrive Digby ~4:45 PM Atlantic Time." },
        { "time": "~5:00 PM", "title": "Arrive Digby", "desc": "Scallop capital of the world. Walk the waterfront." }
      ]
    },
    {
      "day": 3, "label": "Digby → Lunenburg",
      "stops": [
        { "time": "Morning", "title": "Scenic Drive — South Shore", "desc": "~2.5 hours along the Lighthouse Route through fishing villages." },
        { "time": "Afternoon", "title": "Explore Lunenburg", "desc": "UNESCO World Heritage Site. Colourful harbour, Fisheries Museum, Bluenose II." }
      ]
    },
    {
      "day": 4, "label": "Lunenburg → North Sydney → Overnight Ferry",
      "stops": [
        { "time": "8:00 AM", "title": "Early Start", "desc": "~4.5-hour drive to North Sydney, Cape Breton. Longest driving day." },
        { "time": "Evening", "title": "Overnight Ferry to Newfoundland", "desc": "Marine Atlantic ferry, 6–8 hour crossing. Cabin booked." }
      ]
    },
    {
      "day": 5, "label": "Port aux Basques → Twillingate",
      "stops": [
        { "time": "Morning", "title": "Arrive Port aux Basques", "desc": "Begin drive east across Newfoundland on the Trans-Canada." },
        { "time": "Mid-Morning", "title": "Corner Brook", "desc": "~2.5 hrs from Port aux Basques. Captain Cook's Lookout — panoramic Bay of Islands views." },
        { "time": "Lunch", "title": "Deer Lake", "desc": "Halfway point. Natural lunch stop." },
        { "time": "Evening", "title": "Arrive Twillingate", "desc": "Iceberg Capital of the World. Massive icebergs from Greenland drift past." }
      ]
    },
    {
      "day": "6–8", "label": "Fogo Island",
      "stops": [
        { "time": "Day 6 Morning", "title": "Ferry to Fogo Island", "desc": "Drive Twillingate to Farewell, ~45 min ferry through iceberg waters." },
        { "time": "Day 6", "title": "Check In — Fogo Island Inn", "desc": "Architecturally stunning hotel on stilts at the North Atlantic edge. Designed by Todd Saunders. Every room faces the sea." },
        { "time": "Days 6–8", "title": "Explore Fogo Island", "desc": "3 full days. Visit Fogo Island Studios (artist residencies), hike coastal trails, meet local fishers, see icebergs. The inn offers community-host programs, boat tours, and foraging excursions. All profits return to the community." }
      ]
    },
    {
      "day": 9, "label": "Fogo → Port aux Basques (Return Ferry)",
      "stops": [
        { "time": "Morning", "title": "Ferry back to mainland", "desc": "~45 min crossing." },
        { "time": "All Day", "title": "Drive: Farewell → Port aux Basques", "desc": "~560 km, ~6.5 hours. Grand Falls-Windsor (~2.5 hrs) for the Gorge. Deer Lake (~4.5 hrs) for lunch." },
        { "time": "Evening", "title": "Overnight Ferry to Nova Scotia", "desc": "Another night sleeping on the water." }
      ]
    },
    {
      "day": 10, "label": "North Sydney → Pictou",
      "stops": [
        { "time": "Morning", "title": "Arrive North Sydney", "desc": "Disembark ferry." },
        { "time": "Afternoon", "title": "Explore Pictou", "desc": "Birthplace of New Scotland — first Scottish settlers landed 1773. Ship Hector Heritage Quay." }
      ]
    },
    {
      "day": 11, "label": "Pictou → Fredericton",
      "stops": [
        { "time": "Morning", "title": "Drive: Pictou → Fredericton", "desc": "~4 hours through New Brunswick." },
        { "time": "En Route", "title": "Hopewell Rocks", "desc": "Iconic flower-pot formations carved by Bay of Fundy tides. Worth the detour." },
        { "time": "Afternoon", "title": "Fredericton Riverfront", "desc": "Walkable capital with craft beer, riverside trails, Beaverbrook Art Gallery (Dalí's Santiago El Grande)." }
      ]
    },
    {
      "day": 12, "label": "Fredericton → Portland (Home)",
      "stops": [
        { "time": "Morning", "title": "Final Drive", "desc": "~5 hours south through NB, back into US at Calais or Houlton." },
        { "time": "En Route", "title": "Hartland Covered Bridge", "desc": "World's longest covered bridge (1,282 ft). Quick photo stop." },
        { "time": "Afternoon", "title": "Arrive Portland — Trip Complete", "desc": "12 days, ~4,000 km, 3 ferry crossings. Homecoming dinner." }
      ]
    }
  ],
  "driving": [
    { "day": 2, "route": "Portland → Saint John", "distance": "~450 km", "time": "~4.5 hr" },
    { "day": 3, "route": "Digby → Lunenburg", "distance": "~250 km", "time": "~2.5 hr" },
    { "day": 4, "route": "Lunenburg → North Sydney", "distance": "~395 km", "time": "~4.5 hr" },
    { "day": 9, "route": "Fogo → Port aux Basques", "distance": "~560 km", "time": "~6.5 hr" },
    { "day": 10, "route": "North Sydney → Pictou", "distance": "~185 km", "time": "~2 hr" },
    { "day": 11, "route": "Pictou → Fredericton", "distance": "~385 km", "time": "~4 hr" },
    { "day": 12, "route": "Fredericton → Portland", "distance": "~545 km", "time": "~5 hr" }
  ],
  "ferries": [
    { "day": 2, "route": "Saint John → Digby", "vessel": "MV Fundy Rose", "duration": "2.5 hours" },
    { "day": 4, "route": "North Sydney → Port aux Basques", "vessel": "Marine Atlantic", "duration": "6–8 hours (overnight)" },
    { "day": 6, "route": "Farewell → Fogo Island", "duration": "~45 min" },
    { "day": 9, "route": "Fogo Island → Farewell", "duration": "~45 min" },
    { "day": 9, "route": "Port aux Basques → North Sydney", "vessel": "Marine Atlantic", "duration": "6–8 hours (overnight)" }
  ]
}`;
