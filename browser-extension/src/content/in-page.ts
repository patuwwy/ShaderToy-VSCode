import {
  ShaderToyExport,
  ShaderToyInfo,
  ShaderToyRenderPass,
  ShaderCompileDiagnostic,
  PassType,
  ShaderToyInput,
} from '@shared/shadertoy';

interface MonacoModelLike {
  getValue(): string;
  setValue(val: string): void;
  onDidChangeContent(listener: () => void): void;
  __shadertoyAiContentHooked?: boolean;
}

interface MonacoEditorLike {
  getModel(): MonacoModelLike | null;
  setModel(model: MonacoModelLike): void;
  onDidChangeModel?(listener: () => void): void;
  onDidChangeModelContent?(listener: () => void): void;
  __shadertoyAiHooked?: boolean;
  __shadertoyAiContentHooked?: boolean;
}

interface MonacoLike {
  editor?: {
    getModels?(): MonacoModelLike[];
    getEditors?(): MonacoEditorLike[];
    onDidCreateModel?(listener: (model: MonacoModelLike) => void): void;
  };
}

interface ShaderToyInputRaw {
  id?: number;
  mId?: number;
  src?: string;
  mSrc?: string;
  url?: string;
  mUrl?: string;
  ctype?: string | number;
  type?: string | number;
  mType?: string | number;
  channel?: number;
  mInfo?: { src?: string };
  mSampler?: {
    filter?: string;
    wrap?: string;
    vflip?: boolean;
    srgb?: boolean;
    internal?: string;
  };
  mPublished?: number;
  published?: number;
  [key: string]: unknown;
}

interface ShadertoyPassLike {
  name?: string;
  mName?: string;
  description?: string;
  mDescription?: string;
  mType?: string | number;
  mSource?: string;
  mShaderCode?: string;
  mCode?: string;
  mError?: string;
  mErrorLog?: string;
  mEditor?: { getValue?: () => string; setValue?: (val: string) => void };
  mInputs?: ShaderToyInputRaw[];
  NewCode?: (code: string) => void;
  [key: string]: unknown;
}

type ShadertoyInfoLike = Partial<ShaderToyInfo> & Record<string, unknown>;

interface ShadertoyEffectLike {
  mPasses?: ShadertoyPassLike[];
  mActivePass?: number;
  mShaderID?: string;
  mInfo?: ShadertoyInfoLike;
  mEditor?: { getValue?: () => string; setValue?: (val: string) => void };
  SetPass?: (idx: number) => void;
  SelectPass?: (idx: number) => void;
  SetTab?: (idx: number) => void;
  [key: string]: unknown;
}

interface WindowWithShaderToy extends Window {
  gShaderToy?: {
    mEffect?: ShadertoyEffectLike;
    mPasses?: ShadertoyPassLike[];
    mActivePass?: number;
    mShaderID?: string;
    mInfo?: ShadertoyInfoLike;
    mEditor?: { getValue?: () => string; setValue?: (val: string) => void };
    SetPass?: (idx: number) => void;
    SelectPass?: (idx: number) => void;
    [key: string]: unknown;
  };
  monaco?: MonacoLike;
  __shadertoyAiModelCreateHooked?: boolean;
}

const win = window as unknown as WindowWithShaderToy;
const tabSessionId = crypto.randomUUID();
let isInitialized = false;

// 1. Podstawowa komunikacja z content script
function postToBridge(payload: unknown) {
  window.postMessage(
    {
      source: 'shadertoy-ai-inpage',
      payload,
    },
    '*',
  );
}

function sendDebugLog(message: string, data?: unknown) {
  postToBridge({
    type: 'DEBUG_LOG',
    component: 'in-page',
    message,
    data: data ? (typeof data === 'object' ? JSON.parse(JSON.stringify(data)) : data) : undefined,
    timestamp: Date.now(),
  });
}

function getShaderIdFromUrl(): string | null {
  const match = window.location.pathname.match(/\/view\/([a-zA-Z0-9]+)/);
  return match ? match[1] : null;
}

/**
 * Zwraca właściwy obiekt Effect zawierający mPasses.
 * W architekturze Shadertoy passy znajdują się w gShaderToy.mEffect.mPasses.
 */
