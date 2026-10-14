import { DEFAULT_WS_PORT } from '@shared/protocol';

const statusBadge = document.getElementById('statusBadge');
const statusLabel = document.getElementById('statusLabel');
const tabCountLabel = document.getElementById('tabCountLabel');
const portInput = document.getElementById('portInput') as HTMLInputElement | null;
const savePortBtn = document.getElementById('savePortBtn');

function refreshUI() {
  chrome.storage.local.get(['wsStatus', 'wsError', 'activePort', 'tabCount'], (res) => {
    const status = res.wsStatus || 'disconnected';
    const port = res.activePort || DEFAULT_WS_PORT;
    const tabCount = res.tabCount || 0;

    if (portInput) {
      portInput.value = String(port);
    }
    if (tabCountLabel) {
      tabCountLabel.textContent = String(tabCount);
    }

    if (statusBadge && statusLabel) {
      statusBadge.className = `badge ${status}`;
      if (status === 'connected') {
        statusLabel.textContent = `Connected (port ${port})`;
      } else if (status === 'connecting') {
        statusLabel.textContent = 'Connecting...';
      } else {
        statusLabel.textContent = res.wsError ? `Error: ${res.wsError}` : 'Disconnected';
      }
    }
  });
}

if (savePortBtn && portInput) {
  savePortBtn.addEventListener('click', () => {
    const port = parseInt(portInput.value, 10);
    if (!isNaN(port) && port > 1024 && port < 65535) {
      chrome.storage.local.set({ shadertoyPort: port }, () => {
        // Reload background service worker
        chrome.runtime.reload();
        window.close();
      });
    }
  });
}

refreshUI();
// Listen to storage changes in real time
chrome.storage.onChanged.addListener(() => {
  refreshUI();
});
