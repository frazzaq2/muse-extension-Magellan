/* Castify background service worker (MV3 module).
 * Orchestrates the one-by-one pipeline:
 *   auth check (Magellan) -> eligibility (Availity) -> fill claim ->
 *   submit (auto | review) -> capture TCN -> write back to EHR.
 * Also handles AI calls and backend sync.
 */

const DEFAULT_SETTINGS = {
  mode: 'review', // 'auto' | 'review'
  organization: 'Atlanta Autism Center Inc',
  providerNpi: '1861156978',
  taxId: '872935575',
  payer: 'AETNA',
  pos: '11 - Office',
  frequencyType: '1 - Admit Through Discharge Claim',
  assignment: 'A - Assigned',
  filingIndicator: 'CI - Commercial Insurance Co.',
  roi: 'Y - Yes',
  signature: 'Yes',
  defaultDx: ['F840'],
  asOfDate: '', // defaults to today
  centerAddresses: {
    'Covington':      { address: '7138 Hwy 212', city: 'Covington', state: 'Georgia', zip: '30016-8047' },
    'Lawrenceville':  { address: '833 Hurricane Shoals Rd NE', city: 'Lawrenceville', state: 'Georgia', zip: '30043-4821' },
    'Alpharetta':     { address: '1356 Bluegrass Lakes Pkwy', city: 'Alpharetta', state: 'Georgia', zip: '30004-3395' },
    'Norcross':       { address: '30 Innovation Dr NW STE 100', city: 'Norcross', state: 'Georgia', zip: '30092-2925' },
    'Loganville':     { address: '5835 Georgia Hwy 20', city: 'Loganville', state: 'Georgia', zip: '30052-5321' },
    'Flowery Branch': { address: '4170 Tanners Creek Dr', city: 'Flowery Branch', state: 'Georgia', zip: '30042-2839' },
    'Kennesaw':       { address: '2045 Vaughn Rd NW Building 100', city: 'Kennesaw', state: 'Georgia', zip: '30144' }
  },
  noteTemplate: 'Claim submitted via Castify by {user} — Availity TCN {tcn} on {date}',
  aiProvider: 'anthropic', // 'anthropic' | 'openai'
  aiApiKey: '',
  aiModel: '', // empty = provider default
  backendUrl: '',
  backendToken: '',
  userName: '',
  eligUrl: '',
  startClaimUrl: ''
};

const store = {
  async get(keys) { return chrome.storage.local.get(keys); },
  async set(obj) { return chrome.storage.local.set(obj); }
};

async function getSettings() {
  const { settings } = await store.get(['settings']);
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

/* ---------- tab helpers ---------- */

async function findTab(urlPart) {
  const tabs = await chrome.tabs.query({});
  return tabs.find((t) => (t.url || '').includes(urlPart)) || null;
}

// Dedicated automation tab (inactive) so we don't hijack the user's active tab.
async function helperTab(urlPart, fallbackUrl) {
  let tab = await findTab(urlPart);
  if (tab && (tab.url || '').includes('castify-helper')) return tab;
  const tabs = await chrome.tabs.query({});
  const helper = tabs.find((t) => (t.title || '').includes('Castify helper'));
  if (helper) return helper;
  tab = await chrome.tabs.create({ url: fallbackUrl, active: false });
  return tab;
}

async function sendToSite(urlPart, msg, timeoutMs = 120000) {
  const tab = await findTab(urlPart);
  if (!tab) return { ok: false, error: `No open tab found for ${urlPart}. Open the site and log in first.` };
  return sendToTab(tab.id, msg, timeoutMs);
}

function sendMessageOnce(tabId, msg, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) { done = true; resolve({ ok: false, error: 'Timed out waiting for page response.' }); }
    }, timeoutMs);
    chrome.tabs.sendMessage(tabId, msg, (resp) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (chrome.runtime.lastError) {
        const m = chrome.runtime.lastError.message || '';
        if (/receiving end does not exist|could not establish connection/i.test(m)) {
          resolve({ ok: false, _noReceiver: true, error: m });
        } else {
          resolve({ ok: false, error: m });
        }
      } else resolve(resp || { ok: false, error: 'No response from page.' });
    });
  });
}

// If the tab was open before the extension was installed/reloaded, the content
// script isn't there — inject it programmatically and retry once.
async function injectContentScript(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const url = tab.url || '';
    const file = url.includes('magellanehr.com') ? 'content/magellan.js'
      : url.includes('availity.com') ? 'content/availity.js' : null;
    if (!file) return { ok: false, error: 'This tab is not a Magellan or Availity page. Open the site and log in first.' };
    await chrome.scripting.executeScript({ target: { tabId }, files: [file] });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: 'Could not attach to this tab. Refresh the page and try again.' };
  }
}

async function sendToTab(tabId, msg, timeoutMs = 120000) {
  let resp = await sendMessageOnce(tabId, msg, timeoutMs);
  if (resp && resp._noReceiver) {
    const inj = await injectContentScript(tabId);
    if (!inj.ok) return { ok: false, error: inj.error };
    await sleep(900);
    resp = await sendMessageOnce(tabId, msg, timeoutMs);
    if (resp && resp._noReceiver) {
      return { ok: false, error: 'Still no response after attaching. Refresh the page and try again.' };
    }
  }
  return resp;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForUrl(tabId, includes, timeout = 25000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (t && (t.url || '').includes(includes) && t.status === 'complete') return true;
    await sleep(600);
  }
  return false;
}

/* ---------- claim store ---------- */

