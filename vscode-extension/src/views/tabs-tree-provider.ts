import * as vscode from 'vscode';
import { SessionManager, TabSession } from '../session/session-manager';
import { TempFileManager } from '../vfs/temp-file-manager';

export type TreeItemData =
  | { type: 'shader'; session: TabSession } |
  { type: 'pass'; shaderId: string; passName: string } |
  { type: 'metadata'; shaderId: string };

export class ShadertoyTabsTreeProvider implements vscode.TreeDataProvider<TreeItemData> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeItemData | undefined>();
  public readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private activeShaderId: string | null = null;
  private activePassName: string | null = null;
  private passItems = new Map<string, TreeItemData>(); // `${shaderId}:${passName.toLowerCase()}` -> TreeItemData
  private metadataItems = new Map<string, TreeItemData>(); // shaderId -> TreeItemData

  constructor(
    private sessionManager: SessionManager,
    private tempFileManager: TempFileManager,
  ) {
    this.sessionManager.onDidSessionsChange(() => {
      this.refresh();
    });
  }

  public refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  public setActivePass(shaderId: string, passName: string): void {
    this.activeShaderId = shaderId;
    this.activePassName = passName;
    this.refresh();
  }

  public getPassItem(shaderId: string, passName: string): TreeItemData {
    const key = `${shaderId}:${passName.toLowerCase()}`;
    let item = this.passItems.get(key);
    if (!item) {
      item = { type: 'pass', shaderId, passName };
      this.passItems.set(key, item);
    }
    return item;
  }

  public getTreeItem(element: TreeItemData): vscode.TreeItem {
    if (element.type === 'shader') {
      const { session } = element;
      const item = new vscode.TreeItem(
        session.title || 'Shader',
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.id = `shader:${session.shaderId}`;
      item.description = `[${session.shaderId}]`;
      const shaderDir = this.tempFileManager.getShaderDir(session.shaderId);
      item.tooltip = `${session.title}\nFolder: ${shaderDir}\nURL: ${session.url}`;
      item.iconPath = new vscode.ThemeIcon('symbol-color');
      item.contextValue = 'shadertoy-session';
      return item;
    }

    if (element.type === 'pass') {
      const { shaderId, passName } = element;
      const filePath = this.tempFileManager.getPassFilePath(shaderId, passName);
      const uri = vscode.Uri.file(filePath);
      const item = new vscode.TreeItem(`${passName}.glsl`, vscode.TreeItemCollapsibleState.None);
      item.id = `pass:${shaderId}:${passName.toLowerCase()}`;

      const isActive =
        this.activeShaderId === shaderId &&
        this.activePassName?.toLowerCase() === passName.toLowerCase();

      if (isActive) {
        item.description = '● active';
        item.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.green'));
      } else {
        item.iconPath = new vscode.ThemeIcon('file-code');
      }

      item.command = {
        command: 'vscode.open',
        title: 'Open Pass',
        arguments: [uri],
      };
      item.contextValue = isActive ? 'shadertoy-pass-active' : 'shadertoy-pass';
      return item;
    }

    if (element.type === 'metadata') {
      const { shaderId } = element;
      const filePath = this.tempFileManager.getMetadataFilePath(shaderId);
      const uri = vscode.Uri.file(filePath);
      const item = new vscode.TreeItem('shader.json', vscode.TreeItemCollapsibleState.None);
      item.id = `meta:${shaderId}`;
      item.iconPath = new vscode.ThemeIcon('gear');
      item.command = {
        command: 'vscode.open',
        title: 'Open Metadata',
        arguments: [uri],
      };
      item.contextValue = 'shadertoy-metadata';
      return item;
    }

    return new vscode.TreeItem('Unknown element');
  }

  public getChildren(element?: TreeItemData): vscode.ProviderResult<TreeItemData[]> {
    if (!element) {
      // Root: lista wszystkich sesji kart
      const sessions = this.sessionManager.getAllSessions();
      if (sessions.length === 0) {
        return [];
      }
      return sessions.map(s => ({ type: 'shader', session: s }));
    }

    if (element.type === 'shader') {
      const { session } = element;
      const passNames = this.sessionManager.getPassNames(session.shaderId);

      const items: TreeItemData[] = passNames.map(name =>
        this.getPassItem(session.shaderId, name),
      );

      let metaItem = this.metadataItems.get(session.shaderId);
      if (!metaItem) {
        metaItem = { type: 'metadata', shaderId: session.shaderId };
        this.metadataItems.set(session.shaderId, metaItem);
      }
      items.push(metaItem);

      return items;
    }

    return [];
  }

  public getParent(element: TreeItemData): vscode.ProviderResult<TreeItemData> {
    if (element.type === 'pass' || element.type === 'metadata') {
      const session = this.sessionManager.getSessionByShaderId(element.shaderId);
      if (session) {
        return { type: 'shader', session };
      }
    }
    return undefined;
  }
}
