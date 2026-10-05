/* Castify — Magellan EHR content script.
 * Runs on magellanehr.com. Scrapes the Ready-to-Bill claims table,
 * reads patient authorization records, and writes submission notes back.
 * All selectors are defensive and overridable via options (selector config).
 */
(() => {
  'use strict';

  const DEFAULT_SELECTORS = {
    // Header texts used to identify the claims table columns (case-insensitive, substring match)
    tableHeaders: ['patient', 'mrn', 'payer', 'member id', 'billing provider',
      'rendering provider', 'center', 'service date', 'cpt', 'units', 'charges',
      'auth balance', 'status'],
    // Auth tab markers
    authCardMarker: 'Authorizations',
    // Note / activity UI (best effort — tune in Options if needed)
    noteSelectors: [
      'textarea[placeholder*="note" i]', 'textarea[name*="note" i]',
      '[data-testid*="note"] textarea', '.claim-notes textarea'
    ]
  };

  let SELECTORS = { ...DEFAULT_SELECTORS };
  chrome.storage.local.get(['selectorConfig'], (r) => {
    if (r.selectorConfig && r.selectorConfig.magellan) {
      SELECTORS = { ...DEFAULT_SELECTORS, ...r.selectorConfig.magellan };
    }
  });

  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // innerText isn't implemented in every DOM (e.g. jsdom); fall back to textContent
  const elText = (el) => (el && (el.innerText ?? el.textContent)) || '';

  async function waitFor(fn, timeout = 15000, interval = 400) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(interval);
    }
    return null;
  }

  /* ---------- Ready-to-Bill table scraping ---------- */

  function findClaimsTable() {
    const tables = [...document.querySelectorAll('table')];
    for (const t of tables) {
      const headers = [...t.querySelectorAll('thead th, thead td')].map((h) => norm(h.textContent).toLowerCase());
      if (headers.length < 5) continue;
      const hits = SELECTORS.tableHeaders.filter((h) =>
        headers.some((hh) => hh.includes(h)));
      if (hits.length >= 6) return { table: t, headers };
    }
    return null;
  }

  function colIndex(headers, ...names) {
    for (const n of names) {
      const i = headers.findIndex((h) => h.includes(n));
      if (i >= 0) return i;
    }
    return -1;
  }

  function cellText(row, i) {
    const cells = row.querySelectorAll('td');
    return i >= 0 && cells[i] ? norm(cells[i].textContent) : '';
  }

  function parseMoney(s) {
    const m = (s || '').replace(/[^0-9.\-]/g, '');
    const v = parseFloat(m);
    return Number.isFinite(v) ? v : 0;
  }

  function parseUnits(s) {
    const m = (s || '').match(/[\d.]+/);
    return m ? parseFloat(m[0]) : 0;
  }

  // Patient link: Magellan's table markup varies — try several strategies.
  function findPatientLink(row, patientCell, patientName) {
    const hrefOf = (a) => (a && a.getAttribute('href')) || '';
    const usable = (h) => h && !/^javascript:/i.test(h) && h !== '#';
    let a = patientCell && (patientCell.querySelector('a[href*="patientId"]') || patientCell.querySelector('a[href*="patient"]'));
    if (!a && patientCell) a = patientCell.querySelector('a[href]');
    const rowLinks = [...row.querySelectorAll('a[href]')];
    if (!a && patientName) {
      const key = norm(patientName).split(',')[0].toLowerCase();
      if (key) a = rowLinks.find((x) => norm(x.textContent).toLowerCase().includes(key));
    }
    if (!a) a = rowLinks[0];
    if (a && usable(hrefOf(a))) return hrefOf(a);
    const dh = (patientCell && patientCell.querySelector('[data-href]')) || row.querySelector('[data-href]');
    if (dh && dh.getAttribute('data-href')) return dh.getAttribute('data-href');
    return '';
  }

  // Find a row action (icon link/button next to the patient name) by text, href,
  // title or aria-label. Falls back to position: 1st icon = demographics, 2nd = encounter/auth.
  function findRowActionEl(row, kind, patientCell, patientHref) {
    const patterns = kind === 'demographics' ? [/demograph/i] : [/encounter|authoriz/i];
    const els = [...row.querySelectorAll('a[href], button')];
    let el = els.find((e) => {
      const h = e.getAttribute('href') || '';
      if (h && patientHref && h === patientHref) return false; // the patient name link itself
      if (norm(e.textContent).length > 40 && !patterns.some((re) => re.test(norm(e.textContent)))) return false;
      const hay = norm(e.textContent) + ' ' + h + ' ' +
        (e.getAttribute('title') || '') + ' ' + (e.getAttribute('aria-label') || '');
      return patterns.some((re) => re.test(hay));
    });
    if (!el && patientCell) {
      const icons = [...patientCell.querySelectorAll('a[href], button')].filter((e) => {
        const h = e.getAttribute('href') || '';
        if (h && patientHref && h === patientHref) return false; // the name link itself
        return norm(e.textContent).length <= 30; // icon buttons have little/no text
      });
      el = icons[kind === 'demographics' ? 0 : 1] || null;
    }
    return el || null;
  }

  function rowActionTarget(el) {
    if (!el) return { href: '', clickable: false };
    const h = el.getAttribute && el.getAttribute('href');
    if (h && !/^javascript:/i.test(h) && h !== '#') return { href: h, clickable: false };
    return { href: '', clickable: true };
  }

  function rowActionFields(row, patientCell, patientHref) {
    const d = rowActionTarget(findRowActionEl(row, 'demographics', patientCell, patientHref));
    const e = rowActionTarget(findRowActionEl(row, 'encounter', patientCell, patientHref));
    return {
      demographicsHref: d.href, demographicsClickable: d.clickable,
      encounterHref: e.href, encounterClickable: e.clickable
    };
  }

  function scanReadyToBill() {
    const found = findClaimsTable();
    if (!found) return { ok: false, error: 'Claims table not found on this page. Open Billing → Claims (Ready to Bill).' };
    const { table, headers } = found;
    const idx = {
      patient: colIndex(headers, 'patient'),
      mrn: colIndex(headers, 'mrn'),
      payer: colIndex(headers, 'payer'),
      memberId: colIndex(headers, 'member id'),
      billingProvider: colIndex(headers, 'billing provider'),
      renderingProvider: colIndex(headers, 'rendering provider'),
      center: colIndex(headers, 'center'),
      scheduled: colIndex(headers, 'scheduled'),
      serviceDate: colIndex(headers, 'service date'),
      cpt: colIndex(headers, 'cpt'),
      units: colIndex(headers, 'u.', 'units'),
      charges: colIndex(headers, 'charges'),
      authBalance: colIndex(headers, 'auth balance'),
      status: colIndex(headers, 'status')
    };

    const rows = [...table.querySelectorAll('tbody tr')];
    const claims = [];
    for (const row of rows) {
      const status = cellText(row, idx.status);
      if (!/ready/i.test(status) && status) continue; // only READY rows
      const patientCell = idx.patient >= 0 ? row.querySelectorAll('td')[idx.patient] : null;
      const patientName = cellText(row, idx.patient);
      const patientLink = findPatientLink(row, patientCell, patientName);
      const payerCell = idx.payer >= 0 ? row.querySelectorAll('td')[idx.payer] : null;
      claims.push({
        id: `${cellText(row, idx.mrn)}|${cellText(row, idx.serviceDate)}|${cellText(row, idx.cpt)}|${cellText(row, idx.units)}`,
        patient: patientName,
        patientHref: patientLink || '',
        ...rowActionFields(row, patientCell, patientLink),
        mrn: cellText(row, idx.mrn),
        payer: cellText(row, idx.payer),
        memberId: cellText(row, idx.memberId).replace(/\s+/g, ''),
        billingProvider: cellText(row, idx.billingProvider),
        billingNpi: (cellText(row, idx.billingProvider).match(/\b\d{10}\b/) || [''])[0],
        renderingProvider: cellText(row, idx.renderingProvider),
        center: cellText(row, idx.center),
        scheduled: cellText(row, idx.scheduled),
        serviceDate: cellText(row, idx.serviceDate),
        cpt: (cellText(row, idx.cpt).match(/\b\d{5}\b/) || [''])[0],
        units: parseUnits(cellText(row, idx.units)),
        charges: parseMoney(cellText(row, idx.charges)),
        authBalance: cellText(row, idx.authBalance),
        status: status || 'READY',
        source: 'magellan'
      });
    }

    // KPI cards if present
    const kpis = {};
    document.querySelectorAll('[class*="kpi"], [class*="Kpi"], [class*="stat"]').forEach(() => {});
    const bodyText = elText(document.body);
    const grab = (label) => {
      const m = bodyText.match(new RegExp(label + '\\s*\\$?\\s*([\\d,]+(?:\\.\\d+)?)', 'i'));
      return m ? m[1] : '';
    };
    kpis.claims = grab('CLAIMS');
    kpis.totalUnits = grab('TOTAL UNITS');
    kpis.uniquePatients = grab('UNIQUE PATIENTS');
    kpis.outstanding = grab('Outstanding Claims Balance');
    kpis.expected = grab('Expected Reimbursement');

    return { ok: true, claims, kpis, scannedAt: new Date().toISOString() };
  }

  /* ---------- Authorization tab scraping ---------- */

  function parseDate(s) {
    const str = s || '';
    let m = str.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) return new Date(+m[3], +m[1] - 1, +m[2]);
    // Magellan also renders dates like "Oct 2, 2026"
    m = str.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2}),?\s+(\d{4})/i);
    if (m) {
      const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
      return new Date(+m[3], months[m[1].toLowerCase().slice(0, 3)], +m[2]);
    }
    return null;
  }

  function scrapeAuthorizations() {
    return extractAuths(true);
  }

  // strict=true requires an "authorization" section on the page (auth tab);
  // strict=false just hunts auth-number cards anywhere (icon-opened pages).
  // root lets us scope the hunt to a modal instead of the whole document.
  function extractAuths(strict, root) {
    const doc = root && root !== document ? root : document;
    const bodyEl = doc === document ? document.body : doc;
    // Text with spaces at element boundaries, so adjacent inline elements
    // (e.g. <span>UM123</span><span>1/1/2026</span>) don't glue tokens together.
    const spacedText = (node) => {
      const parts = [];
      try {
        const wdoc = (node && node.ownerDocument) || document;
        const walker = wdoc.createTreeWalker(node, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = walker.nextNode())) {
          const t = (n.nodeValue || '').replace(/\s+/g, ' ').trim();
          if (t) parts.push(t);
        }
      } catch (e) { return elText(node); }
      return parts.join(' ');
    };
    const text = spacedText(bodyEl);
    if (strict && !/authorization/i.test(text)) {
      return { ok: false, error: 'No authorization section found on this page.' };
    }
    const auths = [];
    const NUM_RE = /\b[A-Z]{2}\d{6,}\b/; // non-global: safe for .test()

    // Candidate auth numbers in a text: the known UM123456789 shape, plus a
    // fallback for other shapes — a token following an "Authorization"/"Auth #"
    // label (with 3+ digits, not a date). The label match tolerates the plural
    // ("Authorizations 260512329713") and "Auth." variants.
    const findCandidates = (t) => {
      const cands = [];
      const seen = new Set();
      const push = (num, idx) => {
        if (!num || seen.has(num)) return;
        seen.add(num);
        cands.push({ num, idx });
      };
      const re = /\b[A-Z]{2}\d{6,}\b/g;
      let m;
      while ((m = re.exec(t))) push(m[0], m.index);
      const labRe = /(?:authorizations?|auth\.?)(?:\s*(?:no|number|#))?\s*[:#-]?\s*([A-Z0-9][A-Z0-9\-]{4,24})/gi;
      while ((m = labRe.exec(t))) {
        const tok = m[1];
        if (!/\d{3,}/.test(tok)) continue;
        if (/^\d{4}-\d{2}-\d{2}$/.test(tok) || /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(tok)) continue;
        push(tok, m.index + m[0].indexOf(tok));
      }
      cands.sort((a, b) => a.idx - b.idx);
      return cands;
    };

    const parseOne = (num, ctx) => {
      if (!num || auths.some((a) => a.number === num)) return;
      const period = ctx.match(/(\d{1,2}\/\d{1,2}\/\d{4})\s*[–—-]\s*(\d{1,2}\/\d{1,2}\/\d{4})/)
        || ctx.match(/(\d{4}-\d{2}-\d{2})\s*(?:to|–|—|-)\s*(\d{4}-\d{2}-\d{2})/i);
      const codes = [...new Set([...ctx.matchAll(/\b97\d{3}\b/g)].map((m) => m[0]))];
      const authUnits = (ctx.match(/Authorized\s*([\d,]+)/i) || [])[1];
      const usedUnits = (ctx.match(/(?:Scheduled estimate used|Used)\s*([\d,]+)/i) || [])[1];
      const remUnits = (ctx.match(/(?:remaining|Remaining)\s*([\d,]+)/i) || [])[1];
      auths.push({
        number: num,
        periodStart: period ? period[1] : '',
        periodEnd: period ? period[2] : '',
        codes,
        authorizedUnits: authUnits ? parseInt(authUnits.replace(/,/g, ''), 10) : null,
        usedUnits: usedUnits ? parseInt(usedUnits.replace(/,/g, ''), 10) : 0,
        remainingUnits: remUnits ? parseInt(remUnits.replace(/,/g, ''), 10) : null,
        raw: ctx.slice(0, 600)
      });
    };
    const allNumsIn = (t) => findCandidates(t).map((c) => c.num);

    // 1) Card-based: leaf-most auth-ish elements only (a wrapper like .auth-list
    //    must not swallow its cards). Each card contributes ALL numbers it holds.
    //    The pre-filter also accepts label-hinted elements so pure-digit auth
    //    numbers (e.g. "Authorizations 260512329713") are not screened out.
    const AUTH_HINT_RE = /(?:authorizations?|auth\.?)(?:\s*(?:no|number|#))?\s*[:#-]?\s*[A-Z0-9][A-Z0-9\-]{4,24}/i;
    const allMatches = [...doc.querySelectorAll('[class*="auth"], [class*="Auth"], [class*="AUTH"]')]
      .filter((el) => NUM_RE.test(el.textContent || '') || AUTH_HINT_RE.test(el.textContent || ''));
    const cards = allMatches.filter((el) => !allMatches.some((o) => o !== el && el.contains(o)));
    const seenCardTexts = new Set();
    for (const card of cards) {
      const t = spacedText(card);
      if (seenCardTexts.has(t)) continue;
      seenCardTexts.add(t);
      allNumsIn(t).forEach((num) => parseOne(num, t));
    }

    // 2) Sweep the whole scope for numbers the card detection missed. Each number
    //    gets a non-overlapping segment: from the number itself up to the next one.
    const allNums = findCandidates(text);
    for (let i = 0; i < allNums.length; i++) {
      const { num, idx } = allNums[i];
      if (auths.some((a) => a.number === num)) continue;
      const nextIdx = i + 1 < allNums.length ? allNums[i + 1].idx : text.length;
      parseOne(num, text.slice(idx, nextIdx));
    }
    return { ok: true, auths };
  }

  function checkAuthForClaim(claim, auths) {
    const dos = parseDate(claim.serviceDate);
    const matches = [];
    for (const a of auths) {
      const issues = [];
      const start = parseDate(a.periodStart);
      const end = parseDate(a.periodEnd);
      if (start && end && dos && (dos < start || dos > end)) {
        issues.push(`DOS ${claim.serviceDate} outside auth period ${a.periodStart}–${a.periodEnd}`);
      }
      if (a.codes.length && claim.cpt && !a.codes.includes(claim.cpt)) {
        issues.push(`CPT ${claim.cpt} not in authorized codes (${a.codes.join(', ')})`);
      }
      if (a.remainingUnits != null && claim.units > a.remainingUnits) {
        issues.push(`Insufficient auth units (need ${claim.units}, ${a.remainingUnits} remaining)`);
      }
      matches.push({ auth: a, ok: issues.length === 0, issues });
    }
    const valid = matches.find((m) => m.ok);
    if (valid) return { ok: true, auth: valid.auth, matches };
    if (!matches.length) {
      return { ok: false, reason: 'No authorization on file for this patient', matches };
    }
    return { ok: false, reason: matches[0].issues.join('; ') || 'Authorization invalid', matches };
  }

  /* ---------- Write-back: submission note in the EHR ---------- */

  async function writeBackNote({ claim, tcn, note }) {
    // Best effort: find a note/activity composer on the current claim or patient page.
    const box = await waitFor(() => {
      for (const sel of SELECTORS.noteSelectors) {
        const el = document.querySelector(sel);
        if (el && el.offsetParent !== null) return el;
      }
      return null;
    }, 8000);
    if (!box) {
      return { ok: false, error: 'Note field not found on this page — TCN kept in Castify (manual write-back needed).' };
    }
    const text = note || `Claim submitted via Castify — Availity TCN ${tcn}`;
    box.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, text);
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(400);
    // Try to find and click a save/add button near the box
    const container = box.closest('form') || box.parentElement;
    const btn = container ? [...container.querySelectorAll('button')]
      .find((b) => /save|add|post|submit/i.test(b.textContent || '')) : null;
    if (btn) btn.click();
    return { ok: true, saved: !!btn, note: text };
  }

  // Generic labeled-field scraper ("Date of Birth: 01/15/2018", "Place of Service: Office", …)
  function scrapeFields(scope) {
    const fields = {};
    const seen = new Set();
    const els = [...scope.querySelectorAll('*')];
    for (const el of els) {
      if (el.children.length > 3) continue;
      if (el.closest('script, style, noscript')) continue;
      const t = norm(el.textContent);
      if (!t || t.length > 80) continue;
      const m = t.match(/^([A-Za-z][A-Za-z0-9 .()/#-]{1,40})[:：]\s*(.+)?$/);
      if (!m) continue;
      const label = m[1].trim();
      let value = (m[2] || '').trim();
      if (!value) {
        const sib = el.nextElementSibling;
        if (sib && !sib.children.length) value = norm(sib.textContent).slice(0, 150);
      }
      if (!value || value.startsWith('{') || value.startsWith('//')) continue;
      const key = label.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      fields[label] = value.slice(0, 200);
      if (Object.keys(fields).length >= 50) break;
    }
    return fields;
  }

  // Fallback: regex-hunt common fields when the page has no "Label: value" layout
  function huntCommonFields(text) {
    const out = {};
    const grab = (label, re) => { const m = text.match(re); if (m && m[1]) out[label] = m[1].trim(); };
    grab('Date of Birth', /\b(?:DOB|Date of Birth)\b\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{4}|[A-Z][a-z]{2,9}\s+\d{1,2},?\s+\d{4})/i);
    grab('Phone', /(\(\d{3}\)\s*\d{3}[-.\s]?\d{4}|\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b)/);
    grab('Member ID', /\bMember ID\b\s*:?\s*([A-Z0-9-]{4,25})/i);
    grab('Place of Service', /\bPlace of Service\b\s*:?\s*([A-Za-z .()/-]{2,40})/i);
    grab('Gender', /\bGender\b\s*:?\s*(Male|Female)\b/i);
    return out;
  }

  /* ---------- Paginated scan: walk "Next" through all table pages ---------- */

  function isHidden(el) {
    let n = el;
    while (n && n !== document.body) {
      if (n.hidden) return true;
      const s = (n.getAttribute('style') || '').replace(/\s/g, '').toLowerCase();
      if (s.includes('display:none') || s.includes('visibility:hidden')) return true;
      n = n.parentElement;
    }
    return false;
  }

  function findNextButton() {
    const cands = [...document.querySelectorAll('a, button')];
    for (const el of cands) {
      const t = norm(el.textContent);
      const aria = el.getAttribute('aria-label') || '';
      if (/^\s*next[\s›»→]*$/i.test(t) || /^(›|»|→)$/.test(t) || /next page/i.test(aria)) {
        if (el.disabled || el.getAttribute('aria-disabled') === 'true' || /\bdisabled\b/i.test(el.className)) continue;
        if (isHidden(el)) continue;
        return el;
      }
    }
    return null;
  }

  function tableSignature() {
    const found = findClaimsTable();
    if (!found) return '';
    const rows = [...found.table.querySelectorAll('tbody tr')];
    if (!rows.length) return 'empty';
    return rows.length + '|' + norm(rows[0].textContent).slice(0, 80) + '|' +
      norm(rows[rows.length - 1].textContent).slice(0, 80);
  }

  async function waitForTableChange(before, timeout) {
    const end = Date.now() + (timeout || 12000);
    while (Date.now() < end) {
      await sleep(600);
      const sig = tableSignature();
      if (sig && sig !== before) return true;
    }
    return false;
  }

  async function scanAllPages() {
    const all = [];
    const seen = new Set();
    let kpis = {};
    let page = 0;
    const MAX_PAGES = 100;
    const pushProgress = (done) => {
      try {
        chrome.runtime.sendMessage({ type: 'CASTIFY_SCAN_PROGRESS', page, claims: all.length, done: !!done });
      } catch (_) { /* background may be briefly busy; progress is best-effort */ }
    };
    while (page < MAX_PAGES) {
      page++;
      const res = scanReadyToBill();
      if (!res.ok) {
        if (page === 1) return res;
        break; // table vanished mid-walk — keep what we collected
      }
      for (const c of res.claims) {
        if (!seen.has(c.id)) { seen.add(c.id); all.push(c); }
      }
      kpis = res.kpis || kpis;
      pushProgress(false);
      const before = tableSignature();
      const next = findNextButton();
      if (!next) break;
      next.click();
      const changed = await waitForTableChange(before, 12000);
      if (!changed) break; // no more pages (or table didn't reload)
    }
    pushProgress(true);
    return { ok: true, claims: all, kpis, pages: page, scannedAt: new Date().toISOString() };
  }

  /* ---------- Patient modal (the icon next to the patient name opens it) ---------- */

  // Find the patient detail modal: the container holding an "Authorizations" tab
  // alongside "Demographics" with substantial content.
  function findPatientModal() {
    const tabs = [...document.querySelectorAll('a, button, [role="tab"]')].filter((el) =>
      /^\s*authorizations?\s*$/i.test(el.textContent || ''));
    for (const t of tabs) {
      let n = t.parentElement;
      for (let i = 0; i < 8 && n && n !== document.body; i++) {
        const txt = norm(n.textContent || '');
        if (/demographics/i.test(txt) && txt.length > 300) return n;
        n = n.parentElement;
      }
    }
    return null;
  }

  async function waitForPatientModal(timeout) {
    const end = Date.now() + (timeout || 9000);
    while (Date.now() < end) {
      const m = findPatientModal();
      if (m && norm(m.textContent).length > 300) return m;
      await sleep(400);
    }
    return null;
  }

  function scrapeModalDemographics(modal) {
    const fields = {};
    const text = elText(modal);
    // form label -> input pairs: honor <label for> first, then pair each label
    // with the next unassigned input in document order
    const assigned = new Set();
    const takeValue = (input) => {
      let v = '';
      if (/^select$/i.test(input.tagName)) {
        const opt = input.options[input.selectedIndex];
        v = opt ? norm(opt.textContent) : '';
      } else v = norm(input.value);
      return (!v || /^select\.{0,3}$/i.test(v)) ? '' : v;
    };
    modal.querySelectorAll('label[for]').forEach((lb) => {
      const name = norm(lb.textContent).replace(/\*+\s*$/, '').trim();
      if (!name || fields[name] || name.length > 40) return;
      const fid = (lb.getAttribute('for') || '').replace(/[^a-zA-Z0-9_-]/g, '');
      let input = null;
      try { input = fid ? modal.querySelector('#' + fid) : null; } catch (_) {}
      if (input && !assigned.has(input)) {
        const v = takeValue(input);
        if (v) { fields[name] = v; assigned.add(input); }
      }
    });
    let pending = null;
    modal.querySelectorAll('label, input, select, textarea').forEach((el) => {
      const tag = el.tagName.toLowerCase();
      if (tag === 'label' && !el.getAttribute('for')) {
        const name = norm(el.textContent).replace(/\*+\s*$/, '').trim();
        pending = (name && name.length <= 40 && !fields[name]) ? name : null;
      } else if (tag !== 'label' && pending && !assigned.has(el)) {
        const v = takeValue(el);
        if (v) { fields[pending] = v; assigned.add(el); }
        pending = null;
      }
    });
    // header line fills gaps: "DOB: May 1, 2023  Age: 3y  MRN: A07G"
    const dob = text.match(/DOB\s*:?\s*([A-Z][a-z]+\s+\d{1,2},?\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{4})/i);
    if (dob && !fields['Date of Birth']) fields['Date of Birth'] = dob[1];
    const age = text.match(/Age\s*:?\s*(\d+\s*y)/i);
    if (age && !fields['Age']) fields['Age'] = age[1];
    const mrn = text.match(/MRN\s*:?\s*([A-Z0-9]{3,12})/i);
    if (mrn && !fields['MRN']) fields['MRN'] = mrn[1];
    Object.assign(fields, scrapeFields(modal));
    if (Object.keys(fields).length < 3) Object.assign(fields, huntCommonFields(text));
    return fields;
  }

  async function scrapeModalAuthorizations(modal) {
    const findTab = (root) => {
      const cands = [...root.querySelectorAll('a, button, [role="tab"]')]
        .filter((el) => /^\s*authorizations?\s*$/i.test(el.textContent || ''));
      // Prefer a real tablist tab over stray nav links sharing the label.
      return cands.find((el) => (el.closest && el.closest('[role="tablist"]')) || el.getAttribute('role') === 'tab')
        || cands[0];
    };
    const isSelected = (el) => {
      if (!el) return false;
      if (el.getAttribute('aria-selected') === 'true') return true;
      return /\bactive\b|\bselected\b/i.test(el.className || '');
    };
    // The panel belonging to the tab: aria-controls target, else the visible tabpanel.
    const tabPanel = (root, tabEl) => {
      if (tabEl) {
        const id = (tabEl.getAttribute('aria-controls') || '').replace(/[^a-zA-Z0-9_-]/g, '');
        if (id) { try { const p = root.querySelector('#' + id); if (p) return p; } catch (_) {} }
      }
      const panels = [...root.querySelectorAll('[role="tabpanel"]')];
      const vis = panels.filter((p) => { try { return p.getClientRects().length > 0; } catch (e) { return false; } });
      return vis[0] || panels[0] || root;
    };
    // True when the panel actually shows the auth list (or its empty state).
    // v1.1.6 trusted the tab's selected flag alone and skipped the click that
    // loads the data — this check is the actual source of truth. Accepts both
    // UM-shaped numbers and digit tokens following an authorization label
    // (e.g. "Authorizations 260512329713").
    const panelReady = (panel) => {
      const t = norm(panel.textContent);
      return /\b[A-Z]{2}\d{6,}\b/.test(t)
        || /authorizations?\s*[:#-]?\s*\d[\d\-]{4,24}/i.test(t)
        || /no authorizations?/i.test(t);
    };
    let tab = findTab(modal);
    if (!tab) return { ok: false, error: 'Authorizations tab not found in the patient window' };
    let clicked = false;
    let switched = false;
    let panel = tabPanel(modal, tab);
    if (!(isSelected(tab) && panelReady(panel))) {
      tab.click();
      clicked = true;
    }
    // Wait for the panel to actually show auth content. The click may remount
    // the modal (stale references), so re-find the modal and tab each poll.
    const end = Date.now() + 20000;
    while (Date.now() < end) {
      await sleep(500);
      const fresh = findPatientModal();
      if (fresh) { modal = fresh; tab = findTab(modal) || tab; }
      panel = tabPanel(modal, tab);
      if (panelReady(panel)) { switched = true; break; }
    }
    // Brief settle for late-arriving cards on slow networks.
    const sEnd = Date.now() + 2000;
    let lastN = -1;
    while (Date.now() < sEnd) {
      await sleep(500);
      const n = (norm(panel.textContent).match(/\b[A-Z]{2}\d{6,}\b/g) || []).length;
      if (n === lastN) break;
      lastN = n;
    }
    const finalModal = findPatientModal() || modal;
    const r = extractAuths(false, finalModal);
    r.tabSwitched = switched;
    r.clicked = clicked;
    r.panelChars = norm(panel.textContent).length;
    r.panelSnippet = norm(panel.textContent).slice(0, 320);
    return r;
  }

  function closePatientModal() {
    const modal = findPatientModal();
    if (!modal) return true;
    const btn = [...modal.querySelectorAll('button, a')].find((el) =>
      /^\s*(×|x|close)$/i.test(el.textContent || '') || /close/i.test(el.getAttribute('aria-label') || ''));
    if (btn) btn.click();
    else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return true;
  }

  /* ---------- Message router ---------- */

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      try {
        if (msg.type === 'CASTIFY_PING') return { ok: true, site: 'magellan', url: location.href };
        if (msg.type === 'CASTIFY_SCAN_MAGELLAN') {
          if (msg.allPages) return await scanAllPages();
          return scanReadyToBill();
        }
        if (msg.type === 'CASTIFY_SCRAPE_AUTH') return scrapeAuthorizations();
        if (msg.type === 'CASTIFY_CHECK_AUTH') {
          const authRes = scrapeAuthorizations();
          if (!authRes.ok) return authRes;
          return checkAuthForClaim(msg.claim, authRes.auths);
        }
        if (msg.type === 'CASTIFY_GOTO' && msg.url) {
          const url = msg.url;
          setTimeout(() => { try { location.href = url; } catch (_) {} }, 60);
          return { ok: true, navigating: true };
        }
        if (msg.type === 'CASTIFY_SCRAPE_FIELDS') {
          const fields = scrapeFields(document.body);
          if (Object.keys(fields).length < 3) Object.assign(fields, huntCommonFields(elText(document.body)));
          return { ok: true, fields };
        }
        if (msg.type === 'CASTIFY_FIND_AUTHS') {
          return extractAuths(false);
        }
        if (msg.type === 'CASTIFY_OPEN_PATIENT_MODAL') {
          const key = norm(msg.patient || '').toLowerCase();
          const mrn = norm(msg.mrn || '').toLowerCase();
          const found = findClaimsTable();
          const rows = found ? [...found.table.querySelectorAll('tbody tr')] : [];
          for (const row of rows) {
            const rt = norm(row.textContent).toLowerCase();
            if (!((key && rt.includes(key)) || (mrn && rt.includes(mrn)))) continue;
            const cells = row.querySelectorAll('td');
            const pCell = cells[0] || row;
            const pLink = findPatientLink(row, pCell, msg.patient);
            const el = findRowActionEl(row, 'demographics', pCell, pLink);
            if (!el) return { ok: false, error: 'Patient icon not found on the row' };
            el.click();
            const modal = await waitForPatientModal(9000);
            if (!modal) return { ok: false, error: 'Patient window did not open after clicking the icon' };
            return { ok: true, opened: true };
          }
          return { ok: false, error: 'Patient row not found on this page' };
        }
        if (msg.type === 'CASTIFY_READ_CAPTURED_URL') {
          const u = document.documentElement.getAttribute('data-castify-opened-url');
          if (!u) return { ok: false };
          document.documentElement.removeAttribute('data-castify-opened-url');
          try { return { ok: true, url: new URL(u, location.origin).toString() }; }
          catch (e) { return { ok: true, url: u }; }
        }
        if (msg.type === 'CASTIFY_NOTE_READY') {
          const btn = [...document.querySelectorAll('button, a')].find((b) =>
            /print note/i.test(b.textContent || '') || /printable pdf/i.test(b.getAttribute('title') || ''));
          const bodyTxt = norm(document.body ? document.body.textContent : '').slice(0, 3000);
          const hasNote = /session note|edit session note|note title|participants present/i.test(bodyTxt);
          return { ok: true, ready: !!(btn || hasNote) };
        }
        if (msg.type === 'CASTIFY_SCRAPE_MODAL') {
          let modal = findPatientModal();
          if (!modal) modal = await waitForPatientModal(6000);
          if (!modal) return { ok: false, error: 'Patient window is not open' };
          if (msg.tab === 'authorizations') {
            const r = await scrapeModalAuthorizations(modal);
            if (!r.ok) return r;
            // pass through the full diagnostics (v1.1.6 dropped these, making the line meaningless)
            return { ok: true, auths: r.auths, clicked: r.clicked, tabSwitched: r.tabSwitched, panelChars: r.panelChars, panelSnippet: r.panelSnippet };
          }
          return { ok: true, fields: scrapeModalDemographics(modal) };
        }
        if (msg.type === 'CASTIFY_CLOSE_MODAL') {
          closePatientModal();
          return { ok: true };
        }
        if (msg.type === 'CASTIFY_CLICK_ROW_ACTION') {
          // Click the icon next to the patient name (opens demographics/encounter, often in a new tab)
          const key = norm(msg.patient || '').toLowerCase();
          const mrn = norm(msg.mrn || '').toLowerCase();
          const found = findClaimsTable();
          const rows = found ? [...found.table.querySelectorAll('tbody tr')] : [];
          for (const row of rows) {
            const rt = norm(row.textContent).toLowerCase();
            if (!((key && rt.includes(key)) || (mrn && rt.includes(mrn)))) continue;
            const cells = row.querySelectorAll('td');
            const pCell = cells[0] || row;
            const pLink = findPatientLink(row, pCell, msg.patient);
            const el = findRowActionEl(row, msg.action === 'demographics' ? 'demographics' : 'encounter', pCell, pLink);
            if (el) { el.click(); return { ok: true, clicked: true }; }
            return { ok: false, error: 'Action icon not found on the patient row' };
          }
          return { ok: false, error: 'Patient row not found on this page' };
        }
        if (msg.type === 'CASTIFY_GOTO_PATIENT' && msg.patientHref) {
          const url = new URL(msg.patientHref, location.origin).toString();
          setTimeout(() => { try { location.href = url; } catch (_) {} }, 60);
          return { ok: true, navigating: true };
        }
        if (msg.type === 'CASTIFY_GOTO_AUTH_TAB') {
          if (msg.patientHref) {
            const url = new URL(msg.patientHref, location.origin);
            url.searchParams.set('tab', 'authorizations');
            const href = url.toString();
            setTimeout(() => { try { location.href = href; } catch (_) {} }, 60);
            return { ok: true, navigating: true };
          }
          // Already on the patient page (click-through fallback): click the Authorizations tab.
          const tab = [...document.querySelectorAll('a, button, [role="tab"]')]
            .find((el) => /^\s*authorizations?\s*$/i.test(el.textContent || ''));
          if (tab) { tab.click(); return { ok: true, clickedTab: true }; }
          return { ok: false, error: 'Authorizations tab not found on this page' };
        }
        if (msg.type === 'CASTIFY_CLICK_PATIENT_LINK') {
          // Fallback when the claims table has no usable patient href: find the
          // row by patient name/MRN and click its patient element.
          const key = norm(msg.patient || '').toLowerCase();
          const mrn = norm(msg.mrn || '').toLowerCase();
          const found = findClaimsTable();
          const rows = found ? [...found.table.querySelectorAll('tbody tr')] : [...document.querySelectorAll('tbody tr')];
          for (const row of rows) {
            const rt = norm(row.textContent).toLowerCase();
            if ((key && rt.includes(key)) || (mrn && rt.includes(mrn))) {
              const clickable = row.querySelector('a[href], button, [role="link"], [role="button"], [tabindex]') || row.querySelector('td');
              if (clickable) { clickable.click(); return { ok: true, clicked: true }; }
              return { ok: false, error: 'Patient row is not clickable' };
            }
          }
          return { ok: false, error: 'Patient row not found on this page' };
        }
        if (msg.type === 'CASTIFY_WRITEBACK') return await writeBackNote(msg);
        return { ok: false, error: 'Unknown message: ' + msg.type };
      } catch (e) {
        return { ok: false, error: String(e && e.message || e) };
      }
    })().then(sendResponse);
    return true;
  });
})();
