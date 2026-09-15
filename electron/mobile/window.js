'use strict';
const element = (id) => document.getElementById(id);
let workspace = '';
let state = {};
let busy = false;
let alive = true;
let polling;
let artworkVisible = false;

function updateArtwork() {
  element('remote-artwork').contentWindow?.postMessage({
    type: 'droidex.remote-artwork',
    active: artworkVisible && !document.hidden,
    step: state.pending ? 2 : state.device ? 3 : null,
  }, '*');
}
const artworkObserver = new IntersectionObserver(([entry]) => {
  artworkVisible = entry.isIntersecting;
  updateArtwork();
});
artworkObserver.observe(element('remote-artwork'));
element('remote-artwork').addEventListener('load', updateArtwork);
document.addEventListener('visibilitychange', updateArtwork);

function showError(error) {
  element('error').textContent = error.message || String(error);
  element('error').hidden = false;
}
function render() {
  element('setup').hidden = state.enabled === true;
  element('connection').hidden = state.enabled !== true;
  if (state.addresses) {
    const selected = element('network').value;
    element('network').replaceChildren(...state.addresses.map((address) => {
      const option = document.createElement('option');
      option.value = address;
      option.textContent = address === '127.0.0.1' ? `${address} · Simulator on this Mac only` : address;
      return option;
    }));
    if (state.addresses.includes(selected)) element('network').value = selected;
  }
  element('enable').disabled = busy || !workspace || state.enabling === true;
  element('folder').textContent = workspace || 'Choose a folder…';
  element('workspace').textContent = state.workspace || '';
  element('state').textContent = state.device ? `Connected · ${state.device.name}` : state.pending ? 'Waiting for your approval' : state.code ? 'Ready to pair' : 'Generate a new code';
  const seconds = Math.max(0, Math.ceil(((state.expiresAt || 0) - Date.now()) / 1000));
  element('expiry').textContent = state.device || state.pending ? '' : seconds ? `${seconds}s remaining` : 'Code expired';
  element('copy').hidden = !!state.device || !!state.pending;
  element('copy').disabled = busy || !state.code || seconds === 0;
  element('pending').hidden = !state.pending;
  element('request-name').textContent = state.pending ? `${state.pending.name} wants to connect` : '';
  element('instruction').hidden = !!state.device || !!state.pending;
  element('detail').textContent = state.device ? `${state.models || 0} models available. Keep this computer awake and DROIDEX running.` : 'The code is single-use and includes this computer’s certificate fingerprint. Expired? Disable access, then enable again.';
  for (const id of ['approve', 'deny', 'disable', 'share-guide']) element(id).disabled = busy;
  updateArtwork();
}
async function perform(action) {
  if (busy) return;
  busy = true; render(); element('error').hidden = true;
  try { await action(); await refresh(); } catch (error) { showError(error); }
  finally { busy = false; render(); }
}
async function refresh() { state = await window.mobile.status(); render(); }
element('folder').onclick = () => perform(async () => { workspace = await window.mobile.folder() || workspace; });
element('enable').onclick = () => perform(async () => { await window.mobile.enable(workspace, element('network').value); });
element('copy').onclick = () => perform(async () => { await window.mobile.copy(); element('copy').textContent = 'Copied. Paste on your iPhone'; });
element('approve').onclick = () => perform(() => window.mobile.approve(state.pending.id, true));
element('deny').onclick = () => perform(() => window.mobile.approve(state.pending.id, false));
element('disable').onclick = () => perform(async () => { await window.mobile.disable(); element('copy').textContent = 'Copy pairing code'; });
element('share-guide').onclick = async () => {
  const button = element('share-guide');
  button.disabled = true;
  try {
    const saved = await window.mobile.saveGuide();
    button.textContent = saved ? 'SVG guide saved' : 'Save SVG pairing guide';
  } catch (error) { showError(error); }
  finally { button.disabled = false; }
};
async function poll() {
  if (!alive) return;
  try { if (!busy) await refresh(); } catch (error) { showError(error); }
  if (alive) polling = setTimeout(poll, 1000);
}
window.addEventListener('beforeunload', () => {
  alive = false;
  artworkObserver.disconnect();
  clearTimeout(polling);
});
void poll();