function getEffect(): ShadertoyEffectLike | null {
  const g = win.gShaderToy;
  if (!g) return null;
  if (g.mEffect && g.mEffect.mPasses && Array.isArray(g.mEffect.mPasses)) {
    return g.mEffect;
  }
  if (g.mPasses && Array.isArray(g.mPasses)) {
    return g as ShadertoyEffectLike;
  }
  return g.mEffect || (g as ShadertoyEffectLike);
}

function getPassName(pass: ShadertoyPassLike, index: number, allPasses: ShadertoyPassLike[]): string {
  if (pass.mName && typeof pass.mName === 'string') return pass.mName;
  if (pass.mType === 'image' || pass.mType === 2) return 'Image';
  if (pass.mType === 'common' || pass.mType === 4) return 'Common';
  if (pass.mType === 'sound' || pass.mType === 1) return 'Sound';
  if (pass.mType === 'cubemap' || pass.mType === 5) return 'Cube A';

  if (pass.mType === 'buffer' || pass.mType === 3) {
    const bufferIndex = allPasses
      .slice(0, index + 1)
      .filter(p => p.mType === 'buffer' || p.mType === 3).length;
    const letters = ['A', 'B', 'C', 'D'];
    return `Buffer ${letters[bufferIndex - 1] || bufferIndex}`;
  }

  return `Pass ${index}`;
}

function mapPassType(typeName: string | number): PassType {
  if (typeName === 'image' || typeName === 2) return 'image';
  if (typeName === 'common' || typeName === 4) return 'common';
  if (typeName === 'sound' || typeName === 1) return 'sound';
  if (typeName === 'cubemap' || typeName === 5) return 'cubemap';
  return 'buffer';
}

/**
 * Zaawansowana ekstrakcja kodu passu.
 * Sprawdza właściwości passu, edytor Monaco, CodeMirror i elementy DOM.
 */
function extractPassCode(p: ShadertoyPassLike, index: number, effect: ShadertoyEffectLike | null, g?: Record<string, unknown>): string {
  // 1. Check Monaco editor models first (live text buffer as typed by user)
  if (win.monaco?.editor) {
    const models = win.monaco.editor.getModels?.();
    if (models && models[index]) {
      const val = models[index].getValue();
      if (typeof val === 'string' && val.length > 0) {
        return val;
      }
    }
    if (models && models[0] && effect && effect.mActivePass === index) {
      const val = models[0].getValue();
      if (typeof val === 'string' && val.length > 0) {
        return val;
      }
    }
  }

  // 2. Check CodeMirror editor assigned to pass
  if (p.mEditor) {
    if (typeof p.mEditor.getValue === 'function') {
      const val = p.mEditor.getValue();
      if (typeof val === 'string' && val.length > 0) {
        return val;
      }
    }
    const editorObj = p.mEditor as Record<string, unknown>;
    if (typeof editorObj.value === 'string' && editorObj.value.length > 0) {
      return editorObj.value;
    }
  }

  // 3. Check active editor in effect or g
  if (effect && effect.mActivePass === index) {
    const gObj = g as Record<string, unknown> | undefined;
    const ed = (effect.mEditor || gObj?.mEditor) as { getValue?: () => string } | undefined;
    if (ed && typeof ed.getValue === 'function') {
      const val = ed.getValue();
      if (typeof val === 'string' && val.length > 0) {
        return val;
      }
    }
  }

  // 4. Check CodeMirror instance in DOM
  const cmElem = document.querySelector('.CodeMirror') as (Element & { CodeMirror?: { getValue?: () => string } }) | null;
  if (cmElem && cmElem.CodeMirror && typeof cmElem.CodeMirror.getValue === 'function') {
    const val = cmElem.CodeMirror.getValue();
    if (typeof val === 'string' && val.length > 0) {
      return val;
    }
  }

  // 5. Check textarea elements in page
  const textareas = Array.from(document.querySelectorAll('textarea'));
  for (const textarea of textareas) {
    const val = textarea.value;
    if (val && (val.includes('mainImage') || val.includes('void main'))) {
      return val;
    }
  }

  // 6. Direct pass properties (mSource, mShaderCode, mCode)
  if (typeof p.mSource === 'string' && p.mSource.length > 0) return p.mSource;
  if (typeof p.mShaderCode === 'string' && p.mShaderCode.length > 0) return p.mShaderCode;
  if (typeof p.mCode === 'string' && p.mCode.length > 0) return p.mCode;

  // 7. Fallback to any code-like property in pass object
  for (const k of Object.keys(p)) {
    const val = p[k];
    if (typeof val === 'string' && val.length > 0) {
      if (
        k.toLowerCase().includes('code') ||
        k.toLowerCase().includes('shader') ||
        k.toLowerCase().includes('source') ||
        val.includes('mainImage') ||
        val.includes('mainSound') ||
        val.includes('void main')
      ) {
        return val;
      }
    }
  }

  return '';
}

