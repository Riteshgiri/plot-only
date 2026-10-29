// Plot Only for Netflix — background service worker.
// Downloads the subtitle track, asks Claude which scenes carry the plot,
// turns that into a list of skip ranges, and caches it per title.

const DEFAULT_MODEL = 'claude-sonnet-5-5';
// Shared server (see plot-only-server). When set, nobody needs their own API key,
// and each title is analyzed once for everyone. Can be overridden in the popup.
const DEFAULT_SERVER = 'https://plot-only-api.riteshpgiri.workers.dev';
const PLAN_VERSION = 4;
const MIN_SKIP_SEC = 15;
const MAX_FRAMES = 300;          // Netflix gives one frame per 10s; keep up to ~every 20s for long titles
const SHEET_COLS = 4;
const SHEET_ROWS = 3;
const CELL_W = 320;

const SYSTEM_PROMPT = `You are a film editor making a "plot only" cut of a TV episode or film.

You get two views of it:
1. CONTACT SHEETS: grids of still frames sampled every few seconds, each frame labeled with its time in seconds. Use them to SEE what happens: who is on screen, locations, action, fights, chases, discoveries, important objects, emotional reactions, and where one scene visually ends and the next begins (cuts to a new location or set of characters).
2. SUBTITLES: timestamped dialogue, including [sound descriptions].

Combine both. Visual-only moments (a silent discovery, an action sequence, a look between characters that changes things) can matter as much as dialogue. Use visual location/character changes to place scene boundaries precisely.

Split the whole runtime into scenes and decide, for each one, whether a viewer must see it to fully follow the MAIN story.

KEEP:
- The setup of this episode's main story, and anything that advances it
- Reveals, twists, key information, decisions with consequences
- Scenes that create or change an important relationship
- Important action. Subtitle sound descriptions in [brackets] and "(no dialogue)" gaps often mark action; keep them when they matter to the plot
- The climax, the ending, and any cliffhanger

SKIP:
- "Previously on" recaps and cold-open repeats of earlier episodes
- Side plots that don't affect the main story
- Banter, comic relief, small talk, repeated exposition
- Travel, transitions, montages that add no new information

PROTECT SETUPS (things that may pay off later, in this episode or a future one):
- Keep anything the show deliberately draws attention to: a close-up or lingering shot on an object, a character noticing or hiding something, an odd detail, a line that sounds planted, a name or place mentioned with weight. Writers signal setups this way, and the contact sheets often show it.
- If you recognize this show or film from its title, use what you know about the rest of the story (later scenes, later episodes) to keep scenes that set up later payoffs. Use only what you actually know; if you don't recognize it, rely on the signals above.
- NO SPOILERS: labels and reasons must never reveal later events. For a protected setup, write a reason like "Sets up something that matters later".

Rules:
- When unsure, KEEP. The viewer must never be confused about what happened or why.
- Aim to keep roughly 35-55% of the runtime, but comprehension beats the target.
- Scenes must be contiguous and in order, covering 0 to END with no gaps or overlaps.
- Put boundaries at natural cut points: dialogue gaps or clear topic/location changes. No scene shorter than 20 seconds.
- Times are whole seconds.
- "label": 3-8 words saying what happens in the scene, for EVERY scene (e.g. "Holly finds the missing ledger", "Opening title sequence").
- "why": 4-10 words, for EVERY scene, saying why it is kept or skipped (e.g. "Reveals who took the money", "Side plot, never comes back", "Recap of earlier episodes").

Respond with ONLY this JSON, nothing else:
{"scenes":[{"start":0,"end":84,"keep":false,"label":"Previously-on recap","why":"Recap of earlier episodes"},{"start":84,"end":310,"keep":true,"label":"Holly finds the missing ledger","why":"Sets up this episode's main mystery"}]}`;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const run = msg && msg.type === 'ANALYZE' ? analyze : msg && msg.type === 'ANALYZE_SEASON' ? analyzeSeason : null;
  if (!run) return;
  run(msg).then(
    (plan) => sendResponse({ ok: true, plan }),
    (err) => sendResponse({ ok: false, error: (err && err.message) || String(err) })
  );
  return true; // async response
});