async function getClaims() { const { claims } = await store.get(['claims']); return claims || []; }
async function saveClaims(claims) { await store.set({ claims }); }
async function updateClaim(id, patch) {
  const claims = await getClaims();
  const i = claims.findIndex((c) => c.id === id);
  if (i >= 0) { claims[i] = { ...claims[i], ...patch, updatedAt: new Date().toISOString() }; await saveClaims(claims); }
  return claims[i];
}
async function logEvent(entry) {
  const { eventLog } = await store.get(['eventLog']);
  const log = eventLog || [];
  log.push({ at: new Date().toISOString(), ...entry });
  await store.set({ eventLog: log.slice(-500) });
}
function broadcast(msg) { chrome.runtime.sendMessage({ ...msg, _broadcast: true }).catch(() => {}); }

/* ---------- queue engine (one by one) ---------- */

let queueRunning = false;
let reviewGate = null; // {resolve} when waiting on human review

async function startQueue(ids, mode) {
  if (queueRunning) return { ok: false, error: 'A submission run is already in progress.' };
  const settings = await getSettings();
  const runMode = mode || settings.mode || 'review';
  await store.set({ queue: { ids, index: 0, running: true, mode: runMode, startedAt: new Date().toISOString() } });
  queueRunning = true;
  broadcast({ type: 'QUEUE_STARTED', total: ids.length, mode: runMode });
  processQueue().catch((e) => failQueue(String((e && e.message) || e)));
  return { ok: true, total: ids.length, mode: runMode };
}

async function failQueue(error) {
  queueRunning = false;
  await store.set({ queue: { running: false, error } });
  broadcast({ type: 'QUEUE_FAILED', error });
  await logEvent({ kind: 'queue_failed', error });
}

async function stopQueue() {
  queueRunning = false;
  if (reviewGate) { reviewGate.resolve('stopped'); reviewGate = null; }
  await store.set({ queue: { running: false, stopped: true } });
  broadcast({ type: 'QUEUE_STOPPED' });
  return { ok: true };
}

function waitForReviewDecision() {
  return new Promise((resolve) => { reviewGate = { resolve }; });
}
function resolveReview(decision) {
  if (reviewGate) { reviewGate.resolve(decision); reviewGate = null; return true; }
  return false;
}

async function processQueue() {
  const settings = await getSettings();
  let { queue } = await store.get(['queue']);
  while (queueRunning && queue && queue.index < queue.ids.length) {
    const id = queue.ids[queue.index];
    const claim = (await getClaims()).find((c) => c.id === id);
    if (!claim) { queue.index++; await store.set({ queue }); continue; }

    broadcast({ type: 'CLAIM_START', claim });
    await logEvent({ kind: 'claim_start', claimId: id, patient: claim.patient });
    await updateClaim(id, { status: 'processing', step: 'auth' });

    // ---- Step 2: authorization check (Magellan) ----
    const authRes = await stepAuthCheck(claim);
    if (!authRes.ok) {
      await markUnbilled(claim, 'auth', authRes.reason || authRes.error || 'Authorization check failed');
      queue.index++; await store.set({ queue }); ({ queue } = await store.get(['queue']));
      continue;
    }
    await updateClaim(id, { status: 'auth_ok', step: 'eligibility', authNumber: authRes.auth.number });
    broadcast({ type: 'CLAIM_AUTH_OK', claimId: id, auth: authRes.auth });

    // ---- Step 3a: eligibility (Availity) ----
    const eligRes = await stepEligibility(claim, authRes.auth, settings);
    if (!eligRes.ok || !eligRes.active) {
      await markUnbilled(claim, 'eligibility',
        eligRes.ok ? `Eligibility inactive as of DOS (${eligRes.payer || 'unknown payer'})`
                   : (eligRes.error || 'Eligibility check failed'));
      queue.index++; await store.set({ queue }); ({ queue } = await store.get(['queue']));
      continue;
    }
    await updateClaim(id, { status: 'eligibility_ok', step: 'fill', eligibility: eligRes });
    broadcast({ type: 'CLAIM_ELIG_OK', claimId: id, eligibility: eligRes });

    // ---- Step 3b: fill claim (Availity) ----
    const fillRes = await stepFillClaim(claim, authRes.auth, eligRes, settings);
    if (!fillRes.ok) {
      const reason = [...(fillRes.errors || []), ...(fillRes.formErrors || [])].join(' | ') || 'Claim form fill failed';
      await markUnbilled(claim, 'fill', reason);
      queue.index++; await store.set({ queue }); ({ queue } = await store.get(['queue']));
      continue;
    }
    await updateClaim(id, { status: 'filled', step: queue.mode === 'auto' ? 'submit' : 'review' });

    // ---- Step 3c: submit (auto) or wait for review ----
    if (queue.mode === 'auto') {
      const subRes = await stepSubmit(settings);
      if (!subRes.ok) {
        await markUnbilled(claim, 'submit', subRes.error || 'Submission failed');
        queue.index++; await store.set({ queue }); ({ queue } = await store.get(['queue']));
        continue;
      }
      await finalizeBilled(claim, subRes.tcn, settings, subRes.confirmation);
    } else {
      broadcast({ type: 'REVIEW_NEEDED', claimId: id, claim });
      await updateClaim(id, { status: 'awaiting_review', step: 'review' });
      const decision = await waitForReviewDecision(); // 'submit' | 'skip' | 'stopped'
      if (decision === 'submit') {
        const subRes = await stepSubmit(settings);
        if (!subRes.ok) {
          await markUnbilled(claim, 'submit', subRes.error || 'Submission failed');
        } else {
          await finalizeBilled(claim, subRes.tcn, settings, subRes.confirmation);
        }
      } else if (decision === 'skip') {
        await markUnbilled(claim, 'review', 'Skipped by user at review');
      } else {
        await markUnbilled(claim, 'review', 'Run stopped during review');
        break;
      }
    }

    queue.index++;
    await store.set({ queue });
    ({ queue } = await store.get(['queue']));
    await sleep(1200); // breathing room between claims
  }
  queueRunning = false;
  await store.set({ queue: { ...(queue || {}), running: false, finishedAt: new Date().toISOString() } });
  broadcast({ type: 'QUEUE_DONE' });
  await logEvent({ kind: 'queue_done' });
  syncToBackend().catch(() => {});
}

