// Test v1.1.3: extractAuths finds ALL authorizations (multi-card + no-card fallback)
const fs = require('fs');
const { JSDOM } = require('/home/hatch/workspace/castify/test/node_modules/jsdom');
const SRC = fs.readFileSync('/home/hatch/workspace/castify/extension/content/magellan.js', 'utf8');
const out = [];
const send = (l, m) => new Promise((res) => { l(m, {}, res); setTimeout(() => res({ timeout: true }), 8000); });

function load(html, url) {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
  const { window } = dom;
  let listener = null;
  const chromeStub = {
    storage: { local: { get: (k, cb) => cb({}) } },
    runtime: { onMessage: { addListener: (fn) => { listener = fn; } }, sendMessage: () => Promise.resolve({}), getURL: (p) => p, lastError: null }
  };
  new Function('chrome', 'window', 'document', 'location', 'setTimeout', 'clearTimeout', 'Event', 'KeyboardEvent', 'URL', 'navigator', 'NodeFilter', `(function(){${SRC}})();`)
    .call({}, chromeStub, window, window.document, { href: url, origin: 'https://magellanehr.com' },
      setTimeout, clearTimeout, window.Event, window.KeyboardEvent, URL, { userAgent: 'node' }, window.NodeFilter);
  return listener;
}

(async () => {
  // T1: three auth cards with auth-ish classes, distinct periods/codes
  const cards = `<html><body><div class="auth-list">
    <div class="auth-card"><h4>UM103045286 [ABA]</h4><div>8/31/2026 – 1/22/2027</div><div>Codes 97151</div><div>Authorized 5120</div><div>Remaining 5080</div></div>
    <div class="auth-card"><h4>UM103099871 [ABA]</h4><div>2/1/2027 – 7/31/2027</div><div>Codes 97155, 97156</div><div>Authorized 2000</div><div>Remaining 2000</div></div>
    <div class="authCard"><h4>UM103100233</h4><div>Period 1/1/2027 - 12/31/2027</div><div>Codes 97153</div><div>Authorized 500</div><div>Used 120</div><div>Remaining 380</div></div>
  </div></body></html>`;
  const l1 = load(cards, 'https://magellanehr.com/patients?patientId=188');
  const r1 = await send(l1, { type: 'CASTIFY_FIND_AUTHS' });
  const a1 = (r1 && r1.auths) || [];
  out.push(`T1 three cards found: ${a1.length === 3 ? 'PASS' : `FAIL (${a1.length}: ${a1.map((a) => a.number).join(',')})`}`);
  const nums = a1.map((a) => a.number).sort();
  out.push(`T1 numbers: ${JSON.stringify(nums) === JSON.stringify(['UM103045286', 'UM103099871', 'UM103100233']) ? 'PASS' : `FAIL (${nums})`}`);
  const b = a1.find((a) => a.number === 'UM103099871') || {};
  out.push(`T1 per-card period: ${b.periodStart === '2/1/2027' && b.periodEnd === '7/31/2027' ? 'PASS' : `FAIL (${b.periodStart}-${b.periodEnd})`}`);
  out.push(`T1 per-card codes: ${JSON.stringify((b.codes || []).sort()) === JSON.stringify(['97155', '97156']) ? 'PASS' : `FAIL (${b.codes})`}`);
  const c = a1.find((a) => a.number === 'UM103100233') || {};
  out.push(`T1 units used/remaining: ${c.usedUnits === 120 && c.remainingUnits === 380 ? 'PASS' : `FAIL (${c.usedUnits}/${c.remainingUnits})`}`);

  // T2: no auth-ish classes — plain page text with two auth numbers
  const plain = `<html><body><h1>Authorizations</h1>
    <p>Authorization UM200111222 period 3/1/2026 – 8/31/2026 codes 97151 Authorized 100 Remaining 100</p>
    <p>Authorization UM200333444 period 9/1/2026 – 2/28/2027 codes 97155 Authorized 50 Remaining 25</p>
  </body></html>`;
  const l2 = load(plain, 'https://magellanehr.com/patients?patientId=188');
  const r2 = await send(l2, { type: 'CASTIFY_FIND_AUTHS' });
  const a2 = (r2 && r2.auths) || [];
  out.push(`T2 no-card fallback finds both: ${a2.length === 2 ? 'PASS' : `FAIL (${a2.length})`}`);
  const d = a2.find((a) => a.number === 'UM200333444') || {};
  out.push(`T2 second auth context: ${d.periodStart === '9/1/2026' && d.remainingUnits === 25 ? 'PASS' : `FAIL (${d.periodStart},${d.remainingUnits})`}`);

  // T3: duplicates across nested wrappers deduped
  const nested = `<html><body><div class="auth-wrapper"><div class="auth-card">
    <span>UM300555666</span><span>1/1/2026 – 12/31/2026</span><span>97151</span></div></div></body></html>`;
  const l3 = load(nested, 'https://magellanehr.com/patients?patientId=188');
  const r3 = await send(l3, { type: 'CASTIFY_FIND_AUTHS' });
  const a3 = (r3 && r3.auths) || [];
  out.push(`T3 nested dedupe: ${a3.length === 1 && a3[0].number === 'UM300555666' ? 'PASS' : `FAIL (${a3.length})`}`);

  console.log(out.join('\n'));
  process.exit(0);
})().catch((e) => { console.error('HARNESS FAIL:', e && e.message); process.exit(1); });