function extractShaderSnapshot(): ShaderToyExport | null {
  const g = win.gShaderToy;
  const effect = getEffect();
  const passes = effect?.mPasses;
  if (!effect || !passes || !Array.isArray(passes)) {
    return null;
  }

  const shaderId = getShaderIdFromUrl() || (effect.mShaderID || g?.mShaderID || effect.mInfo?.id || g?.mInfo?.id || '');
  const srcInfo = effect.mInfo || g?.mInfo;

  const info: ShaderToyInfo = {
    id: shaderId,
    date: srcInfo?.date || new Date().toISOString(),
    viewed: srcInfo?.viewed ?? 0,
    name: srcInfo?.name || document.title.replace(' - Shadertoy BETA', '').replace(' - Shadertoy', '').trim() || 'Shader',
    username: srcInfo?.username || '',
    description: srcInfo?.description || '',
    likes: srcInfo?.likes ?? 0,
    published: srcInfo?.published ?? 0,
    flags: srcInfo?.flags ?? 0,
    usePreview: srcInfo?.usePreview ?? 0,
    tags: Array.isArray(srcInfo?.tags) ? srcInfo.tags : [],
    hasliked: srcInfo?.hasliked ?? 0,
  };

  const renderpass: ShaderToyRenderPass[] = passes.map((p: ShadertoyPassLike, index: number) => {
    const passName = getPassName(p, index, passes);
    const passType = mapPassType(p.mType ?? 'image');
    const code = extractPassCode(p, index, effect, g);

    // Ekstrakcja wejść iChannel0..3
    const inputs: ShaderToyInput[] = [];
    if (p.mInputs && Array.isArray(p.mInputs)) {
      p.mInputs.forEach((inp: ShaderToyInputRaw, channelIndex: number) => {
        if (!inp) return;

        // Log właściwości inputu dla diagnostyki
        const inpClean: Record<string, unknown> = {};
        for (const k of Object.keys(inp)) {
          const v = inp[k];
          if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
            inpClean[k] = v;
          } else if (v && typeof v === 'object' && !(v as { nodeType?: unknown }).nodeType && !(v as { canvas?: unknown }).canvas) {
            try {
              inpClean[k] = JSON.parse(JSON.stringify(v));
            } catch {
              inpClean[k] = typeof v;
            }
          } else {
            inpClean[k] = typeof v;
          }
        }
        sendDebugLog(`[extractInputs] pass "${passName}" ch ${channelIndex}:`, inpClean);

        const srcVal = inp.mSrc || inp.src || inp.url || inp.mUrl || inp.mInfo?.src || '';
        let ctypeVal = inp.mType || inp.type || inp.ctype || 'texture';
        if (typeof ctypeVal === 'number') {
          // Mapowanie numerycznych typów Shadertoy jeśli występują
          if (ctypeVal === 1) ctypeVal = 'texture';
          else if (ctypeVal === 2) ctypeVal = 'cubemap';
          else if (ctypeVal === 3) ctypeVal = 'volume';
          else if (ctypeVal === 4) ctypeVal = 'buffer';
          else if (ctypeVal === 5) ctypeVal = 'music';
          else if (ctypeVal === 6) ctypeVal = 'mic';
        }

        inputs.push({
          id: inp.mId || inp.id || channelIndex,
          src: srcVal,
          ctype: String(ctypeVal),
          channel: channelIndex,
          sampler: {
            filter: (inp.mSampler?.filter as 'nearest' | 'linear' | 'mipmap') || 'linear',
            wrap: (inp.mSampler?.wrap as 'clamp' | 'repeat') || 'clamp',
            vflip: inp.mSampler?.vflip ?? true,
            srgb: inp.mSampler?.srgb ?? false,
            internal: inp.mSampler?.internal || '',
          },
          published: inp.mPublished ?? 1,
        });
      });
    }

    return {
      name: passName,
      type: passType,
      description: (p.mDescription || p.description || '') as string,
      code: code || '',
      inputs: inputs,
      outputs: [{ id: index, channel: 0 }],
    };
  });

  return {
    Shader: {
      ver: '0.1',
      info: info,
      renderpass: renderpass,
    },
  };
}