async function markUnbilled(claim, step, reason) {
  await updateClaim(claim.id, { status: 'unbilled', step, unbilledReason: reason });
  const { unbilled } = await store.get(['unbilled']);
  const list = unbilled || [];
  list.push({ claimId: claim.id, patient: claim.patient, mrn: claim.mrn, payer: claim.payer, cpt: claim.cpt, units: claim.units, charges: claim.charges, serviceDate: claim.serviceDate, center: claim.center, step, reason, at: new Date().toISOString() });
  await store.set({ unbilled: list });
  broadcast({ type: 'CLAIM_UNBILLED', claimId: claim.id, step, reason });
  await logEvent({ kind: 'claim_unbilled', claimId: claim.id, step, reason });
}

async function finalizeBilled(claim, tcn, settings, confirmation) {
  const user = settings.userName || 'user';
  const note = (settings.noteTemplate || DEFAULT_SETTINGS.noteTemplate)
    .replace('{user}', user).replace('{tcn}', tcn || 'n/a')
    .replace('{date}', new Date().toLocaleDateString('en-US'));
  // write back into the EHR (best effort)
  let wb = { ok: false };
  try { wb = await sendToSite('magellanehr.com', { type: 'CASTIFY_WRITEBACK', claim, tcn, note }, 20000); } catch (_) {}
  await updateClaim(claim.id, { status: 'billed', step: 'done', tcn, confirmation, writeBack: wb });
  const { billed } = await store.get(['billed']);
  const list = billed || [];
  list.push({ claimId: claim.id, patient: claim.patient, mrn: claim.mrn, payer: claim.payer, cpt: claim.cpt, units: claim.units, charges: claim.charges, serviceDate: claim.serviceDate, center: claim.center, tcn, note, writeBackOk: !!wb.ok, at: new Date().toISOString() });
  await store.set({ billed: list });
  broadcast({ type: 'CLAIM_BILLED', claimId: claim.id, tcn });
  await logEvent({ kind: 'claim_billed', claimId: claim.id, tcn });
}

/* ---------- patient preview: demographics + auths + encounter, all in the side panel ---------- */

/* ---------- print-note capture: runs in the page's MAIN world (self-contained) ---------- */

