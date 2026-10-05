/* Castify dashboard — vanilla JS, no dependencies. */
'use strict';

const $ = (id) => document.getElementById(id);
const TOKEN_KEY = 'castify_token';
const PAGE = 50;
let page = 0;
let me = null;

const money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, opts = {}) {
  const r = await fetch(path, {
    ...opts,
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + localStorage.getItem(TOKEN_KEY), ...(opts.headers || {}) },
  });
  if (r.status === 401) { logout(); throw new Error('Session expired — please sign in again.'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
  return j;
}

// ---------- login / session ----------

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-error').textContent = '';
  try {
    // Plain fetch (not the api() helper) so a 401 shows an error instead of bouncing.
    const r = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: $('login-email').value.trim(), password: $('login-pass').value }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.token) throw new Error(j.error || 'Login failed');
    localStorage.setItem(TOKEN_KEY, j.token);
    me = j.user;
    showApp();
  } catch (err) {
    $('login-error').textContent = err.message;
  }
});

function logout() {
  localStorage.removeItem(TOKEN_KEY);
  me = null;
  $('app-view').classList.add('hidden');
  $('login-view').classList.remove('hidden');
}
$('btn-logout').addEventListener('click', logout);

$('btn-token').addEventListener('click', async () => {
  const t = localStorage.getItem(TOKEN_KEY) || '';
  try {
    await navigator.clipboard.writeText(t);
    flash('API token copied — paste it into the extension Options → API token.');
  } catch {
    prompt('Copy your API token (paste into extension Options):', t);
  }
});

function flash(msg) {
  const b = $('btn-token');
  const old = b.textContent;
  b.textContent = msg;
  setTimeout(() => { b.textContent = old; }, 2200);
}

// ---------- tabs ----------

$('nav-dash').addEventListener('click', () => switchTab('dash'));
$('nav-users').addEventListener('click', () => switchTab('users'));
function switchTab(which) {
  $('tab-dash').classList.toggle('hidden', which !== 'dash');
  $('tab-users').classList.toggle('hidden', which !== 'users');
  $('nav-dash').classList.toggle('active', which === 'dash');
  $('nav-users').classList.toggle('active', which === 'users');
  if (which === 'users') loadUsers();
}

function showApp() {
  $('login-view').classList.add('hidden');
  $('app-view').classList.remove('hidden');
  $('whoami').textContent = `${me.name} · ${me.role}`;
  $('nav-users').classList.toggle('hidden', me.role !== 'admin');
  switchTab('dash');
  loadAll();
}

// ---------- dashboard ----------

function fillSelect(sel, items, keep) {
  const cur = keep ? sel.value : '';
  sel.innerHTML = '<option value="">' + sel.querySelector('option').textContent + '</option>' +
    items.map((x) => `<option value="${esc(x.k)}">${esc(x.k)} (${x.n})</option>`).join('');
  if (keep) sel.value = cur;
}

async function loadAll() {
  const days = $('f-days').value;
  const s = await api(`/api/claims/summary?days=${days}`);
  $('s-billed-n').textContent = s.billedCount.toLocaleString();
  $('s-billed-amt').textContent = money(s.billedCharges);
  $('s-unbilled-n').textContent = s.unbilledCount.toLocaleString();
  $('s-unbilled-amt').textContent = money(s.unbilledCharges);

  const mini = (rows) => '<tr><th>Key</th><th class="num">Claims</th><th class="num">Charges</th></tr>' +
    (rows.length ? rows.slice(0, 12).map((r) =>
      `<tr><td>${esc(r.k)}</td><td class="num">${r.n}</td><td class="num">${money(r.charges)}</td></tr>`).join('')
      : '<tr><td colspan="3" class="empty">No data</td></tr>');
  $('t-center').innerHTML = mini(s.byCenter);
  $('t-payer').innerHTML = mini(s.byPayer);
  $('t-cpt').innerHTML = mini(s.byCpt);
  fillSelect($('f-payer'), s.byPayer, true);
  fillSelect($('f-center'), s.byCenter, true);

  await loadClaims();
}