function parseGLSLErrors(rawError: string, passName: string): ShaderCompileDiagnostic[] {
  const diagnostics: ShaderCompileDiagnostic[] = [];
  if (!rawError) return diagnostics;

  const lines = rawError.split('\n');
  const regex = /(ERROR|WARNING):\s*(\d+):(\d+):\s*(.*)/i;

  for (const line of lines) {
    const match = line.match(regex);
    if (match) {
      const severity = match[1].toUpperCase() === 'WARNING' ? 'warning' : 'error';
      const lineNum = parseInt(match[3], 10);
      const message = match[4].trim();

      diagnostics.push({
        passName,
        line: isNaN(lineNum) ? 1 : lineNum,
        message,
        severity,
        raw: line,
      });
    } else if (line.trim().length > 0) {
      diagnostics.push({
        passName,
        line: 1,
        message: line.trim(),
        severity: 'error',
        raw: line,
      });
    }
  }

  return diagnostics;
}

function collectAllDiagnostics(): ShaderCompileDiagnostic[] {
  const effect = getEffect();
  const passes = effect?.mPasses;
  if (!effect || !passes) return [];

  const allDiagnostics: ShaderCompileDiagnostic[] = [];

  passes.forEach((p: ShadertoyPassLike, index: number) => {
    const passName = getPassName(p, index, passes);
    const errorText = p.mError || p.mErrorLog || '';
    if (errorText && typeof errorText === 'string') {
      const parsed = parseGLSLErrors(errorText, passName);
      allDiagnostics.push(...parsed);
    }
  });

  return allDiagnostics;
}

let isApplyingRemoteCode = false;

function applyPassCode(passName: string, newCode: string, triggerRecompile = true): boolean {
  const g = win.gShaderToy;
  const effect = getEffect();
  const passes = effect?.mPasses;
  if (!effect || !passes) return false;

  const passIndex = passes.findIndex(
    (p: ShadertoyPassLike, idx: number) => getPassName(p, idx, passes).toLowerCase() === passName.toLowerCase(),
  );

  if (passIndex === -1) {
    console.warn(`[ShaderToy to VSCode] Pass not found: ${passName}`);
    return false;
  }

  const pass = passes[passIndex];
  sendDebugLog(`[applyPassCode] Updating code for pass "${passName}" (${newCode.length} chars)`);
  pass.mSource = newCode;
  pass.mShaderCode = newCode;
  if (typeof pass.NewCode === 'function') {
    pass.NewCode(newCode);
  }
  if (typeof pass.mCode !== 'undefined') {
    pass.mCode = newCode;
  }

  isApplyingRemoteCode = true;
  try {
    // 1. Update Monaco Editor if present
    if (win.monaco?.editor) {
      const models = win.monaco.editor.getModels?.();
      if (models && models[passIndex]) {
        if (models[passIndex].getValue() !== newCode) {
          models[passIndex].setValue(newCode);
        }
      } else if (effect.mActivePass === passIndex && models && models[0]) {
        if (models[0].getValue() !== newCode) {
          models[0].setValue(newCode);
        }
      }
    }

    // 2. Update CodeMirror
    const ed = (effect.mEditor || g?.mEditor) as { getValue?: () => string; setValue?: (v: string) => void } | undefined;
    if (effect.mActivePass === passIndex && ed && typeof ed.setValue === 'function' && typeof ed.getValue === 'function') {
      if (ed.getValue() !== newCode) {
        ed.setValue(newCode);
      }
    } else if (pass.mEditor && typeof pass.mEditor.setValue === 'function' && typeof pass.mEditor.getValue === 'function') {
      if (pass.mEditor.getValue() !== newCode) {
        pass.mEditor.setValue(newCode);
      }
    }
  } finally {
    setTimeout(() => {
      isApplyingRemoteCode = false;
    }, 200);
  }

  if (triggerRecompile) {
    recompileShader();
  }

  return true;
}

