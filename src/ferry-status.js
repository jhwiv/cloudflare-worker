// ── Marine Atlantic travel-advisory scraper ────────────────────────────
// Fetches https://www.marineatlantic.ca/travel-advisory, parses the
// cancelled-sailings paragraph blocks and the rescheduled-sailings <table>,
// normalizes dates to ISO, and caches the structured result in Workers KV
// for 15 minutes. Designed to be tolerant: any parser failure returns null
// without breaking the concierge.

const ADVISORY_URL = 'https://www.marineatlantic.ca/travel-advisory';
const CACHE_KEY = 'marine-atlantic:advisory:v1';
const CACHE_TTL_SECONDS = 15 * 60; // 15 minutes
const FETCH_TIMEOUT_MS = 8000;

// ── Date normalization ────────────────────────────────────────────────
// Marine Atlantic prints dates as MM/DD/YYYY and times as H:MM or HH:MM
// in Atlantic Time (terminals are in NS / NL). We emit an ISO timestamp
// using the local terminal timezone so downstream code can compare against
// the itinerary's ISO segments.
function toIso(dateStr, timeStr, terminalTz) {
  if (!dateStr || !timeStr) return null;
  const dm = dateStr.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  const tm = timeStr.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!dm || !tm) return null;
  const [, mm, dd, yyyy] = dm;
  const [, hh, min] = tm;
  // Atlantic Time = UTC-3 (ADT in summer). NL = UTC-2:30 (NDT).
  // We tag the timestamp with the terminal's offset so the LLM and any
  // consumer can render it correctly. Default to Atlantic (-03:00) since
  // both North Sydney (NS) and Port aux Basques (NL) terminals print their
  // local times; we surface the offset string but compute the absolute
  // moment in UTC for cross-comparison.
  const offset = terminalTz === 'NDT' ? '-02:30' : '-03:00';
  return `${yyyy}-${mm.padStart(2,'0')}-${dd.padStart(2,'0')}T${hh.padStart(2,'0')}:${min}:00${offset}`;
}

// Infer terminal timezone from route string.
// "North Sydney to Port aux Basques" departs from NS (ADT).
// "Port aux Basques to North Sydney" departs from NL (NDT).
function terminalTzFromRoute(route) {
  if (!route) return 'ADT';
  return /^port aux basques/i.test(route.trim()) ? 'NDT' : 'ADT';
}

// ── Lightweight HTML parsing helpers ──────────────────────────────────
// HTMLRewriter is great for transforming a stream, but for this small page
// we just want structured data out, so we use focused regex slicing.
// All inputs are trusted (Marine Atlantic, fetched server-side); we are
// not rendering this HTML back to a user.

