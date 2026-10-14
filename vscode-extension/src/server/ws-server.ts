import * as vscode from 'vscode';
import { WebSocketServer, WebSocket } from 'ws';
import {
  DEFAULT_WS_PORT,
  ProtocolMessage,
  AuthRequestMessage,
  AuthResponseMessage,
  WS_PROTOCOL_VERSION,
} from '@shared/protocol';

import { appendLog } from '../logger';

export class ShadertoyWSServer {
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();
  private authenticatedClients = new Set<WebSocket>();
  private isAutoApproved = false;

  private onMessageCallbacks: ((msg: ProtocolMessage, ws: WebSocket) => void)[] = [];
  private onClientConnectedCallbacks: (() => void)[] = [];
  private onClientDisconnectedCallbacks: (() => void)[] = [];

  constructor(private context: vscode.ExtensionContext) {}

  public start(port = DEFAULT_WS_PORT): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        appendLog('VSCode Server', `Starting WebSocket server on 127.0.0.1:${port}`);
        this.wss = new WebSocketServer({ port, host: '127.0.0.1' }, () => {
          appendLog('VSCode Server', `WebSocket server listening on 127.0.0.1:${port}`);
          console.log(`[ShaderToy VSCode Server] WebSocket server listening on 127.0.0.1:${port}`);
          resolve();
        });

        this.wss.on('connection', (ws) => {
          this.handleConnection(ws);
        });

        this.wss.on('error', (err) => {
          appendLog('VSCode Server', `WebSocket server error: ${err.message}`);
          console.error('[ShaderToy VSCode Server] WebSocket server error:', err);
          vscode.window.showErrorMessage(`ShaderToy VSCode: WebSocket server error on port ${port}: ${err.message}`);
          reject(err);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  public stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.wss) {
        this.wss.close(() => {
          this.wss = null;
          this.clients.clear();
          this.authenticatedClients.clear();
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  private pendingMessages = new Map<WebSocket, ProtocolMessage[]>();

  private handleConnection(ws: WebSocket) {
    this.clients.add(ws);
    this.pendingMessages.set(ws, []);
    appendLog('VSCode Server', 'Browser client connected via WebSocket.');
    console.log('[ShaderToy VSCode Server] New connection from browser.');

    ws.on('message', async (data) => {
      try {
        const msg: ProtocolMessage = JSON.parse(data.toString());
        appendLog('VSCode Server', `Received message: ${msg.type}`, msg);
        await this.handleMessage(msg, ws);
      } catch (e: any) {
        appendLog('VSCode Server', `Failed to parse message: ${e.message}`);
        console.error('[ShaderToy VSCode Server] Failed to parse message:', e);
      }
    });

    ws.on('close', () => {
      this.clients.delete(ws);
      this.authenticatedClients.delete(ws);
      this.pendingMessages.delete(ws);
      appendLog('VSCode Server', 'Browser client disconnected.');
      console.log('[ShaderToy VSCode Server] Browser client disconnected.');
      this.onClientDisconnectedCallbacks.forEach((cb) => cb());
    });
  }

  private async handleMessage(msg: ProtocolMessage, ws: WebSocket) {
    if (msg.type === 'AUTH_REQUEST') {
      await this.handleAuthRequest(msg as AuthRequestMessage, ws);
      return;
    }

    if (msg.type === 'DEBUG_LOG') {
      const debugMsg = msg as any;
      appendLog(`Browser [${debugMsg.component}]`, debugMsg.message, debugMsg.data);
      return;
    }

    // If client is not yet authenticated, queue the message
    if (!this.authenticatedClients.has(ws)) {
      appendLog('VSCode Server', `Queueing message before authentication: ${msg.type}`);
      const queue = this.pendingMessages.get(ws) || [];
      queue.push(msg);
      this.pendingMessages.set(ws, queue);
      return;
    }

    this.onMessageCallbacks.forEach((cb) => cb(msg, ws));
  }

  private async handleAuthRequest(msg: AuthRequestMessage, ws: WebSocket) {
    appendLog('VSCode Server', `Authorizing client: ${msg.clientName}`);
    this.approveClient(ws);
  }

  private approveClient(ws: WebSocket) {
    this.authenticatedClients.add(ws);
    const resp: AuthResponseMessage = {
      type: 'AUTH_RESPONSE',
      approved: true,
      timestamp: Date.now(),
    };
    ws.send(JSON.stringify(resp));
    appendLog('VSCode Server', 'Sent AUTH_RESPONSE (approved: true)');

    // Replay queued messages
    const pending = this.pendingMessages.get(ws) || [];
    this.pendingMessages.delete(ws);
    pending.forEach((msg) => {
      appendLog('VSCode Server', `Processing queued message: ${msg.type}`);
      this.onMessageCallbacks.forEach((cb) => cb(msg, ws));
    });

    this.onClientConnectedCallbacks.forEach((cb) => cb());
  }

  public broadcast(msg: ProtocolMessage) {
    const data = JSON.stringify(msg);
    this.authenticatedClients.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });
  }

  public onMessage(cb: (msg: ProtocolMessage, ws: WebSocket) => void) {
    this.onMessageCallbacks.push(cb);
  }

  public onClientConnected(cb: () => void) {
    this.onClientConnectedCallbacks.push(cb);
  }

  public onClientDisconnected(cb: () => void) {
    this.onClientDisconnectedCallbacks.push(cb);
  }

  public hasAuthenticatedClients(): boolean {
    return this.authenticatedClients.size > 0;
  }
}