// Clicks "Print note", intercepts the generated blob (via URL.createObjectURL,
// which every blob: URL goes through regardless of how it is opened), and
// returns the document bytes as base64.
async function capturePrintPdfFn() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    const buttonCount = document.querySelectorAll('button').length;
    const isVisible = (el) => {
      try { return el.getClientRects().length > 0 && el.offsetParent !== null; }
      catch (e) { return true; }
    };
    const pairs = []; // {url, blob}
    let openedUrl = null;
    const fetchUrls = [];
    const origCreate = URL.createObjectURL;
    URL.createObjectURL = function (blob) {
      const url = origCreate.call(URL, blob);
      try { pairs.push({ url: String(url), blob }); } catch (e) {}
      return url;
    };
    const origOpen = window.open;
    const fakeWin = () => {
      const loc = {};
      try {
        Object.defineProperty(loc, 'href', {
          set(v) { try { openedUrl = String(v); } catch (e) {} },
          get() { return ''; },
          configurable: true,
        });
      } catch (e) {}
      return {
        closed: false, close() {}, focus() {}, blur() {},
        location: loc,
        document: { write() {}, writeln() {}, close() {}, open() {} },
      };
    };
    window.open = function (url) {
      try { if (url) openedUrl = String(url); } catch (e) {}
      return fakeWin();
    };
    const origFetch = window.fetch;
    window.fetch = function (...args) {
      try {
        const u = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
        if (u) fetchUrls.push(String(u).slice(0, 160));
      } catch (e) {}
      return origFetch.apply(this, args);
    };
    const restore = () => {
      try { URL.createObjectURL = origCreate; } catch (e) {}
      try { window.open = origOpen; } catch (e) {}
      try { window.fetch = origFetch; } catch (e) {}
    };
    const findBtn = () => {
      const cands = [...document.querySelectorAll('button, a')];
      const byText = cands.filter((b) => /^\s*print note\s*$/i.test(b.textContent || ''));
      const byTitle = cands.filter((b) => /printable pdf/i.test(b.getAttribute('title') || ''));
      const pool = byText.length ? byText : byTitle;
      if (!pool.length) return { btn: null, matchedBy: '' };
      const btn = pool.find(isVisible) || pool[0];
      let info = '';
      try {
        const idx = pool.indexOf(btn);
        const r = btn.getBoundingClientRect();
        info = `#${idx + 1}/${pool.length} visible=${isVisible(btn)} ${Math.round(r.width)}x${Math.round(r.height)}`;
      } catch (e) {}
      return { btn, matchedBy: byText.length ? 'text' : 'title', info };
    };
    let found = { btn: null, matchedBy: '' };
    const endBtn = Date.now() + 6000;
    while (!found.btn && Date.now() < endBtn) {
      found = findBtn();
      if (!found.btn) await sleep(300);
    }
    if (!found.btn) {
      restore();
      return { ok: false, error: 'Print note button not found', buttonCount };
    }
    // Re-find atomically at click time: React may have remounted the button
    // between the poll loop and now, and clicking a detached node silently
    // does nothing (no error, no handler, no fetch).
    const live = findBtn();
    const target = live.btn || found.btn;
    let btnConnected = false;
    try { btnConnected = !!target && target.isConnected !== false; } catch (e) {}
    if (target) target.click();
    // Wait for the print flow. On slow networks the handler's fetch can take a
    // while, so extend the wait while network activity is still happening.
    // If the click clearly did nothing, re-find and click once more.
    let end = Date.now() + 12000;
    let lastFetchN = 0;
    let retried = false;
    while (Date.now() < end && !openedUrl && !pairs.length) {
      await sleep(250);
      if (fetchUrls.length > lastFetchN) { lastFetchN = fetchUrls.length; end = Date.now() + 8000; }
      if (!retried && Date.now() > end - 4000) {
        retried = true;
        try {
          const f2 = findBtn();
          if (f2.btn) { f2.btn.click(); found.retryInfo = f2.info || 'retry'; }
        } catch (e) {}
      }
    }
    if (openedUrl && !pairs.length) await sleep(1500); // blob may race the open
    restore();

    let blob = null;
    if (openedUrl) {
      const hit = pairs.find((p) => p.url === openedUrl);
      if (hit) blob = hit.blob;
    }
    if (!blob && pairs.length) {
      const pdfHit = pairs.find((p) => p.blob && /pdf/i.test(p.blob.type || ''));
      blob = (pdfHit || pairs[pairs.length - 1]).blob;
    }
    const extra = {
      buttonCount, matchedBy: found.matchedBy, clickedBtn: found.info || '',
      btnConnected, retriedClick: found.retryInfo || '',
      openedUrl,
      blobUrls: pairs.slice(0, 3).map((p) => p.url),
      fetchUrls: fetchUrls.slice(0, 5),
    };
    if (!blob) return { ok: false, error: 'Print view did not open', ...extra };
    let buf = null;
    try { buf = await blob.arrayBuffer(); }
    catch (e) { return { ok: false, error: 'Could not read print blob: ' + String((e && e.message) || e), ...extra }; }
    if (!buf || !buf.byteLength) return { ok: false, error: 'Print document was empty', ...extra };
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    return { ok: true, pdfBase64: btoa(bin), ...extra };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// Extract readable text from PDF bytes: decompresses Flate streams, then pulls
// literal (...) and hex <...> strings.
async function extractPdfText(bytes) {
  const latin1 = (arr) => {
    let s = '';
    for (let i = 0; i < arr.length; i += 8192) s += String.fromCharCode.apply(null, arr.subarray(i, i + 8192));
    return s;
  };
  const raw = latin1(bytes);
  const parts = [];
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m;
  let last = 0;
  while ((m = re.exec(raw))) {
    parts.push(raw.slice(last, m.index));
    parts.push({ s: m[1] });
    last = m.index + m[0].length;
  }
  parts.push(raw.slice(last));
  const texts = [];
  for (const p of parts) {
    if (typeof p === 'string') { texts.push(p); continue; }
    const sb = new Uint8Array(p.s.length);
    for (let i = 0; i < p.s.length; i++) sb[i] = p.s.charCodeAt(i) & 255;
    let dec = null;
    try {
      const ds = new DecompressionStream('deflate');
      const ab = await new Response(new Blob([sb]).stream().pipeThrough(ds)).arrayBuffer();
      dec = latin1(new Uint8Array(ab));
    } catch (e) { dec = null; }
    texts.push(dec === null ? p.s : dec);
  }
  const all = texts.join('\n');
  const strings = [];
  const litRe = /\((?:\\.|[^\\()])*\)/g;
  while ((m = litRe.exec(all))) {
    strings.push(m[0].slice(1, -1).replace(/\\([nrtbf])/g, ' ').replace(/\\(.)/g, '$1'));
  }
  const hexRe = /<([0-9a-fA-F \r\n]+)>/g;
  while ((m = hexRe.exec(all))) {
    const hex = m[1].replace(/\s+/g, '');
    if (hex.length < 6) continue;
    let s = '';
    if (/^feff/i.test(hex)) {
      for (let i = 4; i + 3 < hex.length; i += 4) s += String.fromCharCode(parseInt(hex.substr(i, 4), 16));
    } else {
      for (let i = 0; i + 1 < hex.length; i += 2) s += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
    }
    if (s.trim()) strings.push(s);
  }
  return strings.join(' ').replace(/\s+/g, ' ').trim();
}