function recompileShader() {
  const g = win.gShaderToy;
  const effect = getEffect();
  if (!effect && !g) return;

  try {
    if (effect && typeof effect.Recompile === 'function') {
      effect.Recompile();
    } else if (g && typeof g.Recompile === 'function') {
      g.Recompile();
    } else {
      const btn = (document.querySelector('.compileButton') ||
        document.getElementById('compileButton') ||
        document.querySelector('button[title*="compile" i]')) as HTMLElement;
      if (btn) {
        btn.click();
      }
    }
  } catch (err) {
    console.error('[ShaderToy to VSCode] Error during recompilation:', err);
  }

  setTimeout(() => {
    const diagnostics = collectAllDiagnostics();
    postToBridge({
      type: 'DIAGNOSTICS',
      tabSessionId,
      shaderId: getShaderIdFromUrl() || (effect?.mShaderID || g?.mShaderID || ''),
      success: diagnostics.length === 0,
      diagnostics,
      timestamp: Date.now(),
    });
  }, 100);
}

function sendRegistrationAndSnapshot() {
  const g = win.gShaderToy;
  const effect = getEffect();
  const passes = effect?.mPasses;

  if (!effect || !passes) {
    sendDebugLog('sendRegistrationAndSnapshot: missing effect or mPasses!');
    return;
  }

  const shaderId = getShaderIdFromUrl() || (effect.mShaderID || g?.mShaderID || null);
  const srcInfo = effect.mInfo || g?.mInfo;
  const title = srcInfo?.name || document.title.replace(' - Shadertoy BETA', '').replace(' - Shadertoy', '').trim() || 'Shader';

  sendDebugLog(`Sending TAB_REGISTER for shaderId: ${shaderId}, title: ${title}`);
  postToBridge({
    type: 'TAB_REGISTER',
    tabSessionId,
    shaderId,
    title,
    url: window.location.href,
    timestamp: Date.now(),
  });

  const snapshot = extractShaderSnapshot();
  if (snapshot) {
    const passInfo = snapshot.Shader.renderpass.map(p => `${p.name} (code: ${p.code.length}b)`);
    sendDebugLog(`Sending SHADER_SNAPSHOT: ${passInfo.join(', ')}`);
    postToBridge({
      type: 'SHADER_SNAPSHOT',
      tabSessionId,
      shaderId: snapshot.Shader.info.id,
      shader: snapshot,
      hash: String(Date.now()),
      timestamp: Date.now(),
    });
  } else {
    sendDebugLog('extractShaderSnapshot returned null!');
  }
}

let lastReportedPassName = '';

function activatePassTab(passName: string): boolean {
  const g = win.gShaderToy;
  const effect = getEffect();
  const passes = effect?.mPasses;
  if (!passes) return false;

  const targetIndex = passes.findIndex(
    (p: ShadertoyPassLike, idx: number) => getPassName(p, idx, passes).toLowerCase() === passName.toLowerCase(),
  );

  if (targetIndex === -1) {
    sendDebugLog(`[activatePassTab] Pass not found: ${passName}`);
    return false;
  }

  sendDebugLog(`[activatePassTab] Switching to pass "${passName}" (index: ${targetIndex})`);

  // 1. Try Shadertoy programmatic methods
  try {
    if (typeof effect.SetPass === 'function') effect.SetPass(targetIndex);
    else if (typeof g?.SetPass === 'function') g.SetPass(targetIndex);
    else if (typeof effect.SelectPass === 'function') effect.SelectPass(targetIndex);
    else if (typeof g?.SelectPass === 'function') g.SelectPass(targetIndex);
    else if (typeof effect.SetTab === 'function') effect.SetTab(targetIndex);
  } catch (err) {
    sendDebugLog(`[activatePassTab] Error calling effect.SetPass:`, err);
  }

  // 2. Click tab element in DOM (#tab0, #tab1...)
  const idCandidates = [
    document.getElementById(`tab${targetIndex}`),
    document.getElementById(`tabPass${targetIndex}`),
    document.getElementById(`passTab${targetIndex}`),
    document.getElementById(`pass${targetIndex}`),
  ];
  let clicked = false;
  for (const el of idCandidates) {
    if (el) {
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
      el.click();
      sendDebugLog(`[activatePassTab] Clicked element by ID: ${el.id}`);
      clicked = true;
      break;
    }
  }

  if (!clicked) {
    const allCandidates = Array.from(document.querySelectorAll('div, button, a, span, li'));
    for (const el of allCandidates) {
      const txt = el.textContent?.trim();
      if (txt === passName && el.children.length <= 2) {
        const hEl = el as HTMLElement;
        hEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
        hEl.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
        hEl.click();
        sendDebugLog(`[activatePassTab] Clicked DOM element: <${hEl.tagName.toLowerCase()} class="${hEl.className}"> with text "${passName}"`);
        break;
      }
    }
  }

  // 3. If Monaco Editor is present, synchronize model
  try {
    if (win.monaco?.editor) {
      const models = win.monaco.editor.getModels?.();
      const editors = win.monaco.editor.getEditors?.();
      if (editors && editors.length > 0 && models && models[targetIndex]) {
        if (editors[0].getModel() !== models[targetIndex]) {
          editors[0].setModel(models[targetIndex]);
          sendDebugLog(`[activatePassTab] Updated Monaco Editor model to index ${targetIndex}`);
        }
      }
    }
  } catch (err) {
    sendDebugLog(`[activatePassTab] Error updating Monaco:`, err);
  }

  return true;
}

