/* Castify popup launcher (external file: MV3 blocks inline scripts) */
(() => {
  'use strict';
  const status = (t) => { document.getElementById('status').textContent = t || ''; };

  document.getElementById('open').addEventListener('click', async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) { status('No active tab found.'); return; }
      await chrome.sidePanel.open({ tabId: tab.id });
      window.close();
    } catch (e) {
      // sidePanel.open fails on chrome:// pages, the web store, and blank tabs
      status('Could not open here — switch to any website tab (e.g. Magellan) and try again.');
    }
  });

  document.getElementById('opts').addEventListener('click', async () => {
    try {
      await chrome.runtime.openOptionsPage();
      window.close();
    } catch (e) {
      status('Could not open Settings: ' + (e && e.message || e));
    }
  });
})();
