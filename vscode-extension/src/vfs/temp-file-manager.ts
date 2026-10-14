import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ShaderToyExport } from '@shared/shadertoy';

export class TempFileManager {
  private baseDir: string;
  private watchedDirs = new Map<string, fs.FSWatcher>();
  private lastWrittenTime = new Map<string, number>();

  public onFileModifiedByExternal?: (shaderId: string, passName: string, code: string) => void;

  constructor() {
    this.baseDir = this.resolveBaseDir();
    try {
      fs.mkdirSync(this.baseDir, { recursive: true });
    } catch (e: any) {
      console.error('[ShaderToy VSCode] Failed to create base temp directory:', e);
    }
  }

  public resolveBaseDir(): string {
    const customDir = vscode.workspace.getConfiguration('shadertoy').get<string>('tempDirectory', '').trim();
    if (customDir) {
      return path.isAbsolute(customDir) ? customDir : path.resolve(customDir);
    }
    return path.join(os.tmpdir(), 'shadertoy-vscode');
  }

  public getBaseDir(): string {
    return this.baseDir;
  }

  public getShaderDir(shaderId: string): string {
    return path.join(this.baseDir, shaderId);
  }

  public getPassFilePath(shaderId: string, passName: string): string {
    const dir = this.getShaderDir(shaderId);
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (_) {}
    }
    const filePath = path.join(dir, `${passName}.glsl`);
    if (!fs.existsSync(filePath)) {
      try {
        fs.writeFileSync(filePath, '', 'utf-8');
      } catch (_) {}
    }
    return filePath;
  }

  public getMetadataFilePath(shaderId: string): string {
    const dir = this.getShaderDir(shaderId);
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (_) {}
    }
    const filePath = path.join(dir, 'shader.json');
    if (!fs.existsSync(filePath)) {
      try {
        fs.writeFileSync(filePath, '{}', 'utf-8');
      } catch (_) {}
    }
    return filePath;
  }

  public parseFilePath(filePath: string): { shaderId: string; passName: string } | null {
    const normalized = path.normalize(filePath);
    const normalizedBase = path.normalize(this.baseDir);
    if (!normalized.toLowerCase().startsWith(normalizedBase.toLowerCase())) return null;

    const rel = path.relative(normalizedBase, normalized);
    const parts = rel.split(path.sep);
    if (parts.length === 2 && parts[1].toLowerCase().endsWith('.glsl')) {
      return {
        shaderId: parts[0],
        passName: parts[1].replace(/\.glsl$/i, ''),
      };
    }
    return null;
  }

  public isTempShaderFile(filePath: string): boolean {
    return this.parseFilePath(filePath) !== null;
  }

  public writePass(shaderId: string, passName: string, code: string): string {
    const dir = this.getShaderDir(shaderId);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const filePath = this.getPassFilePath(shaderId, passName);

    // Skip rewrite if content is strictly identical
    try {
      if (fs.existsSync(filePath)) {
        const existing = fs.readFileSync(filePath, 'utf-8');
        if (existing === code) return filePath;
      }
    } catch (_) {}

    this.lastWrittenTime.set(filePath.toLowerCase(), Date.now());
    fs.writeFileSync(filePath, code, 'utf-8');
    return filePath;
  }

  public writeMetadata(shaderId: string, exp: ShaderToyExport): string {
    const dir = this.getShaderDir(shaderId);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const filePath = this.getMetadataFilePath(shaderId);
    fs.writeFileSync(filePath, JSON.stringify(exp, null, 2), 'utf-8');
    return filePath;
  }

  public initShaderFiles(shaderId: string, shader: ShaderToyExport): void {
    const dir = this.getShaderDir(shaderId);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    shader.Shader?.renderpass?.forEach((p) => {
      this.writePass(shaderId, p.name, p.code || '');
    });
    this.writeMetadata(shaderId, shader);
    this.watchShaderDir(shaderId);
  }

  public watchShaderDir(shaderId: string): void {
    if (this.watchedDirs.has(shaderId)) return;
    const dir = this.getShaderDir(shaderId);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    try {
      const watcher = fs.watch(dir, (eventType, filename) => {
        if (!filename || !filename.toLowerCase().endsWith('.glsl')) return;
        const filePath = path.join(dir, filename);
        const passName = filename.replace(/\.glsl$/i, '');

        // Echo protection: check if modified within 600ms of our own write
        const lastWrite = this.lastWrittenTime.get(filePath.toLowerCase()) || 0;
        if (Date.now() - lastWrite < 600) {
          return;
        }

        // Debounce read to let file write flush
        setTimeout(() => {
          try {
            if (!fs.existsSync(filePath)) return;
            const code = fs.readFileSync(filePath, 'utf-8');
            this.onFileModifiedByExternal?.(shaderId, passName, code);
          } catch (_) {}
        }, 120);
      });

      this.watchedDirs.set(shaderId, watcher);
    } catch (e) {
      console.warn(`[ShaderToy VSCode] Failed to watch directory for shader ${shaderId}:`, e);
    }
  }

  public unwatchShaderDir(shaderId: string): void {
    const watcher = this.watchedDirs.get(shaderId);
    if (watcher) {
      watcher.close();
      this.watchedDirs.delete(shaderId);
    }
  }

  public dispose(): void {
    for (const watcher of this.watchedDirs.values()) {
      watcher.close();
    }
    this.watchedDirs.clear();
  }
}

