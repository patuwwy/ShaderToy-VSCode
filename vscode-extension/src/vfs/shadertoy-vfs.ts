import * as vscode from 'vscode';
import { SessionManager } from '../session/session-manager';
import { ShaderToyExport } from '@shared/shadertoy';

export class ShadertoyFileSystemProvider implements vscode.FileSystemProvider {
  public static readonly SCHEME = 'shadertoy';

  private _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  public readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this._emitter.event;

  public onUserSavedPass?: (shaderId: string, passName: string, code: string) => void;
  public onUserSavedMetadata?: (shaderId: string, exp: ShaderToyExport) => void;

  constructor(private sessionManager: SessionManager) {
    // Nasłuchuj zmian kodów z zewnątrz (np. ze strony Shadertoy)
    this.sessionManager.onDidShaderCodeChange(({ shaderId, passName }) => {
      const uri = vscode.Uri.parse(`${ShadertoyFileSystemProvider.SCHEME}:/${shaderId}/${passName}.glsl`);
      this._emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
    });

    this.sessionManager.onDidSessionsChange(() => {
      // Zmiana listy folderów / sesji
      const rootUri = vscode.Uri.parse(`${ShadertoyFileSystemProvider.SCHEME}:/`);
      this._emitter.fire([{ type: vscode.FileChangeType.Changed, uri: rootUri }]);
    });
  }

  public watch(_uri: vscode.Uri): vscode.Disposable {
    return new vscode.Disposable(() => {
      // no-op watcher
    });
  }

  public stat(uri: vscode.Uri): vscode.FileStat {
    const parts = this.parsePath(uri.path);

    // Główny katalog domowy /
    if (parts.length === 0) {
      return {
        type: vscode.FileType.Directory,
        ctime: Date.now(),
        mtime: Date.now(),
        size: 0,
      };
    }

    const shaderId = parts[0];

    // Katalog shadera /<shaderId>
    if (parts.length === 1) {
      return {
        type: vscode.FileType.Directory,
        ctime: Date.now(),
        mtime: Date.now(),
        size: 0,
      };
    }

    // Plik wewnątrz shadera /<shaderId>/<filename>
    const filename = parts[1];
    if (filename === 'shader.json') {
      const exp = this.sessionManager.getShaderExport(shaderId);
      const size = exp ? JSON.stringify(exp, null, 2).length : 0;
      return {
        type: vscode.FileType.File,
        ctime: Date.now(),
        mtime: Date.now(),
        size,
      };
    }

    if (filename.endsWith('.glsl')) {
      const passName = filename.replace(/\.glsl$/, '');
      const code = this.sessionManager.getPassCode(shaderId, passName) || '';
      return {
        type: vscode.FileType.File,
        ctime: Date.now(),
        mtime: Date.now(),
        size: Buffer.byteLength(code, 'utf-8'),
      };
    }

    throw vscode.FileSystemError.FileNotFound(uri);
  }

  public readDirectory(uri: vscode.Uri): [string, vscode.FileType][] {
    const parts = this.parsePath(uri.path);

    // Root: lista wszystkich aktywnych shaderów
    if (parts.length === 0) {
      const sessions = this.sessionManager.getAllSessions();
      return sessions.map(s => [s.shaderId, vscode.FileType.Directory]);
    }

    // Wewnątrz folderu shadera /<shaderId>
    if (parts.length === 1) {
      const shaderId = parts[0];
      const passNames = this.sessionManager.getPassNames(shaderId);

      const entries: [string, vscode.FileType][] = [
        ['shader.json', vscode.FileType.File],
      ];

      passNames.forEach((name) => {
        entries.push([`${name}.glsl`, vscode.FileType.File]);
      });

      return entries;
    }

    return [];
  }

  public readFile(uri: vscode.Uri): Uint8Array {
    const parts = this.parsePath(uri.path);
    if (parts.length < 2) {
      throw vscode.FileSystemError.FileIsADirectory(uri);
    }

    const shaderId = parts[0];
    const filename = parts[1];

    if (filename === 'shader.json') {
      const exp = this.sessionManager.getShaderExport(shaderId);
      const jsonContent = exp ? JSON.stringify(exp, null, 2) : '{}';
      return Buffer.from(jsonContent, 'utf-8');
    }

    if (filename.endsWith('.glsl')) {
      const passName = filename.replace(/\.glsl$/, '');
      const code = this.sessionManager.getPassCode(shaderId, passName) ?? '';
      return Buffer.from(code, 'utf-8');
    }

    throw vscode.FileSystemError.FileNotFound(uri);
  }

  public writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    _options: { create: boolean; overwrite: boolean },
  ): void {
    const parts = this.parsePath(uri.path);
    if (parts.length < 2) {
      throw vscode.FileSystemError.FileIsADirectory(uri);
    }

    const shaderId = parts[0];
    const filename = parts[1];
    const textContent = Buffer.from(content).toString('utf-8');

    if (filename === 'shader.json') {
      try {
        const exp = JSON.parse(textContent) as ShaderToyExport;
        this.sessionManager.setShaderExport(shaderId, exp);
        if (this.onUserSavedMetadata) {
          this.onUserSavedMetadata(shaderId, exp);
        }
        this._emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`ShaderToy AI: Invalid shader.json format: ${errMsg}`);
      }
      return;
    }

    if (filename.endsWith('.glsl')) {
      const passName = filename.replace(/\.glsl$/, '');
      // Local session write
      this.sessionManager.updatePassCode(shaderId, passName, textContent, false);

      // Trigger synchronization callback (sends code to browser and recompiles)
      if (this.onUserSavedPass) {
        this.onUserSavedPass(shaderId, passName, textContent);
      }

      this._emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
      return;
    }

    throw vscode.FileSystemError.FileNotFound(uri);
  }

  public createDirectory(_uri: vscode.Uri): void {
    // Virtual folders are managed dynamically
  }

  public delete(_uri: vscode.Uri, _options: { recursive: boolean }): void {
    // Deleting virtual passes is not permitted
  }

  public rename(_oldUri: vscode.Uri, _newUri: vscode.Uri, _options: { overwrite: boolean }): void {
    throw vscode.FileSystemError.NoPermissions('Renaming virtual shader files is not allowed.');
  }

  private parsePath(p: string): string[] {
    return p.split('/').map(s => s.trim()).filter(s => s.length > 0);
  }
}
