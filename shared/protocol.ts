import { ShaderCompileDiagnostic, ShaderToyExport } from './shadertoy';

export const DEFAULT_WS_PORT = 27412;
export const WS_PROTOCOL_VERSION = '1.0.0';

/**
 * Typy wiadomości w kanale WebSocket
 */
export type MessageType =
  | 'AUTH_REQUEST'
  | 'AUTH_RESPONSE'
  | 'TAB_REGISTER'
  | 'TAB_UNREGISTER'
  | 'SHADER_SNAPSHOT'
  | 'UPDATE_PASS'
  | 'UPDATE_METADATA'
  | 'RECOMPILE_COMMAND'
  | 'DIAGNOSTICS'
  | 'SYNC_CONFLICT'
  | 'SET_ACTIVE_PASS'
  | 'DEBUG_LOG';

export interface BaseMessage {
  type: MessageType;
  version?: string;
  timestamp: number;
}

export interface DebugLogMessage extends BaseMessage {
  type: 'DEBUG_LOG';
  component: 'in-page' | 'content' | 'background' | 'vscode';
  message: string;
  data?: any;
}

// 1. Handshake i parowanie One-Click
export interface AuthRequestMessage extends BaseMessage {
  type: 'AUTH_REQUEST';
  clientName: string; // np. "ShaderToyAI Browser Extension"
  browserName?: string;
}

export interface AuthResponseMessage extends BaseMessage {
  type: 'AUTH_RESPONSE';
  approved: boolean;
  reason?: string;
}

// 2. Rejestracja i wyrejestrowanie karty Shadertoy
export interface TabRegisterMessage extends BaseMessage {
  type: 'TAB_REGISTER';
  tabSessionId: string; // unikalny UUID karty
  shaderId: string | null; // ID z URL lub null dla nowego shadera
  title: string;
  url: string;
}

export interface TabUnregisterMessage extends BaseMessage {
  type: 'TAB_UNREGISTER';
  tabSessionId: string;
}

// 3. Pełny stan shadera ze strony
export interface ShaderSnapshotMessage extends BaseMessage {
  type: 'SHADER_SNAPSHOT';
  tabSessionId: string;
  shaderId: string;
  shader: ShaderToyExport;
  hash: string;
}

// 4. Aktualizacja pojedynczego passu (.glsl)
export interface UpdatePassMessage extends BaseMessage {
  type: 'UPDATE_PASS';
  tabSessionId: string;
  shaderId: string;
  passName: string;
  code: string;
  triggerRecompile?: boolean; // czy wywołać rekompilację (domyślnie true przy zapisie z VS Code)
  baseHash?: string; // hash wersji bazowej do wykrywania konfliktów
}

// 5. Aktualizacja metadanych i wejść (shader.json)
export interface UpdateMetadataMessage extends BaseMessage {
  type: 'UPDATE_METADATA';
  tabSessionId: string;
  shaderId: string;
  shader: ShaderToyExport;
}

// 6. Żądanie rekompilacji shadera
export interface RecompileCommandMessage extends BaseMessage {
  type: 'RECOMPILE_COMMAND';
  tabSessionId: string;
  shaderId?: string;
}

// 7. Diagnostyka kompilatora WebGL z przeglądarki
export interface DiagnosticsMessage extends BaseMessage {
  type: 'DIAGNOSTICS';
  tabSessionId: string;
  shaderId: string;
  success: boolean;
  diagnostics: ShaderCompileDiagnostic[];
}

// 8. Zgłoszenie konfliktu
export interface SyncConflictMessage extends BaseMessage {
  type: 'SYNC_CONFLICT';
  tabSessionId: string;
  shaderId: string;
  passName: string;
  localCode: string;
  remoteCode: string;
}

// 9. Przełączanie aktywnego passu (dwukierunkowe)
export interface SetActivePassMessage extends BaseMessage {
  type: 'SET_ACTIVE_PASS';
  tabSessionId?: string;
  shaderId: string;
  passName: string;
}

export type ProtocolMessage =
  | AuthRequestMessage
  | AuthResponseMessage
  | TabRegisterMessage
  | TabUnregisterMessage
  | ShaderSnapshotMessage
  | UpdatePassMessage
  | UpdateMetadataMessage
  | RecompileCommandMessage
  | DiagnosticsMessage
  | SyncConflictMessage
  | SetActivePassMessage
  | DebugLogMessage;

