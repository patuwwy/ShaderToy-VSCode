import * as vscode from 'vscode';
import { ShaderToyExport } from '@shared/shadertoy';

export interface TabSession {
  tabSessionId: string;
  shaderId: string; // "mtyGWy" lub "new-<tabSessionId.slice(0, 8)>"
  realShaderId: string | null;
  title: string;
  url: string;
  snapshot?: ShaderToyExport;
  lastHash?: string;
  isUnsaved: boolean;
}

export class SessionManager {
  private sessions = new Map<string, TabSession>(); // tabSessionId -> TabSession
  private shaderCodes = new Map<string, Map<string, string>>(); // shaderId -> (passName -> code)
  private shaderExports = new Map<string, ShaderToyExport>(); // shaderId -> ShaderToyExport

  private _onDidSessionsChange = new vscode.EventEmitter<void>();
  public readonly onDidSessionsChange = this._onDidSessionsChange.event;

  private _onDidShaderCodeChange = new vscode.EventEmitter<{ shaderId: string; passName: string; code: string }>();
  public readonly onDidShaderCodeChange = this._onDidShaderCodeChange.event;

  public registerTab(tabSessionId: string, shaderId: string | null, title: string, url: string): TabSession {
    const isUnsaved = !shaderId || shaderId === 'new';
    const effectiveShaderId = isUnsaved ? `new-${tabSessionId.slice(0, 8)}` : shaderId;

    const session: TabSession = {
      tabSessionId,
      shaderId: effectiveShaderId,
      realShaderId: isUnsaved ? null : shaderId,
      title: title || 'New shader',
      url,
      isUnsaved,
    };

    this.sessions.set(tabSessionId, session);
    this._onDidSessionsChange.fire();
    return session;
  }

  public unregisterTab(tabSessionId: string) {
    this.sessions.delete(tabSessionId);
    this._onDidSessionsChange.fire();
  }

  public getSessionByTabSessionId(tabSessionId: string): TabSession | undefined {
    return this.sessions.get(tabSessionId);
  }

  public setSnapshot(tabSessionId: string, shader: ShaderToyExport, hash: string): string | undefined {
    const session = this.sessions.get(tabSessionId);
    if (!session) return undefined;

    session.snapshot = shader;
    session.lastHash = hash;
    if (shader.Shader?.info?.name) {
      session.title = shader.Shader.info.name;
    }

    const shaderId = session.shaderId;
    this.shaderExports.set(shaderId, shader);

    // Inicjalizacja kodów passów
    let passesMap = this.shaderCodes.get(shaderId);
    if (!passesMap) {
      passesMap = new Map();
      this.shaderCodes.set(shaderId, passesMap);
    }
    shader.Shader?.renderpass?.forEach((p) => {
      passesMap.set(p.name, p.code || '');
    });

    this._onDidSessionsChange.fire();
    return shaderId;
  }

  public updatePassCode(shaderId: string, passName: string, code: string, notify = true) {
    let passesMap = this.shaderCodes.get(shaderId);
    if (!passesMap) {
      passesMap = new Map();
      this.shaderCodes.set(shaderId, passesMap);
    }
    passesMap.set(passName, code);

    // Zaktualizuj też w przechowywanym eksporcie JSON
    const exp = this.shaderExports.get(shaderId);
    if (exp?.Shader?.renderpass) {
      const pass = exp.Shader.renderpass.find(p => p.name.toLowerCase() === passName.toLowerCase());
      if (pass) {
        pass.code = code;
      }
    }

    if (notify) {
      this._onDidShaderCodeChange.fire({ shaderId, passName, code });
    }
  }

  public getPassCode(shaderId: string, passName: string): string | undefined {
    return this.shaderCodes.get(shaderId)?.get(passName);
  }

  public getShaderExport(shaderId: string): ShaderToyExport | undefined {
    return this.shaderExports.get(shaderId);
  }

  public setShaderExport(shaderId: string, exp: ShaderToyExport) {
    this.shaderExports.set(shaderId, exp);
    if (exp.Shader?.renderpass) {
      exp.Shader.renderpass.forEach((p) => {
        this.updatePassCode(shaderId, p.name, p.code, false);
      });
    }
  }

  public getPassNames(shaderId: string): string[] {
    const exp = this.shaderExports.get(shaderId);
    if (exp?.Shader?.renderpass) {
      return exp.Shader.renderpass.map(p => p.name);
    }
    const codes = this.shaderCodes.get(shaderId);
    if (codes) {
      return Array.from(codes.keys());
    }
    return ['Image'];
  }

  public getSessionByShaderId(shaderId: string): TabSession | undefined {
    for (const session of this.sessions.values()) {
      if (session.shaderId === shaderId) return session;
    }
    return undefined;
  }

  public getAllSessions(): TabSession[] {
    return Array.from(this.sessions.values());
  }

  public getTabSessionIdForShader(shaderId: string): string | undefined {
    return this.getSessionByShaderId(shaderId)?.tabSessionId;
  }
}