// Turn the print view's "Label value Label value ..." text into a fields object.
function parsePrintFields(text) {
  const fields = {};
  const labels = ['Patient Name', 'DOB', 'Patient Insurance ID', 'Diagnosis', 'Services Provided',
    'Organization Name', 'Provider Name', 'Provider Credential', 'Provider NPI', 'Date of Appointment',
    'Scheduled Start Time', 'Scheduled End Time', 'Scheduled Duration', 'Actual Session Time',
    'Place of Service', 'Appointment Modality'];
  const lower = text.toLowerCase();
  const hits = [];
  for (const lab of labels) {
    const idx = lower.indexOf(lab.toLowerCase());
    if (idx >= 0) hits.push({ lab, idx });
  }
  hits.sort((a, b) => a.idx - b.idx);
  for (let i = 0; i < hits.length; i++) {
    const start = hits[i].idx + hits[i].lab.length;
    const end = i + 1 < hits.length ? hits[i + 1].idx : text.length;
    const val = text.slice(start, end).replace(/\s+/g, ' ').trim();
    if (val && val.length < 200) fields[hits[i].lab] = val;
  }
  // Known-format fields: keep just the value, drop any trailing PDF metadata junk
  const clean = {
    'Place of Service': (v) => (v.match(/\b\d{1,2}\b/) || [v])[0],
    'DOB': (v) => (v.match(/\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}/) || [v])[0],
    'Date of Appointment': (v) => (v.match(/\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}/) || [v])[0],
    'Provider NPI': (v) => (v.match(/\b\d{10}\b/) || [v])[0],
  };
  for (const k of Object.keys(clean)) if (fields[k]) fields[k] = clean[k](fields[k]);
  return fields;
}

/* ---------- preview helpers: capture icon URLs via a main-world window.open hook ---------- */

// Runs in the page's MAIN world (CSP-proof): records window.open URLs instead of opening popups.
function armWindowOpenFn() {
  try {
    if (window.__castifyArmed) return;
    window.__castifyArmed = true;
    const orig = window.open;
    window.open = function (url) {
      try { document.documentElement.setAttribute('data-castify-opened-url', String(url)); } catch (e) {}
      return { closed: false, close() {}, focus() {}, blur() {} };
    };
    setTimeout(() => { try { window.open = orig; window.__castifyArmed = false; } catch (e) {} }, 12000);
  } catch (e) {}
}

async function waitForTabComplete(tabId, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) return false;
    if (t.status === 'complete') return true;
    await sleep(500);
  }
  return false;
}

// The encounter note page sometimes never reaches tab status 'complete'
// (a hanging subrequest), so wait for its actual content instead.
// 45s to tolerate slow clinic networks.
async function waitForNoteReady(tabId, timeout = 45000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const r = await sendToTab(tabId, { type: 'CASTIFY_NOTE_READY' }, 6000).catch(() => null);
    if (r && r.ok && r.ready) return true;
    await sleep(1000);
  }
  return false;
}

// Click the row icon and capture the URL its window.open would have opened.
async function captureIconUrl(tab, claim, kind) {
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func: armWindowOpenFn });
  } catch (e) {
    return { ok: false, error: 'hook failed: ' + String((e && e.message) || e) };
  }
  const click = await sendToTab(tab.id, { type: 'CASTIFY_CLICK_ROW_ACTION', patient: claim.patient, mrn: claim.mrn, action: kind }, 15000);
  if (!click || !click.ok) return { ok: false, error: (click && click.error) || 'icon click failed' };
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    const r = await sendToTab(tab.id, { type: 'CASTIFY_READ_CAPTURED_URL' }, 8000).catch(() => null);
    if (r && r.ok && r.url) return { ok: true, url: r.url };
    await sleep(250);
  }
  return { ok: false, error: 'button did not open a page' };
}

async function scrapeTabContents(tabId, kind, diag, out, mergeAuths) {
  if (kind === 'demographics') {
    const m = await sendToTab(tabId, { type: 'CASTIFY_SCRAPE_MODAL', tab: 'demographics' }, 25000);
    if (m && m.ok) {
      Object.assign(out.demographics, m.fields || {});
      diag.push(`demographics: modal fields=${Object.keys(m.fields || {}).length}`);
    } else {
      const f = await sendToTab(tabId, { type: 'CASTIFY_SCRAPE_FIELDS' }, 20000);
      Object.assign(out.demographics, (f && f.ok && f.fields) || {});
      diag.push(`demographics: page fields=${Object.keys(out.demographics).length} (${(m && m.error) || 'no modal'})`);
    }
    const a = await sendToTab(tabId, { type: 'CASTIFY_SCRAPE_MODAL', tab: 'authorizations' }, 30000);
    if (a && a.ok) {
      mergeAuths(a.auths);
      diag.push(`authorizations: modal auths=${(a.auths || []).length} clicked=${!!a.clicked} switched=${!!a.tabSwitched} panelChars=${a.panelChars || 0}`);
      if (!(a.auths || []).length && a.panelSnippet) {
        diag.push(`authorizations: panel text: ${a.panelSnippet}`);
      }
    } else {
      const fa = await sendToTab(tabId, { type: 'CASTIFY_FIND_AUTHS' }, 20000);
      mergeAuths(fa && fa.ok && fa.auths);
      diag.push(`authorizations: page auths=${out.auths.length} (${(a && a.error) || 'no modal'})`);
    }
  } else {
    const f = await sendToTab(tabId, { type: 'CASTIFY_SCRAPE_FIELDS' }, 20000);
    Object.assign(out.encounter, (f && f.ok && f.fields) || {});
    const fa = await sendToTab(tabId, { type: 'CASTIFY_FIND_AUTHS' }, 20000);
    mergeAuths(fa && fa.ok && fa.auths);
    diag.push(`encounter: fields=${Object.keys(out.encounter).length} auths=${out.auths.length}`);
  }
}