async function analyze({ movieId, track, title, frameUrls = [] }) {
  const cacheKey = `plan:${movieId}`;
  const stored = await chrome.storage.local.get([cacheKey, 'apiKey', 'model', 'serverUrl', 'useOwnKey']);
  const cached = stored[cacheKey];
  // Reuse a cached plan unless it was dialogue-only and we can now see the scenes.
  if (cached && cached.v === PLAN_VERSION && (cached.visual || !frameUrls.length)) return cached;
  const server = stored.useOwnKey ? '' : String(stored.serverUrl || DEFAULT_SERVER).trim().replace(/\/+$/, '');
  if (!server && !stored.apiKey) throw new Error('add your Anthropic API key in the extension popup (Advanced)');

  const [subRes, frames] = await Promise.all([fetch(track.url), loadFrames(frameUrls)]);
  if (!subRes.ok) throw new Error(`couldn't download subtitles (HTTP ${subRes.status})`);
  const cues = parseSubtitles(await subRes.text());
  if (cues.length < 20 && !frames.length) throw new Error('not enough dialogue or frames to find the plot');

  const lastFrame = frames.length ? frames[frames.length - 1].time : 0;
  const end = Math.ceil(Math.max(cues.length ? cues[cues.length - 1].end : 0, lastFrame));
  const transcript = buildTranscript(cues);

  let result; // { scenes, visual }
  if (server) {
    result = await viaServer({ server, movieId, title, end, transcript, frames });
  } else {
    const sheets = frames.length ? await buildContactSheets(frames) : [];
    const scenes = await askClaude({
      apiKey: stored.apiKey,
      model: stored.model || DEFAULT_MODEL,
      transcript,
      sheets,
      title,
      end,
    });
    result = { scenes, visual: sheets.length > 0 };
  }

  const plan = buildPlan(result.scenes, cues, end);
  plan.title = title || '';
  plan.visual = !!result.visual;
  plan.shared = !!server;
  await chrome.storage.local.set({ [cacheKey]: plan });
  return plan;
}

// ---------- Season look-ahead ----------
// 1. Get (or build) the season map on the server: which moments in each episode
//    set up later episodes. Building it needs every episode's dialogue.
// 2. Re-plan this episode with those notes, so setups for later payoffs are kept.
async function analyzeSeason({ movieId, track, title, frameUrls = [], season }) {
  const cacheKey = `plan:${movieId}`;
  const stored = await chrome.storage.local.get([cacheKey, 'serverUrl', 'useOwnKey']);
  const server = stored.useOwnKey ? '' : String(stored.serverUrl || DEFAULT_SERVER).trim().replace(/\/+$/, '');
  if (!server) throw new Error('season look-ahead needs the Plot Only server');
  const cached = stored[cacheKey];
  if (cached && cached.v === PLAN_VERSION && cached.season && (cached.visual || !frameUrls.length)) return cached;
  if (!season || !season.seasonId || !Array.isArray(season.episodes) || season.episodes.length < 2) {
    throw new Error('not a multi-episode season');
  }

  // Season map: reuse the server's if it covers this season's episodes.
  let map = null;
  try {
    const r = await fetch(`${server}/v1/season/${season.seasonId}`);
    if (r.ok) map = await r.json();
  } catch (_) {}
  // A cached map is reusable only if it was built from this season's full episode list.
  const wanted = season.episodes.filter((e) => e.trackUrl).map((e) => String(e.movieId)).sort().join(',');
  if (!map || !Array.isArray(map.episodeIds) || map.episodeIds.slice().sort().join(',') !== wanted) map = null;

  if (!map) {
    const eps = await Promise.all(
      season.episodes.map(async (e) => {
        if (!e.trackUrl) return null;
        try {
          const res = await fetch(e.trackUrl);
          if (!res.ok) return null;
          const transcript = buildTranscript(parseSubtitles(await res.text()));
          if (transcript.length < 200) return null;
          return { movieId: String(e.movieId), seq: e.seq, title: e.title || '', transcript, hash: await sha256Hex(transcript) };
        } catch (_) {
          return null;
        }
      })
    );
    const got = eps.filter(Boolean);
    if (got.length < 2) throw new Error("couldn't load the other episodes' dialogue");
    const res = await fetch(`${server}/v1/season`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ seasonId: String(season.seasonId), show: season.show || '', episodes: got }),
    });
    map = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(map.error || `server error (HTTP ${res.status})`);
  }

  // Re-plan this episode with the season notes.
  const [subRes, frames] = await Promise.all([fetch(track.url), loadFrames(frameUrls)]);
  if (!subRes.ok) throw new Error(`couldn't download subtitles (HTTP ${subRes.status})`);
  const cues = parseSubtitles(await subRes.text());
  const lastFrame = frames.length ? frames[frames.length - 1].time : 0;
  const end = Math.ceil(Math.max(cues.length ? cues[cues.length - 1].end : 0, lastFrame));
  const transcript = buildTranscript(cues);
  const result = await viaServer({ server, movieId, title, end, transcript, frames, seasonId: season.seasonId, seasonKey: map.key });

  const plan = buildPlan(result.scenes, cues, end);
  plan.title = title || '';
  plan.visual = !!result.visual;
  plan.shared = true;
  plan.season = !!result.season;
  await chrome.storage.local.set({ [cacheKey]: plan });
  return plan;
}