async function loadClaims() {
  const params = new URLSearchParams({
    days: '3650', limit: PAGE, offset: page * PAGE,
    status: $('f-status').value, payer: $('f-payer').value,
    center: $('f-center').value, q: $('f-q').value.trim(),
  });
  const { items, total } = await api('/api/claims?' + params.toString());
  $('claims-body').innerHTML = items.length ? items.map((c) => {
    const detail = c.status === 'billed'
      ? `<span class="mono">${esc(c.tcn || '')}</span>`
      : c.status === 'unbilled'
        ? esc([c.unbilled_step, c.unbilled_reason].filter(Boolean).join(' — '))
        : '<span style="color:var(--muted)">in queue</span>';
    return `<tr>
      <td>${esc(c.patient)}</td><td class="mono">${esc(c.mrn)}</td><td>${esc(c.payer)}</td>
      <td>${esc(c.center)}</td><td class="mono">${esc(c.service_date)}</td>
      <td class="mono">${esc(c.cpt)}</td><td class="num">${c.units == null ? '' : esc(c.units)}</td>
      <td class="num">${c.charges == null ? '' : money(c.charges)}</td>
      <td><span class="pill ${c.status}">${c.status}</span></td><td>${detail}</td>
    </tr>`;
  }).join('') : '<tr><td colspan="10" class="empty">No claims match the filters.</td></tr>';
  const from = total ? page * PAGE + 1 : 0;
  const to = Math.min(total, (page + 1) * PAGE);
  $('pg-info').textContent = `${from}–${to} of ${total}`;
  $('pg-prev').disabled = page === 0;
  $('pg-next').disabled = to >= total;
}

$('f-apply').addEventListener('click', () => { page = 0; loadAll(); });
$('f-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { page = 0; loadClaims(); } });
$('f-days').addEventListener('change', () => { page = 0; loadAll(); });
$('pg-prev').addEventListener('click', () => { if (page > 0) { page--; loadClaims(); } });
$('pg-next').addEventListener('click', () => { page++; loadClaims(); });

// ---------- users (admin) ----------

async function loadUsers() {
  const users = await api('/api/admin/users');
  $('users-body').innerHTML = users.map((u) =>
    `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${esc(u.role)}</td>
     <td class="num">${u.claim_count}</td><td class="mono">${esc((u.created_at || '').slice(0, 10))}</td>
     <td>${u.id === me.id ? '<span style="color:var(--muted)">you</span>'
       : `<button class="danger" data-del="${u.id}">Delete</button>`}</td></tr>`).join('') ||
    '<tr><td colspan="6" class="empty">No users.</td></tr>';
  $('users-body').querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm('Delete this user and all their synced claims?')) return;
      await api('/api/admin/users/' + b.dataset.del, { method: 'DELETE' });
      loadUsers();
    }));
}

$('user-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('user-error').textContent = '';
  try {
    await api('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        name: $('u-name').value.trim(), email: $('u-email').value.trim(),
        password: $('u-pass').value, role: $('u-role').value,
      }),
    });
    e.target.reset();
    loadUsers();
  } catch (err) {
    $('user-error').textContent = err.message;
  }
});

// ---------- boot ----------

if (localStorage.getItem(TOKEN_KEY)) {
  // Validate the stored token by fetching the summary (admin or user — 401 bounces to login).
  api('/api/claims/summary?days=1').then(() => {
    // We don't know name/role yet; decode payload (not verified, display only).
    try {
      const p = JSON.parse(atob(localStorage.getItem(TOKEN_KEY).split('.')[1]));
      me = { name: p.email, role: p.role };
    } catch { me = { name: '', role: 'user' }; }
    showApp();
  }).catch(() => logout());
}
