// Plot Only — shared backend (Cloudflare Worker).
// Holds the Anthropic API key, asks Claude once per title, and caches the
// result so every later viewer gets it instantly and free.
//
// Episode plans
//   GET  /v1/plan/:movieId?h=<sha256 transcript>[&s=<seasonKey>]  -> cached plan or 404
//   POST /v1/plan   { movieId, hash, title, end, transcript, sheets[], seasonId?, seasonKey? }
//
// Season look-ahead (so setups that pay off in later episodes are kept)
//   GET  /v1/season/:seasonId                                      -> cached season map or 404
//   POST /v1/season { seasonId, show, episodes:[{ movieId, seq, title, hash, transcript }] }
//     Pass 1: a detailed beat sheet per episode (cached per episode).
//     Pass 2: one season map: for each episode, which moments set up later payoffs.
//
// Transcript hashes are checked server-side, so a cached plan can't be swapped
// for one built from different dialogue.

const DEFAULT_MODEL = 'claude-sonnet-5-5';
const SERVER_VERSION = '1.2.0';
const CACHE_VERSION = 1;
const MAX_TRANSCRIPT_CHARS = 400_000;
const MAX_SHEETS = 40;
const MAX_SHEET_B64 = 2_000_000;
const MAX_SEASON_EPISODES = 30;

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

const BEATS_PROMPT = `You read the timestamped subtitles of one TV episode and write a detailed beat sheet of everything that happens, in order.

Include:
- Every main-plot and subplot beat (who does what, what is revealed, what is decided).
- SMALL DETAILS that could matter later in the season: objects shown, given, hidden or left somewhere; places and names mentioned with weight; odd or unexplained events; lines that sound planted; secrets; promises; injuries; anything a writer might be setting up.

Use the [seconds] timestamps. Keep each beat short (under 15 words). 30-60 beats.

Respond with one beat per line, in exactly this form, and nothing else:
95 | Boyd finds the road loops back into town
754 | Sara leaves white flowers on the unmarked grave`;

const SEASON_PROMPT = `You get the beat sheets of every episode of one TV season, in order. Find the SETUPS: moments in an episode that pay off, are referenced, or become important in a LATER episode (or later in the same episode). Also note big callbacks to earlier episodes.

For each episode, list the moments a "plot only" edit of that episode must keep so later episodes still make sense. Prefer specific small details (an object, a name, a line) over broad plot, which an editor would keep anyway. Only list real connections you can see in the beat sheets. At most 8 per episode; keep "what" under 12 words and "why" under 15 words.

Respond with ONLY this JSON (spoilers are fine here, this is internal):
{"episodes":[{"movieId":"81573741","protect":[{"t":754,"what":"Sara leaves flowers on the grave","why":"The grave is revealed to be her brother's in episode 7"}]}]}`;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
    try {
      if (url.pathname === '/health') return json({ ok: true, version: SERVER_VERSION });
      if (url.pathname === '/privacy' || url.pathname === '/privacy/') {
        return new Response(PRIVACY_HTML, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
      }

      let m = url.pathname.match(/^\/v1\/plan\/(\d{1,12})$/);
      if (req.method === 'GET' && m) {
        const hash = url.searchParams.get('h') || '';
        const seasonKey = url.searchParams.get('s') || '';
        if (!/^[a-f0-9]{64}$/.test(hash)) return json({ error: 'bad hash' }, 400);
        if (seasonKey && !/^[a-f0-9]{64}$/.test(seasonKey)) return json({ error: 'bad season key' }, 400);
        const hit = await env.PLANS.get(planKey(m[1], hash, seasonKey), 'json');
        return hit ? json({ ...hit, cached: true }) : json({ error: 'not cached' }, 404);
      }
      if (req.method === 'POST' && url.pathname === '/v1/plan') return await planEpisode(req, env);

      m = url.pathname.match(/^\/v1\/season\/(\d{1,12})$/);
      if (req.method === 'GET' && m) {
        const hit = await env.PLANS.get(`season:v${CACHE_VERSION}:${m[1]}`, 'json');
        return hit ? json({ ...hit, cached: true }) : json({ error: 'not cached' }, 404);
      }
      if (req.method === 'POST' && url.pathname === '/v1/season') return await buildSeason(req, env);

      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, e && e.status ? e.status : 500);
    }
  },
};

