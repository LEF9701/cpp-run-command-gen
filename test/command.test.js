const test = require("node:test");
const assert = require("node:assert/strict");
const { buildCommand, detectShell, DEFAULT_STATE } = require("../src/command");

const nix = { platform: "linux", shell: "posix" };
const ps = { platform: "win32", shell: "powershell" };
const cmd = { platform: "win32", shell: "cmd" };

test("default posix command", () => {
  const r = buildCommand(DEFAULT_STATE, ["/home/u/proj/main.cpp"], nix);
  assert.equal(r.full, "cd /home/u/proj && clang++ -std=c++20 -O0 -Wall -Wextra main.cpp -o main && ./main");
});

test("paths with spaces are quoted (posix)", () => {
  const r = buildCommand(DEFAULT_STATE, ["/home/u/my proj/main.cpp"], nix);
  assert.equal(r.full, "cd '/home/u/my proj' && clang++ -std=c++20 -O0 -Wall -Wextra main.cpp -o main && ./main");
});

test("multi-file, g++, sanitizers, libs, debug, output dir", () => {
  const s = { ...DEFAULT_STATE, compiler: "g++", cppStandard: "c++17", optimization: "-O2",
    warnings: ["-Wall"], sanitizers: ["address", "undefined"], debugSymbols: true,
    linkLibraries: "pthread, fmt", outputDir: "build", outputName: "app" };
  const r = buildCommand(s, ["/p/main.cpp", "/p/src/util.cpp"], nix);
  assert.equal(r.full,
    "cd /p && mkdir -p build && g++ -std=c++17 -O2 -Wall -g -fsanitize=address,undefined main.cpp src/util.cpp -o build/app -lpthread -lfmt && ./build/app");
});

test("stdlib only for clang++", () => {
  const s = { ...DEFAULT_STATE, stdlib: "libc++" };
  assert.match(buildCommand(s, ["/p/a.cpp"], nix).compile, /-stdlib=libc\+\+/);
  assert.doesNotMatch(buildCommand({ ...s, compiler: "g++" }, ["/p/a.cpp"], nix).compile, /-stdlib/);
});

test("PowerShell syntax on Windows", () => {
  const r = buildCommand({ ...DEFAULT_STATE, compiler: "g++" }, ["C:\\Users\\me\\My Code\\main.cpp"], ps);
  assert.equal(r.full,
    "Set-Location -LiteralPath 'C:\\Users\\me\\My Code'; g++ -std=c++20 -O0 -Wall -Wextra main.cpp -o main.exe; if ($LASTEXITCODE -eq 0) { & '.\\main.exe' }");
});

test("cmd syntax on Windows", () => {
  const r = buildCommand({ ...DEFAULT_STATE, outputDir: "bin" }, ["C:\\code\\main.cpp"], cmd);
  assert.equal(r.full,
    "cd /d C:\\code && (if not exist bin mkdir bin) && clang++ -std=c++20 -O0 -Wall -Wextra main.cpp -o bin\\main.exe && .\\bin\\main.exe");
});

test("Git Bash on Windows uses forward slashes", () => {
  const r = buildCommand({ ...DEFAULT_STATE, outputDir: "build" },
    ["C:\\Users\\me\\My Code\\main.cpp", "C:\\Users\\me\\My Code\\src\\util.cpp"], { platform: "win32", shell: "posix" });
  assert.equal(r.full,
    "cd 'C:/Users/me/My Code' && mkdir -p build && clang++ -std=c++20 -O0 -Wall -Wextra main.cpp src/util.cpp -o build/main.exe && ./build/main.exe");
});

test("MSVC translation", () => {
  const s = { ...DEFAULT_STATE, compiler: "cl", cppStandard: "c++23", optimization: "-O2",
    warnings: ["-Wall", "-Werror", "-Wshadow"], sanitizers: ["address", "undefined"],
    debugSymbols: true, linkLibraries: "user32" };
  const r = buildCommand(s, ["C:\\code\\main.cpp"], ps);
  assert.equal(r.compile, "cl /nologo /EHsc /std:c++latest /O2 /W4 /WX /Zi /fsanitize=address main.cpp /Fe:main.exe user32.lib");
});

test("no run step when 'Run after compile' is off", () => {
  const r = buildCommand({ ...DEFAULT_STATE, runAfterCompile: false }, ["/p/a.cpp"], nix);
  assert.equal(r.full, "cd /p && clang++ -std=c++20 -O0 -Wall -Wextra a.cpp -o a");
});

test("absolute output dir outside the project", () => {
  const r = buildCommand({ ...DEFAULT_STATE, outputDir: "/tmp/out" }, ["/p/a.cpp"], nix);
  assert.equal(r.full, "cd /p && mkdir -p /tmp/out && clang++ -std=c++20 -O0 -Wall -Wextra a.cpp -o /tmp/out/a && /tmp/out/a");
});

test("empty file list", () => {
  assert.equal(buildCommand(DEFAULT_STATE, [], nix).full, "");
});

test("shell detection", () => {
  assert.equal(detectShell("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "win32", "auto"), "powershell");
  assert.equal(detectShell("C:\\Program Files\\PowerShell\\7\\pwsh.exe", "win32", "auto"), "powershell");
  assert.equal(detectShell("C:\\Windows\\System32\\cmd.exe", "win32", "auto"), "cmd");
  assert.equal(detectShell("C:\\Program Files\\Git\\bin\\bash.exe", "win32", "auto"), "posix");
  assert.equal(detectShell("/bin/zsh", "darwin", "auto"), "posix");
  assert.equal(detectShell("", "win32", "auto"), "powershell");
  assert.equal(detectShell("/bin/zsh", "darwin", "cmd"), "cmd");
});
