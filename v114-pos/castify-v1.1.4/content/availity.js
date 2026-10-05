/* Castify — Availity Essentials content script.
 * Runs on essentials.availity.com. Automates:
 *  1) Eligibility & Benefits checks (with fallback search strategies)
 *  2) Professional claim form fill (header, patient, claim info, Dx,
 *     rendering provider, service facility, service lines)
 *  3) Claim submission + transaction ID capture
 * Works against Availity's React UI with defensive, text-anchored selectors.
 */
(() => {
  'use strict';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

  async function waitFor(fn, timeout = 20000, interval = 500) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      try { const v = fn(); if (v) return v; } catch (_) {}
      await sleep(interval);
    }
    return null;
  }

  /* ---------- DOM helpers for React/Angular-ish inputs ---------- */

  function setNativeValue(el, value) {
    el.focus();
    const proto = el.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Tab' }));
    el.blur();
  }

  // Find an input/textarea/select near a visible label text
  function fieldNearLabel(labelText) {
    const labels = [...document.querySelectorAll('label, span, div, p, legend')];
    const label = labels.find((el) =>
      el.children.length === 0 && norm(el.textContent).toLowerCase() === labelText.toLowerCase());
    const fuzzy = label || labels.find((el) =>
      norm(el.textContent).toLowerCase().includes(labelText.toLowerCase()) && el.children.length < 3);
    if (!fuzzy) return null;
    // associated control via `for`
    if (fuzzy.tagName === 'LABEL' && fuzzy.htmlFor) {
      const el = document.getElementById(fuzzy.htmlFor);
      if (el) return el;
    }
    const container = fuzzy.closest('div, fieldset, section, li') || fuzzy.parentElement;
    if (!container) return null;
    return container.querySelector('input, textarea, select, [role="combobox"], [role="listbox"]');
  }

  function findInputByLabels(...labelTexts) {
    for (const t of labelTexts) {
      const el = fieldNearLabel(t);
      if (el) return el;
    }
    return null;
  }

  async function pickDropdown(fieldEl, optionText, timeout = 12000) {
    if (!fieldEl) return false;
    const want = norm(optionText).toLowerCase();
    if (fieldEl.tagName === 'SELECT') {
      const opt = [...fieldEl.options].find((o) =>
        norm(o.textContent).toLowerCase().includes(want));
      if (opt) { fieldEl.value = opt.value; fieldEl.dispatchEvent(new Event('change', { bubbles: true })); return true; }
      return false;
    }
    // custom dropdown: click to open, then click matching option
    fieldEl.click();
    await sleep(600);
    const option = await waitFor(() => {
      const cands = [...document.querySelectorAll('[role="option"], li, div[class*="option" i], div[class*="item" i]')];
      return cands.find((c) => norm(c.textContent).toLowerCase().includes(want) && c.offsetParent !== null) || null;
    }, timeout);
    if (option) { option.click(); await sleep(500); return true; }
    // fallback: type into the field and press Enter on first suggestion
    if (/input/i.test(fieldEl.tagName) || fieldEl.getAttribute('role') === 'combobox') {
      setNativeValue(fieldEl, optionText);
      await sleep(1200);
      const first = [...document.querySelectorAll('[role="option"]')].find((c) => c.offsetParent !== null);
      if (first) { first.click(); await sleep(400); return true; }
      fieldEl.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
      await sleep(400);
      return true;
    }
    document.body.click();
    return false;
  }

  function clickButtonByText(...texts) {
    for (const t of texts) {
      const btn = [...document.querySelectorAll('button, a[class*="btn" i], input[type="submit"]')]
        .find((b) => norm(b.textContent).toLowerCase() === t.toLowerCase() && !b.disabled && b.offsetParent !== null);
      if (btn) { btn.click(); return btn; }
    }
    // fuzzy fallback
    for (const t of texts) {
      const btn = [...document.querySelectorAll('button')]
        .find((b) => norm(b.textContent).toLowerCase().includes(t.toLowerCase()) && !b.disabled && b.offsetParent !== null);
      if (btn) { btn.click(); return btn; }
    }
    return null;
  }

  function pageErrors() {
    return [...document.querySelectorAll('[class*="error" i], [role="alert"], .invalid-feedback')]
      .map((e) => norm(e.textContent)).filter((t) => t.length > 2 && t.length < 300)
      .filter((t, i, a) => a.indexOf(t) === i);
  }

  /* ---------- Eligibility & Benefits ---------- */

  const ELIG_STRATEGIES = [
    { name: 'id_dob', fields: ['patientId', 'dob'] },
    { name: 'name_dob', fields: ['lastName', 'firstName', 'dob'] },       // "without ID" search
    { name: 'name_dob_zip', fields: ['lastName', 'firstName', 'dob', 'zip'] }
  ];

  async function fillEligibility(claim, cfg, strategy) {
    const log = [];
    const set = async (labels, value, required = true) => {
      if (value == null || value === '') {
        if (required) log.push(`missing value for ${labels[0]}`);
        return !required;
      }
      const el = findInputByLabels(...labels);
      if (!el) { log.push(`field not found: ${labels[0]}`); return false; }
      if (el.getAttribute('role') === 'combobox' || el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA' && el.tagName !== 'SELECT') {
        // might be a dropdown
        const ok = await pickDropdown(el, String(value));
        if (!ok) log.push(`dropdown select failed: ${labels[0]} = ${value}`);
        return ok;
      }
      setNativeValue(el, String(value));
      await sleep(350);
      return true;
    };

    await set(['Organization'], cfg.organization || claim.billingProviderOrg || 'Atlanta Autism Center Inc');
    await set(['Payer'], cfg.payer || claim.payer);
    // provider select (NPI auto-fills)
    const provField = findInputByLabels('Provider Information', 'Select a Provider', 'Provider');
    if (provField && cfg.providerNpi) await pickDropdown(provField, cfg.providerNpi);

    const f = strategy.fields;
    if (f.includes('patientId')) await set(['Patient ID', 'Member ID', 'Subscriber ID'], claim.memberId);
    if (f.includes('lastName')) await set(['Last Name', 'Patient Last Name'], claim.patientLast);
    if (f.includes('firstName')) await set(['First Name', 'Patient First Name'], claim.patientFirst, false);
    if (f.includes('dob')) await set(['Date of Birth', 'DOB', 'Birth Date'], claim.dob);
    if (f.includes('zip')) await set(['Zip', 'ZIP Code', 'Postal Code'], claim.zip, false);
    await set(["Patient's Relationship to Subscriber", 'Relationship to Subscriber', 'Relationship'], 'Self', false);
    await set(['As of Date', 'Service Date', 'Date of Service'], cfg.asOfDate || new Date().toLocaleDateString('en-US'));
    await set(['Benefit/Service Type', 'Service Type'], 'Health Benefit Plan Coverage - 30', false);
    return log;
  }

  function parseEligibilityResult() {
    const text = document.body.innerText || '';
    const active = /active|eligible/i.test(text) && !/inactive|terminated|not eligible|no coverage/i.test(
      (text.match(/eligib[^.]{0,80}/gi) || []).join(' '));
    const grab = (re) => { const m = text.match(re); return m ? norm(m[1]) : ''; };
    return {
      active,
      groupNumber: grab(/Group Number\s*([A-Za-z0-9]+)/i),
      groupName: grab(/Group Name\s*([^\n]+)/i),
      planNumber: grab(/Plan Number\s*([A-Za-z0-9]+)/i),
      planBegin: grab(/Plan Begin Date\s*([0-9/]+)/i),
      eligibilityBegin: grab(/Eligibility Begin Date\s*([0-9/]+)/i),
      payer: grab(/Payer\s*([^\n]+)/i),
      secondaryPayer: grab(/Secondary Payer[^A-Za-z0-9]*([A-Za-z0-9 ]+)/i),
      raw: text.slice(0, 2000)
    };
  }

  async function runEligibility(claim, cfg) {
    // Assumes the Eligibility & Benefits "New Request" form is visible.
    for (const strategy of ELIG_STRATEGIES) {
      const fillLog = await fillEligibility(claim, cfg, strategy);
      if (fillLog.length) return { ok: false, error: 'Eligibility form fill failed: ' + fillLog.join('; ') };
      const submitBtn = clickButtonByText('Submit', 'Check Eligibility', 'Search');
      if (!submitBtn) return { ok: false, error: 'Eligibility Submit button not found' };
      const appeared = await waitFor(() =>
        /eligibility begin date|group number|coverage/i.test(document.body.innerText || ''), 25000);
      if (!appeared) {
        // try next strategy (clear form first)
        clickButtonByText('Clear Form', 'Clear', 'New Request');
        await sleep(800);
        continue;
      }
      const res = parseEligibilityResult();
      return { ok: true, strategy: strategy.name, ...res };
    }
    return { ok: false, error: 'Eligibility not found with any search strategy (ID+DOB, name+DOB, name+DOB+ZIP).' };
  }

  /* ---------- Professional claim fill ---------- */

  async function fillClaim(claim, ctx) {
    const log = [];
    const errors = [];
    const cfg = ctx.cfg || {};
    const centerAddr = (ctx.centerAddresses || {})[claim.center] || {};

    const set = async (labels, value, { dropdown = false, required = true } = {}) => {
      if (value == null || value === '') {
        if (required) errors.push(`Missing required value: ${labels[0]}`);
        return false;
      }
      const el = findInputByLabels(...labels);
      if (!el) { errors.push(`Field not found on form: ${labels[0]}`); return false; }
      if (dropdown) {
        const ok = await pickDropdown(el, String(value));
        if (!ok) errors.push(`Could not select "${value}" for ${labels[0]}`);
        return ok;
      }
      setNativeValue(el, String(value));
      await sleep(300);
      return true;
    };

    log.push('header');
    await set(['Organization'], cfg.organization || claim.billingProviderOrg, { dropdown: true });
    await set(['Claim Type'], 'Professional Claim', { dropdown: true });
    await set(['Payer', 'Insurance Company'], cfg.payer || claim.payer, { dropdown: true });
    await set(['Responsibility Sequence'], 'Primary', { dropdown: true, required: false });

    log.push('patient');
    // patient lookup by member ID
    const lookup = findInputByLabels('Patient Lookup', 'Find Patient', 'Search Patient');
    if (lookup) {
      setNativeValue(lookup, claim.memberId);
      await sleep(1500);
      const hit = await waitFor(() => [...document.querySelectorAll('[role="option"], li')]
        .find((c) => norm(c.textContent).includes(claim.memberId) && c.offsetParent !== null), 8000);
      if (hit) { hit.click(); await sleep(800); }
      else errors.push('Patient lookup: no match for member ID ' + claim.memberId);
    } else {
      await set(['Last Name'], claim.patientLast);
      await set(['First Name'], claim.patientFirst, { required: false });
      await set(['Date of Birth', 'DOB'], claim.dob);
      await set(['Gender', 'Sex'], claim.gender, { dropdown: true, required: false });
      await set(['Address'], claim.address, { required: false });
      await set(['City'], claim.city, { required: false });
      await set(['State'], claim.state, { dropdown: true, required: false });
      await set(['Zip'], claim.zip, { required: false });
    }

    log.push('claim-info');
    await set(['Patient Control Number', 'Claim Number'], claim.mrn);
    await set(['Place of Service'], cfg.pos || '11 - Office', { dropdown: true });
    await set(['Frequency Type'], cfg.frequencyType || '1 - Admit Through Discharge Claim', { dropdown: true });
    await set(['Provider Accepts Assignment'], cfg.assignment || 'A - Assigned', { dropdown: true, required: false });
    await set(['Claim Filing Indicator'], cfg.filingIndicator || 'CI - Commercial Insurance Co.', { dropdown: true, required: false });
    await set(['Release of Information'], cfg.roi || 'Y - Yes', { dropdown: true, required: false });
    await set(['Provider Signature on File'], cfg.signature || 'Yes', { dropdown: true, required: false });
    await set(['Prior Authorization Number', 'Prior Auth Number', 'Auth Number'], claim.authNumber);
    await set(['Medical Record Number'], claim.mrn, { required: false });

    log.push('diagnosis');
    const dxCodes = claim.dxCodes && claim.dxCodes.length ? claim.dxCodes : ['F840'];
    for (let i = 0; i < dxCodes.length; i++) {
      await set([`Diagnosis ${i + 1}`, i === 0 ? 'Principal Diagnosis' : 'Other Diagnosis', 'Diagnosis Code'], dxCodes[i], { required: i === 0 });
    }

    log.push('rendering-provider');
    await set(['Rendering Provider NPI', 'Rendering NPI', 'NPI'], claim.renderingNpi, { required: false });
    await set(['Rendering Last Name', 'Rendering Provider Last Name'], claim.renderingLast, { required: false });
    await set(['Rendering First Name', 'Rendering Provider First Name'], claim.renderingFirst, { required: false });

    log.push('service-facility');
    const facField = findInputByLabels('Select a Provider', 'Service Facility', 'Facility Location');
    if (facField) await pickDropdown(facField, cfg.organization || claim.billingProviderOrg);
    await set(['Mailing Address', 'Address Line 1', 'Street Address'], centerAddr.address, { required: false });
    await set(['City'], centerAddr.city, { required: false });
    await set(['State'], centerAddr.state, { dropdown: true, required: false });
    await set(['Zip Code', 'Zip'], centerAddr.zip, { required: false });

    log.push('lines');
    const lines = claim.lines && claim.lines.length ? claim.lines : [{
      fromDate: claim.serviceDate, toDate: claim.serviceDate, pos: cfg.pos || '11 - Office',
      cpt: claim.cpt, dxPointer: '1', charge: claim.charges, qty: claim.units, qtyType: 'UN - Unit'
    }];
    for (let li = 0; li < lines.length; li++) {
      const L = lines[li];
      if (li > 0) { const add = clickButtonByText('Add a Line', 'Add Line'); if (add) await sleep(800); }
      const scope = [...document.querySelectorAll('[class*="line" i]')].pop() || document;
      const setIn = async (labels, value, opts = {}) => {
        if (value == null || value === '') { if (opts.required) errors.push(`Missing line value: ${labels[0]}`); return; }
        let el = null;
        for (const t of labels) { el = fieldNearLabel(t); if (el) break; }
        if (!el && scope !== document) {
          el = [...scope.querySelectorAll('input, select')][0];
        }
        if (!el) { errors.push(`Line field not found: ${labels[0]}`); return; }
        if (opts.dropdown) await pickDropdown(el, String(value));
        else { setNativeValue(el, String(value)); await sleep(250); }
      };
      await setIn(['Service From Date', 'From Date'], L.fromDate, { required: true });
      await setIn(['Service To Date', 'To Date'], L.toDate, { required: true });
      await setIn(['POS', 'Place of Service'], L.pos, { dropdown: true });
      await setIn(['Procedure Code', 'CPT', 'HCPCS'], L.cpt, { required: true });
      await setIn(['Diagnosis Code Pointer', 'Dx Pointer'], L.dxPointer, { required: true });
      await setIn(['Charge Amount', 'Charges'], String(L.charge), { required: true });
      await setIn(['Quantity', 'Units'], String(L.qty), { required: true });
      await setIn(['Quantity Type'], L.qtyType || 'UN - Unit', { dropdown: true, required: false });
    }

    await sleep(800);
    const formErrors = pageErrors();
    return { ok: errors.length === 0 && formErrors.length === 0, errors, formErrors, log };
  }

  async function submitClaim() {
    clickButtonByText('Continue', 'Next');
    await sleep(1500);
    const formErrors = pageErrors();
    if (formErrors.length) return { ok: false, error: 'Validation errors before submit: ' + formErrors.join(' | ') };
    const submitted = clickButtonByText('Submit', 'Submit Claim', 'Send Claim');
    if (!submitted) return { ok: false, error: 'Submit button not found' };
    const confirmed = await waitFor(() =>
      /transaction id|confirmation|claim .* (submitted|accepted|received)|control number/i.test(document.body.innerText || ''), 30000);
    const text = document.body.innerText || '';
    const tcn = (text.match(/(?:Transaction ID|TCN|Confirmation (?:Number|#)|Claim #)\s*:?\s*([A-Za-z0-9\-]+)/i) || [])[1] || '';
    const errs = pageErrors();
    if (!confirmed || errs.length) {
      return { ok: false, error: errs.join(' | ') || 'Submission not confirmed', tcn };
    }
    return { ok: true, tcn, confirmation: norm(text.slice(0, 500)) };
  }

  /* ---------- in-app navigation ---------- */

  async function navigateTo(target, directUrl) {
    // Try direct URL first if the user configured one.
    if (directUrl) {
      location.href = directUrl;
      const ok = await waitFor(() => /eligib|benefit|claim/i.test(document.title + ' ' + (document.body.innerText || '').slice(0, 500)), 15000);
      if (ok) return { ok: true, via: 'url' };
    }
    const clickNav = async (...texts) => {
      for (const t of texts) {
        const el = [...document.querySelectorAll('a, button, [role="menuitem"], li')]
          .find((e) => norm(e.textContent).toLowerCase() === t.toLowerCase() && e.offsetParent !== null);
        if (el) { el.click(); await sleep(1200); return true; }
      }
      return false;
    };
    if (target === 'eligibility') {
      await clickNav('Patient Registration');
      const ok = await clickNav('Eligibility & Benefits', 'Eligibility and Benefits', 'Eligibility');
      if (ok) {
        await clickNav('New Request', 'New Search');
        await sleep(1500);
      }
      const form = await waitFor(() => findInputByLabels('Patient ID', 'Member ID', 'Subscriber ID'), 15000);
      return form ? { ok: true, via: 'menu' } : { ok: false, error: 'Could not reach the Eligibility form via menus. Set the direct Eligibility URL in Options.' };
    }
    if (target === 'startClaim') {
      await clickNav('Claims & Payments', 'Claims and Payments');
      const ok = await clickNav('Claims & Encounters', 'Claims and Encounters');
      if (ok) await clickNav('Start a Claim', 'Start A Claim', 'New Claim');
      await sleep(1500);
      const form = await waitFor(() => findInputByLabels('Patient Control Number', 'Claim Number', 'Organization'), 15000);
      return form ? { ok: true, via: 'menu' } : { ok: false, error: 'Could not reach Start a Claim via menus. Set the direct claim URL in Options.' };
    }
    return { ok: false, error: 'Unknown navigation target: ' + target };
  }

  /* ---------- Message router ---------- */

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      try {
        if (msg.type === 'CASTIFY_PING') return { ok: true, site: 'availity', url: location.href, title: document.title };
        if (msg.type === 'CASTIFY_NAVIGATE') return await navigateTo(msg.target, msg.url);
        if (msg.type === 'CASTIFY_ELIGIBILITY') return await runEligibility(msg.claim, msg.cfg || {});
        if (msg.type === 'CASTIFY_FILL_CLAIM') return await fillClaim(msg.claim, msg.ctx || {});
        if (msg.type === 'CASTIFY_SUBMIT_CLAIM') return await submitClaim();
        if (msg.type === 'CASTIFY_GOTO') { location.href = msg.url; return { ok: true, navigating: true }; }
        if (msg.type === 'CASTIFY_PAGE_ERRORS') return { ok: true, errors: pageErrors() };
        return { ok: false, error: 'Unknown message: ' + msg.type };
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
      }
    })().then(sendResponse);
    return true;
  });
})();
