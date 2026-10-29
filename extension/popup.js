const $ = (id) => document.getElementById(id);
const DEFAULT_MODEL = 'claude-sonnet-5-5';
const SERVER = 'https://plot-only-api.riteshpgiri.workers.dev';
// Your Buy Me a Coffee page. The button stays hidden while this is empty.
const TIP_URL = 'https://buymeacoffee.com/riteshgiri';

if (TIP_URL) {
  $('tip').href = TIP_URL;
  $('tip').classList.add('show');
  $('tipnote').classList.add('show');
}

function flash(text) {
  $('msg').textContent = text;
  setTimeout(() => ($('msg').textContent = ''), 2500);
}

async function showStatus() {
  const s = await chrome.storage.local.get(['useOwnKey', 'apiKey', 'serverUrl']);
  const dot = $('dot');
  dot.className = 'dot';
  if (s.useOwnKey) {
    const ok = !!s.apiKey;
    dot.classList.add(ok ? 'ok' : 'bad');
    $('status').textContent = ok ? 'Using your own API key' : 'Add your API key under Advanced';
    return;
  }
  try {
    const r = await fetch(`${(s.serverUrl || SERVER).replace(/\/+$/, '')}/health`);
    const ok = r.ok;
    dot.classList.add(ok ? 'ok' : 'bad');
    $('status').textContent = ok ? 'Connected' : 'Server is having trouble, try later';
  } catch (_) {
    dot.classList.add('bad');
    $('status').textContent = "Can't reach the server";
  }
}

(async () => {
  const s = await chrome.storage.local.get(['apiKey', 'model', 'enabled', 'useOwnKey']);
  $('key').value = s.apiKey || '';
  $('model').value = s.model || DEFAULT_MODEL;
  $('enabled').checked = s.enabled !== false;
  $('ownKey').checked = !!s.useOwnKey;
  if (s.useOwnKey) $('adv').open = true;
  showStatus();
})();

$('enabled').addEventListener('change', (e) => chrome.storage.local.set({ enabled: e.target.checked }));

$('ownKey').addEventListener('change', async (e) => {
  await chrome.storage.local.set({ useOwnKey: e.target.checked });
  showStatus();
});

$('save').addEventListener('click', async () => {
  await chrome.storage.local.set({
    apiKey: $('key').value.trim(),
    model: $('model').value.trim() || DEFAULT_MODEL,
  });
  flash('Saved');
  showStatus();
});

$('clear').addEventListener('click', async () => {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith('plan:'));
  await chrome.storage.local.remove(keys);
  flash(`Cleared ${keys.length} saved plan${keys.length === 1 ? '' : 's'}`);
});
