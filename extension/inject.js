// Plot Only for Netflix — runs inside Netflix's own page context.
// 1. Captures subtitle tracks and scene thumbnails from Netflix's playback manifest.
// 2. Asks the extension (via bridge.js) for a "plot only" plan for the current title.
// 3. Skips non-essential scenes using Netflix's own player API.
(() => {
  if (window.__plotOnlyLoaded) return;
  window.__plotOnlyLoaded = true;

  const PAGE = 'plot-only-page';
  const BRIDGE = 'plot-only-bridge';
  // Subtitle profiles we prefer, best first. WebVTT is the easiest to parse.
  const PROFILES = ['webvtt-lssdh-ios8', 'dfxp-ls-sdh', 'simplesdh', 'imsc1.1'];
  const FRAME_WAIT_MS = 8000; // how long to wait for thumbnails before going dialogue-only

  const tracks = {};          // movieId -> { url, language, seenAt }
  const frameUrls = {};       // movieId -> [scene-thumbnail urls], smallest first
  const manifestsSeen = {};   // movieId -> number of manifests seen
  const durations = {};      // movieId -> real runtime in seconds (from Netflix's manifest)
  const hydrateTries = {};    // movieId -> attempts to make Netflix load a subtitle track
  let hydrating = null;       // { id, prev, at } while we've temporarily switched subtitles on
  let enabled = null;         // null until the bridge tells us the saved setting
  let plan = null;            // { movieId, skips: [{start, end, label}], totalSec, skippedSec, visual }
  let requestedFor = null;    // movieId we've already asked a plan for
  let status = '';
  let isError = false;
  const overridden = new Set(); // skip indexes the user deliberately seeked back into
  let ourSeekUntil = 0;
  let lastRender = 0;
  const seasonState = {};      // movieId -> 'loading' | 'done' | 'failed'
  const watchedVideos = new WeakSet();

  const post = (msg) => window.postMessage({ ...msg, source: PAGE }, '*');
  const log = (...a) => console.debug('[PlotOnly]', ...a);

  // ---------- 1. Hook Netflix's manifest traffic ----------

  // Ask Netflix to include subtitle formats we can read.
  const origStringify = JSON.stringify;
  JSON.stringify = function (value) {
    try {
      const params = value && value.params;
      if (params && Array.isArray(params.profiles)) {
        for (const p of PROFILES.slice(0, 2)) {
          if (!params.profiles.includes(p)) params.profiles.push(p);
        }
      }
    } catch (_) {}
    return origStringify.apply(this, arguments);
  };

  // Netflix batches its responses (e.g. { RESPONSES: [ ... ] }), so instead of
  // expecting the manifest at a fixed spot, look inside anything that mentions
  // subtitle tracks.
  const origParse = JSON.parse;
  JSON.parse = function (text) {
    const value = origParse.apply(this, arguments);
    try {
      if (typeof text === 'string' && text.includes('timedtexttracks')) {
        for (const m of findManifests(value)) handleManifest(m);
      }
    } catch (e) {
      log('manifest read failed', e);
    }
    return value;
  };

  function findManifests(obj, out = [], depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 7) return out;
    if (Array.isArray(obj.timedtexttracks)) {
      out.push(obj);
      return out;
    }
    for (const k in obj) {
      const v = obj[k];
      if (v && typeof v === 'object') findManifests(v, out, depth + 1);
    }
    return out;
  }

  function handleManifest(m) {
    const raw = m.movieId || m.viewableId || m.movie_id || currentMovieId();
    if (!raw) return;
    const id = String(raw);
    manifestsSeen[id] = (manifestsSeen[id] || 0) + 1;
    if (Number(m.duration) > 0) durations[id] = Number(m.duration) / 1000; // ms -> s
    log('manifest', id, `${m.timedtexttracks.length} text tracks`, `${(m.trickplays || []).length} trickplay`);
    captureTracks(id, m);
    captureTrickplay(id, m);
  }

  function urlOf(u) {
    if (!u) return null;
    if (typeof u === 'string') return u;
    return u.url || null;
  }

  function pickUrl(dl) {
    if (!dl) return null;
    if (Array.isArray(dl.urls) && dl.urls.length) return urlOf(dl.urls[0]);
    if (dl.downloadUrls) {
      const urls = Object.values(dl.downloadUrls);
      if (urls.length) return urlOf(urls[0]);
    }
    return null;
  }

  const langOf = (t) => String(t.language || t.bcp47 || '');
  const subScore = (t) =>
    (langOf(t).startsWith('en') ? 10 : 0) + (t.rawTrackType === 'closedcaptions' || t.isCC ? 2 : 0);

  function captureTracks(id, m) {
    // Tracks marked hydrated:false have no download links yet; Netflix only
    // fills those in once a track is selected.
    const candidates = m.timedtexttracks
      .filter((t) => t && !t.isNoneTrack && !t.isForcedNarrative && t.hydrated !== false && t.ttDownloadables)
      .sort((a, b) => subScore(b) - subScore(a));

    for (const t of candidates) {
      for (const profile of PROFILES) {
        const url = pickUrl(t.ttDownloadables[profile]);
        if (url) return saveTrack(id, url, langOf(t));
      }
      for (const dl of Object.values(t.ttDownloadables)) {
        const url = pickUrl(dl);
        if (url) return saveTrack(id, url, langOf(t));
      }
    }
    log('no loaded subtitle track yet for', id);
  }

  function saveTrack(id, url, language) {
    // Keep an English track once we have one; don't let a later non-English one replace it.
    if (tracks[id] && (tracks[id].url === url || (tracks[id].language.startsWith('en') && !language.startsWith('en')))) return;
    tracks[id] = { url, language, seenAt: Date.now() };
    log('subtitles captured', id, language);
    if (hydrating && hydrating.id === id) restoreSubtitles();
    maybeAnalyze();
  }

  // Scene thumbnails: the stills Netflix shows when you scrub the timeline. The
  // video itself is DRM-protected, but these aren't, so they're how we "see" scenes.
  function captureTrickplay(id, m) {
    const list = (m.trickplays || [])
      .filter((t) => t && Array.isArray(t.urls) && t.urls.length)
      .sort((a, b) => (a.size || a.width || 0) - (b.size || b.width || 0));
    for (const t of list) addFrameUrl(id, urlOf(t.urls[0]));
  }

  function addFrameUrl(movieId, url) {
    if (!movieId || !url) return;
    const list = (frameUrls[movieId] = frameUrls[movieId] || []);
    if (list.includes(url)) return;
    list.push(url);
    // A dialogue-only plan exists but now we can see the scenes: redo it with visuals.
    if (plan && plan.movieId === movieId && !plan.visual && requestedFor === movieId) {
      requestedFor = null;
      maybeAnalyze();
    }
  }

  // Netflix no longer always hands the manifest through JSON.parse on this page,
  // but the player keeps it in memory. Read it from there (checked every tick).
  const lastPlayerRead = {};
  function readManifestFromPlayer(id) {
    if (Date.now() - (lastPlayerRead[id] || 0) < 2000) return;
    lastPlayerRead[id] = Date.now();
    try {
      const p = getPlayer();
      const ip = p && typeof p.getInternalPlayer === 'function' ? p.getInternalPlayer() : null;
      const map = ip && ip.playback && ip.playback.playbackViewablesDataByMovieId;
      if (!map || typeof map.get !== 'function') return;
      const entry = map.get(Number(id)) || map.get(id);
      const mr = entry && entry.manifest && entry.manifest.manifestResult;
      if (mr && Array.isArray(mr.timedtexttracks)) handleManifest(mr);
    } catch (e) {
      log('reading manifest from player failed', e);
    }
  }

  // ---------- 1b. Make Netflix load a subtitle track if none is loaded ----------
  // If you watch with subtitles off, Netflix may never download any. We briefly
  // switch English subtitles on (which makes Netflix fetch them), grab the link,
  // then switch back to whatever you had.

  function tryHydrate(id) {
    if (tracks[id] || hydrating || (hydrateTries[id] || 0) >= 2) return;
    const p = getPlayer();
    if (!p || typeof p.getTimedTextTrackList !== 'function' || typeof p.setTimedTextTrack !== 'function') return;
    const list = (p.getTimedTextTrackList() || []).filter(
      (t) => t && !t.isNoneTrack && !t.isForcedNarrative && !/^off$/i.test(String(t.displayName || ''))
    );
    if (!list.length) return;
    const pick = list.sort((a, b) => subScore(b) - subScore(a))[0];
    hydrateTries[id] = (hydrateTries[id] || 0) + 1;
    hydrating = { id, prev: typeof p.getTimedTextTrack === 'function' ? p.getTimedTextTrack() : null, at: Date.now() };
    log('asking Netflix to load subtitles', langOf(pick) || pick.displayName);
    try {
      p.setTimedTextTrack(pick);
    } catch (e) {
      log('could not switch subtitles', e);
      hydrating = null;
    }
  }

  function restoreSubtitles() {
    const h = hydrating;
    hydrating = null;
    if (!h) return;
    const p = getPlayer();
    try {
      if (p && h.prev) p.setTimedTextTrack(h.prev);
    } catch (_) {}
  }

  // ---------- 2. Ask for a plan ----------

  const currentMovieId = () => {
    const m = location.pathname.match(/^\/watch\/(\d+)/);
    return m ? m[1] : null;
  };

  const getTitle = () => {
    const el = document.querySelector('[data-uia="video-title"]');
    return el ? el.innerText.replace(/\s+/g, ' ').trim() : '';
  };

  function maybeAnalyze() {
    const id = currentMovieId();
    if (!id || enabled !== true) return;
    if (requestedFor === id) return;
    if (plan && plan.movieId === id && (plan.visual || !(frameUrls[id] || []).length)) return;
    if (!tracks[id] || !(frameUrls[id] || []).length) readManifestFromPlayer(id);
    const track = tracks[id];
    if (!track) {
      if (document.querySelector('video') && manifestsSeen[id]) tryHydrate(id);
      setStatus(manifestsSeen[id] ? 'loading subtitles…' : 'waiting for subtitles…');
      return;
    }
    const frames = frameUrls[id] || [];
    if (!frames.length && Date.now() - track.seenAt < FRAME_WAIT_MS) {
      setStatus('gathering scenes…');
      return;
    }
    requestedFor = id;
    if (!plan || plan.movieId !== id) setStatus(frames.length ? 'watching the episode…' : 'reading the dialogue…');
    post({ type: 'ANALYZE', movieId: id, track: { url: track.url, language: track.language }, frameUrls: frames, title: getTitle() });
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.source !== BRIDGE) return;
    const m = e.data;
    if (m.type === 'STATE') {
      enabled = !!m.enabled;
      render();
      maybeAnalyze();
    } else if (m.type === 'PLAN' && m.movieId === currentMovieId()) {
      plan = { ...m.plan, movieId: m.movieId };
      overridden.clear();
      isError = false;
      render();
      if (plan.shared && !plan.season) startSeason(m.movieId);
    } else if (m.type === 'ERROR' && m.movieId === currentMovieId()) {
      setStatus(`⚠ ${m.error}`, true);
    } else if (m.type === 'SEASON_PLAN') {
      seasonState[m.movieId] = 'done';
      if (m.movieId === currentMovieId()) {
        // Keep "watch anyway" choices only if the cuts didn't change.
        plan = { ...m.plan, movieId: m.movieId };
        overridden.clear();
        panelKey = '';
        toast('Updated with the whole season in mind');
      }
      render();
    } else if (m.type === 'SEASON_ERROR') {
      log('season look-ahead failed:', m.error);
      seasonState[m.movieId] = 'failed';
      render();
    }
  });
  post({ type: 'GET_STATE' });

  // ---------- 2b. Season look-ahead ----------
  // After the episode's own plan is in, read the whole season so setups that pay
  // off in later episodes are kept. Runs in the background; the current plan keeps
  // working meanwhile and is swapped for the season-aware one when it's ready.

  async function getSeasonInfo(id) {
    const res = await fetch(`/nq/website/memberapi/release/metadata?movieid=${id}`, { credentials: 'include' });
    if (!res.ok) return null;
    const v = ((await res.json()) || {}).video || {};
    if (v.type !== 'show' || !Array.isArray(v.seasons)) return null;
    for (const se of v.seasons) {
      const eps = se.episodes || [];
      if (eps.some((e) => String(e.id || e.episodeId) === String(id))) {
        return {
          seasonId: String(se.id),
          show: String(v.title || ''),
          seasonTitle: String(se.title || ''),
          episodes: eps.map((e) => ({ movieId: String(e.id || e.episodeId), seq: Number(e.seq) || 0, title: String(e.title || '') })),
        };
      }
    }
    return null;
  }

  async function startSeason(id) {
    if (seasonState[id]) return;
    seasonState[id] = 'loading';
    render();
    try {
      const season = await getSeasonInfo(id);
      if (!season || season.episodes.length < 2) throw new Error('not a series');
      const others = season.episodes.map((e) => e.movieId).filter((m) => m !== id && !tracks[m]);
      if (others.length) await preloadEpisodes(others);
      season.episodes.forEach((e) => {
        if (tracks[e.movieId]) e.trackUrl = tracks[e.movieId].url;
      });
      log('season', season.show, season.seasonTitle, `${season.episodes.filter((e) => e.trackUrl).length}/${season.episodes.length} episodes with subtitles`);
      const track = tracks[id];
      post({ type: 'ANALYZE_SEASON', movieId: id, track: { url: track.url, language: track.language }, frameUrls: frameUrls[id] || [], title: getTitle(), season });
    } catch (e) {
      log('season look-ahead skipped:', e && e.message);
      seasonState[id] = 'failed';
      render();
    }
  }

  // Ask Netflix's player to preload other episodes; their manifests (with subtitle
  // links) then arrive through the same capture as the current episode's.
  async function preloadEpisodes(ids) {
    const started = netflixPrepare(ids);
    if (!started) throw new Error('preload not available');
    const until = Date.now() + 45000;
    while (Date.now() < until && ids.some((m) => !tracks[m])) {
      ids.forEach((m) => readManifestFromCache(m));
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  // Netflix's player keeps a "video preparer" that prefetches other titles.
  // We queue ONLY its manifest step (subtitle + thumbnail links), never the
  // license or video prefetch, so no DRM or video traffic is added.
  function getPreparer() {
    try {
      const p = getPlayer();
      const ip = p && typeof p.getInternalPlayer === 'function' ? p.getInternalPlayer() : null;
      const prep = ip && ip.playback && ip.playback.videoPreparer;
      return prep && typeof prep.getCachedData === 'function' ? prep : null;
    } catch (_) {
      return null;
    }
  }

  function netflixPrepare(ids) {
    const prep = getPreparer();
    if (!prep || typeof prep.createManifestTask !== 'function' || !prep.taskScheduler) return false;
    const tasks = [];
    for (const id of ids) {
      try {
        const item = { movieId: Number(id), params: { authParams: { pinCapableClient: false }, trackingId: 0 } };
        const task = prep.createManifestTask(item, undefined);
        if (task) tasks.push(task);
      } catch (e) {
        log('could not queue manifest for', id, e);
      }
    }
    try {
      if (tasks.length) prep.taskScheduler.addTasks(tasks);
    } catch (e) {
      log('could not start preloading', e);
      return false;
    }
    log(`preloading ${tasks.length} episode manifests`);
    return true;
  }

  const reading = {};
  function readManifestFromCache(id) {
    if (tracks[id] || reading[id]) return;
    const prep = getPreparer();
    if (!prep) return;
    let m;
    try {
      m = prep.getCachedData(Number(id), 'manifest');
    } catch (_) {
      return;
    }
    if (!m) return;
    reading[id] = true;
    Promise.resolve(m)
      .then((v) => {
        const mr = v && (v.manifestResult || v);
        if (mr && Array.isArray(mr.timedtexttracks)) handleManifest({ ...mr, movieId: mr.movieId || id });
      })
      .catch(() => {})
      .finally(() => {
        reading[id] = false;
      });
  }

  // ---------- 3. Skip ----------

  function getPlayer() {
    try {
      const vp = window.netflix.appContext.state.playerApp.getAPI().videoPlayer;
      const ids = vp.getAllPlayerSessionIds();
      const id = ids.find((i) => String(i).startsWith('watch')) || ids[0];
      return id ? vp.getVideoPlayerBySessionId(id) : null;
    } catch (_) {
      return null;
    }
  }

  function currentTime(video) {
    const p = getPlayer();
    try {
      if (p) return p.getCurrentTime() / 1000;
    } catch (_) {}
    return video.currentTime;
  }

  function seekTo(sec) {
    // Setting video.currentTime directly crashes Netflix's player; use its API.
    const p = getPlayer();
    if (!p) return false;
    ourSeekUntil = Date.now() + 1500;
    p.seek(Math.round(sec * 1000));
    return true;
  }

  function watchVideo(video) {
    if (watchedVideos.has(video)) return;
    watchedVideos.add(video);
    // If the user scrubs back into a skipped scene, respect that and let it play.
    video.addEventListener('seeking', () => {
      if (Date.now() < ourSeekUntil || !plan) return;
      const t = video.currentTime;
      plan.skips.forEach((s, i) => {
        if (t >= s.start - 2 && t < s.end) overridden.add(i);
      });
    });
  }

  function tick() {
    const id = currentMovieId();
    if (!id) return hideUI();
    ensureUI();
    if (plan && plan.movieId !== id) {
      plan = null;
      overridden.clear();
      render();
    }
    // Give up on a subtitle switch that didn't produce a track, and put things back.
    if (hydrating && Date.now() - hydrating.at > 12000) restoreSubtitles();
    maybeAnalyze();
    if (panelOpen && Date.now() - lastRender > 1000) render(); // keep the panel's position marker live

    const video = document.querySelector('video');
    if (!video) return;
    watchVideo(video);
    if (!enabled || !plan || Date.now() < ourSeekUntil) return;

    const t = currentTime(video);
    for (let i = 0; i < plan.skips.length; i++) {
      const s = plan.skips[i];
      if (overridden.has(i)) continue;
      if (t >= s.start && t < s.end - 1) {
        if (seekTo(s.end)) toast(`Skipped ${fmtDur(s.end - s.start)}${s.label ? ' · ' + s.label : ''}`);
        break;
      }
    }
  }
  setInterval(tick, 250);

  // Run __plotOnlyDebug() in the DevTools console to see what was captured.
  window.__plotOnlyDebug = () => ({
    movieId: currentMovieId(),
    enabled,
    status,
    manifestsSeen,
    subtitles: Object.fromEntries(Object.entries(tracks).map(([k, v]) => [k, v.language])),
    thumbnailSources: Object.fromEntries(Object.entries(frameUrls).map(([k, v]) => [k, v.length])),
    playerFound: !!getPlayer(),
    plan: plan && { visual: plan.visual, shared: !!plan.shared, season: !!plan.season, skips: plan.skips.length, skippedMin: Math.round(plan.skippedSec / 60) },
    season: seasonState,
  });

  // ---------- UI (no innerHTML / inline styles, to stay clear of Netflix's CSP) ----------

  let root, pill, toggleBtn, statusEl, toastEl, toastTimer;
  let panel, panelTitle, panelSummary, bar, nowMarker, list, panelKey = '';
  let panelOpen = false;
  const rows = [];   // { row, sc }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  const hasPlan = () => !!(plan && plan.movieId === currentMovieId());

  function ensureUI() {
    if (!document.body) return;
    if (!root) {
      root = el('div');
      root.id = 'plot-only-root';
      // Keep clicks inside our UI from reaching Netflix (which would pause/play).
      for (const type of ['click', 'mousedown', 'mouseup', 'dblclick']) root.addEventListener(type, (e) => e.stopPropagation());

      pill = el('div', 'po-pill');
      toggleBtn = el('button', 'po-toggle');
      toggleBtn.title = 'Plot only on/off';
      toggleBtn.addEventListener('click', () => post({ type: 'SET_ENABLED', enabled: !enabled }));
      statusEl = el('span', 'po-status');
      statusEl.addEventListener('click', () => {
        if (isError) {
          isError = false;
          requestedFor = null;
          maybeAnalyze();
          return;
        }
        if (hasPlan() && enabled) {
          panelOpen = !panelOpen;
          render();
        }
      });
      pill.append(toggleBtn, statusEl);

      panel = el('div', 'po-panel');
      const head = el('div', 'po-head');
      panelTitle = el('div', 'po-title');
      panelSummary = el('div', 'po-sub');
      head.append(panelTitle, panelSummary);
      bar = el('div', 'po-bar');
      nowMarker = el('div', 'po-now');
      const legend = el('div', 'po-legend');
      legend.append(el('span', 'po-key po-key-watch', 'Watch'), el('span', 'po-key po-key-skip', 'Skip'), el('span', 'po-key po-key-now', 'You are here'));
      list = el('div', 'po-list');
      const hint = el('div', 'po-hint', 'Click a skipped scene to watch it anyway.');
      panel.append(head, bar, legend, list, hint);

      toastEl = el('div', 'po-toast');
      root.append(pill, panel, toastEl);

      document.addEventListener('click', (e) => {
        if (panelOpen && root && !root.contains(e.target)) {
          panelOpen = false;
          render();
        }
      });
      render();
    }
    // In fullscreen, only the fullscreen element is visible, so live inside it.
    const fs = document.fullscreenElement;
    const host = fs && fs !== document.documentElement ? fs : document.body;
    if (root.parentNode !== host) host.appendChild(root);
    root.classList.remove('po-hidden');
  }

  function hideUI() {
    if (root) root.classList.add('po-hidden');
  }

  function setStatus(text, error = false) {
    if (text === status && error === isError) return;
    status = text;
    isError = error;
    render();
  }

  // The <video> element only reports what's buffered, so use Netflix's own runtime.
  function titleLength() {
    const id = currentMovieId();
    if (durations[id]) return durations[id];
    try {
      const p = getPlayer();
      const d = p && typeof p.getDuration === 'function' ? p.getDuration() / 1000 : 0;
      if (d > 60) return d;
    } catch (_) {}
    return plan.totalSec;
  }

  function render() {
    if (!root) return;
    lastRender = Date.now();
    toggleBtn.classList.toggle('on', !!enabled);
    statusEl.classList.toggle('err', isError && !!enabled);
    const showPlan = enabled && hasPlan();
    statusEl.classList.toggle('po-clickable', !!showPlan);
    let text;
    if (!enabled) text = 'Plot only: off';
    else if (showPlan) {
      const total = titleLength();
      const seasonNote = plan.season ? ' · season-aware' : seasonState[plan.movieId] === 'loading' ? ' · reading the season…' : '';
      text = `Plot only · ${fmtMin(total)} → ${fmtMin(total - plan.skippedSec)}${plan.visual ? '' : ' · dialogue only'}${seasonNote} ${panelOpen ? '▴' : '▾'}`;
    } else text = `Plot only · ${status || 'starting…'}`;
    if (isError && enabled) text += ' (click to retry)';
    statusEl.textContent = text;

    if (!showPlan) panelOpen = false;
    root.classList.toggle('po-open', panelOpen);
    if (panelOpen) renderPanel();
  }

  // Scene-by-scene list: kept scenes (clipped so they don't overlap a skip) and skips, in order.
  function panelScenes() {
    const skips = plan.skips.map((sk, i) => ({ ...sk, kind: 'skip', i }));
    const kept = (plan.kept || []).map((k) => {
      let { start, end } = k;
      for (const sk of plan.skips) {
        if (sk.start <= start && sk.end > start) start = sk.end;
        if (sk.start > start && sk.start < end) end = sk.start;
      }
      return { ...k, start, end, kind: 'watch' };
    }).filter((k) => k.end - k.start >= 5);
    return [...skips, ...kept].sort((a, b) => a.start - b.start);
  }

  function renderPanel() {
    const video = document.querySelector('video');
    const total = titleLength();
    const now = video ? currentTime(video) : 0;
    const key = `${plan.movieId}:${plan.createdAt}:${Math.round(total)}:${[...overridden].join(',')}`;

    if (key !== panelKey) {
      panelKey = key;
      const active = plan.skips.filter((_, i) => !overridden.has(i));
      const saved = active.reduce((n, sk) => n + (sk.end - sk.start), 0);
      panelTitle.textContent = `You'll watch ${fmtMin(total - saved)} of ${fmtMin(total)}`;
      panelSummary.textContent =
        `${active.length} skip${active.length === 1 ? '' : 's'} · saves ${fmtMin(saved)}` +
        (plan.season ? ' · checked against the whole season' : '');

      bar.replaceChildren(nowMarker);
      plan.skips.forEach((sk, i) => {
        const seg = el('div', 'po-seg' + (overridden.has(i) ? ' po-watched' : ''));
        seg.style.left = `${(sk.start / total) * 100}%`;
        seg.style.width = `${Math.max(0.4, ((sk.end - sk.start) / total) * 100)}%`;
        seg.title = `Skip ${fmtClock(sk.start)}–${fmtClock(sk.end)}${sk.label ? ' · ' + sk.label : ''}`;
        bar.append(seg);
      });

      list.replaceChildren();
      rows.length = 0;
      for (const sc of panelScenes()) {
        const isSkip = sc.kind === 'skip';
        const watchingAnyway = isSkip && overridden.has(sc.i);
        const row = el('div', `po-row ${isSkip ? (watchingAnyway ? 'po-anyway' : 'po-skip') : 'po-keep'}`);
        const tag = el('span', 'po-tag', isSkip ? (watchingAnyway ? 'WATCHING' : 'SKIP') : 'WATCH');
        const body = el('div', 'po-body');
        const line = el('div', 'po-line');
        line.append(el('span', 'po-label', sc.label || (isSkip ? 'Non-essential scene' : 'Main story')));
        body.append(line);
        if (sc.why) body.append(el('div', 'po-why', sc.why));
        const meta = el('div', 'po-meta');
        meta.append(el('span', 'po-times', `${fmtClock(sc.start)}–${fmtClock(sc.end)}`), el('span', 'po-dur', fmtDur(sc.end - sc.start)));
        row.append(tag, body, meta);
        if (isSkip) {
          row.title = watchingAnyway ? 'Click to skip this again' : 'Click to watch this scene anyway';
          row.addEventListener('click', () => {
            if (overridden.has(sc.i)) {
              overridden.delete(sc.i);
              toast(`Will skip again: ${fmtClock(sc.start)}–${fmtClock(sc.end)}`);
            } else {
              overridden.add(sc.i);
              seekTo(sc.start);
              toast(`Playing skipped scene from ${fmtClock(sc.start)}`);
            }
            render();
          });
        }
        list.append(row);
        rows.push({ row, sc });
      }
    }

    nowMarker.style.left = `${Math.min(100, (now / total) * 100)}%`;
    for (const { row, sc } of rows) {
      const isNow = now >= sc.start && now < sc.end;
      const isPast = now >= sc.end;
      row.classList.toggle('po-current', isNow);
      row.classList.toggle('po-past', isPast);
    }
  }

  function toast(text) {
    if (!toastEl) return;
    toastEl.textContent = text;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 3000);
  }

  const fmtMin = (sec) => `${Math.max(1, Math.round(sec / 60))}m`;
  const fmtClock = (sec) => {
    const t = Math.max(0, Math.round(sec));
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = String(t % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
  };
  const fmtDur = (sec) => {
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    return m ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
  };
})();