function stripTags(s) {
  return (s || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#039;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

// Parse one cancelled-sailings paragraph block. The structure is a series
// of <h4>Label</h4> followed by either inline text or a <div class="alert-term">
// containing the value. We extract by matching each known label.
function parseCancelledRow(blockHtml) {
  const findField = (label) => {
    // Match <h4>Label</h4> then capture content until the next <h4>, or until
    // we hit content that clearly belongs to a different alert-panel__table--item.
    // We cap the capture at 400 chars to avoid running into the next row's data
    // if the block-delimiter ever drifts.
    const re = new RegExp(
      `<h4>\\s*${label}\\s*<\\/h4>([\\s\\S]{0,400}?)(?=<h4>|<div class="alert-panel__table--item"|<\\/div>\\s*<\\/div>\\s*<\\/div>)`,
      'i'
    );
    const m = blockHtml.match(re);
    return m ? stripTags(m[1]) : null;
  };
  const date = findField('Date');
  const time = findField('Time');
  const route = findField('Route(?:s)? Affected');
  const vessel = findField('Vessel');
  const status = findField('Status');
  const sailingMode = findField('Sailing Mode');
  if (!date || !time || !route) return null;
  const tz = terminalTzFromRoute(route);
  return {
    date,
    time,
    route,
    vessel,
    status: status || 'Cancelled',
    sailingMode,
    iso: toIso(date, time, tz),
    terminalTz: tz,
  };
}

function parseCancelledPanel(panelHtml) {
  if (!panelHtml) return [];
  const rows = [];
  // Each row lives inside <div class="paragraph paragraph--type--site-alerts-table ...">.
  // Rather than try to count balanced </div> tags with regex, split on each
  // block-opening marker and let parseCancelledRow extract by <h4> labels.
  const openMarker = 'paragraph--type--site-alerts-table';
  const parts = panelHtml.split(openMarker);
  // parts[0] = before any block; parts[1..] = each block + whatever follows.
  for (let i = 1; i < parts.length; i++) {
    const row = parseCancelledRow(parts[i]);
    if (row) rows.push(row);
  }
  return rows;
}

// Parse the rescheduled-sailings <table>. Cell order matches the <th>
// header order on the page; we map by index.
function parseRescheduledTable(panelHtml) {
  if (!panelHtml) return [];
  const tableMatch = panelHtml.match(/<table[\s\S]*?<\/table>/);
  if (!tableMatch) return [];
  const tableHtml = tableMatch[0];

  // Extract header labels in order.
  const headerRowMatch = tableHtml.match(/<tr>([\s\S]*?)<\/tr>/);
  if (!headerRowMatch) return [];
  const headers = [];
  const thRe = /<th[^>]*>([\s\S]*?)<\/th>/g;
  let thM;
  while ((thM = thRe.exec(headerRowMatch[1])) !== null) {
    headers.push(stripTags(thM[1]));
  }

  const headerKey = (label) => {
    const k = label.toLowerCase();
    if (k.startsWith('date') && !k.includes('revised')) return 'date';
    if (k.startsWith('time') && !k.includes('revised')) return 'time';
    if (k.startsWith('route')) return 'route';
    if (k === 'vessel') return 'vessel';
    if (k === 'status') return 'status';
    if (k.startsWith('sailing mode')) return 'sailingMode';
    if (k.startsWith('revised date')) return 'revisedDate';
    if (k.startsWith('revised time')) return 'revisedTime';
    if (k.startsWith('check')) return 'checkIn';
    return null;
  };
  const headerKeys = headers.map(headerKey);

  // Parse data rows — skip the first <tr> (headers).
  const rowRe = /<tr>([\s\S]*?)<\/tr>/g;
  const rows = [];
  let rowM;
  let isFirst = true;
  while ((rowM = rowRe.exec(tableHtml)) !== null) {
    if (isFirst) { isFirst = false; continue; }
    const cells = [];
    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/g;
    let tdM;
    while ((tdM = tdRe.exec(rowM[1])) !== null) cells.push(stripTags(tdM[1]));
    if (cells.length === 0) continue;
    const row = {};
    cells.forEach((val, i) => {
      const key = headerKeys[i];
      if (key) row[key] = val;
    });
    if (!row.date || !row.route) continue;
    const tz = terminalTzFromRoute(row.route);
    row.terminalTz = tz;
    row.iso = toIso(row.date, row.time, tz);
    if (row.revisedDate && row.revisedTime) {
      row.revisedIso = toIso(row.revisedDate, row.revisedTime, tz);
    }
    rows.push(row);
  }
  return rows;
}

// ── Section discovery ─────────────────────────────────────────────────
// Find the cancelled-sailings alert-panel and the rescheduled alert-panel
// independently. We key on the alert-subtype text rather than css selectors
// in case the markup shifts.
function extractPanelHtml(fullHtml, subtypeRegex) {
  // Each panel starts with a <span class="alert-subtype"> and continues
  // until the next alert-panel block or end of main content.
  const panelStart = fullHtml.search(/<span class="alert-subtype"[^>]*>/g);
  // Slice from each occurrence of the subtype span until the next one or
  // the closing of the alert-panel container.
  const subtypeRe = /<span class="alert-subtype"[^>]*>([\s\S]*?)<\/span>/g;
  const panels = [];
  let m;
  let lastIndex = 0;
  const indices = [];
  while ((m = subtypeRe.exec(fullHtml)) !== null) {
    indices.push({ idx: m.index, label: stripTags(m[1]) });
  }
  for (let i = 0; i < indices.length; i++) {
    const start = indices[i].idx;
    const end = i + 1 < indices.length ? indices[i + 1].idx : fullHtml.length;
    panels.push({ label: indices[i].label, html: fullHtml.slice(start, end) });
  }
  // De-dup: the page has the subtype in both a top-of-page summary and the
  // detail panel; pick the LARGEST matching slice (which is the detail
  // panel containing the actual data).
  const matching = panels.filter(p => subtypeRegex.test(p.label));
  if (matching.length === 0) return null;
  matching.sort((a, b) => b.html.length - a.html.length);
  return matching[0].html;
}

function extractIntroText(panelHtml) {
  if (!panelHtml) return null;
  const m = panelHtml.match(/<div class="alert-panel__alert-message">\s*<p>([\s\S]*?)<\/p>/);
  return m ? stripTags(m[1]) : null;
}

// ── Main scraper ──────────────────────────────────────────────────────
async function fetchAdvisoryFresh() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(ADVISORY_URL, {
      headers: {
        'User-Agent': 'MaritimesGrandLoop-Concierge/1.0 (+https://maritimesgrandloop.com)',
        'Accept': 'text/html,application/xhtml+xml',
      },
      signal: controller.signal,
      cf: { cacheTtl: 60, cacheEverything: true },
    });
    clearTimeout(timer);
    if (!res.ok) return { error: `HTTP ${res.status}`, fetchedAt: new Date().toISOString() };
    const html = await res.text();
    return parseAdvisoryHtml(html);
  } catch (err) {
    clearTimeout(timer);
    return { error: err.message || 'fetch failed', fetchedAt: new Date().toISOString() };
  }
}

