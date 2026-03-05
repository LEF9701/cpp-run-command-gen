const vscode = require("vscode");
const path = require("path");

const CPP_SRC_EXTS = [".cpp", ".cxx", ".cc", ".c", ".c++", ".cp"];

// ─── State ───────────────────────────────────────────────────────────

const defaultState = {
  compiler: "clang++",
  cppStandard: "c++20",
  optimization: "-O0",
  warnings: ["-Wall", "-Wextra"],
  sanitizers: [],
  debugSymbols: false,
  stdlib: "default",
  linkLibraries: "",
  additionalFlags: "",
  outputDir: "",
  outputName: "",
  runAfterCompile: true,
  clearTerminal: true,
};

let state = { ...defaultState };

// Multi-file list: array of absolute paths
let sourceFiles = [];

// ─── Command Builder ─────────────────────────────────────────────────

function buildCommand(files) {
  if (!files || files.length === 0) {
    return { full: "(no source files selected)", compile: "" };
  }

  const isWindows = process.platform === "win32";
  const ext = isWindows ? ".exe" : "";

  // Use the first file's directory as the working directory
  const workDir = path.dirname(files[0]);

  // Output binary name: user-specified or derived from first file
  const baseName = state.outputName.trim()
    || path.basename(files[0], path.extname(files[0]));

  let outPath;
  if (state.outputDir) {
    const outDir = path.isAbsolute(state.outputDir)
      ? state.outputDir
      : path.join(workDir, state.outputDir);
    outPath = path.join(outDir, baseName + ext);
  } else {
    outPath = path.join(workDir, baseName + ext);
  }

  const parts = [];
  parts.push(state.compiler);

  // Standard
  if (state.compiler === "cl") {
    parts.push(`/std:${state.cppStandard}`);
  } else {
    parts.push(`-std=${state.cppStandard}`);
  }

  // Optimization
  if (state.compiler === "cl") {
    const map = { "-O0": "/Od", "-O1": "/O1", "-O2": "/O2", "-O3": "/Ox", "-Os": "/Os", "-Ofast": "/Ox" };
    parts.push(map[state.optimization] || "/Od");
  } else {
    parts.push(state.optimization);
  }

  // Warnings
  if (state.compiler === "cl") {
    if (state.warnings.includes("-Wall")) parts.push("/W4");
  } else {
    state.warnings.forEach((w) => parts.push(w));
  }

  // Debug
  if (state.debugSymbols) {
    parts.push(state.compiler === "cl" ? "/Zi" : "-g");
  }

  // stdlib (clang++ only)
  if (state.compiler === "clang++" && state.stdlib !== "default") {
    parts.push(`-stdlib=${state.stdlib}`);
  }

  // Sanitizers
  if (state.compiler !== "cl" && state.sanitizers.length > 0) {
    parts.push(`-fsanitize=${state.sanitizers.join(",")}`);
  }

  // Additional flags
  if (state.additionalFlags.trim()) {
    parts.push(state.additionalFlags.trim());
  }

  // Source files — use paths relative to workDir
  for (const f of files) {
    const rel = path.relative(workDir, f);
    parts.push(`"${rel}"`);
  }

  // Output
  if (state.compiler === "cl") {
    parts.push(`/Fe:"${outPath}"`);
  } else {
    parts.push("-o", `"${outPath}"`);
  }

  // Link libraries
  if (state.linkLibraries.trim()) {
    state.linkLibraries
      .split(/[\s,]+/)
      .filter(Boolean)
      .forEach((lib) => parts.push(`-l${lib}`));
  }

  const compileCmd = parts.join(" ");

  const lines = [];
  lines.push(isWindows ? `cd /d "${workDir}"` : `cd "${workDir}"`);

  if (state.outputDir) {
    const outDir = path.isAbsolute(state.outputDir)
      ? state.outputDir
      : path.join(workDir, state.outputDir);
    lines.push(isWindows ? `if not exist "${outDir}" mkdir "${outDir}"` : `mkdir -p "${outDir}"`);
  }

  lines.push(compileCmd);

  if (state.runAfterCompile) {
    lines.push(`"${outPath}"`);
  }

  return {
    full: lines.join(" && "),
    compile: compileCmd,
  };
}

// ─── Terminal ────────────────────────────────────────────────────────