// Ask the shared server: first just check its cache (cheap, no frames sent),
// and only upload frames + dialogue if nobody has analyzed this title yet.
async function viaServer({ server, movieId, title, end, transcript, frames, seasonId = '', seasonKey = '' }) {
  const hash = await sha256Hex(transcript);
  const wantVisual = frames.length > 0;
  try {
    const r = await fetch(`${server}/v1/plan/${movieId}?h=${hash}${seasonKey ? `&s=${seasonKey}` : ''}`);
    if (r.ok) {
      const hit = await r.json();
      if (hit && Array.isArray(hit.scenes) && (hit.visual || !wantVisual)) return hit;
    }
  } catch (_) {
    // Server unreachable for the cache check; the POST below reports a clear error.
  }
  const sheets = wantVisual ? await buildContactSheets(frames) : [];
  let res;
  try {
    res = await fetch(`${server}/v1/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ movieId: String(movieId), hash, title: title || '', end, transcript, sheets, seasonId: String(seasonId || ''), seasonKey }),
    });
  } catch (_) {
    throw new Error("couldn't reach the Plot Only server");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `server error (HTTP ${res.status})`);
  if (!Array.isArray(data.scenes)) throw new Error('server sent an empty plan');
  return data;
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------- Subtitle parsing ----------

function parseSubtitles(text) {
  const cues = /^\uFEFF?\s*WEBVTT/.test(text) ? parseVtt(text) : parseTtml(text);
  cues.sort((a, b) => a.start - b.start);
  // Drop exact duplicates (TTML sometimes repeats lines for positioning).
  return cues.filter((c, i) => i === 0 || !(c.start === cues[i - 1].start && c.text === cues[i - 1].text));
}

function parseVtt(text) {
  const cues = [];
  for (const block of text.replace(/\r/g, '').split(/\n\s*\n/)) {
    const lines = block.split('\n');
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const [a, b] = lines[i].split('-->').map((s) => s.trim().split(/\s+/)[0]);
    const txt = cleanText(lines.slice(i + 1).join(' '));
    if (txt) cues.push({ start: clockToSec(a), end: clockToSec(b), text: txt });
  }
  return cues;
}

function parseTtml(text) {
  const tickRate = Number((text.match(/tickRate="(\d+)"/) || [])[1]) || 10000000;
  const frameRate = Number((text.match(/frameRate="(\d+)"/) || [])[1]) || 30;
  const cues = [];
  const re = /<(?:\w+:)?p\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?p>/g;
  let m;
  while ((m = re.exec(text))) {
    const begin = (m[1].match(/\bbegin="([^"]+)"/) || [])[1];
    const end = (m[1].match(/\bend="([^"]+)"/) || [])[1];
    if (!begin || !end) continue;
    const txt = cleanText(m[2].replace(/<(?:\w+:)?br\s*\/?>/g, ' '));
    if (txt) cues.push({ start: ttmlTime(begin, tickRate, frameRate), end: ttmlTime(end, tickRate, frameRate), text: txt });
  }
  return cues;
}

function ttmlTime(s, tickRate, frameRate) {
  if (/^[\d.]+t$/.test(s)) return Number(s.slice(0, -1)) / tickRate;
  if (/^[\d.]+ms$/.test(s)) return Number(s.slice(0, -2)) / 1000;
  if (/^[\d.]+s$/.test(s)) return Number(s.slice(0, -1));
  const p = s.split(':').map(Number);
  if (p.length === 4) return p[0] * 3600 + p[1] * 60 + p[2] + p[3] / frameRate;
  return clockToSec(s);
}

function clockToSec(s) {
  const p = s.split(':').map(Number);
  if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
  if (p.length === 2) return p[0] * 60 + p[1];
  return Number(s) || 0;
}

function cleanText(s) {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&(?:#39|apos);/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------- Prompt input ----------

// Compact transcript: merge nearby cues into lines, mark long silences.
function buildTranscript(cues) {
  const lines = [];
  let cur = null;
  let lastEnd = 0;
  const flush = () => {
    if (cur) lines.push(`[${Math.floor(cur.start)}] ${cur.text}`);
    cur = null;
  };
  for (const c of cues) {
    if (c.start - lastEnd >= 20) {
      flush();
      lines.push(`[${Math.floor(lastEnd)}] (no dialogue for ${Math.round(c.start - lastEnd)}s)`);
    }
    if (cur && c.start - cur.end < 1.5 && c.end - cur.start < 20) {
      cur.text += ' ' + c.text;
      cur.end = c.end;
    } else {
      flush();
      cur = { start: c.start, end: c.end, text: c.text };
    }
    lastEnd = Math.max(lastEnd, c.end);
  }
  flush();
  return lines.join('\n');
}

// ---------- Frames (scrub thumbnails) ----------

// Try each thumbnail archive until one decodes; returns [{ time, blob }] or [].
async function loadFrames(urls) {
  for (const url of [...urls].reverse()) { // later entries tend to be higher resolution
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const frames = parseBif(await res.arrayBuffer());
      if (frames.length >= 10) return frames;
    } catch (_) {}
  }
  return [];
}

// BIF ("Base Index Frames"): 64-byte header, an index of (timestamp, offset) pairs,
// then JPEG images back to back.
function parseBif(buf) {
  const dv = new DataView(buf);
  const magic = [0x89, 0x42, 0x49, 0x46, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buf.byteLength < 64 || magic.some((b, i) => dv.getUint8(i) !== b)) return [];
  const count = dv.getUint32(12, true);
  const multiplier = dv.getUint32(16, true) || 1000; // ms per timestamp unit
  const frames = [];
  for (let i = 0; i < count; i++) {
    const base = 64 + i * 8;
    if (base + 16 > buf.byteLength) break;
    const ts = dv.getUint32(base, true);
    const offset = dv.getUint32(base + 4, true);
    const next = dv.getUint32(base + 12, true);
    if (ts === 0xffffffff || next <= offset || next > buf.byteLength) continue;
    frames.push({ time: (ts * multiplier) / 1000, blob: new Blob([buf.slice(offset, next)], { type: 'image/jpeg' }) });
  }
  return frames;
}

// Tile frames into timestamped grids so the model sees the whole episode in ~20 images.
async function buildContactSheets(frames) {
  const step = Math.max(1, Math.ceil(frames.length / MAX_FRAMES));
  const picked = frames.filter((_, i) => i % step === 0);
  const perSheet = SHEET_COLS * SHEET_ROWS;
  const sheets = [];

  for (let s = 0; s < picked.length; s += perSheet) {
    const batch = picked.slice(s, s + perSheet);
    const bitmaps = await Promise.all(batch.map((f) => createImageBitmap(f.blob).catch(() => null)));
    const first = bitmaps.find(Boolean);
    if (!first) continue;
    const cellH = Math.round((CELL_W * first.height) / first.width);
    const canvas = new OffscreenCanvas(CELL_W * SHEET_COLS, cellH * Math.ceil(batch.length / SHEET_COLS));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.font = 'bold 18px sans-serif';
    ctx.textBaseline = 'top';

    batch.forEach((f, i) => {
      const x = (i % SHEET_COLS) * CELL_W;
      const y = Math.floor(i / SHEET_COLS) * cellH;
      if (bitmaps[i]) ctx.drawImage(bitmaps[i], x, y, CELL_W, cellH);
      const label = `${Math.round(f.time)}s`;
      ctx.fillStyle = 'rgba(0,0,0,0.75)';
      ctx.fillRect(x + 4, y + 4, ctx.measureText(label).width + 10, 24);
      ctx.fillStyle = '#ffeb3b';
      ctx.fillText(label, x + 9, y + 7);
      ctx.strokeStyle = '#000';
      ctx.strokeRect(x, y, CELL_W, cellH);
    });
    bitmaps.forEach((b) => b && b.close());

    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
    sheets.push({
      from: Math.round(batch[0].time),
      to: Math.round(batch[batch.length - 1].time),
      data: await blobToBase64(blob),
    });
  }
  return sheets;
}

async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function askClaude({ apiKey, model, transcript, sheets = [], title, end }) {
  const content = [];
  if (sheets.length) {
    content.push({ type: 'text', text: `CONTACT SHEETS (${sheets.length}), in time order. Each frame is labeled with its time in seconds.` });
    for (const sh of sheets) {
      content.push({ type: 'text', text: `Frames ${sh.from}s–${sh.to}s:` });
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: sh.data } });
    }
  }
  content.push({
    type: 'text',
    text:
      (title ? `Title: ${title}\n` : '') +
      `END = ${end} seconds.\n\nSUBTITLES ([seconds] text):\n${transcript || '(no subtitles available)'}` +
      (sheets.length ? '' : '\n\n(No frames available for this title — judge from dialogue only.)'),
  });

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model,
      max_tokens: 8000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content }],
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Claude API: ${(data.error && data.error.message) || `HTTP ${res.status}`}`);

  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  let parsed;
  try {
    parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  } catch (_) {
    throw new Error("couldn't read the scene plan");
  }
  if (!parsed || !Array.isArray(parsed.scenes) || !parsed.scenes.length) throw new Error('empty scene plan');
  return parsed.scenes;
}

// ---------- Plan ----------

function buildPlan(scenes, cues, end) {
  const clean = scenes
    .map((s) => ({
      start: Math.max(0, Number(s.start)),
      end: Math.min(end, Number(s.end)),
      keep: s.keep !== false,
      label: String(s.label || '').slice(0, 80),
      why: String(s.why || '').slice(0, 100),
    }))
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
    .sort((a, b) => a.start - b.start);

  // Merge back-to-back skipped scenes into one jump.
  const merged = [];
  for (const s of clean) {
    if (s.keep) continue;
    const last = merged[merged.length - 1];
    if (last && s.start - last.end <= 2) {
      last.end = Math.max(last.end, s.end);
      last.parts.push({ label: s.label, why: s.why });
    } else merged.push({ start: s.start, end: s.end, label: s.label, why: s.why, parts: [{ label: s.label, why: s.why }] });
  }

  const skips = merged
    .map((s) => snapToDialogue(s, cues))
    .filter((s) => s.end - s.start >= MIN_SKIP_SEC)
    .map((s) => ({
      start: s.start,
      end: s.end,
      label: s.parts.map((p) => p.label).filter(Boolean).join(' + ') || s.label,
      why: s.parts.length > 1 ? s.parts.map((p) => p.why).filter(Boolean)[0] || '' : s.why,
    }));
  const skippedSec = skips.reduce((n, s) => n + (s.end - s.start), 0);
  // Kept scenes, for the panel's scene-by-scene list.
  const kept = clean.filter((s) => s.keep).map((s) => ({ start: s.start, end: s.end, label: s.label, why: s.why }));
  return { v: PLAN_VERSION, skips, kept, totalSec: end, skippedSec, createdAt: Date.now() };
}

// Avoid cutting a line mid-sentence and land just before the next kept line.
function snapToDialogue(s, cues) {
  let { start, end } = s;
  const inProgress = cues.find((c) => c.start < start && c.end > start);
  if (inProgress && inProgress.end - start < 5) start = inProgress.end;
  const next = cues.find((c) => c.start >= end - 3);
  if (next && next.start - end <= 5) end = Math.max(start, next.start - 0.4);
  return { ...s, start, end };
}

// Exposed for tests (no effect in the extension).
if (typeof module !== 'undefined') module.exports = { parseSubtitles, buildTranscript, buildPlan, parseBif, analyze, analyzeSeason, SYSTEM_PROMPT, sha256Hex };