function hookMonacoModelChange() {
  if (win.monaco?.editor) {
    const editors = win.monaco.editor.getEditors?.();
    if (editors && editors.length > 0) {
      const ed = editors[0];
      if (ed && typeof ed.onDidChangeModel === 'function' && !ed.__shadertoyAiHooked) {
        ed.__shadertoyAiHooked = true;
        ed.onDidChangeModel(() => {
          sendDebugLog('[MonacoWatcher] Model change detected in Monaco Editor!');
          checkAndReportActivePass();
        });
      }
    }
  }
}

function getActivePassIndex(): number {
  const g = win.gShaderToy;
  const effect = getEffect();
  const passes = effect?.mPasses;
  if (!passes || !Array.isArray(passes)) return -1;

  // 1. Sprawdź edytor Monaco jeśli obecny (najbardziej wiarygodny stan edytora)
  if (win.monaco?.editor) {
    const editors = win.monaco.editor.getEditors?.();
    if (editors && editors.length > 0) {
      const curModel = editors[0].getModel();
      const models = win.monaco.editor.getModels?.();
      if (curModel && models && Array.isArray(models)) {
        const mIdx = models.indexOf(curModel);
        if (mIdx >= 0 && mIdx < passes.length) {
          return mIdx;
        }
      }
    }
  }

  // 2. Sprawdź mActivePass w Shadertoy
  if (typeof g?.mActivePass === 'number' && g.mActivePass >= 0 && g.mActivePass < passes.length) {
    return g.mActivePass;
  }
  if (typeof effect?.mActivePass === 'number' && effect.mActivePass >= 0 && effect.mActivePass < passes.length) {
    return effect.mActivePass;
  }

  // 3. Sprawdź elementy DOM #tab0..#tabN
  for (let i = 0; i < passes.length; i++) {
    const el = document.getElementById(`tab${i}`);
    if (el) {
      const cls = el.className || '';
      if (cls.toLowerCase().includes('select') || cls.toLowerCase().includes('active') || el.getAttribute('aria-selected') === 'true') {
        return i;
      }
    }
  }

  return -1;
}

let programmaticSwitchUntil = 0;
let lastKnownPassesSignature = '';

function checkAndSyncPasses() {
  const effect = getEffect();
  const passes = effect?.mPasses;
  if (!effect || !passes || !Array.isArray(passes) || passes.length === 0) return;

  const signature = passes.map((p: ShadertoyPassLike, idx: number) => `${p.mType}:${getPassName(p, idx, passes)}`).join(';');
  if (signature !== lastKnownPassesSignature) {
    const isFirstTime = lastKnownPassesSignature === '';
    lastKnownPassesSignature = signature;
    sendDebugLog(`[PassSync] Pass structure changed (first=${isFirstTime}): ${signature}`);
    sendRegistrationAndSnapshot();
    hookMonacoEditorContentEvents();
  }
}

function reportPassSwitch(passName: string) {
  if (!passName) return;
  checkAndSyncPasses();

  if (Date.now() < programmaticSwitchUntil) {
    lastReportedPassName = passName;
    return;
  }
  if (passName === lastReportedPassName) return;
  lastReportedPassName = passName;

  const effect = getEffect();
  sendDebugLog(`[ActivePassWatcher] Detected active pass change in browser to: "${passName}"`);
  postToBridge({
    type: 'SET_ACTIVE_PASS',
    tabSessionId,
    shaderId: getShaderIdFromUrl() || effect?.mShaderID || '',
    passName,
    timestamp: Date.now(),
  });
}