// Fetch a blob: URL created by the page and return its bytes as base64.
// Runs in the page's MAIN world — blob: URLs are readable from their origin.
async function fetchBlobAsBase64Fn(blobUrl) {
  try {
    const r = await fetch(blobUrl);
    if (!r.ok) return { ok: false, error: 'fetch status ' + r.status };
    const buf = await r.arrayBuffer();
    if (!buf || !buf.byteLength) return { ok: false, error: 'empty blob' };
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    return { ok: true, base64: btoa(bin), byteLength: bytes.length };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// Open the encounter's "Print note" view in the hidden tab, read the generated
// document, and merge its fields (incl. Place of Service) into the preview.
async function captureEncounterPrint(tabId, diag, out) {
  const before = new Set((await chrome.tabs.query({})).map((t) => t.id));
  out.printNote = { ok: false, detail: '' };
  const parseAndMerge = async (bytes, via) => {
    diag.push(`encounter: print doc bytes=${bytes.length} via=${via}`);
    const text = await extractPdfText(bytes);
    const pf = parsePrintFields(text);
    Object.assign(out.encounter, pf);
    if (pf['Place of Service']) out.placeOfService = pf['Place of Service'];
    diag.push(`encounter: print fields=${Object.keys(pf).length} pos=${pf['Place of Service'] || '?'}`);
    out.printNote = { ok: true, detail: `POS ${pf['Place of Service'] || 'not found in PDF'} (via ${via})` };
  };
  try {
    const pr = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: capturePrintPdfFn });
    const r0 = pr && pr[0] && pr[0].result;
    const btnInfo = r0 ? `buttons=${r0.buttonCount ?? '?'} matchedBy=${r0.matchedBy || '?'} clicked=${r0.clickedBtn || '?'}` : 'buttons=?';
    diag.push(`encounter: print ${btnInfo}`);
    if (r0 && r0.ok && r0.pdfBase64) {
      const bytes = Uint8Array.from(atob(r0.pdfBase64), (c) => c.charCodeAt(0));
      await parseAndMerge(bytes, 'hook');
      return;
    }
    // Fallback: a real print tab with a blob: URL may have opened anyway
    // (e.g. anchor target=_blank, which window.open hooks don't suppress).
    // The blob was created by the encounter page, so fetch it from that tab.
    await sleep(1500);
    const fresh = (await chrome.tabs.query({})).filter((t) => !before.has(t.id));
    const urls = fresh.map((t) => t.url).filter(Boolean);
    const blobTab = fresh.find((t) => (t.url || '').startsWith('blob:'));
    let extra = '';
    if (r0 && r0.openedUrl) extra += ` opened=${r0.openedUrl}`;
    if (r0 && r0.blobUrls && r0.blobUrls.length) extra += ` blobs=${r0.blobUrls.join(',')}`;
    if (r0 && r0.fetchUrls && r0.fetchUrls.length) extra += ` fetch=${r0.fetchUrls.join(' | ')}`;
    if (urls.length) extra += ` freshTabs=${urls.join(',')}`;
    if (blobTab && blobTab.url) {
      diag.push(`encounter: print fallback reading blob tab ${blobTab.url.slice(0, 64)}...`);
      try {
        const br = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: fetchBlobAsBase64Fn, args: [blobTab.url] });
        const b0 = br && br[0] && br[0].result;
        if (b0 && b0.ok && b0.base64) {
          const bytes = Uint8Array.from(atob(b0.base64), (c) => c.charCodeAt(0));
          for (const t of fresh) { try { await chrome.tabs.remove(t.id); } catch (_) {} }
          await parseAndMerge(bytes, 'blob-tab');
          return;
        }
        extra += ` blobRead=${(b0 && b0.error) || 'failed'}`;
      } catch (e) {
        extra += ` blobRead=error ${String((e && e.message) || e).slice(0, 80)}`;
      }
    }
    const reason = (r0 && r0.error) || 'no result';
    diag.push(`encounter: print note failed (${reason})${extra}`);
    out.printNote = { ok: false, detail: `Print note not captured (${reason})` };
    for (const t of fresh) { try { await chrome.tabs.remove(t.id); } catch (_) {} }
  } catch (e) {
    diag.push(`encounter: print error ${String((e && e.message) || e)}`);
    out.printNote = { ok: false, detail: 'Print error' };
  }
}

