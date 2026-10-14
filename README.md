# ShaderToy VSCode

A development tool that connects **Shadertoy** directly with **VS Code**, enabling full-featured, two-way, real-time shader coding in your favorite editor with live browser preview and automatic WebGL compiler diagnostics.

---

## Features

- **Full VS Code Editing Experience**: Write GLSL shaders in VS Code with syntax highlighting, code snippets, keyboard shortcuts, formatting, and custom themes.
- **Two-Way Live Synchronization**:
  - Typing in VS Code instantly updates the shader in the browser.
  - Pressing `Ctrl+S` in VS Code compiles the shader and immediately renders the new frame in Shadertoy.
  - Edits made on shadertoy.com are immediately reflected in VS Code.
- **Active Pass Tab Syncing**: Switching between `.glsl` files in VS Code automatically switches the active pass tab in Shadertoy, and vice-versa.
- **Dedicated Sidebar View**: A clean Activity Bar view ("ShaderToy Tabs") lists all open Shadertoy tabs and their render passes without cluttering your File Explorer.
- **Real Disk Temporary Files**: Shaders are synchronized to a temporary folder (`shadertoy-vscode/<shaderId>/`), making passes (`Image.glsl`, `Common.glsl`, etc.) accessible to Node.js scripts, external linters, CLI tools, and background agents.
- **Live Compiler Diagnostics**: WebGL compiler errors and warnings from Shadertoy are surfaced directly in the VS Code *Problems* panel with exact line numbers.

---

## Solution Architecture

The project consists of three main components:

1. **`shared/`**:
   Shared TypeScript definitions:
   - `protocol.ts` – WebSocket protocol definitions, authentication handshake, snapshots, pass updates, and diagnostics.
   - `shadertoy.ts` – Shadertoy data models (`ShaderToyExport`, render passes, inputs `iChannel0..3`, samplers) and diagnostic structures (`ShaderCompileDiagnostic`).

2. **`vscode-extension/` (`ShaderToy VSCode`)**:
   VS Code editor extension:
   - **TempFileManager**: Manages local disk synchronization (`shadertoy-vscode/<shaderId>/`) and watches for external edits.
   - **ShadertoyTabsTreeProvider**: Custom sidebar panel displaying active tabs and passes.
   - **WebSocket Server**: Listens locally on `127.0.0.1:27412` with one-click approval authentication.
   - **Diagnostics Manager**: Maps WebGL compiler diagnostics directly into the VS Code *Problems* panel.

3. **`browser-extension/` (`ShaderToy to VSCode`)**:
   Manifest V3 browser extension (Chrome, Edge, Brave):
   - **`in-page.js` (`world: "MAIN"`)**: Runs directly in page context, interacting with `window.gShaderToy`, Monaco editor models, and compile events.
   - **`content.js` (`world: "ISOLATED"`)**: Bridges messages between in-page script and the background service worker.
   - **`background.js`**: Service worker managing local WebSocket communication, connection retries (every 5s), and tab dispatch.
   - **`popup.html` / `popup.js`**: Status indicator with configurable port settings.

---

## How to Run & Test (Development)

### Step 1: Install and Build

In the repository root directory:

```bash
# Install dependencies
npm run install:all

# Build both extensions
npm run build
```

During development, you can run watchers:
```bash
npm run watch:vscode    # in one terminal
npm run watch:browser   # in another terminal
```

---

### Step 2: Launch the VS Code Extension

1. Open this repository in VS Code.
2. Press **`F5`** (or go to *Run and Debug* and select `Run Extension`).
3. An *Extension Development Host* window will open with the WebSocket server running on port `27412`.

---

### Step 3: Load the Browser Extension

1. In a Chromium browser (Chrome, Edge, Brave), navigate to `chrome://extensions/`.
2. Enable **Developer mode** in the top-right corner.
3. Click **Load unpacked**.
4. Select the directory:
   ```
   c:\github\ShaderToyAI\browser-extension\dist
   ```
5. The **ShaderToy to VSCode** extension icon will appear in your toolbar.

---

### Step 4: Live Coding

1. In the browser, open any shader:
   - `https://www.shadertoy.com/new` (new shader), or
   - any existing shader, such as `https://www.shadertoy.com/view/mtyGWy`.
2. When prompted in VS Code, click **Allow (Always)** to approve the connection.
3. Open the **ShaderToy VSCode** sidebar tab (palette icon in Activity Bar).
4. Click on `Image.glsl` to open the pass in your editor.
5. Edit the shader code and press **`Ctrl+S`** — the shader compiles immediately in Shadertoy!