function checkAndReportActivePass() {
  const effect = getEffect();
  const passes = effect?.mPasses;
  if (!effect || !passes) return;

  checkAndSyncPasses();
  hookMonacoModelChange();

  const activeIdx = getActivePassIndex();
  if (activeIdx >= 0 && passes[activeIdx]) {
    const activePassName = getPassName(passes[activeIdx], activeIdx, passes);
    reportPassSwitch(activePassName);
  }
}

// Receive commands from content script (world: ISOLATED)
window.addEventListener('message', (event) => {
  if (event.source !== window || !event.data || event.data.source !== 'shadertoy-ai-bridge') {
    return;
  }

  const { type, payload } = event.data;

  switch (type) {
    case 'REQUEST_SNAPSHOT': {
      console.log('[ShaderToy to VSCode] Received REQUEST_SNAPSHOT – sending registration and snapshot.');
      sendRegistrationAndSnapshot();
      break;
    }
    case 'UPDATE_PASS': {
      if (payload && payload.passName && typeof payload.code === 'string') {
        applyPassCode(payload.passName, payload.code, payload.triggerRecompile !== false);
      }
      break;
    }
    case 'SET_ACTIVE_PASS': {
      if (payload && payload.passName) {
        sendDebugLog(`[In-Page] Received SET_ACTIVE_PASS command from VS Code: ${payload.passName}`);
        programmaticSwitchUntil = Date.now() + 500;
        lastReportedPassName = payload.passName;
        activatePassTab(payload.passName);
      }
      break;
    }
    case 'RECOMPILE_COMMAND': {
      recompileShader();
      break;
    }
  }
});

let passUpdateDebounceTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePassUpdate(hintIndex?: number) {
  if (isApplyingRemoteCode) return;
  if (passUpdateDebounceTimer) clearTimeout(passUpdateDebounceTimer);
  passUpdateDebounceTimer = setTimeout(() => {
    sendPassUpdate(hintIndex);
  }, 150);
}

function sendPassUpdate(hintIndex?: number) {
  if (isApplyingRemoteCode) return;
  const g = win.gShaderToy;
  const effect = getEffect();
  const passes = effect?.mPasses;
  if (!passes || !Array.isArray(passes)) return;

  let targetIdx = typeof hintIndex === 'number' && hintIndex >= 0 && hintIndex < passes.length ? hintIndex : -1;
  if (targetIdx === -1) {
    targetIdx = getActivePassIndex();
  }
  if (targetIdx === -1 || !passes[targetIdx]) return;

  const pass = passes[targetIdx];
  const passName = getPassName(pass, targetIdx, passes);
  const code = extractPassCode(pass, targetIdx, effect, g);
  if (typeof code !== 'string') return;

  sendDebugLog(`[EditorWatcher] Sending live UPDATE_PASS for "${passName}" (${code.length} chars)`);
  postToBridge({
    type: 'UPDATE_PASS',
    tabSessionId,
    shaderId: getShaderIdFromUrl() || effect?.mShaderID || g?.mShaderID || '',
    passName,
    code,
    triggerRecompile: false,
    timestamp: Date.now(),
  });
}

function hookMonacoEditorContentEvents() {
  if (!win.monaco?.editor) return;

  const hookModel = (model: MonacoModelLike | null, idx?: number) => {
    if (!model || model.__shadertoyAiContentHooked) return;
    model.__shadertoyAiContentHooked = true;
    model.onDidChangeContent(() => {
      if (isApplyingRemoteCode) return;
      const models = win.monaco?.editor?.getModels?.() || [];
      const mIdx = typeof idx === 'number' ? idx : models.indexOf(model);
      schedulePassUpdate(mIdx >= 0 ? mIdx : undefined);
    });
  };

  const models = win.monaco?.editor?.getModels?.();
  if (Array.isArray(models)) {
    models.forEach((m: MonacoModelLike, i: number) => hookModel(m, i));
  }

  if (typeof win.monaco?.editor?.onDidCreateModel === 'function' && !win.__shadertoyAiModelCreateHooked) {
    win.__shadertoyAiModelCreateHooked = true;
    win.monaco.editor.onDidCreateModel((m: MonacoModelLike) => {
      hookModel(m);
    });
  }

  const editors = win.monaco?.editor?.getEditors?.();
  if (Array.isArray(editors)) {
    editors.forEach((ed: MonacoEditorLike) => {
      if (ed && typeof ed.onDidChangeModelContent === 'function' && !ed.__shadertoyAiContentHooked) {
        ed.__shadertoyAiContentHooked = true;
        ed.onDidChangeModelContent(() => {
          if (isApplyingRemoteCode) return;
          schedulePassUpdate();
        });
      }
    });
  }
}

