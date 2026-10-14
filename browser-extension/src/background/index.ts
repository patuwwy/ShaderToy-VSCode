/// <reference types="chrome" />
import {
  DEFAULT_WS_PORT,
  ProtocolMessage,
  AuthRequestMessage,
  AuthResponseMessage,
  WS_PROTOCOL_VERSION,
} from '@shared/protocol';

let ws: WebSocket | null = null;
let isAuthenticated = false;
let hasLoggedConnectionFailure = false;
const RECONNECT_INTERVAL_MS = 5000;
const CONNECTION_TIMEOUT_MS = 4500;
let reconnectTimer: any = null;
let connectionTimeoutTimer: any = null;
let currentPort = DEFAULT_WS_PORT;

// Map: tabSessionId -> chromeTabId
const sessionToTabMap = new Map<string, number>();
// Queue of messages to send after authentication
const messageQueue: ProtocolMessage[] = [];

async function loadPort(): Promise<number> {
  return new Promise((resolve) => {
    chrome.storage.local.get(['shadertoyPort'], (result) => {
      if (result.shadertoyPort === 37412) {
        currentPort = DEFAULT_WS_PORT;
        chrome.storage.local.set({ shadertoyPort: DEFAULT_WS_PORT });
      } else if (result.shadertoyPort && typeof result.shadertoyPort === 'number') {
        currentPort = result.shadertoyPort;
      } else {
        currentPort = DEFAULT_WS_PORT;
      }
      resolve(currentPort);
    });
  });
}

function updateConnectionStatus(status: 'connected' | 'connecting' | 'disconnected', error?: string) {
  chrome.storage.local.set({
    wsStatus: status,
    wsError: error || '',
    activePort: currentPort,
    tabCount: sessionToTabMap.size,
  });
}

function requestAllTabsToSendSnapshot() {
  chrome.tabs.query({}, (tabs) => {
    const shadertoyTabs = tabs.filter((t) => t.id && t.url && t.url.includes('shadertoy.com'));
    console.log(`[ShaderToy to VSCode] Querying open Shadertoy tabs (found: ${shadertoyTabs.length})...`);
    sendWsMessage({
      type: 'DEBUG_LOG',
      component: 'background',
      message: `Found open Shadertoy tabs: ${shadertoyTabs.length}`,
      data: shadertoyTabs.map((t) => ({ id: t.id, url: t.url, title: t.title })),
      timestamp: Date.now(),
    } as any);

    shadertoyTabs.forEach((tab) => {
      if (!tab.id) return;
      const tabId = tab.id;

      chrome.tabs.sendMessage(tabId, {
        target: 'shadertoy-ai-inpage',
        type: 'REQUEST_SNAPSHOT',
      }).catch((err) => {
        console.log(`[ShaderToy to VSCode] Tab ${tabId} requires script injection (${err.message}), injecting...`);
        // If tab does not have content scripts loaded yet (e.g. opened before extension load)
        if (chrome.scripting) {
          chrome.scripting.executeScript({
            target: { tabId },
            files: ['in-page.js'],
            world: 'MAIN',
          }).then(() => {
            return chrome.scripting.executeScript({
              target: { tabId },
              files: ['content.js'],
              world: 'ISOLATED',
            });
          }).then(() => {
            console.log(`[ShaderToy to VSCode] Scripts successfully injected into tab ${tabId}.`);
          }).catch((injectErr) => {
            console.warn(`[ShaderToy to VSCode] Script injection error for tab ${tabId}:`, injectErr);
          });
        }
      });
    });
  });
}

function connectWebSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  updateConnectionStatus('connecting');
  const url = `ws://127.0.0.1:${currentPort}`;
  if (!hasLoggedConnectionFailure) {
    console.log(`[ShaderToy to VSCode] Connecting to VS Code: ${url}...`);
  }

  try {
    ws = new WebSocket(url);
  } catch (err: any) {
    if (!hasLoggedConnectionFailure) {
      console.warn(`[ShaderToy to VSCode] VS Code server not reachable at ${url}:`, err?.message || err);
      hasLoggedConnectionFailure = true;
    }
    scheduleReconnect();
    return;
  }

  // Safety timeout: if WebSocket hangs in CONNECTING state, abort and retry
  if (connectionTimeoutTimer) {
    clearTimeout(connectionTimeoutTimer);
  }
  connectionTimeoutTimer = setTimeout(() => {
    connectionTimeoutTimer = null;
    if (ws && ws.readyState === WebSocket.CONNECTING) {
      if (!hasLoggedConnectionFailure) {
        console.warn('[ShaderToy to VSCode] Connection attempt timed out.');
      }
      try {
        ws.close();
      } catch (_) {}
      ws = null;
      updateConnectionStatus('disconnected', 'Connection timed out');
      scheduleReconnect();
    }
  }, CONNECTION_TIMEOUT_MS);

  ws.onopen = () => {
    hasLoggedConnectionFailure = false;
    if (connectionTimeoutTimer) {
      clearTimeout(connectionTimeoutTimer);
      connectionTimeoutTimer = null;
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    console.log('[ShaderToy to VSCode] Connected to VS Code server. Sending AUTH_REQUEST...');
    const authReq: AuthRequestMessage = {
      type: 'AUTH_REQUEST',
      version: WS_PROTOCOL_VERSION,
      clientName: 'ShaderToy to VSCode',
      browserName: navigator.userAgent,
      timestamp: Date.now(),
    };
    sendWsMessage(authReq);
  };

  ws.onmessage = (event) => {
    try {
      const msg: ProtocolMessage = JSON.parse(event.data);
      handleIncomingWsMessage(msg);
    } catch (e) {
      console.error('[ShaderToy to VSCode] Error parsing WS message:', e);
    }
  };

  ws.onclose = () => {
    if (connectionTimeoutTimer) {
      clearTimeout(connectionTimeoutTimer);
      connectionTimeoutTimer = null;
    }
    if (isAuthenticated) {
      console.warn(`[ShaderToy to VSCode] WebSocket connection closed. Will retry in ${RECONNECT_INTERVAL_MS / 1000}s...`);
    }
    ws = null;
    isAuthenticated = false;
    updateConnectionStatus('disconnected');
    scheduleReconnect();
  };

  ws.onerror = (error: any) => {
    if (connectionTimeoutTimer) {
      clearTimeout(connectionTimeoutTimer);
      connectionTimeoutTimer = null;
    }
    error?.preventDefault?.();
    if (!hasLoggedConnectionFailure) {
      console.warn(`[ShaderToy to VSCode] VS Code server not running at ${url}. Will keep retrying in background every ${RECONNECT_INTERVAL_MS / 1000}s.`);
      hasLoggedConnectionFailure = true;
    }
    updateConnectionStatus('disconnected', 'Cannot connect to VS Code');
    // Note: onclose will fire after onerror and call scheduleReconnect()
  };
}

function scheduleReconnect() {
  if (isAuthenticated) return;
  if (reconnectTimer) return;

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!isAuthenticated) {
      connectWebSocket();
    }
  }, RECONNECT_INTERVAL_MS);
}

function sendWsMessage(msg: ProtocolMessage) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    if (isAuthenticated || msg.type === 'AUTH_REQUEST') {
      ws.send(JSON.stringify(msg));
      return;
    }
  }
  if (msg.type !== 'AUTH_REQUEST') {
    messageQueue.push(msg);
  }
}

function flushQueue() {
  while (messageQueue.length > 0 && ws && ws.readyState === WebSocket.OPEN && isAuthenticated) {
    const msg = messageQueue.shift();
    if (msg) {
      ws.send(JSON.stringify(msg));
    }
  }
}

