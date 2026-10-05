const { JSDOM } = require('/home/hatch/workspace/castify/test/node_modules/jsdom');
// Simulate: Authorizations tab looks selected via class (false positive for old
// isSelected), but its panel is EMPTY. Clicking the tab loads the auth cards.
const dom = new JSDOM(`
<div id="ws">
  <div role="tablist">
    <button role="tab" aria-selected="false">Demographics</button>
    <button role="tab" aria-selected="false" class="active" id="authTab">Authorizations</button>
  </div>
  <div role="tabpanel" id="p1">demographics stuff</div>
  <div role="tabpanel" id="p2"></div>
</div>`);
const { document } = dom.window;
document.getElementById('authTab').addEventListener('click', () => {
  document.getElementById('authTab').setAttribute('aria-selected', 'true');
  setTimeout(() => {
    document.getElementById('p2').innerHTML =
      '<div class="auth-card"><span>UM123456789</span><span>01/01/2026 - 12/31/2026</span><span>97153</span></div>';
  }, 100);
});
const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
const findTab = (root) => {
  const cands = [...root.querySelectorAll('a, button, [role="tab"]')]
    .filter((el) => /^\s*authorizations?\s*$/i.test(el.textContent || ''));
  return cands.find((el) => (el.closest && el.closest('[role="tablist"]')) || el.getAttribute('role') === 'tab') || cands[0];
};
// OLD (v1.1.6-1.1.8) isSelected: also checked parentElement className
const oldIsSelected = (el) => el.getAttribute('aria-selected') === 'true'
  || /\bactive\b|\bselected\b/i.test(el.className || '')
  || /\bactive\b|\bselected\b/i.test((el.parentElement && el.parentElement.className) || '');
// NEW (v1.1.9) isSelected: element only
const newIsSelected = (el) => {
  if (!el) return false;
  if (el.getAttribute('aria-selected') === 'true') return true;
  return /\bactive\b|\bselected\b/i.test(el.className || '');
};
const tabPanel = (root) => {
  const panels = [...root.querySelectorAll('[role="tabpanel"]')];
  return panels[1] || panels[0] || root;
};
const panelReady = (panel) => /\b[A-Z]{2}\d{6,}\b/.test(norm(panel.textContent))
  || /no authorizations?/i.test(norm(panel.textContent));
(async () => {
  const modal = document.getElementById('ws');
  const tab = findTab(modal);
  const panel = tabPanel(modal);
  const oldSkips = oldIsSelected(tab);                    // v1.1.6 behavior
  const newClicks = !(newIsSelected(tab) && panelReady(panel)); // v1.1.9 behavior
  console.log('T1 old logic skips the click (the bug):', oldSkips ? 'PASS' : 'FAIL');
  console.log('T2 new logic clicks despite looking selected:', newClicks ? 'PASS' : 'FAIL');
  if (newClicks) tab.click();
  await new Promise((r) => setTimeout(r, 500));
  console.log('T3 panel shows auth card after click:', panelReady(tabPanel(modal)) ? 'PASS' : 'FAIL');
})();