const PRIVACY_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Plot Only — Privacy Policy</title>
<style>
  :root { --bg:#fbfbfa; --text:#1d1d22; --muted:#5c5c66; --line:#e6e6e2; --accent:#b67600; }
  @media (prefers-color-scheme: dark) { :root { --bg:#141418; --text:#ededf0; --muted:#a3a3ad; --line:#2c2c34; --accent:#ffb020; } }
  body { margin:0; background:var(--bg); color:var(--text); font:16px/1.65 system-ui,-apple-system,"Segoe UI",sans-serif; }
  main { max-width:720px; margin:0 auto; padding:48px 16px 80px; }
  h1 { font-size:30px; line-height:1.2; margin:0 0 6px; }
  .meta { color:var(--muted); font-size:14px; margin-bottom:32px; }
  h2 { font-size:19px; margin:34px 0 8px; }
  p, li { color:var(--text); }
  ul { padding-left:20px; }
  li { margin:6px 0; }
  .note { border-left:3px solid var(--accent); padding:4px 0 4px 14px; color:var(--muted); }
  a { color:var(--accent); }
</style>
</head>
<body>
<main>
  <h1>Plot Only — Privacy Policy</h1>
  <div class="meta">Last updated: October 26, 2026</div>

  <p class="note">Plot Only is a browser extension that skips non-essential scenes while you watch on Netflix in your browser. It has no accounts, no ads, no analytics and no tracking. It only processes what it needs to decide which scenes to skip.</p>

  <h2>What the extension reads in your browser</h2>
  <ul>
    <li><strong>The title you are watching</strong>: its Netflix title ID and name, and for series, the season's episode list.</li>
    <li><strong>Subtitles</strong> (dialogue text with timestamps) for that title, and for series, the other episodes of the same season.</li>
    <li><strong>Preview thumbnails</strong>: the small still images Netflix shows when you scrub the timeline. The extension never captures or records the video itself.</li>
  </ul>
  <p>It does not read your Netflix account details, profile, viewing history, payment information, or anything on other websites.</p>

  <h2>What is sent, and to whom</h2>
  <ul>
    <li>The subtitle text, preview thumbnails and title name are sent to the Plot Only server (<code>plot-only-api.riteshpgiri.workers.dev</code>, hosted on Cloudflare) only when that title has not been analyzed before.</li>
    <li>The server sends them to <strong>Anthropic's Claude API</strong>, which returns a list of scenes to keep or skip. Anthropic processes this data under its commercial terms, which do not permit using it to train models.</li>
    <li>If you turn on <em>Use my own Anthropic API key</em>, this goes directly from your browser to Anthropic instead, and the Plot Only server is not used.</li>
  </ul>

  <h2>What is stored</h2>
  <ul>
    <li><strong>On the server:</strong> the resulting scene plan for each title (scene times, short scene descriptions and keep/skip decisions), short summaries of what happens in each episode, and a fingerprint (hash) of the subtitle text used to verify plans. These are shared between all users so each title is only analyzed once. Subtitle text and thumbnails themselves are not stored.</li>
    <li><strong>For abuse prevention:</strong> a daily count of new analyses per IP address, deleted automatically after about 26 hours. It is not linked to anything else.</li>
    <li><strong>In your browser:</strong> your settings (on/off, and your own API key if you add one) and saved scene plans, using the browser's extension storage. Use <em>Clear saved plans</em> in the extension, or remove the extension, to delete them.</li>
  </ul>

  <h2>What we never do</h2>
  <ul>
    <li>No selling, renting or sharing of data with anyone other than the processing described above.</li>
    <li>No advertising, analytics, cookies or tracking.</li>
    <li>No data is used to build profiles of you or your viewing.</li>
  </ul>

  <h2>Children</h2>
  <p>Plot Only is not directed at children under 13 and does not knowingly collect personal information from them.</p>

  <h2>Changes</h2>
  <p>If this policy changes, the updated version will be posted at this address with a new date.</p>

  <h2>Contact</h2>
  <p>Questions or deletion requests: <a href="mailto:riteshpgiri@gmail.com">riteshpgiri@gmail.com</a></p>

  <p class="meta" style="margin-top:40px">Plot Only is an independent project and is not affiliated with or endorsed by Netflix.</p>
</main>
</body>
</html>`;

// ---------- Episode plan ----------

async function planEpisode(req, env) {
  const body = await req.json().catch(() => null);
  if (!body) return json({ error: 'expected JSON' }, 400);
  const { movieId, hash, title = '', end, transcript = '', sheets = [], seasonId = '', seasonKey = '' } = body;

  if (!/^\d{1,12}$/.test(String(movieId))) return json({ error: 'bad movieId' }, 400);
  if (!/^[a-f0-9]{64}$/.test(String(hash))) return json({ error: 'bad hash' }, 400);
  if (typeof transcript !== 'string' || transcript.length > MAX_TRANSCRIPT_CHARS) return json({ error: 'transcript too large' }, 413);
  if (!Number.isFinite(end) || end <= 0 || end > 6 * 3600) return json({ error: 'bad end' }, 400);
  if (!Array.isArray(sheets) || sheets.length > MAX_SHEETS) return json({ error: 'too many sheets' }, 413);
  for (const sh of sheets) {
    if (!sh || typeof sh.data !== 'string' || sh.data.length > MAX_SHEET_B64 || !/^[A-Za-z0-9+/=]+$/.test(sh.data)) {
      return json({ error: 'bad sheet' }, 400);
    }
  }
  if (seasonId && !/^\d{1,12}$/.test(String(seasonId))) return json({ error: 'bad seasonId' }, 400);
  if ((await sha256Hex(transcript)) !== hash) return json({ error: 'hash does not match transcript' }, 400);

  // Season notes for this episode, if the season map exists and matches.
  let notes = [];
  let usedSeasonKey = '';
  if (seasonId) {
    const season = await env.PLANS.get(`season:v${CACHE_VERSION}:${seasonId}`, 'json');
    if (season && (!seasonKey || season.key === seasonKey)) {
      const ep = (season.episodes || []).find((e) => String(e.movieId) === String(movieId));
      notes = (ep && ep.protect) || [];
      usedSeasonKey = season.key;
    }
  }

  const key = planKey(movieId, hash, usedSeasonKey);
  const hit = await env.PLANS.get(key, 'json');
  const wantVisual = sheets.length > 0;
  if (hit && (hit.visual || !wantVisual)) return json({ ...hit, cached: true });

  await spend(req, env, 1);
  const content = [];
  if (sheets.length) {
    content.push({ type: 'text', text: `CONTACT SHEETS (${sheets.length}), in time order. Each frame is labeled with its time in seconds.` });
    for (const sh of sheets) {
      content.push({ type: 'text', text: `Frames ${Number(sh.from) || 0}s–${Number(sh.to) || 0}s:` });
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: sh.data } });
    }
  }
  const t = String(title).slice(0, 200);
  content.push({
    type: 'text',
    text:
      (t ? `Title: ${t}\n` : '') +
      (notes.length
        ? 'SEASON NOTES — from a reading of the whole season. These moments set up later episodes, so KEEP the scenes that contain them. They may contain spoilers: use them only to decide, and never reveal them in "label" or "why" (say "Sets up something that matters later").\n' +
          notes.map((n) => `- around ${Math.round(Number(n.t) || 0)}s: ${String(n.what).slice(0, 160)} — ${String(n.why || '').slice(0, 200)}`).join('\n') +
          '\n\n'
        : '') +
      `END = ${Math.round(end)} seconds.\n\nSUBTITLES ([seconds] text):\n${transcript || '(no subtitles available)'}` +
      (sheets.length ? '' : '\n\n(No frames available for this title — judge from dialogue only.)'),
  });

  const parsed = await callClaude(env, SYSTEM_PROMPT, content, 8000);
  if (!Array.isArray(parsed.scenes) || !parsed.scenes.length) throw new Error('empty scene plan');
  const scenes = parsed.scenes.slice(0, 400).map((s) => ({
    start: Number(s.start),
    end: Number(s.end),
    keep: s.keep !== false,
    label: String(s.label || '').slice(0, 80),
    why: String(s.why || '').slice(0, 100),
  }));

  const plan = { v: CACHE_VERSION, scenes, visual: wantVisual, season: !!usedSeasonKey, seasonKey: usedSeasonKey, title: t, createdAt: Date.now() };
  await env.PLANS.put(key, JSON.stringify(plan));
  return json({ ...plan, cached: false });
}

// ---------- Season map ----------

async function buildSeason(req, env) {
  const body = await req.json().catch(() => null);
  if (!body) return json({ error: 'expected JSON' }, 400);
  const { seasonId, show = '', episodes } = body;
  if (!/^\d{1,12}$/.test(String(seasonId))) return json({ error: 'bad seasonId' }, 400);
  if (!Array.isArray(episodes) || episodes.length < 2 || episodes.length > MAX_SEASON_EPISODES) return json({ error: 'need 2-30 episodes' }, 400);

  const eps = [];
  for (const e of episodes) {
    if (!e || !/^\d{1,12}$/.test(String(e.movieId)) || !/^[a-f0-9]{64}$/.test(String(e.hash))) return json({ error: 'bad episode' }, 400);
    if (typeof e.transcript !== 'string' || e.transcript.length > MAX_TRANSCRIPT_CHARS) return json({ error: 'episode transcript too large' }, 413);
    if ((await sha256Hex(e.transcript)) !== e.hash) return json({ error: `hash mismatch for ${e.movieId}` }, 400);
    eps.push({ movieId: String(e.movieId), seq: Number(e.seq) || eps.length + 1, title: String(e.title || '').slice(0, 120), hash: e.hash, transcript: e.transcript });
  }
  eps.sort((a, b) => a.seq - b.seq);
  const key = await sha256Hex(eps.map((e) => `${e.movieId}:${e.hash}`).join('|'));

  const existing = await env.PLANS.get(`season:v${CACHE_VERSION}:${seasonId}`, 'json');
  if (existing && existing.key === key) return json({ ...existing, cached: true });

  // Pass 1: beat sheet per episode (cached per episode, built in parallel).
  const missing = [];
  const beats = await Promise.all(
    eps.map(async (e) => {
      const hit = await env.PLANS.get(`beats:v${CACHE_VERSION}:${e.movieId}:${e.hash}`, 'json');
      if (hit) return hit;
      missing.push(e);
      return null;
    })
  );
  await spend(req, env, missing.length + 1);
  await Promise.all(
    eps.map(async (e, i) => {
      if (beats[i]) return;
      const text = await callClaudeText(
        env,
        BEATS_PROMPT,
        [{ type: 'text', text: `${show ? `Show: ${String(show).slice(0, 120)}\n` : ''}Episode ${e.seq}${e.title ? `: ${e.title}` : ''}\n\nSUBTITLES ([seconds] text):\n${e.transcript}` }],
        8000
      );
      const list = parseBeats(text);
      if (list.length < 3) throw new Error(`couldn't read the beat sheet for episode ${e.seq} (${text.length} chars: ${text.slice(0, 80).replace(/\s+/g, ' ')}…)`);
      beats[i] = { beats: list };
      await env.PLANS.put(`beats:v${CACHE_VERSION}:${e.movieId}:${e.hash}`, JSON.stringify(beats[i]));
    })
  );

  // Pass 2: one look across the whole season.
  const sheetText = eps
    .map((e, i) => `=== Episode ${e.seq} (movieId ${e.movieId})${e.title ? ` "${e.title}"` : ''} ===\n` + beats[i].beats.map((b) => `[${b.t}] ${b.what}`).join('\n'))
    .join('\n\n');
  const parsed = await callClaude(env, SEASON_PROMPT, [{ type: 'text', text: `${show ? `Show: ${String(show).slice(0, 120)}\n\n` : ''}${sheetText}` }], 16000);
  const valid = new Set(eps.map((e) => e.movieId));
  const mapEps = (Array.isArray(parsed.episodes) ? parsed.episodes : [])
    .filter((e) => e && valid.has(String(e.movieId)))
    .map((e) => ({
      movieId: String(e.movieId),
      protect: (Array.isArray(e.protect) ? e.protect : []).slice(0, 25).map((p) => ({
        t: Math.round(Number(p.t) || 0),
        what: String(p.what || '').slice(0, 160),
        why: String(p.why || '').slice(0, 200),
      })),
    }));

  const season = { v: CACHE_VERSION, seasonId: String(seasonId), key, show: String(show).slice(0, 120), episodeIds: eps.map((e) => e.movieId), episodes: mapEps, createdAt: Date.now() };
  await env.PLANS.put(`season:v${CACHE_VERSION}:${seasonId}`, JSON.stringify(season));
  return json({ ...season, cached: false });
}