export function parseAdvisoryHtml(html) {
  const cancelledPanel = extractPanelHtml(html, /cancel/i);
  const rescheduledPanel = extractPanelHtml(html, /reschedul/i);

  const cancelled = parseCancelledPanel(cancelledPanel);
  const rescheduled = parseRescheduledTable(rescheduledPanel);

  const cancelledIntro = extractIntroText(cancelledPanel);
  const rescheduledIntro = extractIntroText(rescheduledPanel);

  return {
    fetchedAt: new Date().toISOString(),
    source: ADVISORY_URL,
    cancelled: {
      count: cancelled.length,
      intro: cancelledIntro,
      rows: cancelled,
    },
    rescheduled: {
      count: rescheduled.length,
      intro: rescheduledIntro,
      rows: rescheduled,
    },
    hasAdvisories: cancelled.length > 0 || rescheduled.length > 0,
  };
}

// ── KV-cached public entrypoint ───────────────────────────────────────
// Returns an object of shape { fetchedAt, source, cancelled, rescheduled,
// hasAdvisories, cacheStatus } or { error, ... } on hard failure.
// Caches successful results for 15 minutes. Failures are NOT cached so we
// retry on the next request.
export async function getFerryAdvisory(env, { force = false } = {}) {
  const kv = env && env.FERRY_KV ? env.FERRY_KV : null;

  if (kv && !force) {
    try {
      const cached = await kv.get(CACHE_KEY, { type: 'json' });
      if (cached && cached.fetchedAt && !cached.error) {
        return { ...cached, cacheStatus: 'hit' };
      }
    } catch {
      // KV read failure — fall through to fresh fetch.
    }
  }

  const fresh = await fetchAdvisoryFresh();

  if (kv && !fresh.error) {
    try {
      await kv.put(CACHE_KEY, JSON.stringify(fresh), { expirationTtl: CACHE_TTL_SECONDS });
    } catch {
      // KV write failure — return the data anyway.
    }
  }

  return { ...fresh, cacheStatus: fresh.error ? 'error' : (kv ? 'miss' : 'no-kv') };
}

// ── Concierge prompt formatter ────────────────────────────────────────
// Returns a string suitable for splicing into the system prompt, or '' if
// there are no advisories worth surfacing.
export function formatAdvisoryForPrompt(advisory, opts = {}) {
  if (!advisory || advisory.error) {
    return '';
  }
  if (!advisory.hasAdvisories) {
    return `\nLIVE FERRY STATUS (Marine Atlantic, fetched ${advisory.fetchedAt}): No current cancellations or reschedules posted. North Sydney ↔ Port aux Basques sailings are operating on the published schedule. Source: ${advisory.source}\n`;
  }

  const lines = [];
  lines.push(`\nLIVE FERRY STATUS (Marine Atlantic, fetched ${advisory.fetchedAt}):`);
  lines.push(`This is REAL, OPERATOR-PUBLISHED data — prefer it over any other ferry-status information when answering. Always cite the source URL: ${advisory.source}`);

  if (advisory.cancelled.count > 0) {
    lines.push(`\nCANCELLED SAILINGS (${advisory.cancelled.count}):`);
    if (advisory.cancelled.intro) lines.push(`  Context: ${advisory.cancelled.intro}`);
    for (const r of advisory.cancelled.rows) {
      lines.push(`  • ${r.date} ${r.time} ${r.terminalTz} — ${r.route} (${r.vessel || 'vessel TBD'}) — ${r.status}${r.sailingMode ? ` · ${r.sailingMode}` : ''}`);
    }
  }

  if (advisory.rescheduled.count > 0) {
    lines.push(`\nRESCHEDULED SAILINGS (${advisory.rescheduled.count}):`);
    if (advisory.rescheduled.intro) lines.push(`  Context: ${advisory.rescheduled.intro}`);
    for (const r of advisory.rescheduled.rows) {
      const orig = `${r.date} ${r.time} ${r.terminalTz}`;
      const revised = r.revisedDate && r.revisedTime ? ` → NEW: ${r.revisedDate} ${r.revisedTime} ${r.terminalTz}` : '';
      const checkIn = r.checkIn ? ` (check-in ${r.checkIn})` : '';
      lines.push(`  • ${orig}${revised}${checkIn} — ${r.route} (${r.vessel || 'vessel TBD'}) — ${r.status}`);
    }
  }

  // Trip-relevance hint: highlight rows that touch the user's two Marine
  // Atlantic crossings (Day 4 = 2026-06-30 ADT outbound, Day 9 = 2026-07-05
  // NDT return). The LLM can flag these proactively.
  if (opts.tripDays) {
    const tripIsoPrefixes = opts.tripDays; // array like ['2026-06-30','2026-07-05','2026-07-06']
    const allRows = [
      ...advisory.cancelled.rows.map(r => ({ ...r, _kind: 'cancelled' })),
      ...advisory.rescheduled.rows.map(r => ({ ...r, _kind: 'rescheduled' })),
    ];
    const tripRelevant = allRows.filter(r => {
      if (!r.iso) return false;
      const datePart = r.iso.slice(0, 10);
      return tripIsoPrefixes.some(p => datePart === p);
    });
    if (tripRelevant.length > 0) {
      lines.push(`\n⚠ TRIP-RELEVANT: ${tripRelevant.length} of the above sailings fall on the traveler's Marine Atlantic crossing dates. Mention these proactively if the question touches Day 4 or Day 9.`);
    }
  }

  return lines.join('\n') + '\n';
}