function getTerminal() {
  const name = "C++ Run";
  let terminal = vscode.window.terminals.find((t) => t.name === name);
  if (!terminal) terminal = vscode.window.createTerminal(name);
  terminal.show();
  if (state.clearTerminal) terminal.sendText("clear", true);
  return terminal;
}

function isCppSource(filePath) {
  return CPP_SRC_EXTS.includes(path.extname(filePath).toLowerCase());
}

function getActiveFile() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return null;
  if (!isCppSource(editor.document.fileName)) return null;
  editor.document.save();
  return editor.document.fileName;
}

function getFilesToCompile() {
  if (sourceFiles.length > 0) return [...sourceFiles];
  const active = getActiveFile();
  if (active) return [active];
  vscode.window.showErrorMessage("No source files selected and no active C++ file.");
  return [];
}

// ─── Webview Provider ────────────────────────────────────────────────

class CppRunViewProvider {
  constructor(extensionUri) {
    this._extensionUri = extensionUri;
    this._view = null;
  }

  resolveWebviewView(webviewView) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtml();

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case "stateUpdate":
          Object.assign(state, msg.payload);
          this._postCommandPreview();
          break;

        case "run":
          vscode.commands.executeCommand("cppRunGen.run");
          break;

        case "runCustom": {
          const terminal = getTerminal();
          terminal.sendText(msg.payload);
          break;
        }

        case "copy":
          vscode.commands.executeCommand("cppRunGen.copyCommand");
          break;

        case "addFiles":
          await this._addFiles();
          break;

        case "addActiveFile": {
          const active = getActiveFile();
          if (active && !sourceFiles.includes(active)) {
            sourceFiles.push(active);
            this._postFileList();
            this._postCommandPreview();
          } else if (!active) {
            vscode.window.showWarningMessage("No active C++ file to add.");
          } else {
            vscode.window.showInformationMessage("File already in list.");
          }
          break;
        }

        case "removeFile": {
          const idx = msg.index;
          if (idx >= 0 && idx < sourceFiles.length) {
            sourceFiles.splice(idx, 1);
            this._postFileList();
            this._postCommandPreview();
          }
          break;
        }

        case "clearFiles":
          sourceFiles = [];
          this._postFileList();
          this._postCommandPreview();
          break;

        case "moveFile": {
          const { from, to } = msg;
          if (from >= 0 && from < sourceFiles.length && to >= 0 && to < sourceFiles.length) {
            const [item] = sourceFiles.splice(from, 1);
            sourceFiles.splice(to, 0, item);
            this._postFileList();
            this._postCommandPreview();
          }
          break;
        }

