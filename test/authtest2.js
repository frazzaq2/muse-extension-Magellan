// Test v1.1.4: labeled fallback for non-UM auth formats + CASTIFY_NOTE_READY
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
  // T1: non-UM format picked up via "Authorization #" label
  const html1 = `<html><body><h1>Authorizations</h1><div class="panel">
    <div>Authorization # AB98765432</div><div>Period 4/1/2026 - 9/30/2026</div><div>Codes 97155</div>
  </div></body></html>`;
  const r1 = await send(load(html1, 'https://magellanehr.com/patients?x=1'), { type: 'CASTIFY_FIND_AUTHS' });
  const a1 = (r1 && r1.auths) || [];
  out.push(`T1 labeled fallback: ${a1.length === 1 && a1[0].number === 'AB98765432' ? 'PASS' : `FAIL (${JSON.stringify(a1.map((a) => a.number))})`}`);
  out.push(`T1 fallback period: ${a1[0] && a1[0].periodStart === '4/1/2026' ? 'PASS' : `FAIL (${a1[0] && a1[0].periodStart})`}`);

  // T2: no false positives from member IDs / dates near auth words
  const html2 = `<html><body><h1>Authorizations</h1><p>No authorizations on file. Member ID 222118973950. Call 2026-10-05 for help.</p></body></html>`;
  const r2 = await send(load(html2, 'https://magellanehr.com/patients?x=1'), { type: 'CASTIFY_FIND_AUTHS' });
  const a2 = (r2 && r2.auths) || [];
  out.push(`T2 no false positives: ${a2.length === 0 ? 'PASS' : `FAIL (${JSON.stringify(a2.map((a) => a.number))})`}`);

  // T3: NOTE_READY true when print button present (title-based, like the real one)
  const html3 = `<html><body><h1>Edit Session Note</h1><button type="button" title="Open a printable PDF of this note"><svg></svg>Print note</button></body></html>`;
  const r3 = await send(load(html3, 'https://magellanehr.com/clinical/notes/1'), { type: 'CASTIFY_NOTE_READY' });
  out.push(`T3 note ready (button): ${r3 && r3.ready === true ? 'PASS' : `FAIL (${JSON.stringify(r3)})`}`);

  // T4: NOTE_READY false on a bare loading page
  const html4 = `<html><body><div id="root"></div></body></html>`;
  const r4 = await send(load(html4, 'https://magellanehr.com/clinical/notes/1'), { type: 'CASTIFY_NOTE_READY' });
  out.push(`T4 note not ready (empty): ${r4 && r4.ready === false ? 'PASS' : `FAIL (${JSON.stringify(r4)})`}`);

  console.log(out.join('\n'));
  process.exit(0);
})().catch((e) => { console.error('HARNESS FAIL:', e && e.message); process.exit(1); });
