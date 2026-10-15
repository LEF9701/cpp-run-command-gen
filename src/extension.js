const vscode = require("vscode");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { DEFAULT_STATE, detectShell, buildCommand, clearCommand } = require("./command");

const CPP_SRC_EXTS = [".cpp", ".cxx", ".cc", ".c", ".c++", ".cp"];
const STATE_KEY = "cppRunGen.options";
const FILES_KEY = "cppRunGen.sourceFiles";
const TERMINAL_NAME = "C++ Run";
const SHELL_LABEL = { powershell: "PowerShell", cmd: "cmd", posix: "bash/zsh" };

let state = { ...DEFAULT_STATE };
let sourceFiles = [];   // explicit multi-file list (absolute paths)
let lastCppFile = null; // most recent C/C++ editor, used when the list is empty
let ctx;

// ─── helpers ─────────────────────────────────────────────────────────

const isCppSource = (fp) => CPP_SRC_EXTS.includes(path.extname(fp).toLowerCase());

function currentShell() {
  const override = vscode.workspace.getConfiguration("cppRunGen").get("shell", "auto");
  return detectShell(vscode.env.shell, process.platform, override);
}

function trackActiveEditor(editor) {
  if (editor && editor.document.uri.scheme === "file" && isCppSource(editor.document.fileName)) {
    lastCppFile = editor.document.fileName;
  }
}

/** Files that would be compiled right now (no side effects). */
function filesToCompile() {
  if (sourceFiles.length > 0) return [...sourceFiles];
  return lastCppFile ? [lastCppFile] : [];
}

/** Save any unsaved editors for the given files before compiling. */
async function saveFiles(files) {
  const wanted = new Set(files.map((f) => path.normalize(f)));
  const dirty = vscode.workspace.textDocuments.filter(
    (d) => d.isDirty && wanted.has(path.normalize(d.fileName))
  );
  await Promise.all(dirty.map((d) => d.save()));
}

function makeCommand(files) {
  const shell = currentShell();
  return { shell, ...buildCommand(state, files, { platform: process.platform, shell }) };
}

function getTerminal(shell) {
  let terminal = vscode.window.terminals.find((t) => t.name === TERMINAL_NAME && t.exitStatus === undefined);
  if (!terminal) terminal = vscode.window.createTerminal(TERMINAL_NAME);
  terminal.show(true);
  if (state.clearTerminal) terminal.sendText(clearCommand(shell), true);
  return terminal;
}

function noFilesError() {
  vscode.window.showErrorMessage("C++ Run: open a C/C++ file or add source files in the C++ Run panel first.");
}

// ─── commands ────────────────────────────────────────────────────────

async function runCommand(customText) {
  const files = filesToCompile();
  if (!customText && files.length === 0) return noFilesError();
  await saveFiles(files);
  const shell = currentShell();
  const text = customText || makeCommand(files).full;
  getTerminal(shell).sendText(text, true);
}

async function copyCommand(customText) {
  const files = filesToCompile();
  if (!customText && files.length === 0) return noFilesError();
  await vscode.env.clipboard.writeText(customText || makeCommand(files).full);
  vscode.window.setStatusBarMessage("$(check) C++ Run: command copied", 2500);
}

// ─── Webview provider ────────────────────────────────────────────────

class CppRunViewProvider {
  constructor(extensionUri) {
    this._extensionUri = extensionUri;
    this._view = null;
  }

