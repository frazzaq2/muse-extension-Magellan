// Test v1.1.5: capturePrintPdfFn catches blob via createObjectURL hook (anchor-click flow)
const fs = require('fs');
const { JSDOM } = require('/home/hatch/workspace/castify/test/node_modules/jsdom');
const SRC = fs.readFileSync('/home/hatch/workspace/castify/extension/background.js', 'utf8');
const out = [];

// extract capturePrintPdfFn source
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
  // jsdom lacks createObjectURL — stub it like a browser (real blob: URL shape)
  const blobs = new Map();
  window.URL.createObjectURL = function (blob) {
    const url = 'blob:https://magellanehr.com/' + Math.random().toString(16).slice(2);
    blobs.set(url, blob);
    return url;
  };
  window.openedAnchors = [];
  const btn = window.document.querySelector('button');
  btn.addEventListener('click', () => clickImpl(window, blobs));
  // run the function in page context
  const p = new window.Function(`${fnSrc}; return capturePrintPdfFn();`)();
  return p;
}

(async () => {
  // T1: print flow opens blob via anchor click (NOT window.open)
  const pdfBytes = Buffer.from('%PDF-1.4\n1 0 obj<</Title(Test)>>endobj\ntrailer', 'latin1');
  const t1 = await makeDom((window) => {
    const blob = new window.Blob([pdfBytes], { type: 'application/pdf' });
    const url = window.URL.createObjectURL(blob);
    const a = window.document.createElement('a');
    a.href = url; a.target = '_blank';
    window.document.body.appendChild(a); a.click(); a.remove();
  });
  out.push(`T1 anchor-flow blob captured: ${t1 && t1.ok && t1.pdfBase64 ? 'PASS' : `FAIL (${JSON.stringify(t1).slice(0, 160)})`}`);
  if (t1 && t1.pdfBase64) {
    const back = Buffer.from(t1.pdfBase64, 'base64');
    out.push(`T1 bytes round-trip: ${back.equals(pdfBytes) ? 'PASS' : `FAIL (${back.length} vs ${pdfBytes.length})`}`);
  }
  out.push(`T1 buttonCount reported: ${t1 && t1.buttonCount === 1 ? 'PASS' : `FAIL (${t1 && t1.buttonCount})`}`);
  out.push(`T1 matchedBy: ${t1 && t1.matchedBy === 'text' ? 'PASS' : `FAIL (${t1 && t1.matchedBy})`}`);

  // T2: print flow via window.open still works
  const t2 = await makeDom((window) => {
    const blob = new window.Blob([pdfBytes], { type: 'application/pdf' });
    window.open(window.URL.createObjectURL(blob), '_blank');
  });
  out.push(`T2 window.open flow: ${t2 && t2.ok && t2.pdfBase64 ? 'PASS' : `FAIL (${JSON.stringify(t2).slice(0, 160)})`}`);

  // T3: no Print note button -> clear error + buttonCount
  const dom3 = new JSDOM(`<html><body><div id="root"></div></body></html>`, { url: 'https://magellanehr.com/x', runScripts: 'outside-only' });
  const w3 = dom3.window;
  w3.URL.createObjectURL = () => 'blob:x';
  const t3 = await new w3.Function(`${fnSrc}; return capturePrintPdfFn();`)();
  out.push(`T3 missing button: ${t3 && !t3.ok && t3.error === 'Print note button not found' && t3.buttonCount === 0 ? 'PASS' : `FAIL (${JSON.stringify(t3).slice(0, 120)})`}`);

  console.log(out.join('\n'));
  process.exit(0);
})().catch((e) => { console.error('HARNESS FAIL:', e && e.stack.split('\n')[0]); process.exit(1); });
