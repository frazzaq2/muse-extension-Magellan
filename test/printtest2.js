// Test v1.1.6: w=window.open(''); w.location.href=blobUrl pattern + fetch spy
const fs = require('fs');
const { JSDOM } = require('/home/hatch/workspace/castify/test/node_modules/jsdom');
const SRC = fs.readFileSync('/home/hatch/workspace/castify/extension/background.js', 'utf8');
const out = [];
function grab(name) {
  const start = SRC.indexOf('async function ' + name);
  let depth = 0; const k = SRC.indexOf('{', start);
  for (let p = k; p < SRC.length; p++) {
    if (SRC[p] === '{') depth++;
    else if (SRC[p] === '}') { depth--; if (!depth) return SRC.slice(start, p + 1); }
  }
  throw new Error('unbalanced');
}
const fnSrc = grab('capturePrintPdfFn');
function makeDom(clickImpl) {
  const dom = new JSDOM(
    `<html><body><h1>Edit Session Note</h1><button type="button" title="Open a printable PDF of this note">Print note</button></body></html>`,
    { url: 'https://magellanehr.com/clinical/notes/1', runScripts: 'outside-only' }
  );
  const { window } = dom;
  window.URL.createObjectURL = function (blob) {
    return 'blob:https://magellanehr.com/' + Math.random().toString(16).slice(2);
  };
  const realFetch = window.fetch;
  window.fetch = (...a) => Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) });
  const btn = window.document.querySelector('button');
  btn.addEventListener('click', () => clickImpl(window));
  return new window.Function(`${fnSrc}; return capturePrintPdfFn();`)();
}
const pdfBytes = Buffer.from('%PDF-1.4\n1 0 obj<</Title(Test)>>endobj\ntrailer', 'latin1');
(async () => {
  // T1: w = window.open(''); w.location.href = blobUrl  (empty-open then assign)
  const t1 = await makeDom((window) => {
    const w = window.open('', '_blank');
    const blob = new window.Blob([pdfBytes], { type: 'application/pdf' });
    w.location.href = window.URL.createObjectURL(blob);
  });
  out.push(`T1 location.href pattern: ${t1 && t1.ok && t1.pdfBase64 ? 'PASS' : `FAIL (${JSON.stringify(t1).slice(0, 200)})`}`);
  if (t1 && t1.pdfBase64) {
    out.push(`T1 bytes match: ${Buffer.from(t1.pdfBase64, 'base64').equals(pdfBytes) ? 'PASS' : 'FAIL'}`);
  }
  // T2: async handler that fetches first (fetch spy should record it)
  const t2 = await makeDom((window) => {
    window.fetch('/api/notes/1/pdf-data').catch(() => {});
    setTimeout(() => {
      const blob = new window.Blob([pdfBytes], { type: 'application/pdf' });
      const a = window.document.createElement('a');
      a.href = window.URL.createObjectURL(blob); a.target = '_blank';
      window.document.body.appendChild(a); a.click(); a.remove();
    }, 300);
  });
  out.push(`T2 async+fetch flow: ${t2 && t2.ok ? 'PASS' : `FAIL (${JSON.stringify(t2).slice(0, 200)})`}`);
  out.push(`T2 fetch spy: ${(t2 && t2.fetchUrls && t2.fetchUrls[0] === '/api/notes/1/pdf-data') ? 'PASS' : `FAIL (${JSON.stringify(t2 && t2.fetchUrls)})`}`);
  // T3: handler that does nothing -> error carries diagnostics
  const t3 = await makeDom(() => {});
  out.push(`T3 silent handler: ${t3 && !t3.ok && t3.error === 'Print view did not open' && t3.buttonCount === 1 && t3.matchedBy === 'text' ? 'PASS' : `FAIL (${JSON.stringify(t3).slice(0, 200)})`}`);
  console.log(out.join('\n'));
  process.exit(0);
})().catch((e) => { console.error('HARNESS FAIL:', e && e.stack.split('\n')[0]); process.exit(1); });
