// Webview script for the C++ Run sidebar panel.
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);

  const el = {
    compiler: $("compiler"),
    cppStandard: $("cppStandard"),
    optimization: $("optimization"),
    stdlib: $("stdlib"),
    stdlibRow: $("stdlibRow"),
    compilerHint: $("compilerHint"),
    sanitizerHint: $("sanitizerHint"),
    debugSymbols: $("debugSymbols"),
    runAfterCompile: $("runAfterCompile"),
    clearTerminal: $("clearTerminal"),
    outputName: $("outputName"),
    linkLibraries: $("linkLibraries"),
    additionalFlags: $("additionalFlags"),
    outputDir: $("outputDir"),
    preview: $("preview"),
    fileList: $("fileList"),
    fileEmpty: $("fileEmpty"),
    fileCount: $("fileCount"),
    warnCount: $("warnCount"),
    sanCount: $("sanCount"),
    shellTag: $("shellTag"),
    editedTag: $("editedTag"),
    btnResetEdit: $("btnResetEdit"),
  };

  const warningInputs = () => [...document.querySelectorAll("#warningChecks input")];
  const sanitizerInputs = () => [...document.querySelectorAll("#sanitizerChecks input")];
  const checked = (inputs) => inputs.filter((i) => i.checked && !i.disabled).map((i) => i.value);

  // Which options each compiler understands (others are greyed out)
  const MSVC_WARNINGS = ["-Wall", "-Werror"];
  const MSVC_SANITIZERS = ["address"];

  function applyCompilerSupport() {
    const c = el.compiler.value;
    el.stdlibRow.hidden = c !== "clang++";
    for (const i of warningInputs()) setSupported(i, c !== "cl" || MSVC_WARNINGS.includes(i.value),
      "MSVC: only -Wall (→ /W4) and -Werror (→ /WX) are translated");
    for (const i of sanitizerInputs()) setSupported(i, c !== "cl" || MSVC_SANITIZERS.includes(i.value),
      "MSVC only supports AddressSanitizer");

    el.compilerHint.textContent = c === "cl"
      ? "MSVC needs a Developer PowerShell / Command Prompt, or run VS Code from one."
      : "";
    const san = checked(sanitizerInputs());
    let hint = "";
    if (san.includes("thread") && (san.includes("address") || san.includes("leak"))) {
      hint = "TSan can't be combined with ASan or Leak.";
    } else if (san.includes("memory") && san.length > 1) {
      hint = "MSan must be used on its own (clang++ on Linux only).";
    } else if (san.includes("memory") && c !== "clang++") {
      hint = "MSan is only available with clang++ on Linux.";
    }
    el.sanitizerHint.textContent = hint;
    updateCounts();
  }

  function setSupported(input, ok, why) {
    input.disabled = !ok;
    input.parentElement.classList.toggle("unsupported", !ok);
    input.parentElement.title = ok ? "" : why;
  }

  function updateCounts() {
    const w = checked(warningInputs()).length;
    const s = checked(sanitizerInputs()).length;
    el.warnCount.textContent = w ? `(${w})` : "";
    el.sanCount.textContent = s ? `(${s})` : "";
  }

  function collectState() {
    return {
      compiler: el.compiler.value,
      cppStandard: el.cppStandard.value,
      optimization: el.optimization.value,
      stdlib: el.stdlib.value,
      // keep greyed-out ticks too, so switching back to clang++/g++ restores them
      warnings: warningInputs().filter((i) => i.checked).map((i) => i.value),
      sanitizers: sanitizerInputs().filter((i) => i.checked).map((i) => i.value),
      debugSymbols: el.debugSymbols.checked,
      runAfterCompile: el.runAfterCompile.checked,
      clearTerminal: el.clearTerminal.checked,
      outputName: el.outputName.value,
      linkLibraries: el.linkLibraries.value,
      additionalFlags: el.additionalFlags.value,
      outputDir: el.outputDir.value,
    };
  }

  function sendState() {
    applyCompilerSupport();
    setEdited(false);
    vscode.postMessage({ type: "stateUpdate", payload: collectState() });
  }

  // ── wire option controls
  for (const id of ["compiler", "cppStandard", "optimization", "stdlib", "debugSymbols", "runAfterCompile", "clearTerminal"]) {
    el[id].addEventListener("change", sendState);
  }
  for (const i of [...warningInputs(), ...sanitizerInputs()]) i.addEventListener("change", sendState);
  for (const id of ["outputName", "linkLibraries", "additionalFlags", "outputDir"]) {
    el[id].addEventListener("input", sendState);
  }

  // ── editable preview
  let customCommand = null;
  let generated = "";
  function setEdited(on) {
    if (!on) customCommand = null;
    el.editedTag.hidden = !on;
    el.btnResetEdit.hidden = !on;
  }
  el.preview.addEventListener("input", () => {
    customCommand = el.preview.textContent;
    setEdited(customCommand.trim() !== generated.trim());
    if (customCommand.trim() === generated.trim()) customCommand = null;
  });
  el.preview.addEventListener("keydown", (e) => {
    // Ctrl/Cmd+Enter runs the (edited) command
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); run(); }
    else if (e.key === "Enter") e.preventDefault(); // keep it on one line
  });
  el.btnResetEdit.addEventListener("click", () => {
    setEdited(false);
    showPreview(generated, !generated);
  });

  function showPreview(text, isPlaceholder) {
    el.preview.textContent = isPlaceholder ? "(add source files or open a C++ file)" : text;
    el.preview.classList.toggle("placeholder", !!isPlaceholder);
    el.preview.contentEditable = isPlaceholder ? "false" : "true";
  }

  // ── file list
  let dragSrcIdx = null;
  function renderFileList(files) {
    el.fileCount.textContent = files.length;
    el.fileList.querySelectorAll(".file-item").forEach((n) => n.remove());
    el.fileEmpty.hidden = files.length > 0;

    files.forEach((f, i) => {
      const item = document.createElement("div");
      item.className = "file-item" + (i === 0 && files.length > 1 ? " main" : "");
      item.draggable = true;

      const icon = document.createElement("span");
      icon.className = "file-icon"; icon.textContent = "📄";
      const name = document.createElement("span");
      name.className = "file-name"; name.textContent = f.name; name.title = f.fullPath;
      const dir = document.createElement("span");
      dir.className = "file-dir"; dir.textContent = f.dir.split(/[\\/]/).slice(-2).join("/"); dir.title = f.dir;
      const rm = document.createElement("button");
      rm.className = "file-remove"; rm.textContent = "✕"; rm.title = "Remove";
      rm.addEventListener("click", () => vscode.postMessage({ type: "removeFile", index: i }));
      item.append(icon, name, dir, rm);

      item.addEventListener("dragstart", (e) => {
        dragSrcIdx = i; item.classList.add("dragging"); e.dataTransfer.effectAllowed = "move";
      });
      item.addEventListener("dragend", () => {
        item.classList.remove("dragging"); dragSrcIdx = null;
        el.fileList.querySelectorAll(".drag-over").forEach((n) => n.classList.remove("drag-over"));
      });
      item.addEventListener("dragover", (e) => { e.preventDefault(); item.classList.add("drag-over"); });
      item.addEventListener("dragleave", () => item.classList.remove("drag-over"));
      item.addEventListener("drop", (e) => {
        e.preventDefault(); item.classList.remove("drag-over");
        if (dragSrcIdx !== null && dragSrcIdx !== i) vscode.postMessage({ type: "moveFile", from: dragSrcIdx, to: i });
      });
      el.fileList.appendChild(item);
    });
  }

  $("btnAddFiles").addEventListener("click", () => vscode.postMessage({ type: "addFiles" }));
  $("btnAddActive").addEventListener("click", () => vscode.postMessage({ type: "addActiveFile" }));
  $("btnClearFiles").addEventListener("click", () => vscode.postMessage({ type: "clearFiles" }));

  // ── run / copy
  function run() {
    if (customCommand) vscode.postMessage({ type: "runCustom", payload: customCommand });
    else vscode.postMessage({ type: "run" });
  }
  $("btnRun").addEventListener("click", run);
  $("btnCopy").addEventListener("click", () => {
    if (customCommand) vscode.postMessage({ type: "copyCustom", payload: customCommand });
    else vscode.postMessage({ type: "copy" });
  });

  // ── messages from the extension
  window.addEventListener("message", (e) => {
    const msg = e.data;
    switch (msg.type) {
      case "setState": {
        const s = msg.payload;
        for (const id of ["compiler", "cppStandard", "optimization", "outputName", "linkLibraries", "additionalFlags", "outputDir"]) {
          el[id].value = s[id] || "";
        }
        el.stdlib.value = s.stdlib || "default";
        for (const id of ["debugSymbols", "runAfterCompile", "clearTerminal"]) el[id].checked = !!s[id];
        for (const i of warningInputs()) i.checked = (s.warnings || []).includes(i.value);
        for (const i of sanitizerInputs()) i.checked = (s.sanitizers || []).includes(i.value);
        applyCompilerSupport();
        break;
      }
      case "fileList":
        renderFileList(msg.payload);
        setEdited(false);
        break;
      case "preview":
        generated = msg.payload.command || "";
        el.shellTag.textContent = msg.payload.shellLabel || "";
        if (!customCommand) showPreview(generated, !generated);
        break;
    }
  });

  applyCompilerSupport();
  vscode.postMessage({ type: "ready" });
})();
