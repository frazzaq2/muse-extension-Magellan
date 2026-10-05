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

// Clicks "Print note", catches the print-view blob URL, and returns the document bytes as base64.
async function capturePrintPdfFn() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    let blobUrl = null;
    const origOpen = window.open;
    window.open = function (url) {
      try { blobUrl = String(url); } catch (e) {}
      return { closed: false, close() {}, focus() {}, blur() {} };
    };
    let btn = null;
    const endBtn = Date.now() + 6000;
    while (!btn && Date.now() < endBtn) {
      btn = [...document.querySelectorAll('button, a')].find((b) =>
        /^\s*print note\s*$/i.test(b.textContent || '') || /printable pdf/i.test(b.getAttribute('title') || ''));
      if (!btn) await sleep(300);
    }
    if (!btn) { window.open = origOpen; return { ok: false, error: 'Print note button not found' }; }
    btn.click();
    const end = Date.now() + 10000;
    while (!blobUrl && Date.now() < end) await sleep(200);
    window.open = origOpen;
    if (!blobUrl) return { ok: false, error: 'Print view did not open' };
    const resp = await fetch(blobUrl);
    const buf = await resp.arrayBuffer();
    if (!buf || !buf.byteLength) return { ok: false, error: 'Print document was empty' };
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    return { ok: true, pdfBase64: btoa(bin) };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// Technique 4 worker: fetch a PDF URL directly inside the page (the browser
// attaches the login session automatically). Zero button clicking.
// `init` carries the exact method/headers/credentials recorded during learning,
// because the API refuses requests without the app's auth headers (HTTP 403).
// Runs in the page's MAIN world, self-contained for executeScript.
async function fetchPdfDirectFn(url, init) {
  try {
    const r = await fetch(url, {
      credentials: (init && init.credentials) || 'include',
      method: (init && init.method) || 'GET',
      headers: (init && init.headers) || {},
    });
    if (!r.ok) return { ok: false, error: 'HTTP ' + r.status };
    const buf = await r.arrayBuffer();
    if (!buf || !buf.byteLength) return { ok: false, error: 'Empty PDF response' };
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    return { ok: true, pdfBase64: btoa(bin) };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// One-time learning for technique 4: wrap fetch and resolve with the first PDF
// request seen — URL *plus* its full shape (method/headers/credentials), so the
// replay is faithful and the server doesn't 403 it. The user clicks Print note
// manually once (a real gesture, so the request is guaranteed to fire).
// Runs in the page's MAIN world, self-contained for executeScript.
async function learnPdfRequestFn() {
  return await new Promise((resolve) => {
    const orig = window.fetch;
    let done = false;
    const finish = (info) => {
      if (done) return;
      done = true;
      try { window.fetch = orig; } catch (e) {}
      resolve(info || null);
    };
    setTimeout(() => finish(null), 90000);
    window.fetch = async function (...args) {
      const resp = await orig.apply(this, args);
      try {
        const u = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
        let ct = '';
        let status = 0;
        try { ct = (resp.headers && resp.headers.get('content-type')) || ''; } catch (e) {}
        try { status = resp.status || 0; } catch (e) {}
        if (/pdf/i.test(u) || /application\/pdf/i.test(ct)) {
          const rawInit = (args[1] && typeof args[1] === 'object') ? args[1] : {};
          const headers = {};
          try {
            const h = rawInit.headers;
            if (h && typeof h.forEach === 'function') h.forEach((v, k) => { headers[String(k)] = String(v); });
            else if (h && typeof h === 'object') for (const k of Object.keys(h)) headers[k] = String(h[k]);
          } catch (e) {}
          finish({ url: String(u), status, init: { method: rawInit.method || 'GET', headers, credentials: rawInit.credentials || 'same-origin' } });
        }
      } catch (e) {}
      return resp;
    };
  });
}

// Technique 1 (fetch hook): catch the PDF at the network instead of chasing
// the blob window. We wrap window.fetch BEFORE clicking Print note; our wrapper
// calls the real fetch, but clones any response whose URL mentions "pdf" (or
// whose content-type is application/pdf) and keeps the bytes for ourselves.
// The original response continues to the page untouched, so the app's own
// flow (blob tab etc.) is unaffected. Runs in the page's MAIN world,
// self-contained for executeScript.
async function capturePrintPdfViaFetchFn() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const origFetch = window.fetch;
  const restore = () => { try { if (window.fetch !== origFetch) window.fetch = origFetch; } catch (e) {} };
  try {
    const btn = [...document.querySelectorAll('button, a')].find((b) =>
      /^\s*print note\s*$/i.test(b.textContent || '') || /printable pdf/i.test(b.getAttribute('title') || ''));
    if (!btn) return { ok: false, error: 'Print note button not found' };
    let pdfBuf = null;
    let pdfUrl = '';
    window.fetch = async function (...args) {
      const resp = await origFetch.apply(this, args);
      try {
        const u = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
        let ct = '';
        try { ct = (resp.headers && resp.headers.get('content-type')) || ''; } catch (e) {}
        if (!pdfBuf && (/pdf/i.test(u) || /application\/pdf/i.test(ct))) {
          pdfUrl = String(u).slice(0, 160);
          const ab = await resp.clone().arrayBuffer();
          if (ab && ab.byteLength) pdfBuf = ab;
        }
      } catch (e) {}
      return resp;
    };
    btn.click();
    const end = Date.now() + 15000;
    while (!pdfBuf && Date.now() < end) await sleep(250);
    restore();
    if (!pdfBuf) return { ok: false, error: 'PDF response not seen', pdfUrl };
    const bytes = new Uint8Array(pdfBuf);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    return { ok: true, pdfBase64: btoa(bin), pdfUrl };
  } catch (e) {
    restore();
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
async function waitForNoteReady(tabId, timeout = 30000) {
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
      diag.push(`authorizations: modal auths=${(a.auths || []).length} switched=${!!a.tabSwitched} panelChars=${a.panelChars || 0}`);
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

// Open the encounter's "Print note" view in the hidden tab, read the generated
// document, and merge its fields (incl. Place of Service) into the preview.
async function captureEncounterPrint(tabId, diag, out) {
  try {
    const pr = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: capturePrintPdfFn });
    const r0 = pr && pr[0] && pr[0].result;
    if (!r0 || !r0.ok || !r0.pdfBase64) {
      diag.push(`encounter: print note failed (${(r0 && r0.error) || 'no result'})`);
      return;
    }
    const bytes = Uint8Array.from(atob(r0.pdfBase64), (c) => c.charCodeAt(0));
    diag.push(`encounter: print doc bytes=${bytes.length}`);
    const text = await extractPdfText(bytes);
    const pf = parsePrintFields(text);
    Object.assign(out.encounter, pf);
    if (pf['Place of Service']) out.placeOfService = pf['Place of Service'];
    diag.push(`encounter: print fields=${Object.keys(pf).length} pos=${pf['Place of Service'] || '?'}`);
  } catch (e) {
    diag.push(`encounter: print error ${String((e && e.message) || e)}`);
  }
}

// POS button: runs the Print-note flow for the encounter and OPENS the
// resulting PDF blob in a new tab for the user (Place of Service lives in it).
// The blob is captured through the Print note button exactly like the preview
// flow does, then re-opened via an extension-created tab (not popup-blocked).
const printBlobUrls = {}; // keep Blob refs alive while their tabs are open
async function openPatientPrintBlob(claim) {
  const tab = await findTab('magellanehr.com');
  if (!tab) return { ok: false, error: 'Magellan is not open. Open magellanehr.com and log in first.' };
  const cap = await captureIconUrl(tab, claim, 'encounter');
  if (!cap || !cap.ok || !cap.url) return { ok: false, error: (cap && cap.error) || 'Could not open the encounter note.' };
  const noteId = (String(cap.url).match(/\/clinical\/notes\/(\d+)/) || [])[1] || '';

  const openBlobForUser = async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    let pos = '';
    try {
      const pf = parsePrintFields(await extractPdfText(bytes));
      if (pf['Place of Service']) pos = pf['Place of Service'];
    } catch (e) {}
    // Extension-created tab: not popup-blocked, unlike the page's window.open.
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    printBlobUrls[url] = blob;
    await chrome.tabs.create({ url, active: true });
    return pos;
  };

  // Technique 4: direct fetch with the learned URL template — zero clicking.
  // The existing Magellan tab already carries the login session; the recorded
  // headers make the replay faithful so the server doesn't 403 it.
  const stored = await store.get(['pdfTemplate']);
  const tpl = stored && stored.pdfTemplate;
  if (tpl && tpl.template && tpl.generalizable !== false && noteId) {
    try {
      const url = tpl.template.split('{id}').join(noteId);
      const pr = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func: fetchPdfDirectFn, args: [url, tpl.init || null] });
      const r0 = pr && pr[0] && pr[0].result;
      if (r0 && r0.ok && r0.pdfBase64) {
        const pos = await openBlobForUser(r0.pdfBase64);
        return { ok: true, pos };
      }
      // 403/401 or site change — the saved request shape no longer works.
      if (r0 && /HTTP 40[13]/.test(r0.error || '')) {
        try { await store.set({ pdfTemplate: null }); } catch (e) {}
      }
    } catch (e) {}
  }

  // Learn once: open the note visibly and ask the user to click its
  // "Print note" button a single time. A real gesture guarantees the
  // request fires; we record its URL *and headers* for all future notes.
  broadcast({ type: 'POS_LEARN', text: 'A note tab just opened — please click its "Print note" button once. I’ll learn the PDF address; after that it’s fully automatic.' });
  let lt = null;
  try {
    lt = await chrome.tabs.create({ url: cap.url, active: true });
    const lr = await chrome.scripting.executeScript({ target: { tabId: lt.id }, world: 'MAIN', func: learnPdfRequestFn });
    const learned = lr && lr[0] && lr[0].result;
    if (!learned || !learned.url) return { ok: false, error: 'No PDF request was seen. Click "Print note" in the opened tab, then press POS again.' };
    if (learned.status === 403 || learned.status === 401) {
      return { ok: false, error: 'The server refused the PDF request (HTTP ' + learned.status + ') for this note. It may not be printable right now.' };
    }
    let template = String(learned.url);
    if (noteId && template.includes(noteId)) template = template.split(noteId).join('{id}');
    await store.set({ pdfTemplate: { template, init: learned.init || null, generalizable: template.includes('{id}'), learnedAt: new Date().toISOString() } });
    // Use it immediately for this note — no second click needed.
    const pr = await chrome.scripting.executeScript({ target: { tabId: lt.id }, world: 'MAIN', func: fetchPdfDirectFn, args: [template.split('{id}').join(noteId), learned.init || null] });
    const r0 = pr && pr[0] && pr[0].result;
    if (!r0 || !r0.ok || !r0.pdfBase64) return { ok: false, error: (r0 && r0.error) || 'PDF fetch failed' };
    const pos = await openBlobForUser(r0.pdfBase64);
    return { ok: true, pos };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  } finally {
    if (lt) try { await chrome.tabs.remove(lt.id); } catch (_) {}
  }
}

async function previewPatientFlow(claim) {
  const tab = await findTab('magellanehr.com');
  if (!tab) return { ok: false, error: 'Magellan is not open. Open magellanehr.com and log in first.' };
  const out = { demographics: {}, auths: [], encounter: {}, placeOfService: '' };
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
        case 'PATIENT_OPEN_PRINT': {
          const list = await getClaims();
          const claim = list.find((c) => c.id === msg.id);
          if (!claim) return { ok: false, error: 'Claim not found. Scan again first.' };
          return await openPatientPrintBlob(claim);
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