  resolveWebviewView(webviewView) {
    this._view = webviewView;
    const media = vscode.Uri.joinPath(this._extensionUri, "media");
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [media] };
    webviewView.webview.html = this._getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case "ready":
          this.postState(); this.postFileList(); this.postPreview();
          break;
        case "stateUpdate":
          state = { ...state, ...msg.payload };
          ctx.globalState.update(STATE_KEY, state);
          this.postPreview();
          break;
        case "run": await runCommand(); break;
        case "runCustom": await runCommand(String(msg.payload || "")); break;
        case "copy": await copyCommand(); break;
        case "copyCustom": await copyCommand(String(msg.payload || "")); break;
        case "addFiles": await this._addFiles(); break;
        case "addActiveFile": {
          const ed = vscode.window.activeTextEditor;
          const active = ed && isCppSource(ed.document.fileName) ? ed.document.fileName : lastCppFile;
          if (!active) vscode.window.showWarningMessage("C++ Run: no C/C++ file is open.");
          else if (sourceFiles.includes(active)) vscode.window.setStatusBarMessage("C++ Run: file already in list", 2500);
          else { sourceFiles.push(active); this.filesChanged(); }
          break;
        }
        case "removeFile":
          if (msg.index >= 0 && msg.index < sourceFiles.length) { sourceFiles.splice(msg.index, 1); this.filesChanged(); }
          break;
        case "clearFiles":
          sourceFiles = []; this.filesChanged();
          break;
        case "moveFile": {
          const { from, to } = msg;
          if (from >= 0 && from < sourceFiles.length && to >= 0 && to < sourceFiles.length) {
            const [item] = sourceFiles.splice(from, 1);
            sourceFiles.splice(to, 0, item);
            this.filesChanged();
          }
          break;
        }
      }
    });
  }

  async _addFiles() {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: true,
      defaultUri: lastCppFile ? vscode.Uri.file(path.dirname(lastCppFile)) : undefined,
      filters: { "C/C++ Source Files": ["cpp", "cxx", "cc", "c", "c++", "cp"], "All Files": ["*"] },
      title: "Select C++ source files to compile",
    });
    if (!uris) return;
    for (const uri of uris) if (!sourceFiles.includes(uri.fsPath)) sourceFiles.push(uri.fsPath);
    this.filesChanged();
  }

  filesChanged() {
    ctx.workspaceState.update(FILES_KEY, sourceFiles);
    this.postFileList();
    this.postPreview();
  }

  postState() {
    this._view?.webview.postMessage({ type: "setState", payload: state });
  }

  postFileList() {
    this._view?.webview.postMessage({
      type: "fileList",
      payload: sourceFiles.map((fp, i) => ({ index: i, fullPath: fp, name: path.basename(fp), dir: path.dirname(fp) })),
    });
  }

  postPreview() {
    if (!this._view) return;
    const files = filesToCompile();
    const shell = currentShell();
    this._view.webview.postMessage({
      type: "preview",
      payload: { command: files.length ? makeCommand(files).full : "", shellLabel: SHELL_LABEL[shell] },
    });
  }

  _getHtml(webview) {
    const media = vscode.Uri.joinPath(this._extensionUri, "media");
    const nonce = crypto.randomBytes(16).toString("base64");
    const tpl = fs.readFileSync(path.join(media.fsPath, "panel.html"), "utf8");
    return tpl
      .replace(/{{cspSource}}/g, webview.cspSource)
      .replace(/{{nonce}}/g, nonce)
      .replace(/{{cssUri}}/g, webview.asWebviewUri(vscode.Uri.joinPath(media, "panel.css")).toString())
      .replace(/{{jsUri}}/g, webview.asWebviewUri(vscode.Uri.joinPath(media, "panel.js")).toString());
  }
}

// ─── activation ──────────────────────────────────────────────────────

function activate(context) {
  ctx = context;
  state = { ...DEFAULT_STATE, ...context.globalState.get(STATE_KEY, {}) };
  sourceFiles = context.workspaceState.get(FILES_KEY, []).filter((f) => fs.existsSync(f));
  trackActiveEditor(vscode.window.activeTextEditor);

  const provider = new CppRunViewProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("cppRunGen.panel", provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.onDidChangeActiveTextEditor((ed) => {
      const before = lastCppFile;
      trackActiveEditor(ed);
      if (lastCppFile !== before) provider.postPreview();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("cppRunGen")) provider.postPreview();
    }),
    vscode.commands.registerCommand("cppRunGen.run", () => runCommand()),
    vscode.commands.registerCommand("cppRunGen.copyCommand", () => copyCommand()),
    vscode.commands.registerCommand("cppRunGen.resetOptions", () => {
      state = { ...DEFAULT_STATE };
      context.globalState.update(STATE_KEY, state);
      provider.postState();
      provider.postPreview();
      vscode.window.setStatusBarMessage("C++ Run: options reset to defaults", 2500);
    }),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