async function previewPatientFlow(claim) {
  const tab = await findTab('magellanehr.com');
  if (!tab) return { ok: false, error: 'Magellan is not open. Open magellanehr.com and log in first.' };
  const out = { demographics: {}, auths: [], encounter: {}, placeOfService: '', printNote: null };
  const diag = [];
  const seenAuths = new Set();
  const mergeAuths = (list) => {
    (list || []).forEach((a) => {
      if (a && a.number && !seenAuths.has(a.number)) { seenAuths.add(a.number); out.auths.push(a); }
    });
  };

  const fetchViaIcon = async (kind) => {
    const before = new Set((await chrome.tabs.query({})).map((t) => t.id));
    const cap = await captureIconUrl(tab, claim, kind);
    if (cap && cap.ok && cap.url) {
      diag.push(`${kind}: captured ${cap.url}`);
      let t = null;
      try {
        t = await chrome.tabs.create({ url: cap.url, active: false });
        if (kind === 'encounter') {
          const ready = await waitForNoteReady(t.id, 30000);
          diag.push(`${kind}: note ready=${ready}`);
        } else {
          const loaded = await waitForTabComplete(t.id, 20000);
          diag.push(`${kind}: tab loaded=${loaded}`);
          await sleep(1500);
        }
        await scrapeTabContents(t.id, kind, diag, out, mergeAuths);
        if (kind === 'encounter') await captureEncounterPrint(t.id, diag, out);
      } catch (e) {
        diag.push(`${kind}: error ${String((e && e.message) || e)}`);
      } finally {
        if (t) try { await chrome.tabs.remove(t.id); } catch (_) {}
      }
      return;
    }
    // Fallback: the click may have opened a real tab despite the hook missing it
    await sleep(2000);
    const fresh = (await chrome.tabs.query({})).filter((t) => !before.has(t.id) && t.url && /^https?:/.test(t.url));
    if (fresh.length) {
      diag.push(`${kind}: caught opened tab ${fresh[0].url}`);
      try { await scrapeTabContents(fresh[0].id, kind, diag, out, mergeAuths); }
      finally { try { await chrome.tabs.remove(fresh[0].id); } catch (_) {} }
    } else {
      diag.push(`${kind}: no URL captured (${(cap && cap.error) || 'no response'})`);
    }
  };

  try {
    await fetchViaIcon('demographics');
    await fetchViaIcon('encounter');
  } catch (e) {
    out.error = String((e && e.message) || e);
  }
  out.diag = diag;
  const blob = JSON.stringify(out);
  const m = blob.match(/place of service[^a-z0-9]{0,12}([a-z0-9 .\-()]{2,50})/i);
  if (m) out.placeOfService = m[1].replace(/["'}\\]+$/, '').trim();
  return { ok: true, preview: out };
}

/* ---------- pipeline steps ---------- */

async function stepAuthCheck(claim) {
  // Navigate a Magellan tab to the patient's authorizations tab, then scrape + check.
  let tab = await findTab('magellanehr.com');
  if (!tab) return { ok: false, reason: 'Magellan is not open. Open magellanehr.com and log in first.' };
  if (claim.patientHref) {
    const nav = await sendToTab(tab.id, { type: 'CASTIFY_GOTO_AUTH_TAB', patientHref: claim.patientHref }, 15000);
    if (!nav || !nav.ok) return { ok: false, reason: 'Could not open the patient authorizations tab.' };
    await waitForUrl(tab.id, 'tab=authorizations', 20000);
  } else {
    // Fallback: the table had no usable patient link — click the patient row
    // in the claims table, then open the Authorizations tab on the patient page.
    const click = await sendToTab(tab.id, { type: 'CASTIFY_CLICK_PATIENT_LINK', patient: claim.patient, mrn: claim.mrn }, 15000);
    if (!click || !click.ok) return { ok: false, reason: (click && click.error) || 'No patient link captured from the claims table.' };
    await sleep(3000); // let the patient page load
    tab = await findTab('magellanehr.com');
    if (!tab) return { ok: false, reason: 'Lost the Magellan tab after opening the patient.' };
    const nav = await sendToTab(tab.id, { type: 'CASTIFY_GOTO_AUTH_TAB' }, 15000);
    if (!nav || !nav.ok) return { ok: false, reason: (nav && nav.error) || 'Could not open the patient authorizations tab.' };
    await waitForUrl(tab.id, 'tab=authorizations', 20000);
  }
  await sleep(1500);
  const res = await sendToTab(tab.id, { type: 'CASTIFY_CHECK_AUTH', claim }, 30000);
  if (!res || !res.ok) return { ok: false, reason: (res && (res.reason || res.error)) || 'Authorization scrape failed' };
  return res; // {ok, auth, matches} or {ok:false, reason}
}

async function stepEligibility(claim, auth, settings) {
  const cfg = {
    organization: settings.organization,
    payer: settings.payer || claim.payer,
    providerNpi: settings.providerNpi,
    asOfDate: settings.asOfDate || claim.serviceDate || new Date().toLocaleDateString('en-US')
  };
  const nav = await sendToSite('availity.com', { type: 'CASTIFY_NAVIGATE', target: 'eligibility', url: settings.eligUrl }, 60000);
  if (!nav || !nav.ok) return { ok: false, error: (nav && nav.error) || 'Could not open Eligibility & Benefits.' };
  const res = await sendToSite('availity.com', { type: 'CASTIFY_ELIGIBILITY', claim, cfg }, 120000);
  return res || { ok: false, error: 'No response from Availity eligibility.' };
}

async function stepFillClaim(claim, auth, elig, settings) {
  const nav = await sendToSite('availity.com', { type: 'CASTIFY_NAVIGATE', target: 'startClaim', url: settings.startClaimUrl }, 60000);
  if (!nav || !nav.ok) return { ok: false, errors: [(nav && nav.error) || 'Could not open Start a Claim.'] };
  const ctx = {
    cfg: {
      organization: settings.organization,
      payer: settings.payer || claim.payer,
      pos: settings.pos, frequencyType: settings.frequencyType,
      assignment: settings.assignment, filingIndicator: settings.filingIndicator,
      roi: settings.roi, signature: settings.signature
    },
    centerAddresses: settings.centerAddresses
  };
  const enriched = {
    ...claim,
    authNumber: auth.number,
    billingProviderOrg: settings.organization,
    dxCodes: claim.dxCodes || settings.defaultDx,
    patientLast: claim.patientLast || (claim.patient || '').split(',')[0] || '',
    patientFirst: claim.patientFirst || ((claim.patient || '').split(',')[1] || '').trim()
  };
  const res = await sendToSite('availity.com', { type: 'CASTIFY_FILL_CLAIM', claim: enriched, ctx }, 180000);
  return res || { ok: false, errors: ['No response from Availity claim form.'] };
}

async function stepSubmit() {
  const res = await sendToSite('availity.com', { type: 'CASTIFY_SUBMIT_CLAIM' }, 120000);
  return res || { ok: false, error: 'No response from Availity submit.' };
}

/* ---------- AI ---------- */

async function getSkillText() {
  try {
    const url = chrome.runtime.getURL('skills/SKILL.md');
    const r = await fetch(url);
    if (r.ok) return await r.text();
  } catch (_) {}
  const { skillText } = await store.get(['skillText']);
  return skillText || '';
}

async function aiComplete({ system, user, maxTokens = 1200 }) {
  const settings = await getSettings();
  const key = (settings.aiApiKey || '').trim();
  if (!key) return { ok: false, error: 'No AI API key set. Add one in Castify Options → AI.' };
  const provider = settings.aiProvider || 'anthropic';
  try {
    if (provider === 'anthropic') {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
        body: JSON.stringify({ model: settings.aiModel || 'claude-haiku-4-5-20251001', max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] })
      });
      const j = await r.json();
      if (!r.ok) return { ok: false, error: j.error?.message || `Anthropic error ${r.status}` };
      return { ok: true, text: (j.content || []).map((b) => b.text || '').join('') };
    }
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: settings.aiModel || 'gpt-4o-mini', max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] })
    });
    const j = await r.json();
    if (!r.ok) return { ok: false, error: j.error?.message || `OpenAI error ${r.status}` };
    return { ok: true, text: j.choices?.[0]?.message?.content || '' };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