// ---------- Helpers ----------

// Only new Claude calls count against the limits; cache hits are free and unlimited.
async function spend(req, env, calls) {
  if (!env.ANTHROPIC_API_KEY) throw httpError('server is missing its API key', 500);
  const day = new Date().toISOString().slice(0, 10);
  const ip = req.headers.get('cf-connecting-ip') || 'unknown';
  const globalKey = `count:${day}:all`;
  const ipKey = `count:${day}:ip:${ip}`;
  const [g, p] = await Promise.all([env.PLANS.get(globalKey), env.PLANS.get(ipKey)]);
  const gn = Number(g || 0);
  const pn = Number(p || 0);
  if (gn + calls > Number(env.DAILY_NEW_LIMIT || 200)) throw httpError('daily limit reached for new titles, try again tomorrow', 429);
  if (pn + calls > Number(env.PER_IP_DAILY_LIMIT || 40)) throw httpError('you have analyzed a lot of new titles today, try again tomorrow', 429);
  const ttl = { expirationTtl: 60 * 60 * 26 };
  await Promise.all([env.PLANS.put(globalKey, String(gn + calls), ttl), env.PLANS.put(ipKey, String(pn + calls), ttl)]);
}

async function callClaudeText(env, system, content, maxTokens) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: env.MODEL || DEFAULT_MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content }] }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Claude API: ${(data.error && data.error.message) || `HTTP ${res.status}`}`);
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return text;
}

async function callClaude(env, system, content, maxTokens) {
  const text = await callClaudeText(env, system, content, maxTokens);
  const parsed = parseJsonLoose(text);
  if (parsed) return parsed;
  throw new Error(`couldn't read Claude's answer (${text.length} chars: ${text.slice(0, 80).replace(/\s+/g, ' ')}…)`);
}

// "95 | what happens" lines (also accepts "[95] what happens" and "95: ...").
function parseBeats(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const m = line.match(/^\s*[-*]?\s*\[?(\d{1,5})(?:s)?\]?\s*(?:[|:\u2013\u2014-]\s*)?(.{3,})$/);
    if (m) out.push({ t: Number(m[1]), what: m[2].replace(/^["']|["']$/g, '').trim().slice(0, 160) });
  }
  return out.slice(0, 120);
}

// Quote string values Claude sometimes leaves unquoted, e.g. {"what":Boys argue}.
function repairJson(s) {
  return s.replace(/"(what|why|label|title)"\s*:\s*(?!["\d\[{tfn])(.*?)(?=\s*(?:,\s*"[A-Za-z_]+"\s*:|\}))/g, (_, k, v) => `"${k}":${JSON.stringify(v.trim())}`);
}

// Parse the JSON object in Claude's reply. Tolerates code fences / extra text, and
// salvages an answer cut off by the length limit by closing it after the last
// complete item.
function parseJsonLoose(text) {
  return parseJsonLooseRaw(text) || parseJsonLooseRaw(repairJson(text));
}

function parseJsonLooseRaw(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;
  const body = text.slice(start);
  try {
    return JSON.parse(body.slice(0, body.lastIndexOf('}') + 1));
  } catch (_) {}
  for (let cut = body.lastIndexOf('}'); cut > 0; cut = body.lastIndexOf('}', cut - 1)) {
    const head = body.slice(0, cut + 1);
    for (const tail of [']}', ']}]}', '}]}', ']}]}]}']) {
      try {
        return JSON.parse(head + tail);
      } catch (_) {}
    }
    if (body.length - cut > 20000) break;
  }
  return null;
}

const planKey = (movieId, hash, seasonKey = '') => `plan:v${CACHE_VERSION}:${movieId}:${hash}${seasonKey ? ':s:' + seasonKey : ''}`;

function httpError(message, status) {
  const e = new Error(message);
  e.status = status;
  return e;
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function json(obj, status = 200) {
  return cors(new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } }));
}

function cors(res) {
  res.headers.set('access-control-allow-origin', '*');
  res.headers.set('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.headers.set('access-control-allow-headers', 'content-type');
  return res;
}

export { SYSTEM_PROMPT, sha256Hex };