function dispatchToTabs(msg: ProtocolMessage) {
  const tabSessionId = (msg as any).tabSessionId;
  const directTabId = tabSessionId ? sessionToTabMap.get(tabSessionId) : undefined;

  const broadcastAll = () => {
    if (sessionToTabMap.size > 0) {
      sessionToTabMap.forEach((chromeTabId) => {
        chrome.tabs.sendMessage(chromeTabId, {
          target: 'shadertoy-ai-inpage',
          type: msg.type,
          payload: msg,
        }).catch(() => {});
      });
    } else {
      chrome.tabs.query({ url: '*://*.shadertoy.com/*' }, (tabs) => {
        tabs.forEach((tab) => {
          if (tab.id) {
            chrome.tabs.sendMessage(tab.id, {
              target: 'shadertoy-ai-inpage',
              type: msg.type,
              payload: msg,
            }).catch(() => {});
          }
        });
      });
    }
  };

  if (directTabId) {
    chrome.tabs.sendMessage(directTabId, {
      target: 'shadertoy-ai-inpage',
      type: msg.type,
      payload: msg,
    }).catch((err) => {
      console.warn(`[ShaderToy to VSCode] Direct delivery to tab ${directTabId} failed, broadcasting:`, err);
      broadcastAll();
    });
  } else {
    broadcastAll();
  }
}

function handleIncomingWsMessage(msg: ProtocolMessage) {
  switch (msg.type) {
    case 'AUTH_RESPONSE': {
      const authResp = msg as AuthResponseMessage;
      if (authResp.approved) {
        console.log('[ShaderToy to VSCode] Connection to VS Code authenticated successfully!');
        isAuthenticated = true;
        updateConnectionStatus('connected');
        flushQueue();

        // Query all open Shadertoy tabs after successful authentication
        requestAllTabsToSendSnapshot();
      } else {
        console.warn('[ShaderToy to VSCode] Connection rejected by VS Code.');
        isAuthenticated = false;
        updateConnectionStatus('disconnected', authResp.reason || 'Connection rejected by VS Code');
        if (ws) {
          try {
            ws.close();
          } catch (_) {}
          ws = null;
        }
        scheduleReconnect();
      }
      break;
    }

    case 'UPDATE_PASS':
    case 'RECOMPILE_COMMAND':
    case 'UPDATE_METADATA':
    case 'SET_ACTIVE_PASS': {
      dispatchToTabs(msg);
      break;
    }
  }
}

// Receive messages from content scripts on shadertoy.com pages
chrome.runtime.onMessage.addListener((message, sender, _sendResponse) => {
  if (message && message.source === 'shadertoy-ai-content') {
    const { source, ...protocolMsg } = message;

    if (protocolMsg.tabSessionId && sender.tab?.id) {
      sessionToTabMap.set(protocolMsg.tabSessionId, sender.tab.id);
      updateConnectionStatus(isAuthenticated ? 'connected' : 'connecting');
    }

    if (protocolMsg.type === 'TAB_UNREGISTER' && protocolMsg.tabSessionId) {
      sessionToTabMap.delete(protocolMsg.tabSessionId);
      updateConnectionStatus(isAuthenticated ? 'connected' : 'connecting');
    }

    // If WebSocket is not connected, try connecting immediately
    if (!ws || ws.readyState === WebSocket.CLOSED) {
      connectWebSocket();
    }

    sendWsMessage(protocolMsg as ProtocolMessage);
  }
  return true;
});

// Clean up mapping when tab is closed
chrome.tabs.onRemoved.addListener((closedTabId) => {
  for (const [sessionId, tabId] of sessionToTabMap.entries()) {
    if (tabId === closedTabId) {
      sessionToTabMap.delete(sessionId);
      sendWsMessage({
        type: 'TAB_UNREGISTER',
        tabSessionId: sessionId,
        timestamp: Date.now(),
      });
      break;
    }
  }
});

// MV3 alarm to wake up background service worker if suspended while disconnected
chrome.alarms.create('reconnect-alarm', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'reconnect-alarm') {
    if (!isAuthenticated && (!ws || ws.readyState === WebSocket.CLOSED)) {
      connectWebSocket();
    }
  }
});

// Start
loadPort().then(() => {
  connectWebSocket();
});
