// Plot Only for Netflix — relays messages between the page script (inject.js)
// and the extension's background worker, and keeps the on/off setting.
const PAGE = 'plot-only-page';
const BRIDGE = 'plot-only-bridge';

const toPage = (msg) => window.postMessage({ ...msg, source: BRIDGE }, '*');

async function sendState() {
  const { enabled = true } = await chrome.storage.local.get('enabled');
  toPage({ type: 'STATE', enabled });
}

window.addEventListener('message', async (e) => {
  if (e.source !== window || !e.data || e.data.source !== PAGE) return;
  const m = e.data;

  if (m.type === 'GET_STATE') return sendState();

  if (m.type === 'SET_ENABLED') {
    await chrome.storage.local.set({ enabled: !!m.enabled });
    return; // storage.onChanged below pushes the new state
  }

  if (m.type === 'ANALYZE_SEASON') {
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'ANALYZE_SEASON',
        movieId: m.movieId,
        track: m.track,
        frameUrls: m.frameUrls || [],
        title: m.title,
        season: m.season,
      });
      if (res && res.ok) toPage({ type: 'SEASON_PLAN', movieId: m.movieId, plan: res.plan });
      else toPage({ type: 'SEASON_ERROR', movieId: m.movieId, error: (res && res.error) || 'Something went wrong' });
    } catch (err) {
      toPage({ type: 'SEASON_ERROR', movieId: m.movieId, error: String((err && err.message) || err) });
    }
    return;
  }

  if (m.type === 'ANALYZE') {
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'ANALYZE',
        movieId: m.movieId,
        track: m.track,
        frameUrls: m.frameUrls || [],
        title: m.title,
      });
      if (res && res.ok) toPage({ type: 'PLAN', movieId: m.movieId, plan: res.plan });
      else toPage({ type: 'ERROR', movieId: m.movieId, error: (res && res.error) || 'Something went wrong' });
    } catch (err) {
      toPage({ type: 'ERROR', movieId: m.movieId, error: String((err && err.message) || err) });
    }
  }
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.enabled) sendState();
});

sendState();
