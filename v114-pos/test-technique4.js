// Tests for technique 4 with faithful header replay + one-time learn flow.
const fs = require('fs');
const src = fs.readFileSync('/home/hatch/workspace/castify/v114-pos/castify-v1.1.4/background.js', 'utf8');
const out = [];
const grab = (name) => {
  const m = src.match(new RegExp('async function ' + name + '[\\s\\S]*?\\n}\\n'));
  if (!m) throw new Error('missing ' + name);
  return m[0];
};
(async () => {
  // ---- learnPdfRequestFn: resolves with url + full request shape ----
  {
    const realFetch = async (url, init) => ({
      url, status: 200,
      headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'application/pdf' : '') },
    });
    const win = { fetch: realFetch };
    global.window = win;
    const fn = eval('(' + grab('learnPdfRequestFn') + ')');
    const p = fn();
    setTimeout(() => win.fetch('https://api.magellanehr.com/api/notes/12859/pdf',
      { method: 'GET', headers: { authorization: 'Bearer tok123', 'x-app': '1' }, credentials: 'include' }), 50);
    const r = await p;
    out.push(`T1 learn resolves pdf url: ${r && r.url === 'https://api.magellanehr.com/api/notes/12859/pdf' ? 'PASS' : `FAIL (${JSON.stringify(r)})`}`);
    out.push(`T2 learn captures auth headers: ${r && r.init && r.init.headers && r.init.headers.authorization === 'Bearer tok123' ? 'PASS' : `FAIL (${JSON.stringify(r && r.init)})`}`);
    out.push(`T3 learn captures method+credentials: ${r && r.init && r.init.method === 'GET' && r.init.credentials === 'include' ? 'PASS' : 'FAIL'}`);
    out.push(`T4 fetch restored after learn: ${win.fetch === realFetch ? 'PASS' : 'FAIL'}`);
  }
  // ---- learnPdfRequestFn: timeout resolves null, fetch restored ----
  {
    const realFetch = async () => ({ url: '', status: 200, headers: { get: () => '' } });
    const win = { fetch: realFetch };
    global.window = win;
    const origST = global.setTimeout;
    global.setTimeout = (fn, ms) => origST(fn, 5); // async like the real one
    const fn = eval('(' + grab('learnPdfRequestFn') + ')');
    const r = await fn();
    global.setTimeout = origST;
    out.push(`T5 learn timeout resolves null: ${r === null ? 'PASS' : `FAIL (${JSON.stringify(r)})`}`);
    out.push(`T6 fetch restored on timeout: ${win.fetch === realFetch ? 'PASS' : 'FAIL'}`);
  }
  // ---- fetchPdfDirectFn: sends recorded init, returns bytes ----
  {
    const pdfBytes = new Uint8Array([37, 80, 68, 70, 45]);
    let seenInit = null;
    global.fetch = async (url, init) => { seenInit = init; return { ok: true, arrayBuffer: async () => pdfBytes.buffer.slice(0) }; };
    global.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
    const fn = eval('(' + grab('fetchPdfDirectFn') + ')');
    const r = await fn('https://api.magellanehr.com/api/notes/12859/pdf',
      { method: 'GET', headers: { authorization: 'Bearer tok123' }, credentials: 'include' });
    const back = r.ok ? Buffer.from(r.pdfBase64, 'base64') : null;
    out.push(`T7 direct fetch returns bytes: ${r.ok && back && back[0] === 37 ? 'PASS' : `FAIL (${JSON.stringify(r).slice(0, 100)})`}`);
    out.push(`T8 replay sends recorded headers: ${seenInit && seenInit.headers && seenInit.headers.authorization === 'Bearer tok123' && seenInit.credentials === 'include' ? 'PASS' : `FAIL (${JSON.stringify(seenInit)})`}`);
    global.fetch = async () => ({ ok: false, status: 403 });
    const r2 = await fn('https://api.magellanehr.com/api/notes/1/pdf', null);
    out.push(`T9 direct fetch reports 403: ${!r2.ok && /403/.test(r2.error) ? 'PASS' : `FAIL (${JSON.stringify(r2)})`}`);
  }
  const mkRunner = (extras) => {
    const fnSrc = grab('learnPdfRequestFn') + '\n' + grab('fetchPdfDirectFn') + '\n' + grab('openPatientPrintBlob');
    return new Function('claim', 'chrome', 'findTab', 'captureIconUrl', 'extractPdfText', 'parsePrintFields',
      'store', 'broadcast', 'printBlobUrls', 'URL', 'Blob', 'atob',
      fnSrc + '\nreturn openPatientPrintBlob(claim);');
  };
  const baseStubs = () => {
    const calls = [];
    const pdfB64 = Buffer.from([37, 80, 68, 70]).toString('base64');
    const chrome = {
      tabs: {
        create: async (o) => { calls.push(['tabs.create', String(o.url).slice(0, 50), !!o.active]); return { id: 400 }; },
        remove: async (id) => { calls.push(['tabs.remove', id]); },
        query: async () => [],
      },
      scripting: { executeScript: async (o) => { calls.push(['exec', o.func.name || 'anon', (o.args || [])[0], (o.args || [])[1] || null]); return [{ result: { ok: true, pdfBase64: pdfB64 } }]; } },
      storage: { local: { get: async () => ({}), set: async () => {} } },
      runtime: { sendMessage: () => Promise.resolve() },
    };
    return { calls, chrome, pdfB64 };
  };
  // ---- technique-4 path: template+init replayed, 403 invalidates template ----
  {
    const { calls, chrome } = baseStubs();
    global.URL.createObjectURL = () => 'blob:chrome-extension://t/u2';
    global.Blob = class {};
    global.atob = (s) => Buffer.from(s, 'base64').toString('binary');
    const findTab = async () => ({ id: 7 });
    const captureIconUrl = async () => ({ ok: true, url: 'https://magellanehr.com/clinical/notes/12859?popup=1' });
    const store = { get: async () => ({ pdfTemplate: { template: 'https://api.magellanehr.com/api/notes/{id}/pdf', generalizable: true, init: { method: 'GET', headers: { authorization: 'Bearer tok123' }, credentials: 'include' } } }), set: async () => {} };
    const runner = mkRunner();
    const r = await runner({ id: 'c1' }, chrome, findTab, captureIconUrl, async () => '', () => ({}), store, () => {}, {}, global.URL, global.Blob, global.atob);
    const execCalls = calls.filter((c) => c[0] === 'exec');
    out.push(`T10 t4 replay ok: ${r.ok ? 'PASS' : `FAIL (${JSON.stringify(r)})`}`);
    out.push(`T11 replay used swapped id + recorded init: ${execCalls.length === 1 && /12859\/pdf/.test(execCalls[0][2]) && execCalls[0][3] && execCalls[0][3].headers.authorization === 'Bearer tok123' ? 'PASS' : `FAIL (${JSON.stringify(execCalls)})`}`);
  }
  // ---- learn path: records url+headers, saves template, completes request ----
  {
    const { calls, chrome } = baseStubs();
    let saved = null;
    const broadcasts = [];
    chrome.scripting.executeScript = async (o) => {
      const name = o.func.name || '';
      calls.push(['exec', name]);
      if (name === 'learnPdfRequestFn') return [{ result: { url: 'https://api.magellanehr.com/api/notes/12859/pdf', status: 200, init: { method: 'GET', headers: { authorization: 'Bearer tok123' }, credentials: 'include' } } }];
      return [{ result: { ok: true, pdfBase64: Buffer.from([37, 80, 68, 70]).toString('base64') } }];
    };
    const findTab = async () => ({ id: 7 });
    const captureIconUrl = async () => ({ ok: true, url: 'https://magellanehr.com/clinical/notes/12859?popup=1' });
    const store = { get: async () => ({}), set: async (o) => { saved = o; } };
    const runner = mkRunner();
    const r = await runner({ id: 'c1' }, chrome, findTab, captureIconUrl, async () => '', () => ({}), store, (m) => broadcasts.push(m.type), {}, global.URL, global.Blob, global.atob);
    out.push(`T12 learn path ok: ${r.ok ? 'PASS' : `FAIL (${JSON.stringify(r)})`}`);
    out.push(`T13 template+headers saved: ${saved && saved.pdfTemplate && saved.pdfTemplate.template === 'https://api.magellanehr.com/api/notes/{id}/pdf' && saved.pdfTemplate.init.headers.authorization === 'Bearer tok123' ? 'PASS' : `FAIL (${JSON.stringify(saved)})`}`);
    out.push(`T14 user prompted: ${broadcasts.includes('POS_LEARN') ? 'PASS' : 'FAIL'}`);
  }
  // ---- learn path: server 403 on the learned request -> clear refusal ----
  {
    const { chrome } = baseStubs();
    chrome.scripting.executeScript = async (o) => {
      if ((o.func.name || '') === 'learnPdfRequestFn') return [{ result: { url: 'https://api.magellanehr.com/api/notes/67503/pdf', status: 403, init: {} } }];
      return [{ result: { ok: false, error: 'HTTP 403' } }];
    };
    const findTab = async () => ({ id: 7 });
    const captureIconUrl = async () => ({ ok: true, url: 'https://magellanehr.com/clinical/notes/67503?popup=1' });
    const store = { get: async () => ({}), set: async () => {} };
    const runner = mkRunner();
    const r = await runner({ id: 'c1' }, chrome, findTab, captureIconUrl, async () => '', () => ({}), store, () => {}, {}, global.URL, global.Blob, global.atob);
    out.push(`T15 server 403 reported clearly: ${!r.ok && /403/.test(r.error) ? 'PASS' : `FAIL (${JSON.stringify(r)})`}`);
  }
  console.log(out.join('\n'));
  process.exit(0);
})().catch((e) => { console.error('HARNESS FAIL:', e && e.message); process.exit(1); });