function setupEditorWatcher() {
  const g = win.gShaderToy;
  const effect = getEffect();
  if (!effect && !g) return;

  // 1. Hook Monaco Editor content events
  hookMonacoEditorContentEvents();
  setInterval(hookMonacoEditorContentEvents, 1000);

  // 2. Hook CodeMirror / Native Shadertoy Editor
  const ed = (effect?.mEditor || g?.mEditor) as { on?: (event: string, cb: () => void) => void; __shadertoyAiHooked?: boolean } | undefined;
  if (ed && typeof ed.on === 'function' && !ed.__shadertoyAiHooked) {
    ed.__shadertoyAiHooked = true;
    ed.on('change', () => {
      if (isApplyingRemoteCode) return;
      schedulePassUpdate();
    });
  }

  // 3. DOM Textarea / Input listener
  document.addEventListener('input', (e) => {
    if (isApplyingRemoteCode) return;
    const target = e.target as HTMLElement;
    if (target && (target.tagName === 'TEXTAREA' || target.closest('.CodeMirror') || target.closest('.monaco-editor'))) {
      schedulePassUpdate();
    }
  });

  // Pass structure change watcher (tab add / remove)
  setInterval(checkAndSyncPasses, 300);

  // Active pass watcher
  hookMonacoModelChange();
  setInterval(checkAndReportActivePass, 250);

  // Dynamic tab bar additions/removals observer
  try {
    const observer = new MutationObserver(() => {
      checkAndSyncPasses();
      setTimeout(checkAndReportActivePass, 50);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  } catch (_) {}

  document.addEventListener('click', (e) => {
    // When clicking any element (+ button, dropdown menu, close tab, etc.), check passes
    setTimeout(checkAndSyncPasses, 50);
    setTimeout(checkAndSyncPasses, 250);
    setTimeout(checkAndSyncPasses, 700);

    const target = e.target as HTMLElement;
    if (target) {
      const tabEl = target.closest('[id^="tab"]') as HTMLElement;
      if (tabEl && tabEl.id) {
        const match = tabEl.id.match(/^tab(\d+)$/);
        if (match) {
          const passIdx = parseInt(match[1], 10);
          const eff = getEffect();
          const pList = eff?.mPasses;
          if (pList && pList[passIdx]) {
            const name = getPassName(pList[passIdx], passIdx, pList);
            sendDebugLog(`[ClickWatcher] Direct click on tab #${tabEl.id} -> "${name}"`);
            checkAndSyncPasses();
            reportPassSwitch(name);
            return;
          }
        }
      }
    }
    setTimeout(checkAndReportActivePass, 60);
  });
}

// Continuously poll for gShaderToy and effect.mPasses presence
let checkAttempts = 0;
function init() {
  sendDebugLog(`init() called on URL: ${window.location.href}`);
  if (isInitialized) return;

  const check = () => {
    checkAttempts++;
    const g = win.gShaderToy;
    const effect = getEffect();
    const passes = effect?.mPasses;

    if (g && passes && Array.isArray(passes) && passes.length > 0) {
      isInitialized = true;
      sendDebugLog(`Detected shadertoy passes on attempt #${checkAttempts}! Pass count: ${passes.length}`);
      console.log(`[ShaderToy to VSCode] Detected passes! Count: ${passes.length}`);

      sendRegistrationAndSnapshot();
      setupEditorWatcher();
      return true;
    } else if (checkAttempts % 10 === 0) {
      sendDebugLog(`Attempt #${checkAttempts}: gShaderToy=${!!g}, effect=${!!g?.mEffect}, passes=${passes?.length}`);
    }
    return false;
  };

  if (!check()) {
    const interval = setInterval(() => {
      if (check()) {
        clearInterval(interval);
      }
    }, 250);
  }
}

// Run immediately and on DOMContentLoaded/load
init();
window.addEventListener('DOMContentLoaded', init);
window.addEventListener('load', init);

window.addEventListener('beforeunload', () => {
  postToBridge({
    type: 'TAB_UNREGISTER',
    tabSessionId,
    timestamp: Date.now(),
  });
});
