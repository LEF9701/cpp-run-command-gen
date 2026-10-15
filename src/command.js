// Pure command builder — no VS Code dependency, so it can be unit-tested.
const path = require("path");

const DEFAULT_STATE = Object.freeze({
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
});

/**
 * Work out which command syntax to emit.
 * @param {string} shellPath  vscode.env.shell (path of the default terminal shell)
 * @param {string} platform   process.platform
 * @param {string} override   "auto" | "powershell" | "cmd" | "bash"
 * @returns {"powershell"|"cmd"|"posix"}
 */
function detectShell(shellPath, platform, override) {
  if (override === "powershell") return "powershell";
  if (override === "cmd") return "cmd";
  if (override === "bash") return "posix";
  const s = String(shellPath || "").toLowerCase();
  if (/(pwsh|powershell)(\.exe)?$/.test(s)) return "powershell";
  if (/cmd(\.exe)?$/.test(s)) return "cmd";
  if (/(bash|zsh|fish|sh)(\.exe)?$/.test(s)) return "posix";
  return platform === "win32" ? "powershell" : "posix";
}

// ── quoting ──────────────────────────────────────────────────────────

function quote(arg, shell) {
  // PowerShell's call operator (&) always gets a quoted string
  if (shell === "powershell-force") return `'${arg.replace(/'/g, "''")}'`;
  if (shell === "powershell") {
    // single quotes: no $ / backtick expansion; ' is escaped by doubling
    return /^[\w.\-\\/:+=]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "''")}'`;
  }
  if (shell === "cmd") {
    return /^[\w.\-\\/:+=]+$/.test(arg) ? arg : `"${arg}"`;
  }
  // bash/zsh (incl. Git Bash on Windows): backslashes are escape characters, so use forward slashes
  if (shell === "posix-win") arg = arg.replace(/\\/g, "/");
  return /^[\w.\-/:+=@%]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

// ── MSVC translations ────────────────────────────────────────────────

const MSVC_STD = {
  "c++11": "c++14", // cl has no C++11 switch; C++14 is its oldest
  "c++14": "c++14",
  "c++17": "c++17",
  "c++20": "c++20",
  "c++23": "c++latest",
  "c++2c": "c++latest",
};
const MSVC_OPT = { "-O0": "/Od", "-O1": "/O1", "-O2": "/O2", "-O3": "/Ox", "-Os": "/Os", "-Ofast": "/Ox" };

function compilerFlags(s) {
  const flags = [];
  if (s.compiler === "cl") {
    flags.push("/nologo", "/EHsc", `/std:${MSVC_STD[s.cppStandard] || "c++20"}`);
    flags.push(MSVC_OPT[s.optimization] || "/Od");
    if (s.warnings.includes("-Wall")) flags.push("/W4");
    if (s.warnings.includes("-Werror")) flags.push("/WX");
    if (s.debugSymbols) flags.push("/Zi");
    if (s.sanitizers.includes("address")) flags.push("/fsanitize=address");
  } else {
    flags.push(`-std=${s.cppStandard}`, s.optimization, ...s.warnings);
    if (s.debugSymbols) flags.push("-g");
    if (s.compiler === "clang++" && s.stdlib && s.stdlib !== "default") flags.push(`-stdlib=${s.stdlib}`);
    if (s.sanitizers.length) flags.push(`-fsanitize=${s.sanitizers.join(",")}`);
  }
  return flags;
}

function splitList(text) {
  return String(text || "").split(/[\s,]+/).filter(Boolean);
}

/**
 * Build the compile (+ run) command line.
 * @param {object} state   panel options (see DEFAULT_STATE)
 * @param {string[]} files absolute source paths; the first one decides the working dir and default output name
 * @param {{platform?: string, shell?: "powershell"|"cmd"|"posix"}} env
 * @returns {{full: string, compile: string, workDir: string, output: string}}
 */
function buildCommand(state, files, env = {}) {
  const s = { ...DEFAULT_STATE, ...state };
  const platform = env.platform || process.platform;
  const shellKind = env.shell || detectShell("", platform, "auto");
  // Git Bash etc. on Windows: Windows paths, but written with forward slashes
  const shell = shellKind === "posix" && platform === "win32" ? "posix-win" : shellKind;
  const p = platform === "win32" ? path.win32 : path.posix;

  if (!files || files.length === 0) {
    return { full: "", compile: "", workDir: "", output: "" };
  }

  const workDir = p.dirname(files[0]);
  const exe = platform === "win32" ? ".exe" : "";
  const baseName = s.outputName.trim() || p.basename(files[0], p.extname(files[0]));

  const outDirAbs = s.outputDir.trim()
    ? (p.isAbsolute(s.outputDir.trim()) ? s.outputDir.trim() : p.join(workDir, s.outputDir.trim()))
    : workDir;
  const outAbs = p.join(outDirAbs, baseName + exe);

  // Keep paths short in the preview: relative to the working dir when possible.
  const rel = (abs) => {
    const r = p.relative(workDir, abs);
    return r && !r.startsWith("..") && !p.isAbsolute(r) ? r : abs;
  };
  const outRel = rel(outAbs);
  const sep = platform === "win32" && !shell.startsWith("posix") ? "\\" : "/";
  const runPath = p.isAbsolute(outRel) ? outRel : `.${sep}${outRel}`;

  // ── compile line
  const parts = [s.compiler, ...compilerFlags(s), ...splitList(s.additionalFlags)];
  for (const f of files) parts.push(quote(rel(f), shell));

  if (s.compiler === "cl") {
    parts.push(`/Fe:${quote(outRel, shell)}`);
    for (const lib of splitList(s.linkLibraries)) parts.push(/\.lib$/i.test(lib) ? lib : `${lib}.lib`);
  } else {
    parts.push("-o", quote(outRel, shell));
    for (const lib of splitList(s.linkLibraries)) parts.push(`-l${lib.replace(/^-l/, "")}`);
  }
  const compile = parts.join(" ");

  // ── full line, shell-specific chaining
  const mkOut = outDirAbs !== workDir;
  let full;
  if (shell === "powershell") {
    const steps = [`Set-Location -LiteralPath ${quote(workDir, shell)}`];
    if (mkOut) steps.push(`New-Item -ItemType Directory -Force ${quote(rel(outDirAbs), shell)} | Out-Null`);
    steps.push(compile);
    if (s.runAfterCompile) steps.push(`if ($LASTEXITCODE -eq 0) { & ${quote(runPath, "powershell-force")} }`);
    full = steps.join("; ");
  } else if (shell === "cmd") {
    const steps = [`cd /d ${quote(workDir, shell)}`];
    if (mkOut) steps.push(`(if not exist ${quote(rel(outDirAbs), shell)} mkdir ${quote(rel(outDirAbs), shell)})`);
    steps.push(compile);
    if (s.runAfterCompile) steps.push(quote(runPath, shell));
    full = steps.join(" && ");
  } else {
    const steps = [`cd ${quote(workDir, shell)}`];
    if (mkOut) steps.push(`mkdir -p ${quote(rel(outDirAbs), shell)}`);
    steps.push(compile);
    if (s.runAfterCompile) steps.push(quote(runPath, shell));
    full = steps.join(" && ");
  }

  return { full, compile, workDir, output: outAbs };
}

function clearCommand(shell) {
  return shell === "powershell" ? "Clear-Host" : shell === "cmd" ? "cls" : "clear";
}

module.exports = { DEFAULT_STATE, detectShell, buildCommand, clearCommand };
