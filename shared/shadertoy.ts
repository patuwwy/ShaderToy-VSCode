/**
 * Typy reprezentujące model danych Shadertoy (kompatybilne z oficjalnym formatem JSON API Shadertoy).
 */

export interface ShaderToyExport {
  Shader: ShaderToyShader;
}

export interface ShaderToyShader {
  ver: string; // np. "0.1"
  info: ShaderToyInfo;
  renderpass: ShaderToyRenderPass[];
}

export interface ShaderToyInfo {
  id: string; // ID shadera na stronie, np. "mtyGWy" lub "" dla nowego shadera
  date: string;
  viewed?: number;
  name: string;
  username?: string;
  description: string;
  likes?: number;
  published?: number;
  flags?: number;
  usePreview?: number;
  tags: string[];
  hasliked?: number;
}

export type PassType = 'image' | 'buffer' | 'sound' | 'common' | 'cubemap';

export interface ShaderToySampler {
  filter: 'nearest' | 'linear' | 'mipmap';
  wrap: 'clamp' | 'repeat';
  vflip: 'true' | 'false' | boolean;
  srgb: 'true' | 'false' | boolean;
  internal: string;
}

export interface ShaderToyInput {
  id: number;
  src?: string;
  ctype: 'texture' | 'buffer' | 'cubemap' | 'music' | 'mic' | 'keyboard' | 'volume' | 'video' | 'webcam' | string;
  channel: number; // 0, 1, 2, 3
  sampler: ShaderToySampler;
  published: number;
}

export interface ShaderToyOutput {
  id: number;
  channel: number;
}

export interface ShaderToyRenderPass {
  name: string; // np. "Image", "Buffer A", "Buffer B", "Buffer C", "Buffer D", "Common", "Sound"
  type: PassType;
  description: string;
  code: string;
  inputs: ShaderToyInput[];
  outputs: ShaderToyOutput[];
}

/**
 * Zdefiniowany błąd kompilacji WebGL z Shadertoy.
 */
export interface ShaderCompileDiagnostic {
  passName: string;
  line: number;
  column?: number;
  message: string;
  severity: 'error' | 'warning';
  raw: string;
}
