import * as vscode from 'vscode';
import {
  DEFAULT_WS_PORT,
  ProtocolMessage,
  UpdatePassMessage,
  UpdateMetadataMessage,
  RecompileCommandMessage,
  SetActivePassMessage,
} from '@shared/protocol';
import { ShadertoyWSServer } from './server/ws-server';
import { SessionManager } from './session/session-manager';
import { ShadertoyFileSystemProvider } from './vfs/shadertoy-vfs';
import { TempFileManager } from './vfs/temp-file-manager';
import { DiagnosticsManager } from './diagnostics/diagnostics-manager';
import { ShadertoyTabsTreeProvider, TreeItemData } from './views/tabs-tree-provider';
import { appendLog } from './logger';

export async function activate(context: vscode.ExtensionContext) {
  console.log('[ShaderToy VSCode] Initializing extension...');

  // Clean up any legacy virtual shadertoy workspace folders from File Explorer
  (vscode.workspace.workspaceFolders || []).forEach((folder, index) => {
    if (folder.uri.scheme === 'shadertoy' || folder.uri.toString().startsWith('shadertoy:/')) {
      vscode.workspace.updateWorkspaceFolders(index, 1);
    }
  });

  // 1. Initialize SessionManager and TempFileManager
  const sessionManager = new SessionManager();
  const tempFileManager = new TempFileManager();
  context.subscriptions.push({
    dispose: () => tempFileManager.dispose(),
  });

  // Handle external edits on disk (e.g. from CLI AI tools or node fs)
  tempFileManager.onFileModifiedByExternal = (shaderId: string, passName: string, code: string) => {
    const currentCode = sessionManager.getPassCode(shaderId, passName);
    if (currentCode === code) return;

    sessionManager.updatePassCode(shaderId, passName, code, false);
    const tabSessionId = sessionManager.getTabSessionIdForShader(shaderId) || '';

    appendLog('VSCode Extension', `External edit detected in ${passName}.glsl (${shaderId}) -> sending UPDATE_PASS with recompile`);
    const updateMsg: UpdatePassMessage = {
      type: 'UPDATE_PASS',
      tabSessionId,
      shaderId,
      passName,
      code,
      triggerRecompile: true, // CLI AI edit: trigger immediate compilation!
      timestamp: Date.now(),
    };
    server.broadcast(updateMsg);
  };

  // 2. Initialize and register FileSystemProvider for "shadertoy" scheme (kept for backward compatibility)
  const vfs = new ShadertoyFileSystemProvider(sessionManager);
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(ShadertoyFileSystemProvider.SCHEME, vfs, {
      isCaseSensitive: true,
      isReadonly: false,
    })
  );

  // 3. Initialize DiagnosticsManager
  const diagnosticsManager = new DiagnosticsManager();
  context.subscriptions.push(diagnosticsManager);

  // 4. Initialize and register TreeView (in dedicated activity bar tab)
  const treeProvider = new ShadertoyTabsTreeProvider(sessionManager, tempFileManager);
  const treeView = vscode.window.createTreeView('shadertoyTabsView', {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);

  // 5. Initialize WebSocket server
  const server = new ShadertoyWSServer(context);
  const config = vscode.workspace.getConfiguration('shadertoy');
  const port = config.get<number>('port', DEFAULT_WS_PORT);

  try {
    await server.start(port);
  } catch (err: any) {
    vscode.window.showErrorMessage(`ShaderToy VSCode: Failed to start server on port ${port}: ${err.message}`);
  }

  // Active file synchronization flags
  let ignoreNextActiveEditorUri: string | null = null;
  let lastReportedUri = '';

  // 6. Handle messages from browser
  server.onMessage(async (msg: ProtocolMessage) => {
    switch (msg.type) {
      case 'TAB_REGISTER': {
        appendLog('VSCode Extension', `Received TAB_REGISTER: ${msg.title} (${msg.shaderId})`, msg);
        const session = sessionManager.registerTab(msg.tabSessionId, msg.shaderId, msg.title, msg.url);
        // Pre-create the directory and default pass file so it exists on disk immediately
        tempFileManager.getPassFilePath(session.shaderId, 'Image');
        tempFileManager.getMetadataFilePath(session.shaderId);
        vscode.window.showInformationMessage(`ShaderToy VSCode: Detected shader "${session.title}" [${session.shaderId}]`);
        console.log(`[ShaderToy VSCode] Registered tab: ${session.title} [${session.shaderId}]`);
        break;
      }

      case 'TAB_UNREGISTER': {
        appendLog('VSCode Extension', `Received TAB_UNREGISTER: ${msg.tabSessionId}`);
        const session = sessionManager.getSessionByTabSessionId(msg.tabSessionId);
        if (session) {
          tempFileManager.unwatchShaderDir(session.shaderId);
        }
        sessionManager.unregisterTab(msg.tabSessionId);
        break;
      }

      case 'SHADER_SNAPSHOT': {
        appendLog('VSCode Extension', `Received SHADER_SNAPSHOT: ${msg.shaderId}, pass count: ${msg.shader?.Shader?.renderpass?.length}`);
        const effectiveShaderId = sessionManager.setSnapshot(msg.tabSessionId, msg.shader, msg.hash) ||
          sessionManager.getSessionByTabSessionId(msg.tabSessionId)?.shaderId ||
          msg.shaderId;
        tempFileManager.initShaderFiles(effectiveShaderId, msg.shader);
        break;
      }

      case 'UPDATE_PASS': {
        appendLog('VSCode Extension', `Received UPDATE_PASS from browser: ${msg.passName} (${msg.shaderId})`);
        const effectiveShaderId = (msg.tabSessionId ? sessionManager.getSessionByTabSessionId(msg.tabSessionId)?.shaderId : undefined) ||
          sessionManager.getSessionByShaderId(msg.shaderId)?.shaderId ||
          msg.shaderId;
        const filePath = tempFileManager.writePass(effectiveShaderId, msg.passName, msg.code);
        const fileUri = vscode.Uri.file(filePath);
        const openDoc = vscode.workspace.textDocuments.find(
          (d) => d.uri.toString() === fileUri.toString()
        );

        // Conflict detection: only warn if VS Code editor has unsaved (dirty) edits
        if (openDoc && openDoc.isDirty && openDoc.getText() !== msg.code) {
          const choice = await vscode.window.showWarningMessage(
            `ShaderToy VSCode: Conflict detected in pass "${msg.passName}" (VS Code has unsaved edits).`,
            'Accept Shadertoy version',
            'Overwrite with VS Code version',
            'Show Diff'
          );

          if (choice === 'Accept Shadertoy version') {
            sessionManager.updatePassCode(effectiveShaderId, msg.passName, msg.code, true);
          } else if (choice === 'Overwrite with VS Code version') {
            const updateMsg: UpdatePassMessage = {
              type: 'UPDATE_PASS',
              tabSessionId: msg.tabSessionId,
              shaderId: effectiveShaderId,
              passName: msg.passName,
              code: openDoc.getText(),
              triggerRecompile: true,
              timestamp: Date.now(),
            };
            server.broadcast(updateMsg);
          } else if (choice === 'Show Diff') {
            vscode.commands.executeCommand('vscode.diff', fileUri, fileUri, `${msg.passName} (Local vs Remote)`);
          }
        } else {
          sessionManager.updatePassCode(effectiveShaderId, msg.passName, msg.code, true);
        }
        break;
      }

      case 'DIAGNOSTICS': {
        const effectiveShaderId = (msg.tabSessionId ? sessionManager.getSessionByTabSessionId(msg.tabSessionId)?.shaderId : undefined) ||
          sessionManager.getSessionByShaderId(msg.shaderId)?.shaderId ||
          msg.shaderId;
        diagnosticsManager.updateDiagnostics(effectiveShaderId, msg.diagnostics, msg.success);
        break;
      }

      case 'SET_ACTIVE_PASS': {
        appendLog('VSCode Extension', `Received SET_ACTIVE_PASS: ${msg.passName} for shader ${msg.shaderId}`);
        const effectiveShaderId = (msg.tabSessionId ? sessionManager.getSessionByTabSessionId(msg.tabSessionId)?.shaderId : undefined) ||
          sessionManager.getSessionByShaderId(msg.shaderId)?.shaderId ||
          msg.shaderId;
        const passName = msg.passName;
        if (!effectiveShaderId || !passName) break;

        const passNames = sessionManager.getPassNames(effectiveShaderId);
        const matched = passNames.find(
          (p) => p.toLowerCase() === passName.toLowerCase()
        );
        const canonicalPassName = matched || passName;

        const filePath = tempFileManager.getPassFilePath(effectiveShaderId, canonicalPassName);
        const targetUri = vscode.Uri.file(filePath);

        // Highlight active pass in sidebar tree view
        treeProvider.setActivePass(effectiveShaderId, canonicalPassName);
        const passItem = treeProvider.getPassItem(effectiveShaderId, canonicalPassName);
        treeView.reveal(passItem, { select: true, focus: false, expand: true }).then(undefined, () => {});

        lastReportedUri = targetUri.toString();

        const currentActive = vscode.window.activeTextEditor?.document.uri;
        if (currentActive?.toString() === targetUri.toString()) {
          break;
        }

        ignoreNextActiveEditorUri = targetUri.toString();
        try {
          const doc = await vscode.workspace.openTextDocument(targetUri);
          await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: true });
        } catch (err: any) {
          console.warn('[ShaderToy VSCode] Failed to open pass file in editor:', err.message);
        }
        break;
      }
    }
  });

  // Active file synchronization: VS Code -> Browser
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!editor) {
        lastReportedUri = '';
        return;
      }
      const uri = editor.document.uri;
      if (uri.scheme !== 'file') {
        lastReportedUri = '';
        return;
      }
      const parsed = tempFileManager.parseFilePath(uri.fsPath);
      if (!parsed) {
        lastReportedUri = '';
        return;
      }

      if (ignoreNextActiveEditorUri && uri.toString() === ignoreNextActiveEditorUri) {
        ignoreNextActiveEditorUri = null;
        return;
      }
      ignoreNextActiveEditorUri = null;

      if (uri.toString() === lastReportedUri) return;
      lastReportedUri = uri.toString();

      const { shaderId, passName } = parsed;
      const tabSessionId = sessionManager.getTabSessionIdForShader(shaderId) || '';

      // Highlight in sidebar tree view
      treeProvider.setActivePass(shaderId, passName);
      const passTreeItem = treeProvider.getPassItem(shaderId, passName);
      treeView.reveal(passTreeItem, { select: true, focus: false, expand: true }).then(undefined, () => {});

      appendLog('VSCode Extension', `Active file switched in VS Code -> sending SET_ACTIVE_PASS: ${passName} (${shaderId})`);
      const activePassMsg: SetActivePassMessage = {
        type: 'SET_ACTIVE_PASS',
        tabSessionId,
        shaderId,
        passName,
        timestamp: Date.now(),
      };
      server.broadcast(activePassMsg);
    })
  );

  // 7. Live editing in VS Code -> immediately overwrite buffer in Shadertoy (without compiling)
  let liveEditDebounceTimer: NodeJS.Timeout | null = null;
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      const uri = event.document.uri;
      if (uri.scheme !== 'file') return;
      const parsed = tempFileManager.parseFilePath(uri.fsPath);
      if (!parsed) return;
      if (event.contentChanges.length === 0) return;

      const { shaderId, passName } = parsed;
      const code = event.document.getText();
      const tabSessionId = sessionManager.getTabSessionIdForShader(shaderId) || '';

      // Update session manager buffer locally
      sessionManager.updatePassCode(shaderId, passName, code, false);

      if (liveEditDebounceTimer) clearTimeout(liveEditDebounceTimer);
      liveEditDebounceTimer = setTimeout(() => {
        const updateMsg: UpdatePassMessage = {
          type: 'UPDATE_PASS',
          tabSessionId,
          shaderId,
          passName,
          code,
          triggerRecompile: false, // Live typing: do NOT compile yet
          timestamp: Date.now(),
        };
        server.broadcast(updateMsg);
      }, 100);
    })
  );

  // 8. Save pass file (.glsl) in VS Code (Ctrl+S) -> send to browser and compile
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((document) => {
      const uri = document.uri;
      if (uri.scheme !== 'file') return;
      const parsed = tempFileManager.parseFilePath(uri.fsPath);
      if (!parsed) return;

      const { shaderId, passName } = parsed;
      const code = document.getText();
      const tabSessionId = sessionManager.getTabSessionIdForShader(shaderId) || '';

      if (liveEditDebounceTimer) clearTimeout(liveEditDebounceTimer);
      const updateMsg: UpdatePassMessage = {
        type: 'UPDATE_PASS',
        tabSessionId,
        shaderId,
        passName,
        code,
        triggerRecompile: true, // Ctrl+S: trigger compilation in Shadertoy!
        timestamp: Date.now(),
      };
      server.broadcast(updateMsg);
    })
  );

  // Save metadata hook for VFS (if still used)
  vfs.onUserSavedMetadata = (shaderId: string, exp) => {
    tempFileManager.writeMetadata(shaderId, exp);
    const tabSessionId = sessionManager.getTabSessionIdForShader(shaderId) || '';
    const updateMsg: UpdateMetadataMessage = {
      type: 'UPDATE_METADATA',
      tabSessionId,
      shaderId,
      shader: exp,
      timestamp: Date.now(),
    };
    server.broadcast(updateMsg);
  };

  // 9. Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('shadertoy.recompile', () => {
      const recompileMsg: RecompileCommandMessage = {
        type: 'RECOMPILE_COMMAND',
        tabSessionId: '',
        timestamp: Date.now(),
      };
      server.broadcast(recompileMsg);
      vscode.window.showInformationMessage('ShaderToy VSCode: Sent recompile command to browser.');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('shadertoy.openShader', async (item?: TreeItemData) => {
      let shaderId: string | undefined;
      if (item && item.type === 'shader') {
        shaderId = item.session.shaderId;
      } else {
        const sessions = sessionManager.getAllSessions();
        if (sessions.length > 0) {
          shaderId = sessions[0].shaderId;
        }
      }

      if (shaderId) {
        const passFile = tempFileManager.getPassFilePath(shaderId, 'Image');
        try {
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(passFile));
          await vscode.window.showTextDocument(doc);
        } catch (err: any) {
          console.warn('[ShaderToy VSCode] Failed to open pass in editor:', err.message);
        }
      } else {
        vscode.window.showInformationMessage('ShaderToy VSCode: No active Shadertoy tabs found.');
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('shadertoy.copyFolderPath', async (item?: TreeItemData) => {
      let shaderId = item?.type === 'shader' ? item.session.shaderId : undefined;
      if (!shaderId) {
        const sessions = sessionManager.getAllSessions();
        if (sessions.length > 0) shaderId = sessions[0].shaderId;
      }
      if (shaderId) {
        const dir = tempFileManager.getShaderDir(shaderId);
        await vscode.env.clipboard.writeText(dir);
        vscode.window.showInformationMessage(`ShaderToy VSCode: Copied folder path to clipboard: ${dir}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('shadertoy.openInTerminal', (item?: TreeItemData) => {
      let shaderId = item?.type === 'shader' ? item.session.shaderId : undefined;
      if (!shaderId) {
        const sessions = sessionManager.getAllSessions();
        if (sessions.length > 0) shaderId = sessions[0].shaderId;
      }
      if (shaderId) {
        const dir = tempFileManager.getShaderDir(shaderId);
        const terminal = vscode.window.createTerminal({ name: `Shader: ${shaderId}`, cwd: dir });
        terminal.show();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('shadertoy.revealInExplorer', (item?: TreeItemData) => {
      let shaderId = item?.type === 'shader' ? item.session.shaderId : undefined;
      if (!shaderId) {
        const sessions = sessionManager.getAllSessions();
        if (sessions.length > 0) shaderId = sessions[0].shaderId;
      }
      if (shaderId) {
        const dir = tempFileManager.getShaderDir(shaderId);
        vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(dir));
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('shadertoy.reconnect', async () => {
      await server.stop();
      const newPort = vscode.workspace.getConfiguration('shadertoy').get<number>('port', DEFAULT_WS_PORT);
      await server.start(newPort);
      vscode.window.showInformationMessage(`ShaderToy VSCode: Server restarted on port ${newPort}.`);
    })
  );

  context.subscriptions.push({
    dispose: () => {
      server.stop();
    },
  });

  console.log('[ShaderToy VSCode] Extension successfully initialized.');
}

export function deactivate() {
  console.log('[ShaderToy VSCode] Deactivating extension.');
}
