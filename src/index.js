// Multi-Site Trip Chat Concierge — Cloudflare Worker
// Uses Cloudflare Workers AI (streaming) + Open-Meteo (weather)
// Routes:
//   /api/chat/zurich, /api/chat/maritimes — concierge chat
//   /api/ferry-status — live Marine Atlantic advisory (KV-cached 15 min)
//   /api/health — healthcheck

import { getFerryAdvisory, formatAdvisoryForPrompt } from './ferry-status.js';

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
      city: 'In transit', timezone: 'Europe/Copenhagen', lat: 55.6838, lng: 12.5718,
      note: 'The traveler is on an overnight flight to Copenhagen. They arrive CPH around 7 AM Thursday.' },
    // Thu 26 Mar 6 AM CET through Fri 27 Mar ~5 PM CET (17:00 CET = 16:00 UTC)
    { from: '2026-03-26T06:00Z', to: '2026-03-27T16:00Z',
      city: 'Copenhagen', timezone: 'Europe/Copenhagen', lat: 55.6838, lng: 12.5718,
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
  wwii2026: [
    // 15-day London / Normandy / Nuremberg / Porto trip, Oct 10-24 2026.
    // Segments are calendar-day (local midnight-to-midnight) rather than
    // precise clock times, matching each day's own `city` field from the
    // verified plan JSON rather than inventing minute-level timings.
    { from: '2026-10-09T23:00:00Z', to: '2026-10-10T23:00:00Z', city: 'London', timezone: 'Europe/London', lat: 51.5074, lng: -0.1278, note: 'Day 1: Evening walk through Mayfair after check-in, martini at The Dorchester' },
    { from: '2026-10-10T23:00:00Z', to: '2026-10-11T23:00:00Z', city: 'London', timezone: 'Europe/London', lat: 51.5074, lng: -0.1278, note: 'Day 2: Stand in Churchill\'s Map Room where the war was directed' },
    { from: '2026-10-11T23:00:00Z', to: '2026-10-12T23:00:00Z', city: 'London', timezone: 'Europe/London', lat: 51.5074, lng: -0.1278, note: 'Day 3: Walk the Holocaust Exhibition and WWII galleries at IWM' },
    { from: '2026-10-12T23:00:00Z', to: '2026-10-13T23:00:00Z', city: 'London', timezone: 'Europe/London', lat: 51.5074, lng: -0.1278, note: 'Day 4: Evening West End show — history on stage after a museum day' },
    { from: '2026-10-13T23:00:00Z', to: '2026-10-14T23:00:00Z', city: 'London', timezone: 'Europe/London', lat: 51.5074, lng: -0.1278, note: 'Day 5: Stand where Anne Boleyn was beheaded, see the Crown Jewels' },
    { from: '2026-10-14T22:00:00Z', to: '2026-10-15T22:00:00Z', city: 'Normandy', timezone: 'Europe/Paris', lat: 49.2764, lng: -0.7024, note: 'Day 6: Stand at the cliff edge above Omaha Beach at dawn' },
    { from: '2026-10-15T22:00:00Z', to: '2026-10-16T22:00:00Z', city: 'Normandy', timezone: 'Europe/Paris', lat: 49.2764, lng: -0.7024, note: 'Day 7: Walk the Canadian beach at Juno, then the Caen peace museum' },
    { from: '2026-10-16T22:00:00Z', to: '2026-10-17T22:00:00Z', city: 'Nuremberg', timezone: 'Europe/Berlin', lat: 49.4521, lng: 11.0767, note: 'Day 8: Sit in Courtroom 600 where the architects of the Holocaust faced justice' },
    { from: '2026-10-17T22:00:00Z', to: '2026-10-18T22:00:00Z', city: 'Nuremberg', timezone: 'Europe/Berlin', lat: 49.4521, lng: 11.0767, note: 'Day 9: Walk the ramparts of Kaiserburg at golden hour' },
    { from: '2026-10-18T22:00:00Z', to: '2026-10-19T22:00:00Z', city: 'Nuremberg', timezone: 'Europe/Berlin', lat: 49.4521, lng: 11.0767, note: 'Day 10: Confront the Rally Grounds, then fly to Portugal\'s wine capital' },
    { from: '2026-10-19T23:00:00Z', to: '2026-10-20T23:00:00Z', city: 'Porto', timezone: 'Europe/Lisbon', lat: 41.1579, lng: -8.6291, note: 'Day 11: First port wine tasting overlooking the Douro at sunset' },
    { from: '2026-10-20T23:00:00Z', to: '2026-10-21T23:00:00Z', city: 'Porto', timezone: 'Europe/Lisbon', lat: 41.1579, lng: -8.6291, note: 'Day 12: Private cellar tour at Graham\'s, then francesinha for lunch' },
    { from: '2026-10-21T23:00:00Z', to: '2026-10-22T23:00:00Z', city: 'Porto', timezone: 'Europe/Lisbon', lat: 41.1579, lng: -8.6291, note: 'Day 13: Quinta do Crasto vineyard lunch overlooking terraced vines' },
    { from: '2026-10-22T23:00:00Z', to: '2026-10-23T23:00:00Z', city: 'Porto', timezone: 'Europe/Lisbon', lat: 41.1579, lng: -8.6291, note: 'Day 14: Morning at Livraria Lello, then sunset port at Taylor\'s terrace' },
    { from: '2026-10-23T23:00:00Z', to: '2026-10-24T23:00:00Z', city: 'Porto', timezone: 'Europe/Lisbon', lat: 41.1579, lng: -8.6291, note: 'Day 15: Morning at leisure, then fly Porto → Newark' },
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

// ── Recommendation detection ─────────────────────────
function isRecommendationQuery(message) {
  const keywords = /\b(breakfast|brunch|lunch|dinner|coffee|café|cafe|eat|restaurant|bar|pub|drink|food|recommend|suggestion|where should|good place|nearby|snack|bakery|pastry|grocery|supermarket|pharmacy|gelato|ice cream|pre-?ferry|before the ferry|before ferry)\b/i;
  return keywords.test(message);
}

// ── Future-day / place override for Overpass searches ──────────
// When the user references a specific date, day number, or place that isn't
// their current location, return coordinates for THAT place instead of "now".
// Returns { lat, lng, timezone, label } or null.
function resolveQueryLocation(siteKey, message) {
  if (siteKey !== 'maritimes') return null;
  const msg = message.toLowerCase();

  // Explicit place mentions — highest priority
  const placeMap = [
    { match: /\b(north sydney|sydney ns|cape breton terminal|marine atlantic terminal)\b/, lat: 46.2034, lng: -60.2391, tz: 'America/Halifax', label: 'North Sydney ferry terminal area' },
    { match: /\b(port aux basques|channel-?port aux basques)\b/, lat: 47.5714, lng: -59.1351, tz: 'America/St_Johns', label: 'Port aux Basques' },
    { match: /\b(lunenburg)\b/, lat: 44.3890, lng: -64.5205, tz: 'America/Halifax', label: 'Lunenburg' },
    { match: /\b(digby)\b/, lat: 44.6206, lng: -65.7596, tz: 'America/Halifax', label: 'Digby' },
    { match: /\b(twillingate)\b/, lat: 49.6514, lng: -54.7681, tz: 'America/St_Johns', label: 'Twillingate' },
    { match: /\b(fogo island|fogo)\b/, lat: 49.4817, lng: -54.7831, tz: 'America/St_Johns', label: 'Fogo Island' },
    { match: /\b(pictou)\b/, lat: 45.6797, lng: -62.7126, tz: 'America/Halifax', label: 'Pictou' },
    { match: /\b(fredericton)\b/, lat: 45.9636, lng: -66.6431, tz: 'America/New_York', label: 'Fredericton' },
    { match: /\b(portland)\b/, lat: 43.6591, lng: -70.2568, tz: 'America/New_York', label: 'Portland, ME' },
    { match: /\b(saint john|st\.? john nb)\b/, lat: 45.2733, lng: -66.0633, tz: 'America/Halifax', label: 'Saint John, NB' },
  ];
  for (const p of placeMap) {
    if (p.match.test(msg)) return { lat: p.lat, lng: p.lng, timezone: p.tz, label: p.label };
  }

  // Date / day references — map to itinerary segment
  const dateMap = [
    { match: /\b(jun(e)?\s*27|day\s*1)\b/, lat: 43.6591, lng: -70.2568, tz: 'America/New_York', label: 'Day 1 — Portland, ME' },
    { match: /\b(jun(e)?\s*28|day\s*2)\b/, lat: 44.6206, lng: -65.7596, tz: 'America/Halifax', label: 'Day 2 — Digby, NS' },
    { match: /\b(jun(e)?\s*29|day\s*3)\b/, lat: 44.3890, lng: -64.5205, tz: 'America/Halifax', label: 'Day 3 — Lunenburg, NS' },
    { match: /\b(jun(e)?\s*30|day\s*4)\b/, lat: 46.2034, lng: -60.2391, tz: 'America/Halifax', label: 'Day 4 — North Sydney (pre-ferry)' },
    { match: /\b(jul(y)?\s*1|day\s*5)\b/, lat: 49.6514, lng: -54.7681, tz: 'America/St_Johns', label: 'Day 5 — Twillingate, NL' },
    { match: /\b(jul(y)?\s*[234]|day\s*[678])\b/, lat: 49.4817, lng: -54.7831, tz: 'America/St_Johns', label: 'Days 6–8 — Fogo Island' },
    { match: /\b(jul(y)?\s*5|day\s*9)\b/, lat: 47.5714, lng: -59.1351, tz: 'America/St_Johns', label: 'Day 9 — Port aux Basques (pre-ferry)' },
    { match: /\b(jul(y)?\s*6|day\s*10)\b/, lat: 45.6797, lng: -62.7126, tz: 'America/Halifax', label: 'Day 10 — Pictou, NS' },
    { match: /\b(jul(y)?\s*7|day\s*11)\b/, lat: 45.9636, lng: -66.6431, tz: 'America/New_York', label: 'Day 11 — Fredericton, NB' },
    { match: /\b(jul(y)?\s*8|day\s*12)\b/, lat: 43.6591, lng: -70.2568, tz: 'America/New_York', label: 'Day 12 — Portland, ME' },
  ];
  for (const d of dateMap) {
    if (d.match.test(msg)) return { lat: d.lat, lng: d.lng, timezone: d.tz, label: d.label };
  }

  // "Before the ferry" / "pre-ferry" without other context — default to Day 4 (next ferry)
  if (/\b(pre-?ferry|before the ferry|before ferry|ferry dinner|near the ferry)\b/.test(msg)) {
    return { lat: 46.2034, lng: -60.2391, timezone: 'America/Halifax', label: 'Pre-ferry — North Sydney' };
  }

  return null;
}

// ── Category mapping for Overpass queries ────────────
function getCategoriesFromMessage(message) {
  const msg = message.toLowerCase();
  if (/\b(breakfast|brunch|coffee|café|cafe|bakery|pastry)\b/.test(msg)) return 'cafe|restaurant|bakery';
  if (/\b(bar|pub|drink)\b/.test(msg)) return 'bar|pub';
  if (/\b(pharmacy)\b/.test(msg)) return 'pharmacy';
  if (/\b(grocery|supermarket)\b/.test(msg)) return 'supermarket';
  if (/\b(gelato|ice cream)\b/.test(msg)) return 'cafe|ice_cream';
  if (/\b(lunch|dinner|eat|food|restaurant)\b/.test(msg)) return 'restaurant|cafe';
  return 'cafe|restaurant|bar';
}

// ── Opening hours parser (OSM format) ────────────────
const DAY_MAP = { mo: 0, tu: 1, we: 2, th: 3, fr: 4, sa: 5, su: 6 };

function parseDayIndex(str) {
  return DAY_MAP[str.toLowerCase().slice(0, 2)];
}

function isOpenNow(openingHoursStr, nowLocal) {
  if (!openingHoursStr) return null;
  const trimmed = openingHoursStr.trim();
  if (trimmed === '24/7') return true;

  const currentDay = nowLocal.getDay(); // 0=Sun
  // Map JS getDay (0=Sun) to OSM (0=Mo)
  const osmDay = currentDay === 0 ? 6 : currentDay - 1;
  const currentMinutes = nowLocal.getHours() * 60 + nowLocal.getMinutes();

  try {
    const rules = trimmed.split(/[;,]/).map(r => r.trim()).filter(Boolean);
    for (const rule of rules) {
      // Skip "off" rules (e.g., "Su off", "PH off") and public holiday rules
      if (/\boff\b/i.test(rule) || /^PH\b/.test(rule)) {
        // Check if this "off" rule matches today — if so, place is closed
        const offMatch = rule.match(/^([A-Za-z][a-z](?:[-,][A-Za-z][a-z])*)\s+off$/i);
        if (offMatch) {
          const offDays = offMatch[1].split(',');
          for (const seg of offDays) {
            const d = parseDayIndex(seg.trim());
            if (d != null && osmDay === d) return false; // Closed today
          }
        }
        continue;
      }
      // Try pattern with day prefix: "Mo-Fr 07:00-22:00" or "Sa 10:00-18:00"
      let match = rule.match(/^([A-Za-z][a-z](?:[-,][A-Za-z][a-z])*)\s+(\d{1,2}:\d{2})\s*[-\u2013]\s*(\d{1,2}:\d{2})$/);
      // Also handle time-only format: "16:00-23:00" (means every day)
      const timeOnly = !match ? rule.match(/^(\d{1,2}:\d{2})\s*[-\u2013]\s*(\d{1,2}:\d{2})$/) : null;

      let dayMatches = false;
      let openStr, closeStr;

      if (match) {
        openStr = match[2]; closeStr = match[3];
        const daysPart = match[1];
        const daySegments = daysPart.split(',');
        for (const seg of daySegments) {
          if (seg.includes('-')) {
            const [startDay, endDay] = seg.split('-');
            const s = parseDayIndex(startDay);
            const e = parseDayIndex(endDay);
            if (s == null || e == null) continue;
            if (s <= e) {
              dayMatches = dayMatches || (osmDay >= s && osmDay <= e);
            } else {
              dayMatches = dayMatches || (osmDay >= s || osmDay <= e);
            }
          } else {
            const d = parseDayIndex(seg);
            if (d != null) dayMatches = dayMatches || (osmDay === d);
          }
        }
      } else if (timeOnly) {
        openStr = timeOnly[1]; closeStr = timeOnly[2];
        dayMatches = true; // No day specified = every day
      } else {
        continue;
      }

      const openTime = openStr.split(':').map(Number);
      const closeTime = closeStr.split(':').map(Number);
      const openMin = openTime[0] * 60 + openTime[1];
      const closeMin = closeTime[0] * 60 + closeTime[1];

      if (dayMatches) {
        // Handle overnight hours (e.g., 22:00-02:00)
        if (closeMin <= openMin) {
          if (currentMinutes >= openMin || currentMinutes < closeMin) return true;
        } else {
          if (currentMinutes >= openMin && currentMinutes < closeMin) return true;
        }
      }
    }
    return false;
  } catch {
    return null;
  }
}

function getClosingTime(openingHoursStr, nowLocal) {
  if (!openingHoursStr) return null;
  if (openingHoursStr.trim() === '24/7') return '24/7';

  const currentDay = nowLocal.getDay();
  const osmDay = currentDay === 0 ? 6 : currentDay - 1;

  try {
    const rules = openingHoursStr.split(/[;,]/).map(r => r.trim()).filter(Boolean);
    for (const rule of rules) {
      const match = rule.match(/^([A-Za-z][a-z](?:[-,][A-Za-z][a-z])*)\s+(\d{1,2}:\d{2})\s*[-\u2013]\s*(\d{1,2}:\d{2})$/);
      if (!match) continue;

      const daysPart = match[1];
      const closeTime = match[3];
      const daySegments = daysPart.split(',');
      for (const seg of daySegments) {
        if (seg.includes('-')) {
          const [startDay, endDay] = seg.split('-');
          const s = parseDayIndex(startDay);
          const e = parseDayIndex(endDay);
          if (s == null || e == null) continue;
          if (s <= e ? (osmDay >= s && osmDay <= e) : (osmDay >= s || osmDay <= e)) return closeTime;
        } else {
          const d = parseDayIndex(seg);
          if (d != null && osmDay === d) return closeTime;
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

// Returns minutes until the place opens today, or null if can't determine
function getNextOpenTime(openingHoursStr, nowLocal) {
  if (!openingHoursStr) return null;

  const currentDay = nowLocal.getDay();
  const osmDay = currentDay === 0 ? 6 : currentDay - 1;
  const currentMinutes = nowLocal.getHours() * 60 + nowLocal.getMinutes();

  try {
    const rules = openingHoursStr.split(/[;,]/).map(r => r.trim()).filter(Boolean);
    let earliest = Infinity;
    for (const rule of rules) {
      const match = rule.match(/^([A-Za-z][a-z](?:[-,][A-Za-z][a-z])*)\s+(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})$/);
      if (!match) continue;

      const openTime = match[2].split(':').map(Number);
      const openMin = openTime[0] * 60 + openTime[1];

      const daysPart = match[1];
      const daySegments = daysPart.split(',');
      let dayMatches = false;
      for (const seg of daySegments) {
        if (seg.includes('-')) {
          const parts = seg.split('-');
          const s = parseDayIndex(parts[0]);
          const e = parseDayIndex(parts[1]);
          if (s == null || e == null) continue;
          dayMatches = dayMatches || (s <= e ? (osmDay >= s && osmDay <= e) : (osmDay >= s || osmDay <= e));
        } else {
          const d = parseDayIndex(seg);
          if (d != null) dayMatches = dayMatches || (osmDay === d);
        }
      }

      if (dayMatches && openMin > currentMinutes) {
        earliest = Math.min(earliest, openMin - currentMinutes);
      }
    }
    return earliest < Infinity ? earliest : null;
  } catch {
    return null;
  }
}

// ── Haversine distance ───────────────────────────────
function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function walkTimeLabel(meters) {
  // Straight-line distance × 1.4 circuity factor for urban streets,
  // then 67 m/min walking speed (~4 km/h, matches Google Maps)
  const actualMeters = meters * 1.4;
  const minutes = Math.round(actualMeters / 67);
  return minutes < 2 ? '~2 min walk' : `~${minutes} min walk`;
}

// ── Overpass API: fetch nearby places ────────────────
async function getNearbyPlaces(lat, lng, categories, timezone) {
  const query = `[out:json][timeout:3];(node["amenity"~"${categories}"]["name"](around:600,${lat},${lng}););out body 15;`;

  // Try multiple Overpass endpoints (POST is more reliable from Workers)
  const endpoints = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
  ];

  let data = null;
  for (const endpoint of endpoints) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(query)}`,
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (res.ok) {
        data = await res.json();
        if (data.elements && data.elements.length > 0) break;
      }
      console.log(`Overpass ${endpoint}: ${res.status}, elements: ${data?.elements?.length ?? 0}`);
    } catch (err) {
      console.log(`Overpass ${endpoint} failed: ${err.message}`);
      continue;
    }
  }

  if (!data?.elements?.length) {
    console.log('Overpass: no results from any endpoint');
    return null;
  }

  try {

    // Build local time for opening-hours check
    const nowLocal = new Date(new Date().toLocaleString('en-US', { timeZone: timezone }));

    const places = [];
    for (const el of data.elements) {
      const tags = el.tags || {};
      if (!tags.name) continue;

      const placeLat = el.lat ?? el.center?.lat;
      const placeLng = el.lon ?? el.center?.lon;
      if (placeLat == null || placeLng == null) continue;

      const dist = haversineMeters(lat, lng, placeLat, placeLng);
      const openStatus = isOpenNow(tags.opening_hours, nowLocal);

      // Include open places, unknown-hours places, and places opening within 60 min
      // Skip places confirmed closed UNLESS they open within 60 minutes
      if (openStatus === false) {
        const opensAt = getNextOpenTime(tags.opening_hours, nowLocal);
        if (!opensAt || opensAt > 60) continue;
        // Opening soon — include but note when
      }

      const address = [tags['addr:street'], tags['addr:housenumber']].filter(Boolean).join(' ') || null;
      const closing = getClosingTime(tags.opening_hours, nowLocal);

      // Determine open-soon info
      let opensAtStr = null;
      if (openStatus === false) {
        const opensInMin = getNextOpenTime(tags.opening_hours, nowLocal);
        if (opensInMin) {
          const opensH = Math.floor((nowLocal.getHours() * 60 + nowLocal.getMinutes() + opensInMin) / 60) % 24;
          const opensM = (nowLocal.getMinutes() + opensInMin) % 60;
          opensAtStr = `${String(opensH).padStart(2, '0')}:${String(opensM).padStart(2, '0')}`;
        }
      }

      places.push({
        name: tags.name,
        type: tags.amenity || 'unknown',
        address,
        distance: dist,
        walkTime: walkTimeLabel(dist),
        openVerified: openStatus === true,
        closingTime: closing,
        opensAt: opensAtStr,
        hoursRaw: tags.opening_hours || null,
        lat: placeLat,
        lng: placeLng,
      });
    }

    // Sort by distance, take top 10
    places.sort((a, b) => a.distance - b.distance);
    const result = places.slice(0, 10);
    console.log(`Overpass: found ${data.elements.length} raw, ${places.length} open/unknown, returning ${result.length}`);
    return result;
  } catch (err) {
    console.log(`Overpass parse error: ${err.message}`);
    return null;
  }
}

// ── Format places for system prompt ──────────────────
function formatPlacesForPrompt(places) {
  if (!places || places.length === 0) return '';

  let lines = ['VERIFIED NEARBY PLACES (from OpenStreetMap):'];
  for (let i = 0; i < places.length; i++) {
    const p = places[i];
    let status;
    if (p.openVerified) {
      status = `open now${p.closingTime && p.closingTime !== '24/7' ? ` (closes ${p.closingTime})` : ''}`;
    } else if (p.opensAt) {
      status = `opens at ${p.opensAt}`;
    } else {
      status = 'hours unverified';
    }
    const addr = p.address ? ` — ${p.address}` : '';
    lines.push(`${i + 1}. ${p.name} — ${p.type}${addr} — ${status} — ${p.walkTime}`);
  }
  lines.push('');
  lines.push('IMPORTANT: When recommending places, STRONGLY PREFER places from this verified list. These are confirmed to exist and be currently open (or have unverified hours). Include Google Maps links formatted as [Name](https://maps.google.com/?q=Name+City).');
  return lines.join('\n');
}

// ── Site configurations ────────────────────────────────
const SITES = {
  zurich: {
    weatherLocations: [
      { lat: 47.3769, lng: 8.5417, tz: 'Europe/Zurich', label: 'ZÜRICH' },
      { lat: 55.6838, lng: 12.5718, tz: 'Europe/Copenhagen', label: 'COPENHAGEN' },
    ],
    geoChecks: [
      { lat: 47.3769, lng: 8.5417, radius: 0.5, label: 'They appear to be IN Zürich right now.' },
      { lat: 55.6838, lng: 12.5718, radius: 0.5, label: 'They appear to be IN Copenhagen right now.' },
    ],
    defaultGeoNote: 'They are NOT currently in Zürich or Copenhagen — they may be planning ahead.',
    localTimezone: 'Europe/Zurich',
    buildPrompt: (wxSummary, locationNote, localTime, inferredLocation, nearbyPlacesContext) => {
      const timeLabel = inferredLocation?.city || 'Zürich';
      return `You are a knowledgeable, friendly travel concierge for a Zürich & Copenhagen trip (25–29 March 2026). You are embedded in the trip's PWA guide.

CRITICAL: Pay close attention to the user's CURRENT LOCATION and TIME. Do NOT assume they are in Zürich unless the location data confirms it. If they are in Copenhagen, give Copenhagen-relevant advice. The user may be browsing any tab of the itinerary regardless of where they physically are.

CURRENT DATE/TIME (${timeLabel}): ${localTime}
${locationNote}
${nearbyPlacesContext ? '\n' + nearbyPlacesContext + '\n' : ''}
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
- When a VERIFIED NEARBY PLACES list is provided above, you MUST recommend ONLY from that list. Do not recommend places not on the list. These are confirmed to exist and be open right now.
- If no verified list is provided, use your general knowledge but note that opening hours should be confirmed.
- Provide exactly 3 options. Each MUST include: a clickable Google Maps link, a one-sentence description of what makes the place good, and the estimated walk time.
- Format EXACTLY like this (the description sentence is mandatory, never omit it):
  [Name of Place](https://maps.google.com/?q=Place+Name+City) — One sentence describing the vibe, specialty, or what to order. ~X min walk.
- Example: [Europa 1989](https://maps.google.com/?q=Europa+1989+Copenhagen) — A cozy neighborhood café known for great espresso and fresh pastries in a relaxed setting. ~9 min walk.
- The description must tell the traveler WHY this place is worth visiting — mention the food, atmosphere, or specialty.
- Pick well-known, highly-rated, real establishments. Prioritize places that are likely open at the current time of day.
- NEVER say "I don't have specific recommendations" or "ask the hotel staff" — you are the concierge, give real answers.
- Keep answers concise — a brief intro sentence, then the 3 recommendations, then an optional closing line.
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
    buildPrompt: (wxSummary, locationNote, localTime, inferredLocation, nearbyPlacesContext, ferryStatusContext) => {
      const timeLabel = inferredLocation?.city || 'local time';
      return `You are a knowledgeable, friendly travel concierge for a 12-day Maritimes Grand Loop road trip (Newfoundland & Nova Scotia, Summer 2026). You are embedded in the trip's PWA guide.

CRITICAL: Pay close attention to the travelers' CURRENT LOCATION and TIME. Do NOT assume they are at any particular stop unless the location data confirms it. The travelers may be browsing any tab of the itinerary regardless of where they physically are.

CURRENT DATE/TIME (${timeLabel}): ${localTime}
${locationNote}
${nearbyPlacesContext ? '\n' + nearbyPlacesContext + '\n' : ''}
${ferryStatusContext || ''}
${wxSummary}

FULL ITINERARY:
${MARITIMES_ITINERARY}

YOUR ROLE:
- Help the travelers decide what to do next based on: the itinerary, current time, weather, and their location.
- Be specific — use place names, driving distances, ferry times, and hotel names from the itinerary.
- For ferry crossings: state the actual departure time, the mandatory check-in time (2 hours prior for Marine Atlantic — reservations are cancelled if missed), and the terminal address from the itinerary data.
- For Fogo Island days (6–8): suggest activities, hikes, and local experiences.
- Reference hotels by name and location.
- For driving days: mention approximate drive times and suggested stops.
- Keep answers concise — 2-4 short paragraphs max. Use natural language, not bullet lists.
- You can respond in English or match the traveler's language.
- The travelers are a group including Molly and Bonie.

FUTURE-DAY PLANNING (IMPORTANT):
- The traveler may ask about ANY day on the itinerary, not just today. If their question references a specific date ("June 30", "Day 4"), a future event ("before the ferry", "pre-ferry dinner", "morning we leave Lunenburg"), or a place that is not their current location ("in North Sydney", "in Port aux Basques"), answer using the itinerary data for THAT day and THAT place. Do NOT default to current GPS or today's date for planning questions.
- Day 4 dinner is BOOKED: Black Spoon Bistro, Sydney, 7:00 PM ADT (Tue Jun 30, confirmed reservation). For Day 4 pre-ferry dinner questions, lead with that fact — do not present it as one of several options. Add the 9:45 PM check-in / 11:45 PM ADT departure reminder.
- For pre-ferry dinner questions on Day 9 (Sun Jul 5, return ferry from Port aux Basques): state the 11:45 PM NDT departure, 9:45 PM check-in deadline, and name 2–3 specific dinner options near the Port aux Basques terminal pulled from the Day 9 stops. Use the restaurants listed in the Day 9 stops — do not invent new ones.
- When the user says the trip hasn't started yet or you're answering ahead of the trip, that is normal — still answer concretely from the itinerary.

FERRY STATUS LANGUAGE:
- The PWA includes a static "Plan B" section with cards titled "...Cancelled" — these are pre-written contingency playbooks, NOT live ferry status. Never tell the traveler a ferry IS cancelled unless either (a) a LIVE FERRY STATUS block above shows it, or (b) the operator has notified them.
- When a LIVE FERRY STATUS block is provided above, treat it as the authoritative source for Marine Atlantic sailings — it comes directly from marineatlantic.ca/travel-advisory. Cite the source URL when you use it. If it shows changes that affect the traveler's booked sailings (Day 4 outbound Jun 30, Day 9 return Jul 5–6), surface those proactively.
- If no LIVE FERRY STATUS block is present and the user asks about current status, tell them to check marineatlantic.ca/travel-advisory or call the operator — do not guess.

LOCAL RECOMMENDATIONS (IMPORTANT):
- When a VERIFIED NEARBY PLACES list is provided above, you MUST recommend ONLY from that list. Do not recommend places not on the list. These are confirmed to exist and be open right now.
- If no verified list is provided, use your general knowledge but note that opening hours should be confirmed.
- Provide exactly 3 options. Each MUST include: a clickable Google Maps link, a one-sentence description of what makes the place good, and the estimated walk/drive time.
- Format EXACTLY like this (the description sentence is mandatory, never omit it):
  [Name of Place](https://maps.google.com/?q=Place+Name+City) — One sentence describing the vibe, specialty, or what to order. ~X min walk/drive.
- The description must tell the traveler WHY this place is worth visiting — mention the food, atmosphere, or specialty.
- Pick well-known, highly-rated, real establishments. Prioritize places that are likely open at the current time of day.
- NEVER say "I don't have specific recommendations" or "ask the hotel staff" — you are the concierge, give real answers.
- Keep answers concise — a brief intro sentence, then the 3 recommendations, then an optional closing line.
- Do NOT fabricate place names, but DO use your real knowledge of well-known establishments in these areas.`;
    },
  },

  wwii2026: {
    weatherLocations: [
      { lat: 51.5074, lng: -0.1278, tz: 'Europe/London', label: 'LONDON' },
      { lat: 49.2764, lng: -0.7024, tz: 'Europe/Paris', label: 'NORMANDY' },
      { lat: 49.4521, lng: 11.0767, tz: 'Europe/Berlin', label: 'NUREMBERG' },
      { lat: 41.1579, lng: -8.6291, tz: 'Europe/Lisbon', label: 'PORTO' },
    ],
    geoChecks: [
      { lat: 51.5074, lng: -0.1278, radius: 0.5, label: 'They appear to be IN London right now.' },
      { lat: 49.2764, lng: -0.7024, radius: 0.5, label: 'They appear to be near Bayeux/Normandy right now.' },
      { lat: 49.4521, lng: 11.0767, radius: 0.5, label: 'They appear to be IN Nuremberg right now.' },
      { lat: 41.1579, lng: -8.6291, radius: 0.5, label: 'They appear to be IN Porto right now.' },
    ],
    defaultGeoNote: 'They are NOT currently near London, Normandy, Nuremberg, or Porto — they may be planning ahead.',
    localTimezone: 'Europe/London',
    buildPrompt: (wxSummary, locationNote, localTime, inferredLocation, nearbyPlacesContext) => {
      const timeLabel = inferredLocation?.city || 'local time';
      return `You are a knowledgeable, friendly travel concierge for a 15-day trip through London, Normandy, Nuremberg, and Porto (Oct 10-24, 2026), with a cultural WWII-history focus for the first three legs and a relaxed wine-country finish in Porto. You are embedded in the trip's guide website.

CRITICAL: Pay close attention to the traveler's CURRENT LOCATION and TIME. Do NOT assume they are in any particular city unless the location data confirms it. They may be browsing any day of the itinerary regardless of where they physically are.

CURRENT DATE/TIME (${timeLabel}): ${localTime}
${locationNote}
${nearbyPlacesContext ? '\n' + nearbyPlacesContext + '\n' : ''}
${wxSummary}

FULL ITINERARY:
${WWII_ITINERARY}

YOUR ROLE:
- Help the traveler decide what to do next based on: the itinerary, current time, weather, and their location.
- Be specific — use times, venue names, and hotel names from the itinerary.
- For the WWII sites (Churchill War Rooms, IWM, the Normandy beaches, the Nuremberg Trials memorial and Rally Grounds), give context that helps the visit land, not just logistics.
- Reference restaurants by name and the day they're booked.
- Nuremberg's Memorium Nürnberger Prozesse (Courtroom 600) is only open to the public on weekends when court isn't in session — Day 8 (Saturday) is scheduled deliberately; don't suggest moving it.
- The Douro Valley day trip (Day 13) is a long day with a private driver — don't suggest replacing it with something requiring the traveler to drive themselves.
- Keep answers concise — 2-4 short paragraphs max. Use natural language, not bullet lists, except for the recommendation format below.
- You can respond in English or match the traveler's language.

LOCAL RECOMMENDATIONS (IMPORTANT):
- When a VERIFIED NEARBY PLACES list is provided above, you MUST recommend ONLY from that list. Do not recommend places not on the list. These are confirmed to exist and be open right now.
- If no verified list is provided, use your general knowledge but note that opening hours should be confirmed.
- Provide exactly 3 options. Each MUST include: a clickable Google Maps link, a one-sentence description of what makes the place good, and the estimated walk time.
- Format EXACTLY like this (the description sentence is mandatory, never omit it):
  [Name of Place](https://maps.google.com/?q=Place+Name+City) — One sentence describing the vibe, specialty, or what to order. ~X min walk.
- The description must tell the traveler WHY this place is worth visiting — mention the food, atmosphere, or specialty.
- Pick well-known, highly-rated, real establishments. Prioritize places that are likely open at the current time of day.
- NEVER say "I don't have specific recommendations" or "ask the hotel staff" — you are the concierge, give real answers.
- Do NOT fabricate place names, but DO use your real knowledge of well-known establishments in these cities.`;
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

    // Live Marine Atlantic ferry status (KV-cached 15 min)
    // GET /api/ferry-status        → JSON, may serve cache
    // GET /api/ferry-status?force  → bypass cache and refetch
    if (url.pathname === '/api/ferry-status' && request.method === 'GET') {
      const force = url.searchParams.has('force');
      const advisory = await getFerryAdvisory(env, { force });
      const status = advisory.error ? 502 : 200;
      return new Response(JSON.stringify(advisory, null, 2), {
        status,
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'application/json; charset=utf-8',
          // Browser-side cache hint matches KV TTL so the PWA can hit this
          // endpoint freely without hammering it.
          'Cache-Control': advisory.error ? 'no-store' : 'public, max-age=900',
        },
      });
    }

    // Chat endpoints: /api/chat/zurich, /api/chat/maritimes, /api/chat/wwii2026
    // Also support legacy /api/chat (defaults to zurich)
    const chatMatch = url.pathname.match(/^\/api\/chat(?:\/(zurich|maritimes|wwii2026))?$/);
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

        // Determine if we need to fetch nearby places (recommendation query)
        // Priority for search center:
        //   1. Explicit place/date in the message (resolveQueryLocation)
        //   2. GPS
        //   3. Itinerary-inferred current location
        let nearbyPlacesPromise = null;
        let queryLocation = null;
        if (isRecommendationQuery(message)) {
          queryLocation = resolveQueryLocation(siteKey, message);
          const searchLat = queryLocation?.lat ?? lat ?? inferredLocation?.lat;
          const searchLng = queryLocation?.lng ?? lng ?? inferredLocation?.lng;
          const searchTz = queryLocation?.timezone || inferredLocation?.timezone || site.localTimezone;
          if (searchLat != null && searchLng != null) {
            const cats = getCategoriesFromMessage(message);
            nearbyPlacesPromise = getNearbyPlaces(searchLat, searchLng, cats, searchTz);
          }
        }

        // Live ferry status — only fetch for maritimes site, and only when the
        // query plausibly relates to ferries. This keeps Zurich requests fast
        // and avoids hitting marineatlantic.ca on unrelated chats.
        let ferryAdvisoryPromise = null;
        const ferryRelevant = siteKey === 'maritimes' && (
          /\b(ferr(y|ies)|marine atlantic|crossing|sail(ing)?|cancel|reschedul|north sydney|port aux basques|fundy rose|leif ericson|blue puttees|ala'?suinu|advisor|delay|on time)\b/i.test(message)
          || /\b(jun(e)?\s*30|jul(y)?\s*5|day\s*[49])\b/i.test(message)
        );
        if (ferryRelevant) {
          ferryAdvisoryPromise = getFerryAdvisory(env).catch(() => null);
        }

        const [weatherResults, actualLocationWeather, nearbyPlaces, ferryAdvisory] = await Promise.all([
          Promise.all(weatherPromises),
          actualLocationWeatherPromise,
          nearbyPlacesPromise,
          ferryAdvisoryPromise,
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

        // Location context — priority: explicit-query location > GPS > itinerary inference > unknown
        let locationNote = '';
        if (queryLocation) {
          locationNote = `QUERY CONTEXT: The user is asking about "${queryLocation.label}" — focus your answer and any recommendations on THAT place, not on the traveler's current position.`;
          if (lat != null && lng != null) {
            locationNote += ` (Their actual GPS is ${Number(lat).toFixed(4)}, ${Number(lng).toFixed(4)}, but the question is about a different place/day on the itinerary.)`;
          }
        } else if (lat != null && lng != null) {
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
        const formatOpts = {
          timeZone: effectiveTz, weekday: 'long', year: 'numeric',
          month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
        };
        let localTime;
        if (clientLocalTime) {
          // Client sends ISO UTC string — convert to the user's effective timezone
          try {
            const clientDate = new Date(clientLocalTime);
            localTime = clientDate.toLocaleString('en-US', formatOpts);
          } catch {
            localTime = now.toLocaleString('en-US', formatOpts);
          }
        } else {
          localTime = now.toLocaleString('en-US', formatOpts);
        }

        // Build nearby-places context for recommendation queries
        const nearbyPlacesContext = formatPlacesForPrompt(nearbyPlaces);

        // Build live ferry-status context (maritimes only, when relevant)
        const ferryStatusContext = ferryAdvisory
          ? formatAdvisoryForPrompt(ferryAdvisory, {
              tripDays: ['2026-06-30', '2026-07-05', '2026-07-06'],
            })
          : '';

        const systemPrompt = site.buildPrompt(wxSummary, locationNote, localTime, inferredLocation, nearbyPlacesContext, ferryStatusContext);

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
      "day": 1, "label": "Portland", "date": "Sat Jun 27", "timezone": "EDT (Eastern Daylight Time, UTC-4)",
      "stops": [
        { "time": "Afternoon", "title": "Meet Molly & Bonie", "desc": "Arrive in Portland. Stroll the Old Port — cobblestone streets, galleries, waterfront." },
        { "time": "Evening", "title": "Dinner in Portland", "desc": "Fresh seafood, farm-to-table, craft breweries." }
      ]
    },
    {
      "day": 2, "label": "Portland → Saint John → Digby", "date": "Sun Jun 28", "timezone": "Starts EDT, crosses into ADT (Atlantic Time, UTC-3) at the New Brunswick border. Times before border are EDT; times after border (Saint John, Digby) are ADT.",
      "depart": "7:00 AM EDT",
      "stops": [
        { "time": "Morning", "title": "Drive: Portland → Saint John, NB", "desc": "~4.5-hour drive north through Maine into New Brunswick. Border at Calais/St. Stephen. Passports needed." },
        { "time": "En Route", "title": "Suggested Stops", "desc": "Coffee in Bangor, ME (~2 hrs). After border, St. Andrews by-the-Sea — charming seaside town." },
        { "time": "2:15 PM AT", "title": "Fundy Rose Ferry", "desc": "Board ferry for 2.5-hour Bay of Fundy crossing. Arrive Digby ~4:45 PM Atlantic Time." },
        { "time": "~5:00 PM", "title": "Arrive Digby", "desc": "Scallop capital of the world. Walk the waterfront." }
      ]
    },
    {
      "day": 3, "label": "Digby → Lunenburg", "date": "Mon Jun 29", "timezone": "ADT (Atlantic Time, UTC-3)",
      "depart": "9:00 AM ADT",
      "stops": [
        { "time": "Morning", "title": "Scenic Drive — South Shore", "desc": "~2.5 hours along the Lighthouse Route through fishing villages." },
        { "time": "Afternoon", "title": "Explore Lunenburg", "desc": "UNESCO World Heritage Site. Colourful harbour, Fisheries Museum, Bluenose II." },
        { "time": "8:00 PM ADT (Atlantic Time)", "title": "Dinner: Beach Pea Kitchen & Bar CONFIRMED", "desc": "Lunenburg, NS. Farm-to-table, Nova Scotian seafood. Reservation confirmed for 8:00 PM local Atlantic Time (UTC-3) on Monday June 29, 2026. That is 7:00 PM Eastern." }
      ]
    },
    {
      "day": 4, "label": "Lunenburg → North Sydney → Overnight Ferry", "date": "Tue Jun 30", "timezone": "ADT (Atlantic Time, UTC-3) until boarding Marine Atlantic ferry; ferry crosses into NDT (Newfoundland Time, UTC-2:30) overnight.",
      "depart": "8:00 AM ADT",
      "stops": [
        { "time": "8:00 AM ADT", "title": "Early Start — Lunenburg → North Sydney", "desc": "~4.5-hour, ~395 km drive. Longest driving day. Coffee stop in Antigonish (~halfway)." },
        { "time": "~1:00 PM ADT", "title": "Arrive North Sydney area", "desc": "Plan a relaxed afternoon and pre-ferry dinner. Marine Atlantic terminal: 355 Purves St, North Sydney (44 nautical miles east of Sydney centre)." },
        { "time": "7:00 PM ADT", "title": "Pre-Ferry Dinner — Black Spoon Bistro (CONFIRMED RESERVATION)", "desc": "Confirmed dinner reservation at Black Spoon Bistro, 320 Esplanade, Sydney — chef-driven menu, ~12 min drive from the North Sydney terminal. Reservation is for 7:00 PM ADT. Aim to be finished by ~8:30 PM so you have a comfortable buffer for the 9:45 PM ferry check-in.", "confirmed": true },
        { "time": "9:45 PM ADT", "title": "FERRY CHECK-IN (mandatory)", "desc": "Marine Atlantic requires check-in 2 hours before sailing. Reservations — including booked cabins — are CANCELLED if you miss check-in. Terminal address: 355 Purves St, North Sydney. Have reservation number + ID ready.", "critical": true },
        { "time": "11:45 PM ADT", "title": "Marine Atlantic departs North Sydney", "desc": "Overnight crossing to Port aux Basques, ~7 hours. Cabin booked. Clocks lose 30 minutes overnight (ADT → NDT). Scheduled arrival ~7:30 AM NDT." }
      ]
    },
    {
      "day": 5, "label": "Port aux Basques → Twillingate", "date": "Wed Jul 1", "timezone": "NDT (Newfoundland Daylight Time, UTC-2:30) — 30 minutes AHEAD of Atlantic Time. This is a Newfoundland-specific half-hour offset that confuses many visitors.",
      "depart": "~9:00 AM NDT (after ferry arrival in Port aux Basques)",
      "stops": [
        { "time": "Morning", "title": "Arrive Port aux Basques", "desc": "Begin drive east across Newfoundland on the Trans-Canada." },
        { "time": "Mid-Morning", "title": "Corner Brook", "desc": "~2.5 hrs from Port aux Basques. Captain Cook's Lookout — panoramic Bay of Islands views." },
        { "time": "Lunch", "title": "Deer Lake", "desc": "Halfway point. Natural lunch stop." },
        { "time": "Evening", "title": "Arrive Twillingate", "desc": "Iceberg Capital of the World. Massive icebergs from Greenland drift past." }
      ]
    },
    {
      "day": "6–8", "label": "Fogo Island", "dates": "Thu Jul 2 – Sat Jul 4", "timezone": "NDT (Newfoundland Daylight Time, UTC-2:30) — 30 minutes ahead of Atlantic Time.",
      "stops": [
        { "time": "Day 6 Morning", "title": "Ferry to Fogo Island", "desc": "Drive Twillingate to Farewell, ~45 min ferry through iceberg waters." },
        { "time": "Day 6", "title": "Check In — Fogo Island Inn", "desc": "Architecturally stunning hotel on stilts at the North Atlantic edge. Designed by Todd Saunders. Every room faces the sea." },
        { "time": "Days 6–8", "title": "Explore Fogo Island", "desc": "3 full days. Visit Fogo Island Studios (artist residencies), hike coastal trails, meet local fishers, see icebergs. The inn offers community-host programs, boat tours, and foraging excursions. All profits return to the community." }
      ]
    },
    {
      "day": 9, "label": "Fogo → Port aux Basques (Return Ferry)", "date": "Sun Jul 5", "timezone": "Starts NDT (Newfoundland) and ends on the overnight Marine Atlantic ferry which crosses back into ADT.",
      "depart": "7:00 AM NDT",
      "stops": [
        { "time": "Morning", "title": "Ferry back to mainland", "desc": "Fogo Island → Farewell, ~45 min crossing." },
        { "time": "All Day", "title": "Drive: Farewell → Port aux Basques", "desc": "~560 km, ~6.5 hours. Grand Falls-Windsor (~2.5 hrs) for the Gorge. Deer Lake (~4.5 hrs) for lunch." },
        { "time": "~6:00–7:30 PM NDT", "title": "Pre-Ferry Dinner — Port aux Basques", "desc": "Eat before terminal check-in. Limited but solid: Alma’s Family Restaurant (Caribou Rd — home-style cod, ~5 min from terminal), Hot Dawgs Snack Bar (Main St — quick local diner), or the dining room at St. Christopher’s Hotel (Caribou Rd — closest hotel restaurant to the terminal). Town options thin out late; aim to be seated by 6:30 PM NDT." },
        { "time": "9:45 PM NDT", "title": "FERRY CHECK-IN (mandatory)", "desc": "Marine Atlantic requires check-in 2 hours before sailing. Missed check-in = reservation cancelled, including cabin. Port aux Basques terminal: Caribou Rd, Port aux Basques.", "critical": true },
        { "time": "11:45 PM NDT", "title": "Marine Atlantic departs Port aux Basques", "desc": "Overnight crossing back to North Sydney, ~7 hours. Clocks GAIN 30 minutes overnight (NDT → ADT). Scheduled arrival ~7:00 AM ADT." }
      ]
    },
    {
      "day": 10, "label": "North Sydney → Pictou", "date": "Mon Jul 6", "timezone": "ADT (Atlantic Time, UTC-3) — clocks shift back 30 minutes from NDT when the ferry arrives in Nova Scotia.",
      "depart": "~10:00 AM ADT (after Marine Atlantic ferry arrival)",
      "stops": [
        { "time": "Morning", "title": "Arrive North Sydney", "desc": "Disembark ferry." },
        { "time": "Afternoon", "title": "Explore Pictou", "desc": "Birthplace of New Scotland — first Scottish settlers landed 1773. Ship Hector Heritage Quay." }
      ]
    },
    {
      "day": 11, "label": "Pictou → Fredericton", "date": "Tue Jul 7", "timezone": "ADT (Atlantic Time, UTC-3)",
      "depart": "8:00 AM ADT",
      "stops": [
        { "time": "Morning", "title": "Drive: Pictou → Fredericton", "desc": "~4 hours through New Brunswick." },
        { "time": "En Route", "title": "Hopewell Rocks", "desc": "Iconic flower-pot formations carved by Bay of Fundy tides. Worth the detour." },
        { "time": "Afternoon", "title": "Fredericton Riverfront", "desc": "Walkable capital with craft beer, riverside trails, Beaverbrook Art Gallery (Dalí's Santiago El Grande)." }
      ]
    },
    {
      "day": 12, "label": "Fredericton → Portland (Home)", "date": "Wed Jul 8", "timezone": "Starts ADT (Atlantic Time, UTC-3) in New Brunswick; crosses back into EDT (Eastern, UTC-4) at the Maine border.",
      "depart": "8:00 AM ADT",
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
  "timezone_summary": {
    "key_rule": "Newfoundland (NL) uses NDT, which is 30 minutes AHEAD of ADT used in NS and NB. This half-hour offset trips up many visitors.",
    "by_day": {
      "Day 1 (Sat Jun 27)": "EDT — Portland, ME",
      "Day 2 (Sun Jun 28)": "EDT → ADT at NB border",
      "Day 3 (Mon Jun 29)": "ADT — Lunenburg, NS",
      "Day 4 (Tue Jun 30)": "ADT then ferry overnight into NDT",
      "Day 5 (Wed Jul 1)": "NDT — arrive Newfoundland",
      "Days 6-8 (Thu Jul 2 - Sat Jul 4)": "NDT — Fogo Island",
      "Day 9 (Sun Jul 5)": "NDT then ferry overnight back to ADT",
      "Day 10 (Mon Jul 6)": "ADT — North Sydney, Pictou",
      "Day 11 (Tue Jul 7)": "ADT — Pictou to Fredericton",
      "Day 12 (Wed Jul 8)": "ADT → EDT at Maine border"
    }
  },
  "ferries": [
    { "day": 2, "route": "Saint John → Digby", "vessel": "MV Fundy Rose", "duration": "2.5 hours", "departs": "2:15 PM ADT", "arrives": "4:45 PM ADT" },
    { "day": 4, "route": "North Sydney → Port aux Basques", "vessel": "Marine Atlantic", "departs": "11:45 PM ADT", "checkIn": "9:45 PM ADT (mandatory — 2 hr prior; reservations cancelled if missed)", "terminal": "355 Purves St, North Sydney", "duration": "~7 hours (overnight)", "arrives": "~7:30 AM NDT", "note": "Boards ADT, arrives NDT — clocks lose 30 minutes during the overnight." },
    { "day": 6, "route": "Farewell → Fogo Island", "duration": "~45 min" },
    { "day": 9, "route": "Fogo Island → Farewell", "duration": "~45 min" },
    { "day": 9, "route": "Port aux Basques → North Sydney", "vessel": "Marine Atlantic", "departs": "11:45 PM NDT", "checkIn": "9:45 PM NDT (mandatory — 2 hr prior; reservations cancelled if missed)", "terminal": "Caribou Rd, Port aux Basques", "duration": "~7 hours (overnight)", "arrives": "~7:00 AM ADT", "note": "Boards NDT, arrives ADT — clocks gain 30 minutes during the overnight." }
  ],
  "dining": [
    { "day": 3, "date": "Mon Jun 29", "time_local": "8:00 PM ADT", "timezone": "America/Halifax (Atlantic Time, UTC-3)", "iso": "2026-06-29T20:00:00-03:00", "venue": "Beach Pea Kitchen & Bar", "location": "Lunenburg, NS", "status": "Confirmed" },
    { "day": 4, "date": "Tue Jun 30", "time_local": "7:00 PM ADT", "timezone": "America/Halifax (Atlantic Time, UTC-3)", "iso": "2026-06-30T19:00:00-03:00", "venue": "Black Spoon Bistro", "location": "Sydney, NS (320 Esplanade) — pre-ferry, ~12 min from North Sydney terminal", "status": "Confirmed" }
  ]
}`;

// ── WWII2026 ITINERARY (London / Normandy / Nuremberg / Porto) ─────────
const WWII_ITINERARY = `{"trip": {"title": "London → Normandy → Nuremberg → Porto · October 2026", "dates": "Oct 10–24, 2026 (14 nights)", "travelers": "2 adults", "theme": "Cultural WWII focus + Porto finish"}, "hotels": [{"city": "London", "nights": 5, "name": "London Marriott Hotel Park Lane", "daysRange": "Day 1–Day 6"}, {"city": "Normandy", "nights": 2, "name": "Villa Lara Hôtel (Bayeux)", "daysRange": "Day 6–Day 8"}, {"city": "Nuremberg", "nights": 2, "name": "Sheraton Carlton Hotel Nürnberg", "daysRange": "Day 8–Day 10"}, {"city": "Porto", "nights": 5, "name": "The Yeatman Hotel", "daysRange": "Day 10–Day 15"}], "days": [{"day": 1, "label": "Day 1 · Sat Oct 10 · Arrive London", "city": "London", "headline": "Evening walk through Mayfair after check-in, martini at The Dorchester", "stops": [{"time": "08:20", "type": "Flight", "text": "Newark (EWR) to London Heathrow (LHR) — nonstop"}, {"time": "22:00", "type": "Transport", "text": "Heathrow Express to Paddington, then taxi to Mayfair — 50 min total"}, {"time": "23:00", "type": "Hotel", "text": "Check in — London Marriott Hotel Park Lane", "hotel": "London Marriott Hotel Park Lane"}, {"time": "23:30", "type": "Dinner", "text": "Late supper at Scott's Mayfair (walk-in bar seats)", "restaurant": "Scott's Mayfair"}]}, {"day": 2, "label": "Day 2 · Sun Oct 11 · Westminster & Churchill War Rooms", "city": "London", "headline": "Stand in Churchill's Map Room where the war was directed", "stops": [{"time": "10:00", "type": "Activity", "text": "Churchill War Rooms"}, {"time": "12:30", "type": "Activity", "text": "Walk Westminster — Parliament Square, Churchill statue, Big Ben exterior, Westminster Abbey exterior"}, {"time": "19:30", "type": "Dinner", "text": "Dinner at Veeraswamy", "restaurant": "Veeraswamy"}, {"time": "23:00", "type": "Hotel", "text": "Overnight — London Marriott Hotel Park Lane", "hotel": "London Marriott Hotel Park Lane"}]}, {"day": 3, "label": "Day 3 · Mon Oct 12 · Imperial War Museum", "city": "London", "headline": "Walk the Holocaust Exhibition and WWII galleries at IWM", "stops": [{"time": "10:00", "type": "Activity", "text": "Imperial War Museum London"}, {"time": "19:30", "type": "Dinner", "text": "Dinner at Clio", "restaurant": "Clio"}, {"time": "23:00", "type": "Hotel", "text": "Overnight — London Marriott Hotel Park Lane", "hotel": "London Marriott Hotel Park Lane"}]}, {"day": 4, "label": "Day 4 · Tue Oct 13 · British Museum & West End", "city": "London", "headline": "Evening West End show — history on stage after a museum day", "stops": [{"time": "10:00", "type": "Activity", "text": "British Museum"}, {"time": "17:00", "type": "Dinner", "text": "Pre-theatre dinner at Kiln", "restaurant": "Kiln"}, {"time": "19:30", "type": "Activity", "text": "West End theatre — evening performance"}, {"time": "23:30", "type": "Hotel", "text": "Overnight — London Marriott Hotel Park Lane", "hotel": "London Marriott Hotel Park Lane"}]}, {"day": 5, "label": "Day 5 · Wed Oct 14 · Tower of London", "city": "London", "headline": "Stand where Anne Boleyn was beheaded, see the Crown Jewels", "stops": [{"time": "09:30", "type": "Activity", "text": "Tower of London"}, {"time": "19:30", "type": "Dinner", "text": "Dinner at The River Restaurant by Gordon Ramsay", "restaurant": "The River Restaurant by Gordon Ramsay"}, {"time": "23:00", "type": "Hotel", "text": "Overnight — London Marriott Hotel Park Lane", "hotel": "London Marriott Hotel Park Lane"}]}, {"day": 6, "label": "Day 6 · Thu Oct 15 · Normandy American Cemetery", "city": "Normandy", "headline": "Stand at the cliff edge above Omaha Beach at dawn", "stops": [{"time": "08:00", "type": "Transport", "text": "Private driver pickup from hotel for full-day Normandy D-Day tour"}, {"time": "09:30", "type": "Activity", "text": "Normandy American Cemetery & Memorial"}, {"time": "11:30", "type": "Activity", "text": "Pointe du Hoc Ranger Monument"}, {"time": "14:00", "type": "Activity", "text": "Utah Beach Museum (Musée du Débarquement)"}, {"time": "17:30", "type": "Transport", "text": "Return to Bayeux hotel"}, {"time": "19:30", "type": "Dinner", "text": "Dinner at Le Pommier", "restaurant": "Le Pommier"}, {"time": "22:00", "type": "Hotel", "text": "Overnight at Villa Lara Hôtel", "hotel": "Villa Lara Hôtel"}]}, {"day": 7, "label": "Day 7 · Fri Oct 16 · Juno Beach & Caen Memorial", "city": "Normandy", "headline": "Walk the Canadian beach at Juno, then the Caen peace museum", "stops": [{"time": "09:00", "type": "Transport", "text": "Drive to Juno Beach — 45 min via D514"}, {"time": "10:00", "type": "Activity", "text": "Juno Beach Centre"}, {"time": "13:00", "type": "Transport", "text": "Drive to Caen — 30 min via N13"}, {"time": "13:45", "type": "Activity", "text": "Mémorial de Caen (Caen Memorial Museum)"}, {"time": "17:00", "type": "Transport", "text": "Return to Bayeux — 35 min via N13"}, {"time": "19:30", "type": "Dinner", "text": "Dinner at L'Angle Saint Laurent", "restaurant": "L'Angle Saint Laurent"}, {"time": "22:00", "type": "Hotel", "text": "Overnight at Villa Lara Hôtel", "hotel": "Villa Lara Hôtel"}]}, {"day": 8, "label": "Day 8 · Sat Oct 17 · Nuremberg Trials Memorial", "city": "Nuremberg", "headline": "Sit in Courtroom 600 where the architects of the Holocaust faced justice", "stops": [{"time": "06:30", "type": "Hotel", "text": "Check out from Villa Lara Hôtel", "hotel": "Villa Lara Hôtel"}, {"time": "06:45", "type": "Transport", "text": "Private driver to Paris CDG — 3h via A13/A86"}, {"time": "12:00", "type": "Flight", "text": "Fly Paris CDG → Nuremberg · nonstop"}, {"time": "14:00", "type": "Transport", "text": "Taxi NUE airport to hotel — 20 min"}, {"time": "14:30", "type": "Hotel", "text": "Check in at Sheraton Carlton Hotel Nürnberg", "hotel": "Sheraton Carlton Hotel Nürnberg"}, {"time": "15:30", "type": "Activity", "text": "Memorium Nürnberger Prozesse (Nuremberg Trials Memorial)"}, {"time": "19:30", "type": "Dinner", "text": "Dinner at Essigbrätlein", "restaurant": "Essigbrätlein"}, {"time": "22:30", "type": "Hotel", "text": "Overnight at Sheraton Carlton Hotel Nürnberg", "hotel": "Sheraton Carlton Hotel Nürnberg"}]}, {"day": 9, "label": "Day 9 · Sun Oct 18 · Nuremberg old town", "city": "Nuremberg", "headline": "Walk the ramparts of Kaiserburg at golden hour", "stops": [{"time": "10:00", "type": "Activity", "text": "Nuremberg Castle (Kaiserburg) & Sinwell Tower"}, {"time": "14:00", "type": "Transport", "text": "Walk to Documentation Center — 25 min via Altstadt"}, {"time": "19:00", "type": "Dinner", "text": "Dinner at Waidwerk", "restaurant": "Waidwerk"}, {"time": "21:30", "type": "Hotel", "text": "Overnight at Sheraton Carlton Hotel Nürnberg", "hotel": "Sheraton Carlton Hotel Nürnberg"}]}, {"day": 10, "label": "Day 10 · Mon Oct 19 · Documentation Center & evening to Porto", "city": "Nuremberg", "headline": "Confront the Rally Grounds, then fly to Portugal's wine capital", "stops": [{"time": "09:00", "type": "Hotel", "text": "Check out from Sheraton Carlton Hotel Nürnberg · luggage hold", "hotel": "Sheraton Carlton Hotel Nürnberg"}, {"time": "09:30", "type": "Activity", "text": "Documentation Center Nazi Party Rally Grounds (Dokumentationszentrum Reichsparteitagsgelände)"}, {"time": "12:30", "type": "Transport", "text": "Taxi back to hotel for luggage pickup — 15 min"}, {"time": "13:00", "type": "Transport", "text": "Taxi to Nuremberg Airport (NUE) — 20 min"}, {"time": "15:55", "type": "Flight", "text": "Fly Nuremberg → Porto · nonstop"}, {"time": "18:20", "type": "Transport", "text": "Taxi OPO airport to hotel — 25 min via VCI"}, {"time": "18:50", "type": "Hotel", "text": "Check in at The Yeatman Hotel", "hotel": "The Yeatman Hotel"}, {"time": "20:00", "type": "Dinner", "text": "Dinner at Antiqvvm", "restaurant": "Antiqvvm"}, {"time": "23:00", "type": "Hotel", "text": "Overnight at The Yeatman Hotel", "hotel": "The Yeatman Hotel"}]}, {"day": 11, "label": "Day 11 · Tue Oct 20 · Porto arrival & riverside evening", "city": "Porto", "headline": "First port wine tasting overlooking the Douro at sunset", "stops": [{"time": "10:30", "type": "Note", "text": "Sleep in, leisurely hotel breakfast with Douro panorama"}, {"time": "14:00", "type": "Activity", "text": "Wine tasting at Quinta do Vallado terrace"}, {"time": "20:00", "type": "Dinner", "text": "Dinner at Antiqvvm", "restaurant": "Antiqvvm"}]}, {"day": 12, "label": "Day 12 · Wed Oct 21 · Ribeira & port lodges", "city": "Porto", "headline": "Private cellar tour at Graham's, then francesinha for lunch", "stops": [{"time": "10:00", "type": "Activity", "text": "Private port-lodge tour & tasting at Graham's"}, {"time": "12:30", "type": "Transport", "text": "Walk down to Ribeira · 15 min via Ponte Luís I lower deck"}, {"time": "13:00", "type": "Note", "text": "Explore Ribeira waterfront — azulejo-tiled buildings, São Francisco Church, Praça da Ribeira"}, {"time": "19:30", "type": "Dinner", "text": "Dinner at Pedro Lemos", "restaurant": "Pedro Lemos"}]}, {"day": 13, "label": "Day 13 · Thu Oct 22 · Douro Valley day trip", "city": "Porto", "headline": "Quinta do Crasto vineyard lunch overlooking terraced vines", "stops": [{"time": "08:30", "type": "Transport", "text": "Private driver picks up at hotel for Douro Valley day · full day with return ~6:00 PM"}, {"time": "10:30", "type": "Activity", "text": "Quinta do Crasto — vineyard tour, tasting & estate lunch"}, {"time": "15:00", "type": "Note", "text": "Scenic drive along N-222 (one of the world's most beautiful roads) · stop at Pinhão riverfront"}, {"time": "18:00", "type": "Transport", "text": "Return to Porto hotel"}, {"time": "20:00", "type": "Dinner", "text": "Dinner at Trasca", "restaurant": "Trasca"}]}, {"day": 14, "label": "Day 14 · Fri Oct 23 · Porto slow morning & evening flight prep", "city": "Porto", "headline": "Morning at Livraria Lello, then sunset port at Taylor's terrace", "stops": [{"time": "09:30", "type": "Activity", "text": "Livraria Lello bookshop & Clérigos Tower"}, {"time": "12:00", "type": "Note", "text": "Free afternoon — stroll Jardins do Palácio de Cristal, browse Rua Miguel Bombarda galleries, or relax at hotel wine spa"}, {"time": "17:30", "type": "Note", "text": "Sunset port tasting at Taylor's terrace (walk-in) — sweeping Douro panorama, quiet end to the trip"}, {"time": "20:00", "type": "Dinner", "text": "Dinner at O Paparico", "restaurant": "O Paparico"}, {"time": "22:00", "type": "Hotel", "text": "The Yeatman Hotel · overnight"}]}, {"day": 15, "label": "Day 15 · Sat Oct 24 · Depart Porto", "city": "Porto", "headline": "Morning at leisure, then fly Porto → Newark", "stops": [{"time": "09:00", "type": "Note", "text": "Sleep in, pack, final hotel breakfast with Douro view"}, {"time": "11:00", "type": "Hotel", "text": "Check out · The Yeatman Hotel", "hotel": "The Yeatman Hotel"}, {"time": "11:30", "type": "Transport", "text": "Private transfer to Porto airport (OPO) · 30 min"}, {"time": "14:05", "type": "Flight", "text": "Fly Porto to Newark (OPO → EWR) · nonstop"}]}]}
`;
