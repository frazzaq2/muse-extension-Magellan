/* Castify options page */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const msg = (m) => chrome.runtime.sendMessage(m);
  const FIELDS = ['mode', 'userName', 'organization', 'providerNpi', 'payer', 'pos',
    'noteTemplate', 'aiProvider', 'aiModel', 'aiApiKey', 'backendUrl', 'backendToken',
    'eligUrl', 'startClaimUrl'];

  function renderAddrs(map) {
    const box = $('addrs');
    box.innerHTML = '';
    Object.entries(map || {}).forEach(([name, a]) => {
      const d = document.createElement('div');
      d.className = 'addr';
      d.innerHTML = `<h4>${name}</h4><div class="row4">
        <input data-k="address" placeholder="Street" value="${esc(a.address)}">
        <input data-k="city" placeholder="City" value="${esc(a.city)}">
        <input data-k="state" placeholder="State" value="${esc(a.state)}">
        <input data-k="zip" placeholder="ZIP" value="${esc(a.zip)}">
        </div><button class="ghost del" type="button" style="margin-top:8px">Remove</button>`;
      d.querySelector('.del').onclick = () => { delete map[name]; renderAddrs(map); };
      d.querySelectorAll('input').forEach((inp) =>
        inp.addEventListener('input', () => { map[name][inp.dataset.k] = inp.value; }));
      box.appendChild(d);
    });
    box._map = map;
  }
  const esc = (s) => String(s ?? '').replace(/"/g, '&quot;');

  async function load() {
    const res = await msg({ type: 'GET_STATE' });
    const s = (res && res.ok && res.state.settings) || {};
    FIELDS.forEach((f) => { if ($('s-' + f) && s[f] != null) $('s-' + f).value = s[f]; });
    renderAddrs({ ...(s.centerAddresses || {}) });
    const sk = await msg({ type: 'GET_SKILL' });
    $('skill').value = (sk && sk.text) || '';
  }

  $('add-center').onclick = () => {
    const name = prompt('Center name (must match the Center column in Magellan):');
    if (!name) return;
    const map = $('addrs')._map || {};
    map[name] = { address: '', city: '', state: '', zip: '' };
    renderAddrs(map);
  };

  $('save').onclick = async () => {
    const settings = {};
    FIELDS.forEach((f) => { settings[f] = $('s-' + f).value; });
    settings.centerAddresses = $('addrs')._map || {};
    const res = await msg({ type: 'SAVE_SETTINGS', settings });
    $('status').textContent = res && res.ok ? '✓ Settings saved.' : 'Save failed.';
    setTimeout(() => $('status').textContent = '', 2500);
  };

  $('save-skill').onclick = async () => {
    const res = await msg({ type: 'SAVE_SKILL', text: $('skill').value });
    $('status').textContent = res && res.ok ? '✓ Skill file saved.' : 'Save failed.';
    setTimeout(() => $('status').textContent = '', 2500);
  };

  $('test-sync').onclick = async () => {
    $('sync-status').textContent = 'Syncing…';
    const res = await msg({ type: 'SYNC_BACKEND' });
    $('sync-status').textContent = res && res.ok ? '✓ Synced.' : '✕ ' + ((res && res.error) || 'failed');
  };

  load();
})();
