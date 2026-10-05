// Test technique 1: fetch-hook PDF capture, simulated page environment.
const fs = require('fs');
const src = fs.readFileSync('/home/hatch/workspace/castify/v114-pos/castify-v1.1.4/background.js', 'utf8');
const out = [];
(async () => {
  const m = src.match(/async function capturePrintPdfViaFetchFn[\s\S]*?\n}\n/);
  if (!m) { console.log('FN NOT FOUND'); process.exit(1); }
  const pdfBytes = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52]); // %PDF-1.4
  // fake page: fetchWithAuth-style wrapper calling window.fetch; button click triggers pdf fetch
  const mkResp = (url, ct) => ({
    url,
    headers: { get: (h) => (h.toLowerCase() === 'content-type' ? ct : '') },
    clone: () => ({ arrayBuffer: async () => pdfBytes.buffer.slice(0) }),
    arrayBuffer: async () => pdfBytes.buffer.slice(0),
  });
  const realFetch = async (url) => {
    if (/pdf/i.test(url)) return mkResp(url, 'application/pdf');
    return mkResp(url, 'application/json');
  };
  const win = { fetch: realFetch };
  const btn = { clicked: false, textContent: 'Print note', getAttribute: () => null,
    click() { this.clicked = true; win.fetch('https://api.magellanehr.com/api/notes/12714/pdf'); } };
  global.window = win;
  global.document = { querySelectorAll: () => [btn] };
  global.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
  const fn = eval('(' + m[0] + ')');
  const r = await fn();
  const back = r.ok ? Buffer.from(r.pdfBase64, 'base64') : null;
  out.push(`T1 button clicked: ${btn.clicked ? 'PASS' : 'FAIL'}`);
  out.push(`T2 pdf bytes captured via fetch clone: ${r.ok && back && back[0] === 37 && back.length === 8 ? 'PASS' : `FAIL (${JSON.stringify(r).slice(0, 120)})`}`);
  out.push(`T3 pdf url recorded: ${/pdf/i.test(r.pdfUrl || '') ? 'PASS' : `FAIL (${r.pdfUrl})`}`);
  out.push(`T4 fetch restored after capture: ${win.fetch === realFetch ? 'PASS' : 'FAIL'}`);
  // T5: non-pdf fetches are ignored
  const win2 = { fetch: realFetch };
  const btn2 = { textContent: 'Print note', getAttribute: () => null,
    click() { win2.fetch('https://api.magellanehr.com/api/ping'); } };
  global.window = win2;
  global.document = { querySelectorAll: () => [btn2] };
  const fn2 = eval('(' + m[0].replace('Date.now() + 15000', 'Date.now() + 1200') + ')');
  const r2 = await fn2();
  out.push(`T5 ignores non-pdf traffic: ${!r2.ok && /not seen/i.test(r2.error) ? 'PASS' : `FAIL (${JSON.stringify(r2).slice(0, 120)})`}`);
  out.push(`T6 fetch restored on failure path: ${win2.fetch === realFetch ? 'PASS' : 'FAIL'}`);
  console.log(out.join('\n'));
  process.exit(0);
})().catch((e) => { console.error('HARNESS FAIL:', e && e.message); process.exit(1); });
