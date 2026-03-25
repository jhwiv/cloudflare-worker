// Zürich Trip Chat Concierge — Cloudflare Worker
// Uses Cloudflare Workers AI (no external API key required) + Open-Meteo (weather)

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

// ── System prompt builder ──────────────────────────────
function buildSystemPrompt(zurichWx, copenhagenWx, locationNote) {
  const now = new Date();
  const localZurich = now.toLocaleString('en-US', {
    timeZone: 'Europe/Zurich', weekday: 'long', year: 'numeric',
    month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
  });

  let wxSummary = '';
  if (zurichWx) {
    wxSummary += `\n\nCURRENT ZÜRICH WEATHER: ${zurichWx.current.temp}°F, ${zurichWx.current.condition}, Wind ${zurichWx.current.windMph} mph, Humidity ${zurichWx.current.humidity}%.`;
    if (zurichWx.hourly.length > 0) {
      wxSummary += '\nNEXT HOURS:';
      for (const h of zurichWx.hourly)
        wxSummary += `\n  ${h.hour}:00 — ${h.temp}°F, ${h.condition}, ${h.rainChance}% rain, Wind ${h.windMph} mph`;
    }
    if (zurichWx.daily.length > 0) {
      wxSummary += '\nDAILY FORECAST:';
      for (const d of zurichWx.daily)
        wxSummary += `\n  ${d.date}: Hi ${d.hi}°F / Lo ${d.lo}°F, ${d.condition}, ${d.rainChance}% rain`;
    }
  }
  if (copenhagenWx)
    wxSummary += `\n\nCOPENHAGEN: ${copenhagenWx.current.temp}°F, ${copenhagenWx.current.condition}.`;

  return `You are a knowledgeable, friendly travel concierge for a Zürich & Copenhagen trip (26–29 March 2026). You are embedded in the trip's PWA guide.

CURRENT DATE/TIME (Zürich): ${localZurich}
${locationNote}
${wxSummary}

FULL ITINERARY:
${ITINERARY_JSON}

YOUR ROLE:
- Help the traveler decide what to do next based on: the itinerary, current time, weather, and their location.
- If it's going to rain during an outdoor activity, proactively suggest the indoor alternative from the itinerary.
- Be specific — use times, names, addresses, and walking distances from the itinerary.
- For Uetliberg: if foggy/rainy, suggest Polybahn + ETH Terrace or Landesmuseum instead.
- For Sunday: always remind them about the 6:00 PM hotel departure and 8:25 PM flight if relevant.
- Reference restaurants by name and confirmed reservation times.
- Keep answers concise — 2-4 short paragraphs max. Use natural language, not bullet lists.
- You can respond in English or match the traveler's language.
- If they ask about something not in the itinerary, give helpful local advice but note it's outside the planned itinerary.
- DO NOT make up information. If you don't know, say so.`;
}

// ── Workers AI call ────────────────────────────────────
async function callWorkersAI(ai, systemPrompt, messages) {
  const aiMessages = [
    { role: 'system', content: systemPrompt },
    ...messages,
  ];

  const response = await ai.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
    messages: aiMessages,
    max_tokens: 800,
  });

  return response.response;
}

// ── Main fetch handler ─────────────────────────────────
export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    // Health check
    if (url.pathname === '/api/health') {
      return corsResponse({ status: 'ok', time: new Date().toISOString() });
    }

    // Chat endpoint
    if (url.pathname === '/api/chat' && request.method === 'POST') {
      try {
        const { message, lat, lng, history } = await request.json();
        if (!message || typeof message !== 'string') {
          return corsResponse({ error: 'Missing message' }, 400);
        }

        // Get weather for both cities in parallel
        const [zurichWx, copenhagenWx] = await Promise.all([
          getWeather(47.3769, 8.5417, 'Europe/Zurich'),
          getWeather(55.6761, 12.5683, 'Europe/Copenhagen'),
        ]);

        // Location context
        let locationNote = '';
        if (lat && lng) {
          const dZ = Math.hypot(lat - 47.3769, lng - 8.5417);
          const dC = Math.hypot(lat - 55.6761, lng - 12.5683);
          locationNote = `User's current GPS: ${lat.toFixed(4)}, ${lng.toFixed(4)}. `;
          if (dZ < 0.5) locationNote += 'They appear to be IN Zürich right now. ';
          else if (dC < 0.5) locationNote += 'They appear to be IN Copenhagen right now. ';
          else locationNote += 'They are NOT currently in Zürich or Copenhagen — they may be planning ahead. ';
        }

        const systemPrompt = buildSystemPrompt(zurichWx, copenhagenWx, locationNote);

        // Build messages array
        const msgs = [];
        if (history && Array.isArray(history)) {
          for (const h of history.slice(-8))
            msgs.push({ role: h.role, content: h.content });
        }
        msgs.push({ role: 'user', content: message });

        const reply = await callWorkersAI(env.AI, systemPrompt, msgs);
        return corsResponse({ reply });

      } catch (err) {
        console.error('Chat error:', err);
        return corsResponse({ error: 'Something went wrong. Please try again.' }, 500);
      }
    }

    // Fallback
    return corsResponse({ error: 'Not found' }, 404);
  },
};

