/* Castify side panel logic */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const msg = (m) => chrome.runtime.sendMessage(m);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  let state = { claims: [], billed: [], unbilled: [], queue: null, settings: {} };
  let selected = new Set();
  let queueTotal = 0;

  /* ---------- tabs ---------- */
  document.querySelectorAll('.tabs button').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.tabs button').forEach((x) => x.classList.remove('active'));
      document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      $('tab-' + b.dataset.tab).classList.add('active');
    });
  });
  $('btn-options').addEventListener('click', () => chrome.runtime.openOptionsPage());

  /* ---------- state ---------- */
  async function refresh() {
    const res = await msg({ type: 'GET_STATE' });
    if (res && res.ok) {
      state = { claims: [], billed: [], unbilled: [], ...res.state };
      renderAll();
    }
  }

  function setConn(ok, text) {
    const el = $('conn');
    el.textContent = text || '';
    el.classList.toggle('bad', !ok);
  }

  /* ---------- Step 1: report ---------- */
  function filteredClaims() {
    const q = $('f-search').value.trim().toLowerCase();
    const payer = $('f-payer').value;
    const cpt = $('f-cpt').value;
    const centers = [...document.querySelectorAll('#f-centers input:checked')].map((c) => c.value);
    const readyOnly = $('f-ready-only').checked;
    return state.claims.filter((c) => {
      if (readyOnly && c.status !== 'ready') return false;
      if (payer && c.payer !== payer) return false;
      if (cpt && c.cpt !== cpt) return false;
      if (centers.length && !centers.includes(c.center)) return false;
      if (q && !`${c.patient} ${c.mrn} ${c.memberId}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }

  function pill(status) {
    const s = (status || 'ready').replace(/_/g, ' ');
    return `<span class="pill ${esc((status || 'ready').split('_')[0])}">${esc(s)}</span>`;
  }

  function renderReport() {
    const claims = state.claims;
    // filter options
    const payers = [...new Set(claims.map((c) => c.payer).filter(Boolean))].sort();
    const cpts = [...new Set(claims.map((c) => c.cpt).filter(Boolean))].sort();
    const centers = [...new Set(claims.map((c) => c.center).filter(Boolean))].sort();
    fillSelect($('f-payer'), payers, $('f-payer').value);
    fillSelect($('f-cpt'), cpts, $('f-cpt').value);
    const cl = $('f-centers');
    const checked = new Set([...cl.querySelectorAll('input:checked')].map((i) => i.value));
    cl.innerHTML = centers.map((c) =>
      `<label class="chk"><input type="checkbox" value="${esc(c)}" ${checked.has(c) ? 'checked' : ''}> ${esc(c)}</label>`).join('') || '<span class="hint">—</span>';
    cl.querySelectorAll('input').forEach((i) => i.addEventListener('change', renderReport));
    const nChecked = cl.querySelectorAll('input:checked').length;
    $('f-center-label').textContent = nChecked ? `${nChecked} center${nChecked > 1 ? 's' : ''}` : 'All centers';

    const rows = filteredClaims();
    // stats on the filtered set
    const by = (key) => {
      const m = {};
      rows.forEach((c) => { const k = c[key] || '—'; m[k] = m[k] || { n: 0, u: 0, $: 0 }; m[k].n++; m[k].u += +c.units || 0; m[k].$ += +c.charges || 0; });
      return Object.entries(m).sort((a, b) => b[1].$ - a[1].$);
    };
    const statTbl = (entries) => entries.slice(0, 5).map(([k, v]) =>
      `<tr><td>${esc(k)}</td><td>${v.n} · $${v.$.toFixed(0)}</td></tr>`).join('');
    const tot$ = rows.reduce((s, c) => s + (+c.charges || 0), 0);
    $('stats').innerHTML = `
      <div class="stat"><div class="k">Claims</div><div class="v">${rows.length}</div></div>
      <div class="stat"><div class="k">Charges</div><div class="v">$${tot$.toFixed(0)}</div></div>
      <div class="stat"><div class="k">Units</div><div class="v">${rows.reduce((s, c) => s + (+c.units || 0), 0)}</div></div>
      <div class="stat"><div class="k">By center</div><table>${statTbl(by('center'))}</table></div>
      <div class="stat"><div class="k">By insurance</div><table>${statTbl(by('payer'))}</table></div>
      <div class="stat"><div class="k">By CPT</div><table>${statTbl(by('cpt'))}</table></div>`;

    // Full breakdown: pending claims per clinic / provider / payer (respects the filters above)
    const bdBy = (key, label) => {
      const entries = by(key);
      if (!entries.length) return '';
      return `<h4>${label}</h4><div class="bdtable"><table>
        <thead><tr><th>${label}</th><th class="n">Claims</th><th class="n">Units</th><th class="n">Charges</th></tr></thead>
        <tbody>${entries.map(([k, v]) =>
          `<tr><td>${esc(k)}</td><td class="n">${v.n}</td><td class="n">${v.u}</td><td class="n">$${v.$.toFixed(0)}</td></tr>`).join('')}</tbody>
      </table></div>`;
    };
    $('breakdown').innerHTML =
      bdBy('center', 'Clinic') + bdBy('renderingProvider', 'Provider') + bdBy('payer', 'Payer');

    $('claims-body').innerHTML = rows.map((c) => `<tr>
      <td><input type="checkbox" data-id="${esc(c.id)}" ${selected.has(c.id) ? 'checked' : ''}></td>
      <td><a class="plink" data-id="${esc(c.id)}" title="Preview patient">${esc(c.patient)}</a></td><td>${esc(c.mrn)}</td><td>${esc(c.payer)}</td>
      <td>${esc(c.memberId)}</td><td>${esc(c.center)}</td><td>${esc(c.serviceDate)}</td>
      <td>${esc(c.cpt)}</td><td>${esc(c.units)}</td><td>$${(+c.charges || 0).toFixed(2)}</td>
      <td>${pill(c.status)}</td></tr>`).join('') ||
      `<tr><td colspan="11" class="empty">No claims match the filters.</td></tr>`;
    $('claims-body').querySelectorAll('input[type=checkbox]').forEach((cb) => {
      cb.addEventListener('change', () => {
        cb.checked ? selected.add(cb.dataset.id) : selected.delete(cb.dataset.id);
        updateSelCount();
      });
    });
    $('claims-body').querySelectorAll('.plink').forEach((a) => {
      a.addEventListener('click', (e) => { e.preventDefault(); openPatientPreview(a.dataset.id); });
    });
    updateSelCount();
    // queue payer options
    fillSelect($('q-payer'), payers, $('q-payer').value, 'All scanned payers');
  }

  function fillSelect(sel, values, keep, allLabel) {
    const cur = keep || sel.value;
    sel.innerHTML = `<option value="">${allLabel || 'All'}</option>` +
      values.map((v) => `<option ${v === cur ? 'selected' : ''}>${esc(v)}</option>`).join('');
  }

  function updateSelCount() { $('sel-count').textContent = `${selected.size} selected`; }

  $('sel-all').addEventListener('change', (e) => {
    filteredClaims().forEach((c) => e.target.checked ? selected.add(c.id) : selected.delete(c.id));
    renderReport();
  });
  ['f-search', 'f-payer', 'f-cpt', 'f-ready-only'].forEach((id) =>
    $(id).addEventListener('input', renderReport));

  $('btn-scan').addEventListener('click', async () => {
    $('btn-scan').disabled = true;
    const allPages = $('scan-all-pages').checked;
    setConn(true, allPages ? 'Scanning Magellan — walking all pages…' : 'Scanning Magellan…');
    const res = await msg({ type: 'SCAN_MAGELLAN', allPages });
    $('btn-scan').disabled = false;
    if (res && res.ok) {
      const pg = res.pages > 1 ? ` across ${res.pages} pages` : '';
      setConn(true, `Scanned ${res.claims.length} claims${pg}.`);
      await refresh();
    }
    else setConn(false, 'Scan failed: ' + ((res && res.error) || 'unknown error'));
  });

  /* ---------- patient preview ---------- */
  let currentPreviewId = null;
  async function openPatientPreview(id) {
    currentPreviewId = id;
    const c = state.claims.find((x) => x.id === id);
    if (!c) return;
    const sibs = state.claims.filter((x) => (c.mrn && x.mrn === c.mrn) || x.patient === c.patient);
    const billed = (state.billed || []).filter((b) => sibs.some((s) => s.id === b.claimId));
    const unbilled = (state.unbilled || []).filter((u) => sibs.some((s) => s.id === u.claimId));
    const totU = sibs.reduce((s, x) => s + (+x.units || 0), 0);
    const totC = sibs.reduce((s, x) => s + (+x.charges || 0), 0);
    $('pm-title').textContent = c.patient || 'Patient';
    $('pm-body').innerHTML = `
      <div class="kv">
        <span class="k">MRN</span><span>${esc(c.mrn || '—')}</span>
        <span class="k">Payer</span><span>${esc(c.payer || '—')}</span>
        <span class="k">Member ID</span><span>${esc(c.memberId || '—')}</span>
        <span class="k">Center</span><span>${esc(c.center || '—')}</span>
        <span class="k">Billing NPI</span><span>${esc(c.billingNpi || '—')}</span>
      </div>
      <h4>Claims (${sibs.length})</h4>
      <div class="bdtable"><table><thead><tr><th>DOS</th><th>CPT</th><th class="n">Units</th><th class="n">Charges</th><th>Status</th></tr></thead>
      <tbody>${sibs.map((s) => `<tr><td>${esc(s.serviceDate || '—')}</td><td>${esc(s.cpt || '—')}</td>
        <td class="n">${esc(s.units || '—')}</td><td class="n">$${(+s.charges || 0).toFixed(2)}</td><td>${pill(s.status)}</td></tr>`).join('')}</tbody></table></div>
      <div class="kv" style="margin-top:8px">
        <span class="k">Total units</span><span>${totU}</span>
        <span class="k">Total charges</span><span>$${totC.toFixed(2)}</span>
      </div>
      ${billed.map((b) => `<div class="hint">✓ Billed — TCN ${esc(b.tcn || 'n/a')} (${esc(b.at || '').slice(0, 10)})</div>`).join('')}
      ${unbilled.map((u) => `<div class="hint">✕ Unbilled [${esc(u.step || '?')}]: ${esc(u.reason || '')}</div>`).join('')}
      <div id="pm-extra"><div class="hint" id="pm-fetching">Fetching demographics, authorizations & place of service…</div></div>`;
    $('patient-modal').classList.remove('hidden');
    // Fetch the rest from the Magellan tab (stays in the sidebar; tab returns to the claims page after)
    try {
      const res = await msg({ type: 'PATIENT_PREVIEW', id });
      const f = $('pm-fetching');
      if (res && res.ok && res.preview) {
        if (f) f.remove();
        renderPreviewExtra(res.preview);
      } else if (f) {
        f.textContent = 'Could not fetch extra info: ' + ((res && res.error) || 'unknown error');
      }
    } catch (e) {
      const f = $('pm-fetching');
      if (f) f.textContent = 'Could not fetch extra info.';
    }
  }
  function renderPreviewExtra(pv) {
    const host = $('pm-extra');
    if (!host) return;
    const demographics = pv.demographics || {};
    const auths = pv.auths || [];
    const encounter = pv.encounter || {};
    const kvHtml = (obj) => {
      const entries = Object.entries(obj).slice(0, 40);
      if (!entries.length) return '<div class="hint">Nothing found on the page.</div>';
      return `<div class="kv">${entries.map(([k, v]) => `<span class="k">${esc(k)}</span><span>${esc(v)}</span>`).join('')}</div>`;
    };
    host.innerHTML = `
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
        <button class="btn sm" id="btn-pos">POS</button>
        <span class="hint" id="pos-status">Open the printable note (Place of Service)</span>
      </div>
      ${pv.placeOfService ? `<h4>Place of service</h4><div class="kv"><span class="k">POS</span><span><strong>${esc(pv.placeOfService)}</strong></span></div>` : ''}
      <h4>Demographics</h4>${kvHtml(demographics)}
      <h4>Authorizations (${auths.length})</h4>
      ${auths.length ? auths.map((a) => {
        const period = [a.periodStart, a.periodEnd].filter(Boolean).join(' – ');
        return `<div class="hint">• <strong>${esc(a.number || 'n/a')}</strong>${period ? ` · ${esc(period)}` : ''}` +
          `${a.codes && a.codes.length ? `<br>CPT: ${esc(a.codes.join(', '))}` : ''}` +
          `${a.remainingUnits != null ? `<br>Remaining units: ${esc(String(a.remainingUnits))}` : ''}</div>`;
      }).join('') : '<div class="hint">None found.</div>'}
      ${Object.keys(encounter).length ? `<h4>Encounter note</h4>${kvHtml(encounter)}` : ''}
      ${pv.error ? `<div class="hint">Note: ${esc(pv.error)}</div>` : ''}
      ${pv.diag && pv.diag.length ? `<details class="diag"><summary>Diagnostics (${pv.diag.length})</summary><div class="hint">${pv.diag.map((d) => esc(d)).join('<br>')}</div></details>` : ''}`;
    const posBtn = $('btn-pos');
    if (posBtn) posBtn.addEventListener('click', async () => {
      const st = $('pos-status');
      posBtn.disabled = true;
      if (st) st.textContent = 'Opening printable note…';
      try {
        const r = await msg({ type: 'PATIENT_OPEN_PRINT', id: currentPreviewId });
        if (r && r.ok) {
          if (st) st.textContent = r.pos ? `Place of Service: ${r.pos} — PDF opened in a new tab.` : 'Printable note opened in a new tab.';
        } else if (st) {
          st.textContent = 'Could not open: ' + ((r && r.error) || 'unknown error');
        }
      } catch (e) {
        if (st) st.textContent = 'Could not open the printable note.';
      }
      posBtn.disabled = false;
    });
  }
  function closePatientPreview() { const m = $('patient-modal'); if (m) m.classList.add('hidden'); }
  const pmc = $('pm-close');
  if (pmc) pmc.addEventListener('click', closePatientPreview);
  const pmm = $('patient-modal');
  if (pmm) pmm.addEventListener('click', (e) => { if (e.target === pmm) closePatientPreview(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePatientPreview(); });
  // Delegated fallback: closes the preview no matter when the button was parsed
  document.addEventListener('click', (e) => {
    const t = e.target && e.target.closest ? e.target.closest('#pm-close') : null;
    if (t) closePatientPreview();
  });

  /* ---------- Steps 2+3: queue ---------- */
  $('btn-start').addEventListener('click', async () => {
    const payer = $('q-payer').value;
    let ids = [...selected];
    if (!ids.length) ids = filteredClaims().map((c) => c.id);
    if (payer) ids = ids.filter((id) => (state.claims.find((c) => c.id === id) || {}).payer === payer);
    ids = ids.filter((id) => ['ready', 'unbilled'].includes((state.claims.find((c) => c.id === id) || {}).status));
    if (!ids.length) { qlog('No eligible claims selected.', 'bad'); return; }
    const mode = $('q-mode').value;
    const res = await msg({ type: 'START_QUEUE', ids, mode });
    if (!(res && res.ok)) qlog('Could not start: ' + (res && res.error), 'bad');
  });
  $('btn-stop').addEventListener('click', () => msg({ type: 'STOP_QUEUE' }));
  $('btn-approve').addEventListener('click', () => { msg({ type: 'REVIEW_DECISION', decision: 'submit' }); $('review-box').classList.add('hidden'); });
  $('btn-skip').addEventListener('click', () => { msg({ type: 'REVIEW_DECISION', decision: 'skip' }); $('review-box').classList.add('hidden'); });

  function qlog(text, cls) {
    const d = document.createElement('div');
    if (cls) d.className = cls;
    d.textContent = `${new Date().toLocaleTimeString()} ${text}`;
    $('q-log').prepend(d);
  }

  function showQueueBox(show) { $('queue-box').classList.toggle('hidden', !show); }

  chrome.runtime.onMessage.addListener((m) => {
    if (!m || !m._broadcast) return;
    if (m.type === 'POS_LEARN') { const st = $('pos-status'); if (st) st.textContent = m.text || ''; return; }
    showQueueBox(true);
    switch (m.type) {
      case 'QUEUE_STARTED':
        queueTotal = m.total;
        $('btn-start').disabled = true; $('btn-stop').disabled = false;
        $('q-status').textContent = `Running (${m.mode} mode)`;
        $('q-progress').textContent = `0 / ${m.total}`;
        $('q-barfill').style.width = '0%';
        qlog(`Started — ${m.total} claims, ${m.mode} mode.`);
        break;
      case 'CLAIM_START': {
        const c = m.claim;
        $('q-current').innerHTML = `<strong>${esc(c.patient)}</strong> · ${esc(c.mrn)} · ${esc(c.cpt)} × ${esc(c.units)} · $${(+c.charges || 0).toFixed(2)} · ${esc(c.serviceDate)}`;
        qlog(`→ ${c.patient} (${c.mrn}) auth check…`);
        break;
      }
      case 'CLAIM_AUTH_OK': qlog(`✓ auth ${m.auth.number} OK`, 'ok'); break;
      case 'CLAIM_ELIG_OK': qlog(`✓ eligibility active (${m.eligibility.strategy})`, 'ok'); break;
      case 'REVIEW_NEEDED':
        $('q-status').textContent = 'Waiting for your review';
        $('review-box').classList.remove('hidden');
        qlog('⏸ Review needed — check the Availity form, then Submit or Skip.');
        document.querySelector('[data-tab="submit"]').click();
        break;
      case 'CLAIM_BILLED':
        qlog(`✓ BILLED — TCN ${m.tcn}`, 'ok');
        $('badge-billed').textContent = state.billed.length + 1;
        $('badge-billed').classList.remove('hidden');
        refresh(); break;
      case 'CLAIM_UNBILLED':
        qlog(`✕ unbilled [${m.step}]: ${m.reason}`, 'bad');
        $('badge-unbilled').textContent = state.unbilled.length + 1;
        $('badge-unbilled').classList.remove('hidden');
        refresh(); break;
      case 'QUEUE_DONE':
        $('q-status').textContent = 'Done';
        $('btn-start').disabled = false; $('btn-stop').disabled = true;
        qlog('Run finished.');
        refresh(); break;
      case 'QUEUE_STOPPED':
        $('q-status').textContent = 'Stopped';
        $('btn-start').disabled = false; $('btn-stop').disabled = true;
        qlog('Stopped by user.', 'bad'); break;
      case 'SCAN_DONE': refresh(); break;
      case 'SCAN_PROGRESS':
        if (!m.done) setConn(true, `Scanning page ${m.page}… ${m.claims} claims so far`);
        break;
    }
    if (m.type === 'CLAIM_BILLED' || m.type === 'CLAIM_UNBILLED' || m.type === 'QUEUE_DONE') {
      const done = (state.billed.length + state.unbilled.length);
      if (queueTotal) { $('q-progress').textContent = `${done} / ${queueTotal}`; $('q-barfill').style.width = (100 * done / queueTotal) + '%'; }
    }
  });

  /* ---------- unbilled / billed lists ---------- */
  function renderLists() {
    $('unbilled-body').innerHTML = state.unbilled.map((u) => `<tr>
      <td>${esc(u.patient)}</td><td>${esc(u.mrn)}</td><td>${esc(u.payer)}</td>
      <td>${esc(u.serviceDate)}</td><td>${esc(u.cpt)}</td><td>${esc(u.step)}</td>
      <td style="white-space:normal;min-width:180px">${esc(u.reason)}</td></tr>`).join('') ||
      `<tr><td colspan="7" class="empty">No unbilled claims.</td></tr>`;
    $('billed-body').innerHTML = state.billed.map((b) => `<tr>
      <td>${esc(b.patient)}</td><td>${esc(b.mrn)}</td><td>${esc(b.payer)}</td>
      <td>${esc(b.serviceDate)}</td><td>${esc(b.cpt)}</td><td>$${(+b.charges || 0).toFixed(2)}</td>
      <td>${esc(b.tcn)}</td><td>${esc((b.at || '').slice(0, 10))}</td></tr>`).join('') ||
      `<tr><td colspan="8" class="empty">No billed claims yet.</td></tr>`;
    $('badge-unbilled').textContent = state.unbilled.length;
    $('badge-unbilled').classList.toggle('hidden', !state.unbilled.length);
    $('badge-billed').textContent = state.billed.length;
    $('badge-billed').classList.toggle('hidden', !state.billed.length);
  }

  /* ---------- AI ---------- */
  $('btn-ai-review').addEventListener('click', async () => {
    const id = [...selected][0];
    if (!id) { $('ai-review-out').textContent = 'Select one claim first.'; $('ai-review-out').classList.remove('hidden'); return; }
    const claim = state.claims.find((c) => c.id === id);
    const out = $('ai-review-out');
    out.textContent = 'AI reviewing…'; out.classList.remove('hidden');
    const res = await msg({ type: 'AI_REVIEW_CLAIM', claim });
    out.textContent = res && res.ok ? res.text : 'AI error: ' + ((res && res.error) || 'unknown');
  });
  const aiAsk = async (context) => {
    const out = $('ai-out');
    out.textContent = 'Thinking…'; out.classList.remove('hidden');
    const res = await msg({ type: 'AI_SUGGEST', context: context || 'General workflow review.' });
    out.textContent = res && res.ok ? res.text : 'AI error: ' + ((res && res.error) || 'unknown');
  };
  $('btn-ai-ask').addEventListener('click', () => aiAsk($('ai-context').value.trim()));
  $('btn-ai-suggest').addEventListener('click', () => {
    const recent = (state.unbilled || []).slice(-10).map((u) => `${u.step}: ${u.reason}`).join('\n');
    aiAsk('Recent unbilled reasons:\n' + (recent || '(none yet)') + '\nSuggest workflow improvements.');
  });
  $('btn-ai-skill').addEventListener('click', () => chrome.runtime.openOptionsPage());

  /* ---------- export ---------- */
  $('btn-export').addEventListener('click', () => {
    if (typeof XLSX === 'undefined') { alert('Excel library not loaded.'); return; }
    const wb = XLSX.utils.book_new();
    const billed = state.billed, unbilled = state.unbilled;
    const sum = [
      ['Castify claim report', new Date().toLocaleString()],
      [],
      ['Billed claims', billed.length],
      ['Unbilled claims', unbilled.length],
      ['Billed charges', billed.reduce((s, b) => s + (+b.charges || 0), 0)],
      ['Unbilled charges', unbilled.reduce((s, u) => s + (+u.charges || 0), 0)],
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sum), 'Summary');
    const row = (b) => ({ Patient: b.patient, MRN: b.mrn, Payer: b.payer, Center: b.center, DOS: b.serviceDate, CPT: b.cpt, Units: b.units, Charges: b.charges, TCN: b.tcn || '', At: b.at });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(billed.map(row)), 'Billed');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(unbilled.map((u) => ({ ...row(u), Step: u.step, Reason: u.reason }))), 'Unbilled');
    const statsBy = (list, key) => {
      const m = {};
      list.forEach((b) => { const k = b[key] || '—'; m[k] = m[k] || { Claims: 0, Charges: 0 }; m[k].Claims++; m[k].Charges += +b.charges || 0; });
      return Object.entries(m).map(([k, v]) => ({ [key]: k, ...v }));
    };
    [...['center', 'payer', 'cpt', 'renderingProvider']].forEach((k) => {
      const name = { center: 'Center', payer: 'Payer', cpt: 'CPT', renderingProvider: 'Provider' }[k];
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(statsBy([...billed, ...unbilled], k)), 'Stats-' + name);
    });
    if ($('exp-include-log').checked) {
      const log = (state.eventLog || []).map((e) => ({ At: e.at, Event: e.kind, Claim: e.claimId || '', Detail: e.reason || e.error || e.tcn || '' }));
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(log), 'Event log');
    }
    XLSX.writeFile(wb, `castify-report-${new Date().toISOString().slice(0, 10)}.xlsx`);
  });
  $('btn-clear').addEventListener('click', async () => {
    if (!confirm('Clear all Castify local data (claims, billed, unbilled, log)?')) return;
    await msg({ type: 'CLEAR_DATA' });
    selected.clear();
    await refresh();
  });

  function renderAll() { renderReport(); renderLists(); }
  refresh();
})();
