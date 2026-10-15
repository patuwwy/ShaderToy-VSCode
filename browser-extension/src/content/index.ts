/**
 * Isolated world bridge
 * Forwards messages between in-page.js (world: MAIN) and background.js (Service Worker)
 */

console.log('[ShaderToy to VSCode Content] ISOLATED bridge running.');

// Receive from in-page (world: MAIN) and forward to background service worker
window.addEventListener('message', (event) => {
  if (event.source !== window || !event.data || event.data.source !== 'shadertoy-ai-inpage') {
    return;
  }

  const { payload } = event.data;
  if (!payload || !payload.type) return;

  // Protect against Extension context invalidated after extension reload in chrome://extensions
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) {
    console.debug('[ShaderToy to VSCode Content] Extension context invalidated (page refresh F5 required).');
    return;
  }

  try {
    chrome.runtime.sendMessage({
      source: 'shadertoy-ai-content',
      ...payload,
    }).catch((err) => {
      console.debug('[ShaderToy to VSCode Content] Failed to send message to background:', err.message);
    });
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.debug('[ShaderToy to VSCode Content] sendMessage exception (context inactive):', errMsg);
  }
});

// Receive from background service worker and forward to in-page (world: MAIN)
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && message.target === 'shadertoy-ai-inpage') {
    window.postMessage(
      {
        source: 'shadertoy-ai-bridge',
        type: message.type,
        payload: message.payload,
      },
      '*',
    );
    sendResponse({ received: true });
  }
  return true;
});