async function aiReviewClaim(claim) {
  const skill = await getSkillText();
  const system = `${skill}\n\nYou are reviewing ONE claim before submission. Reply with PASS or FAIL on the first line, then bullet issues.`;
  const user = `Claim data:\n${JSON.stringify(claim, null, 2)}`;
  return aiComplete({ system, user });
}

async function aiSuggest(contextText) {
  const skill = await getSkillText();
  const system = `${skill}\n\nSuggest concrete workflow improvements: new validation rules, fallback strategies, or unbilled reasons. Be specific and terse.`;
  return aiComplete({ system, user: contextText, maxTokens: 1600 });
}

/* ---------- backend sync ---------- */

async function syncToBackend() {
  const settings = await getSettings();
  if (!settings.backendUrl || !settings.backendToken) return { ok: false, error: 'Backend not configured' };
  const base = settings.backendUrl.replace(/\/$/, '');
  const { billed, unbilled, claims } = await store.get(['billed', 'unbilled', 'claims']);
  try {
    const r = await fetch(`${base}/api/claims/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${settings.backendToken}` },
      body: JSON.stringify({ billed: billed || [], unbilled: unbilled || [], claims: claims || [], at: new Date().toISOString() })
    });
    const j = await r.json().catch(() => ({}));
    return r.ok ? { ok: true } : { ok: false, error: j.error || `Backend error ${r.status}` };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/* ---------- message router ---------- */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case 'GET_STATE': {
          const s = await store.get(['claims', 'billed', 'unbilled', 'queue', 'eventLog', 'settings']);
          return { ok: true, state: s, queueRunning };
        }
        case 'SAVE_SETTINGS': {
          const cur = await getSettings();
          await store.set({ settings: { ...cur, ...(msg.settings || {}) } });
          return { ok: true };
        }
        case 'SCAN_MAGELLAN': {
          const timeout = msg.allPages ? 600000 : 60000;
          const res = await sendToSite('magellanehr.com', { type: 'CASTIFY_SCAN_MAGELLAN', allPages: !!msg.allPages }, timeout);
          if (res && res.ok) {
            const prev = await getClaims();
            const prevById = Object.fromEntries(prev.map((c) => [c.id, c]));
            const merged = res.claims.map((c) => ({ ...(prevById[c.id] || {}), ...c, status: (prevById[c.id] || {}).status || 'ready' }));
            await saveClaims(merged);
            await store.set({ kpis: res.kpis, scannedAt: res.scannedAt });
            broadcast({ type: 'SCAN_DONE', count: merged.length, pages: res.pages || 1 });
          }
          return res || { ok: false, error: 'No response from Magellan page.' };
        }
        case 'CASTIFY_SCAN_PROGRESS': {
          broadcast({ type: 'SCAN_PROGRESS', page: msg.page, claims: msg.claims, done: !!msg.done });
          return { ok: true };
        }
        case 'OPEN_PATIENT': {
          return await sendToSite('magellanehr.com', { type: 'CASTIFY_GOTO_PATIENT', patientHref: msg.patientHref }, 15000);
        }
        case 'PATIENT_PREVIEW': {
          const list = await getClaims();
          const claim = list.find((c) => c.id === msg.id);
          if (!claim) return { ok: false, error: 'Claim not found. Scan again first.' };
          return await previewPatientFlow(claim);
        }
        case 'START_QUEUE': return await startQueue(msg.ids || [], msg.mode);
        case 'STOP_QUEUE': return await stopQueue();
        case 'REVIEW_DECISION': return { ok: resolveReview(msg.decision) };
        case 'AI_REVIEW_CLAIM': return await aiReviewClaim(msg.claim);
        case 'AI_SUGGEST': return await aiSuggest(msg.context || '');
        case 'GET_SKILL': return { ok: true, text: await getSkillText() };
        case 'SAVE_SKILL': await store.set({ skillText: msg.text }); return { ok: true };
        case 'SYNC_BACKEND': return await syncToBackend();
        case 'CLEAR_DATA': await store.set({ claims: [], billed: [], unbilled: [], eventLog: [], queue: null }); return { ok: true };
        default: return { ok: false, error: 'Unknown message: ' + msg.type };
      }
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  })().then(sendResponse);
  return true;
});

// open side panel when the toolbar icon is clicked
chrome.action.onClicked.addListener(async (tab) => {
  try { await chrome.sidePanel.open({ tabId: tab.id }); } catch (_) {}
});
chrome.runtime.onInstalled.addListener(async () => {
  const s = await getSettings();
  await store.set({ settings: s });
});
