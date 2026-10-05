// Test v1.1.10: pure-digit auth number after plural label ("Authorizations 260512329713"),
// plus the label-pattern hardening (no "s"-glue miss, no new false positives).
const fs = require('fs');
const { JSDOM } = require('/home/hatch/workspace/castify/test/node_modules/jsdom');
const SRC = fs.readFileSync('/home/hatch/workspace/castify/extension/content/magellan.js', 'utf8');
const out = [];
const send = (l, m) => new Promise((res) => { l(m, {}, res); setTimeout(() => res({ timeout: true }), 8000); });
function load(html, url) {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
  const { window } = dom;
  let listener = null;
  const chromeStub = { storage: { local: { get: (k, cb) => cb({}) } },
    runtime: { onMessage: { addListener: (fn) => { listener = fn; } }, sendMessage: () => Promise.resolve({}), getURL: (p) => p, lastError: null } };
  new Function('chrome', 'window', 'document', 'location', 'setTimeout', 'clearTimeout', 'Event', 'KeyboardEvent', 'URL', 'navigator', 'NodeFilter', `(function(){${SRC}})();`)
    .call({}, chromeStub, window, window.document, { href: url, origin: 'https://magellanehr.com' },
      setTimeout, clearTimeout, window.Event, window.KeyboardEvent, URL, { userAgent: 'node' }, window.NodeFilter);
  return listener;
}
(async () => {
  // T1: the user's real panel shape — digit-only auth number after plural label
  const html1 = `<html><body><div id="ws"><div role="tablist">
    <button role="tab" aria-selected="true">Demographics</button>
    <button role="tab" aria-selected="false">Authorizations</button></div>
    <div role="tabpanel"><h2>Therapy Authorizations</h2><button>+ Add ABA Authorization</button>
    <div class="auth-card"><div>ABA active</div><div>1 current authorizations</div>
    <div>Active ABA Authorizations</div><div class="auth-num">260512329713</div><div>ABA</div>
    <div>Track in Schedule</div><div>Eval + Therapy</div><div>Not started</div>
    <div>Period: 8/31/2026 - 11/25/2026</div><div>Insurance: Primary &middot; Aetna</div></div>
    </div></div></body></html>`;
  const r1 = await send(load(html1, 'https://magellanehr.com/patients?patientId=170'), { type: 'CASTIFY_FIND_AUTHS' });
  const a1 = (r1 && r1.auths) || [];
  out.push(`T1 plural-label digit auth captured: ${a1.length === 1 && a1[0].number === '260512329713' ? 'PASS' : `FAIL (${JSON.stringify(a1.map((a) => a.number))})`}`);
  out.push(`T1 period parsed: ${a1[0] && a1[0].periodStart === '8/31/2026' && a1[0].periodEnd === '11/25/2026' ? 'PASS' : `FAIL (${a1[0] && a1[0].periodStart} - ${a1[0] && a1[0].periodEnd})`}`);

  // T2: singular "Authorization:" still works (no regression)
  const html2 = `<html><body><div class="auth-card"><div>Authorization: UM9988776655</div><div>Period 1/5/2026 - 6/30/2026</div></div></body></html>`;
  const r2 = await send(load(html2, 'https://magellanehr.com/patients?x=2'), { type: 'CASTIFY_FIND_AUTHS' });
  const a2 = (r2 && r2.auths) || [];
  out.push(`T2 singular label still works: ${a2.length === 1 && a2[0].number === 'UM9988776655' ? 'PASS' : `FAIL (${JSON.stringify(a2.map((a) => a.number))})`}`);

  // T3: no false positives — "Authorization details" text, stray digits elsewhere
  const html3 = `<html><body><h1>Authorizations</h1><p>Authorization details are below. Member ID 222118973950.</p><p>Reviewed 2026.</p></body></html>`;
  const r3 = await send(load(html3, 'https://magellanehr.com/patients?x=3'), { type: 'CASTIFY_FIND_AUTHS' });
  const a3 = (r3 && r3.auths) || [];
  out.push(`T3 no false positives: ${a3.length === 0 ? 'PASS' : `FAIL (${JSON.stringify(a3.map((a) => a.number))})`}`);

  console.log(out.join('\n'));
  process.exit(0);
})().catch((e) => { console.error('HARNESS FAIL:', e && e.message); process.exit(1); });