        case "ready":
          this._postState();
          this._postFileList();
          this._postCommandPreview();
          break;
      }
    });

    vscode.window.onDidChangeActiveTextEditor(() => {
      this._postCommandPreview();
    });
  }

  async _addFiles() {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: true,
      filters: {
        "C/C++ Source Files": ["cpp", "cxx", "cc", "c"],
        "All Files": ["*"],
      },
      title: "Select C++ source files to compile",
    });
    if (uris && uris.length > 0) {
      for (const uri of uris) {
        const fp = uri.fsPath;
        if (!sourceFiles.includes(fp)) {
          sourceFiles.push(fp);
        }
      }
      this._postFileList();
      this._postCommandPreview();
    }
  }

  _postState() {
    if (this._view) {
      this._view.webview.postMessage({ type: "setState", payload: state });
    }
  }

  _postFileList() {
    if (!this._view) return;
    const files = sourceFiles.map((fp, i) => ({
      index: i,
      fullPath: fp,
      name: path.basename(fp),
      dir: path.dirname(fp),
    }));
    this._view.webview.postMessage({ type: "fileList", payload: files });
  }

  _postCommandPreview() {
    if (!this._view) return;
    const files = getFilesToCompile();
    if (files.length > 0) {
      const cmd = buildCommand(files);
      this._view.webview.postMessage({ type: "preview", payload: cmd.full });
    } else {
      this._view.webview.postMessage({
        type: "preview",
        payload: "(add source files or open a C++ file)",
      });
    }
  }

  _getHtml() {
    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<style>
  :root {
    --bg: var(--vscode-sideBar-background);
    --fg: var(--vscode-sideBar-foreground);
    --input-bg: var(--vscode-input-background);
    --input-fg: var(--vscode-input-foreground);
    --input-border: var(--vscode-input-border, #3c3c3c);
    --btn-bg: var(--vscode-button-background);
    --btn-fg: var(--vscode-button-foreground);
    --btn-hover: var(--vscode-button-hoverBackground);
    --focus: var(--vscode-focusBorder);
    --border: var(--vscode-panel-border, #2b2b2b);
    --desc: var(--vscode-descriptionForeground);
    --list-hover: var(--vscode-list-hoverBackground, #2a2d2e);
    --danger: var(--vscode-errorForeground, #f44747);
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: var(--vscode-font-family, system-ui);
    font-size: var(--vscode-font-size, 13px);
    color: var(--fg);
    background: var(--bg);
  }

  .panel { padding: 12px 14px; }

  .section { margin-bottom: 14px; }
  .section-title {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--desc);
    margin-bottom: 8px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }
  .row label { flex: 0 0 90px; font-size: 12px; }
  .row select, .row input[type="text"] {
    flex: 1; min-width: 0;
    background: var(--input-bg); color: var(--input-fg);
    border: 1px solid var(--input-border); border-radius: 3px;
    padding: 4px 6px; font-size: 12px; font-family: inherit; outline: none;
  }
  .row select:focus, .row input:focus { border-color: var(--focus); }

  .check-grid { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-bottom: 6px; }
  .check-item { display: flex; align-items: center; gap: 4px; font-size: 12px; cursor: pointer; }
  .check-item input[type="checkbox"] { accent-color: var(--btn-bg); cursor: pointer; }

  .btn-row { display: flex; gap: 6px; margin-top: 6px; }
  button {
    display: flex; align-items: center; justify-content: center; gap: 6px;
    padding: 7px 10px; border: none; border-radius: 3px;
    font-size: 12px; font-weight: 500; cursor: pointer; font-family: inherit;
  }
  .btn-primary { flex: 1; background: var(--btn-bg); color: var(--btn-fg); }
  .btn-primary:hover { background: var(--btn-hover); }
  .btn-secondary { flex: 1; background: var(--input-bg); color: var(--fg); border: 1px solid var(--input-border); }
  .btn-secondary:hover { opacity: 0.85; }

  .btn-sm {
    padding: 3px 7px; font-size: 11px; border-radius: 3px;
    border: 1px solid var(--input-border); background: var(--input-bg);
    color: var(--fg); cursor: pointer; flex: unset;
  }
  .btn-sm:hover { opacity: 0.85; }

  .preview-box {
    background: var(--input-bg); border: 1px solid var(--input-border); border-radius: 4px;
    padding: 10px;
    font-family: var(--vscode-editor-font-family, 'Cascadia Code', 'Fira Code', monospace);
    font-size: 11.5px; line-height: 1.5; word-break: break-all; white-space: pre-wrap;
    color: var(--input-fg); max-height: 160px; overflow-y: auto;
  }
  .preview-editable { cursor: text; user-select: text; outline: none; min-height: 40px; }
  .preview-editable:focus { border-color: var(--focus); }

  details { margin-bottom: 10px; }
  details summary {
    font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;
    color: var(--desc); cursor: pointer; padding: 4px 0; list-style: none;
    display: flex; align-items: center; gap: 4px;
  }
  details summary::before { content: '▶'; font-size: 9px; transition: transform 0.15s; }
  details[open] summary::before { transform: rotate(90deg); }
  details .detail-body { padding-top: 6px; }

  .sep { border: none; border-top: 1px solid var(--border); margin: 12px 0; }

  /* ── File List ── */
  .file-list { max-height: 200px; overflow-y: auto; margin-bottom: 6px; }
  .file-empty {
    font-size: 11.5px; color: var(--desc); font-style: italic; padding: 8px 4px;
  }
  .file-item {
    display: flex; align-items: center; gap: 6px;
    padding: 4px 6px; border-radius: 3px; font-size: 12px;
    cursor: grab; border: 1px solid transparent;
  }
  .file-item:hover { background: var(--list-hover); }
  .file-icon { flex: 0 0 14px; font-size: 12px; opacity: 0.7; }
  .file-name {
    flex: 1; min-width: 0; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap;
  }
  .file-dir {
    font-size: 10px; color: var(--desc); overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; max-width: 100px;
  }
  .file-remove {
    flex: 0 0 auto; background: none; border: none;
    color: var(--desc); font-size: 14px; cursor: pointer;
    padding: 0 2px; line-height: 1; opacity: 0; transition: opacity 0.1s;
  }
  .file-item:hover .file-remove { opacity: 1; }
  .file-remove:hover { color: var(--danger); }
  .file-item.dragging { opacity: 0.35; }
  .file-item.drag-over { border-top: 2px solid var(--focus); }

  .file-actions { display: flex; gap: 4px; }
  .file-count {
    font-size: 10px; color: var(--desc); background: var(--input-bg);
    padding: 1px 6px; border-radius: 8px; margin-left: 4px;
  }
</style>
</head>
<body>
<div class="panel">

  <!-- ════ SOURCE FILES ════ -->
  <div class="section">
    <div class="section-title">
      <span>Source Files <span class="file-count" id="fileCount">0</span></span>
      <div class="file-actions">
        <button class="btn-sm" id="btnAddActive" title="Add current editor file">+ Active</button>
        <button class="btn-sm" id="btnAddFiles" title="Browse and select files">+ Browse</button>
        <button class="btn-sm" id="btnClearFiles" title="Remove all files">✕ Clear</button>
      </div>
    </div>
    <div class="file-list" id="fileList">
      <div class="file-empty" id="fileEmpty">No files added — will use the active editor file.</div>
    </div>
  </div>

  <hr class="sep"/>

  <!-- ════ COMPILER ════ -->
  <div class="section">
    <div class="section-title">Compiler</div>
    <div class="row">
      <label>Compiler</label>
      <select id="compiler">
        <option value="clang++">clang++</option>
        <option value="g++">g++</option>
        <option value="cl">MSVC cl</option>
      </select>
    </div>
    <div class="row">
      <label>Standard</label>
      <select id="cppStandard">
        <option value="c++11">C++11</option>
        <option value="c++14">C++14</option>
        <option value="c++17">C++17</option>
        <option value="c++20">C++20</option>
        <option value="c++23">C++23</option>
        <option value="c++2c">C++2c (26)</option>
      </select>
    </div>
    <div class="row">
      <label>Optimization</label>
      <select id="optimization">
        <option value="-O0">-O0 (none)</option>
        <option value="-O1">-O1</option>
        <option value="-O2">-O2 (release)</option>
        <option value="-O3">-O3 (aggressive)</option>
        <option value="-Os">-Os (size)</option>
        <option value="-Ofast">-Ofast</option>
      </select>
    </div>
    <div class="row" id="stdlibRow">
      <label>Stdlib</label>
      <select id="stdlib">
        <option value="default">Default</option>
        <option value="libc++">libc++</option>
        <option value="libstdc++">libstdc++</option>
      </select>
    </div>
  </div>

  <!-- Warnings -->
  <details>
    <summary>Warnings</summary>
    <div class="detail-body">
      <div class="check-grid" id="warningChecks">
        <label class="check-item"><input type="checkbox" value="-Wall" checked/> -Wall</label>
        <label class="check-item"><input type="checkbox" value="-Wextra" checked/> -Wextra</label>
        <label class="check-item"><input type="checkbox" value="-Wpedantic"/> -Wpedantic</label>
        <label class="check-item"><input type="checkbox" value="-Werror"/> -Werror</label>
        <label class="check-item"><input type="checkbox" value="-Wshadow"/> -Wshadow</label>
        <label class="check-item"><input type="checkbox" value="-Wconversion"/> -Wconversion</label>
      </div>
    </div>
  </details>

  <!-- Sanitizers -->
  <details>
    <summary>Sanitizers</summary>
    <div class="detail-body">
      <div class="check-grid" id="sanitizerChecks">
        <label class="check-item"><input type="checkbox" value="address"/> ASan</label>
        <label class="check-item"><input type="checkbox" value="undefined"/> UBSan</label>
        <label class="check-item"><input type="checkbox" value="thread"/> TSan</label>
        <label class="check-item"><input type="checkbox" value="memory"/> MSan</label>
        <label class="check-item"><input type="checkbox" value="leak"/> Leak</label>
      </div>
    </div>
  </details>

  <!-- Options -->
  <details>
    <summary>Options</summary>
    <div class="detail-body">
      <div class="check-grid">
        <label class="check-item"><input type="checkbox" id="debugSymbols"/> Debug (-g)</label>
        <label class="check-item"><input type="checkbox" id="runAfterCompile" checked/> Run after compile</label>
        <label class="check-item"><input type="checkbox" id="clearTerminal" checked/> Clear terminal</label>
      </div>
      <div class="row" style="margin-top:8px">
        <label>Output name</label>
        <input type="text" id="outputName" placeholder="(auto from first file)"/>
      </div>
      <div class="row">
        <label>Link libs</label>
        <input type="text" id="linkLibraries" placeholder="pthread, fmt, ..."/>
      </div>
      <div class="row">
        <label>Extra flags</label>
        <input type="text" id="additionalFlags" placeholder="-fno-exceptions ..."/>
      </div>
      <div class="row">
        <label>Output dir</label>
        <input type="text" id="outputDir" placeholder="(same as source)"/>
      </div>
    </div>
  </details>

  <hr class="sep"/>

  <!-- Command Preview -->
  <div class="section">
    <div class="section-title">Command Preview</div>
    <div class="preview-box preview-editable" id="preview" contenteditable="true" spellcheck="false"></div>
  </div>

  <!-- Action Buttons -->
  <div class="btn-row">
    <button class="btn-primary" id="btnRun">▶ Run</button>
    <button class="btn-secondary" id="btnCopy">⎘ Copy</button>
  </div>

</div>

<script>
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);

  const compiler = $("compiler");
  const cppStandard = $("cppStandard");
  const optimization = $("optimization");
  const stdlib = $("stdlib");
  const stdlibRow = $("stdlibRow");
  const debugSymbols = $("debugSymbols");
  const runAfterCompile = $("runAfterCompile");
  const clearTerminal = $("clearTerminal");
  const outputName = $("outputName");
  const linkLibraries = $("linkLibraries");
  const additionalFlags = $("additionalFlags");
  const outputDir = $("outputDir");
  const preview = $("preview");
  const fileListEl = $("fileList");
  const fileEmpty = $("fileEmpty");
  const fileCount = $("fileCount");

  function getWarnings() {
    return [...document.querySelectorAll("#warningChecks input:checked")].map(el => el.value);
  }
  function getSanitizers() {
    return [...document.querySelectorAll("#sanitizerChecks input:checked")].map(el => el.value);
  }

  function sendState() {
    vscode.postMessage({
      type: "stateUpdate",
      payload: {
        compiler: compiler.value,
        cppStandard: cppStandard.value,
        optimization: optimization.value,
        stdlib: stdlib.value,
        warnings: getWarnings(),
        sanitizers: getSanitizers(),
        debugSymbols: debugSymbols.checked,
        runAfterCompile: runAfterCompile.checked,
        clearTerminal: clearTerminal.checked,
        outputName: outputName.value,
        linkLibraries: linkLibraries.value,
        additionalFlags: additionalFlags.value,
        outputDir: outputDir.value,
      },
    });
  }

  function updateStdlibVisibility() {
    stdlibRow.style.display = compiler.value === "clang++" ? "flex" : "none";
  }

  // Wire settings
  [compiler, cppStandard, optimization, stdlib].forEach(el => {
    el.addEventListener("change", () => { updateStdlibVisibility(); sendState(); });
  });
  [debugSymbols, runAfterCompile, clearTerminal].forEach(el => el.addEventListener("change", sendState));
  document.querySelectorAll("#warningChecks input, #sanitizerChecks input").forEach(el => {
    el.addEventListener("change", sendState);
  });
  [outputName, linkLibraries, additionalFlags, outputDir].forEach(el => el.addEventListener("input", sendState));

  // Editable preview
  let customCommand = null;
  preview.addEventListener("input", () => { customCommand = preview.textContent; });
  function resetCustom() { customCommand = null; }
  [compiler, cppStandard, optimization, stdlib, debugSymbols,
   runAfterCompile, clearTerminal, outputName, linkLibraries, additionalFlags, outputDir
  ].forEach(el => el.addEventListener("change", resetCustom));
  document.querySelectorAll("#warningChecks input, #sanitizerChecks input").forEach(el => {
    el.addEventListener("change", resetCustom);
  });

  // ── File list ──
  let dragSrcIdx = null;

  function renderFileList(files) {
    fileCount.textContent = files.length;
    fileListEl.querySelectorAll(".file-item").forEach(el => el.remove());

    if (files.length === 0) {
      fileEmpty.style.display = "block";
      return;
    }
    fileEmpty.style.display = "none";

    files.forEach((f, i) => {
      const item = document.createElement("div");
      item.className = "file-item";
      item.draggable = true;
      item.dataset.index = i;

      const shortDir = f.dir.split(/[\\/]/).slice(-2).join("/");
      item.innerHTML =
        '<span class="file-icon">📄</span>' +
        '<span class="file-name" title="' + escHtml(f.fullPath) + '">' + escHtml(f.name) + '</span>' +
        '<span class="file-dir" title="' + escHtml(f.dir) + '">' + escHtml(shortDir) + '</span>' +
        '<button class="file-remove" title="Remove">✕</button>';

      // Drag & drop for reordering
      item.addEventListener("dragstart", (e) => {
        dragSrcIdx = i;
        item.classList.add("dragging");
        e.dataTransfer.effectAllowed = "move";
      });
      item.addEventListener("dragend", () => {
        item.classList.remove("dragging");
        dragSrcIdx = null;
        fileListEl.querySelectorAll(".drag-over").forEach(el => el.classList.remove("drag-over"));
      });
      item.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        item.classList.add("drag-over");
      });
      item.addEventListener("dragleave", () => item.classList.remove("drag-over"));
      item.addEventListener("drop", (e) => {
        e.preventDefault();
        item.classList.remove("drag-over");
        if (dragSrcIdx !== null && dragSrcIdx !== i) {
          vscode.postMessage({ type: "moveFile", from: dragSrcIdx, to: i });
        }
      });

      item.querySelector(".file-remove").addEventListener("click", () => {
        vscode.postMessage({ type: "removeFile", index: i });
      });

      fileListEl.appendChild(item);
    });
  }

  function escHtml(s) {
    return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }

  // File buttons
  $("btnAddFiles").addEventListener("click", () => vscode.postMessage({ type: "addFiles" }));
  $("btnAddActive").addEventListener("click", () => vscode.postMessage({ type: "addActiveFile" }));
  $("btnClearFiles").addEventListener("click", () => vscode.postMessage({ type: "clearFiles" }));

  // Run / Copy
  $("btnRun").addEventListener("click", () => {
    if (customCommand) {
      vscode.postMessage({ type: "runCustom", payload: customCommand });
    } else {
      vscode.postMessage({ type: "run" });
    }
  });
  $("btnCopy").addEventListener("click", () => vscode.postMessage({ type: "copy" }));

  // Messages from extension
  window.addEventListener("message", (e) => {
    const msg = e.data;
    switch (msg.type) {
      case "setState": {
        const s = msg.payload;
        compiler.value = s.compiler;
        cppStandard.value = s.cppStandard;
        optimization.value = s.optimization;
        stdlib.value = s.stdlib || "default";
        debugSymbols.checked = s.debugSymbols;
        runAfterCompile.checked = s.runAfterCompile;
        clearTerminal.checked = s.clearTerminal;
        outputName.value = s.outputName || "";
        linkLibraries.value = s.linkLibraries || "";
        additionalFlags.value = s.additionalFlags || "";
        outputDir.value = s.outputDir || "";
        document.querySelectorAll("#warningChecks input").forEach(el => {
          el.checked = (s.warnings || []).includes(el.value);
        });
        document.querySelectorAll("#sanitizerChecks input").forEach(el => {
          el.checked = (s.sanitizers || []).includes(el.value);
        });
        updateStdlibVisibility();
        break;
      }
      case "fileList":
        renderFileList(msg.payload);
        resetCustom();
        break;
      case "preview":
        if (!customCommand) preview.textContent = msg.payload;
        break;
    }
  });

  updateStdlibVisibility();
  vscode.postMessage({ type: "ready" });
</script>
</body>
</html>`;
  }
}

// ─── Extension Activation ────────────────────────────────────────────

function activate(context) {
  const provider = new CppRunViewProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("cppRunGen.panel", provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cppRunGen.run", () => {
      const files = getFilesToCompile();
      if (files.length === 0) return;
      const cmd = buildCommand(files);
      const terminal = getTerminal();
      terminal.sendText(cmd.full);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cppRunGen.copyCommand", async () => {
      const files = getFilesToCompile();
      if (files.length === 0) return;
      const cmd = buildCommand(files);
      await vscode.env.clipboard.writeText(cmd.full);
      vscode.window.showInformationMessage("Command copied to clipboard!");
    })
  );

  console.log("C++ Run Command Generator v2.1 is active!");
}

function deactivate() {}

module.exports = { activate, deactivate };
