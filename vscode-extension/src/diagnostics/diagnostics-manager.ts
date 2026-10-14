import * as vscode from 'vscode';
import { ShaderCompileDiagnostic } from '@shared/shadertoy';
import { ShadertoyFileSystemProvider } from '../vfs/shadertoy-vfs';

export class DiagnosticsManager {
  private collection: vscode.DiagnosticCollection;

  constructor() {
    this.collection = vscode.languages.createDiagnosticCollection('shadertoy');
  }

  public updateDiagnostics(
    shaderId: string,
    diagnostics: ShaderCompileDiagnostic[],
    success: boolean
  ) {
    if (success && (!diagnostics || diagnostics.length === 0)) {
      // Wyczyść błędy dla wszystkich passów tego shadera
      this.clearShaderDiagnostics(shaderId);
      return;
    }

    // Pogrupuj błędy po passName
    const passDiagnosticsMap = new Map<string, vscode.Diagnostic[]>();

    diagnostics.forEach((d) => {
      const passName = d.passName || 'Image';
      if (!passDiagnosticsMap.has(passName)) {
        passDiagnosticsMap.set(passName, []);
      }

      // WebGL line numbers są 1-indexed, VS Code 0-indexed
      const line = Math.max(0, d.line - 1);
      const range = new vscode.Range(line, 0, line, 500);
      const severity =
        d.severity === 'warning'
          ? vscode.DiagnosticSeverity.Warning
          : vscode.DiagnosticSeverity.Error;

      const diagnostic = new vscode.Diagnostic(range, d.message, severity);
      diagnostic.source = 'Shadertoy WebGL';
      passDiagnosticsMap.get(passName)!.push(diagnostic);
    });

    // Wyczyść i zastosuj nowe diagnostyki
    this.clearShaderDiagnostics(shaderId);

    passDiagnosticsMap.forEach((diags, passName) => {
      const fileUri = vscode.Uri.parse(
        `${ShadertoyFileSystemProvider.SCHEME}:/${shaderId}/${passName}.glsl`
      );
      this.collection.set(fileUri, diags);
    });
  }

  public clearShaderDiagnostics(shaderId: string) {
    // Przejrzyj diagnostyki i usuń te pasujące do danego shadera
    this.collection.forEach((uri) => {
      if (uri.scheme === ShadertoyFileSystemProvider.SCHEME && uri.path.startsWith(`/${shaderId}/`)) {
        this.collection.delete(uri);
      }
    });
  }

  public dispose() {
    this.collection.clear();
    this.collection.dispose();
  }
}