// ── Itinerary data (inlined) ───────────────────────────
const ITINERARY_JSON = `{
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
        { "time": "Wed Night", "title": "Departure → Copenhagen ✈", "desc": "Overnight flight. Arrive CPH Thu 7 AM." },
        { "time": "7:00 AM Thu", "title": "Arrive CPH → Scandic Nørreport", "desc": "Metro M2 Terminal 3 → Nørreport 13 min, 30 DKK. Hotel across the street." },
        { "time": "Hotel", "title": "Scandic Nørreport", "desc": "4-star, rooftop bar Level Six, free happy hour 4–5 PM. +45 7231 5001." },
        { "time": "Charlotte", "title": "Charlotte's Place · Amager", "desc": "Holmbladsgade 70B. M2 → Amagerbro 15 min from hotel." },
        { "time": "Fri Evening", "title": "CPH → ZRH ✈", "desc": "Fly Friday evening. M2 to airport 13 min." }
      ]
    },
    {
      "id": "friday", "label": "Day 1 · Friday 27 March", "title": "Arrival & White Elephant",
      "stops": [
        { "time": "7:40 PM", "title": "Airport → Marriott", "desc": "Airport Express + Tram 13. Arrive ~8:30–8:45 PM." },
        { "time": "9:00 PM", "title": "Dinner: White Elephant", "desc": "Hotel's Michelin-listed Thai. +41 44 360 73 22. 🌿 Vegetarian." },
        { "time": "10:30 PM", "title": "Lenox Bar Nightcap", "desc": "Hotel bar. Optional.", "optional": true }
      ],
      "extras": "Limmat riverfront walk — lit bridges, 5 min from hotel."
    },
    {
      "id": "saturday", "label": "Day 2 · Saturday 28 March — The Big Day",
      "summary": "Uetliberg → Sprüngli → Kunsthaus → Old Town → Lindenhof → aperitivo → Zeughauskeller. Leave hotel 10 AM.",
      "stops": [
        { "time": "10:00 AM", "title": "Uetliberg Summit 871m", "desc": "S10 from HB 20 min. Zürich Card ✓. ⚠️ Felsenegg cable car CLOSED 2 Mar–10 Apr.", "alt": { "foggy": "Polybahn + ETH Terrace — 90-sec funicular, great rooftop views.", "rainy": "Landesmuseum — behind HB, free with Zürich Card, Sat 10–5." } },
        { "time": "12:45 PM", "title": "Café Sprüngli", "desc": "Legendary confiserie since 1836. Bahnhofstrasse 21. Hot chocolate, Luxemburgerli." },
        { "time": "1:30 PM", "title": "Kunsthaus Zürich", "desc": "Largest Swiss art museum. Heimplatz 1. Bührle, Munch, Giacometti. Free w/ Zürich Card. Sat 10–6." },
        { "time": "3:00 PM", "title": "Lunch: Kunsthaus Café", "desc": "On-site. Soups, salads. Sat 9–9." },
        { "time": "4:15 PM", "title": "Old Town — Augustinergasse & Cathedrals", "desc": "Grossmünster, Fraumünster (Chagall glass), Münsterhof. Free entry." },
        { "time": "5:45 PM", "title": "Lindenhof Hill", "desc": "Panorama, Roman fort park, public chess. 5 min from Fraumünster." },
        { "time": "6:30 PM", "title": "Café Bar Münsterhof", "desc": "Pre-dinner drinks. Münsterhof 6." },
        { "time": "7:30 PM", "title": "Dinner: Zeughauskeller ★ CONFIRMED", "desc": "15th-c beer hall. Bahnhofstrasse 28A. +41 44 220 15 15. CHF 35–55 pp." }
      ],
      "extras": "Niederdorf lanes, Cabaret Voltaire, Beyer Watch Museum."
    },
    {
      "id": "sunday", "label": "Day 3 · Sunday 29 March · Palm Sunday",
      "summary": "Leave hotel by 6:00 PM. Full city window 10 AM–4:30 PM.",
      "stops": [
        { "time": "10:00 AM", "title": "Hiltl Brunch", "desc": "World's oldest veggie restaurant. Sihlstrasse 28. CHF 57 pp. 100+ dishes." },
        { "time": "11:15 AM", "title": "Lake Zürich Promenade", "desc": "Quaianlagen from Bürkliplatz. Free." },
        { "time": "11:45 AM", "title": "Lake Cruise (optional)", "desc": "ZSG Rundfahrt ~40 min. Zürich Card ✓.", "optional": true },
        { "time": "Bonus", "title": "Polybahn (optional)", "desc": "Historic funicular 90 sec. ETH views. Zürich Card ✓.", "optional": true },
        { "time": "1:00 PM", "title": "Lunch: Fischerstube Zürihorn", "desc": "Lakeside terrace. Bellerivestrasse 160. +41 44 422 25 20. CHF 35–50." },
        { "time": "2:30 PM", "title": "Museum Rietberg", "desc": "Asian/African art. Gablerstrasse 15. Free w/ Zürich Card. Sun 10–5." },
        { "time": "5:15 PM", "title": "Farewell Dinner: eCHo", "desc": "Hotel Swiss restaurant. +41 44 360 73 18. Finish by 6 PM." },
        { "time": "6:00 PM", "title": "DEPART for ZRH", "desc": "Walk 5 min to HB → Airport Express 25 min → ZRH 6:30 PM. Flight 8:25 PM.", "critical": true }
      ],
      "warnings": ["All shops closed Sunday. Buy Saturday before 6 PM.", "Palm Sunday — Old Town processions.", "Leave hotel by 6:00 PM."]
    }
  ],
  "dining": [
    { "time": "Fri 9 PM", "venue": "White Elephant", "status": "Recommended", "phone": "+41 44 360 73 22" },
    { "time": "Sat 12:45", "venue": "Sprüngli", "status": "Walk-in" },
    { "time": "Sat 3 PM", "venue": "Kunsthaus Café", "status": "Walk-in" },
    { "time": "Sat 6:30", "venue": "Café Bar Münsterhof", "status": "Walk-in" },
    { "time": "Sat 7:30", "venue": "Zeughauskeller ★", "status": "✓ Confirmed", "phone": "+41 44 220 15 15" },
    { "time": "Sun 10 AM", "venue": "Hiltl", "status": "Walk-in, arrive early" },
    { "time": "Sun 1 PM", "venue": "Fischerstube", "status": "Recommended", "phone": "+41 44 422 25 20" },
    { "time": "Sun 5:15", "venue": "eCHo", "status": "Book via hotel", "phone": "+41 44 360 73 18" }
  ],
  "budget": "CHF 260–325 pp total",
  "transit": [
    { "dest": "Hotel from Airport", "via": "Airport Express + Tram 13", "time": "30–40 min" },
    { "dest": "Uetliberg", "via": "S10 from HB", "time": "20 min" },
    { "dest": "Sprüngli", "via": "Walk or Tram 13 → Paradeplatz", "time": "12/5 min" },
    { "dest": "Kunsthaus", "via": "Tram 3 → Kunsthaus", "time": "11 min" },
    { "dest": "Old Town", "via": "Walk via Grossmünster", "time": "15 min" },
    { "dest": "Zeughauskeller", "via": "Walk from Münsterhof", "time": "3 min" },
    { "dest": "Hotel after dinner", "via": "Tram 13 → Sihlquai/HB", "time": "5 min" },
    { "dest": "Fischerstube", "via": "Tram 2 → Zürichhorn", "time": "10 min" },
    { "dest": "Rietberg", "via": "Tram 7 or Uber", "time": "16 min" },
    { "dest": "ZRH Airport", "via": "Airport Express from HB", "time": "25 min" }
  ]
}`;
