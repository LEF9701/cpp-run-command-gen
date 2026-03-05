# C++ Run Command Generator v2

A VS Code extension with a **dedicated sidebar panel** for generating and executing C++ compile & run commands. Configure everything visually — compiler, C++ standard, optimization, sanitizers, warnings, and more.

## Features

- **Custom sidebar panel** in the Activity Bar with C++ Run icon
- **Live command preview** — see the generated command update in real time as you change settings
- **Editable preview** — directly modify the command before running
- **One-click Run** — compile & run from the sidebar or editor title bar
- **Compiler**: `clang++`, `g++`, MSVC `cl`
- **C++ Standard**: C++11 through C++2c (C++26)
- **Optimization**: `-O0` to `-Ofast`
- **Warnings**: `-Wall`, `-Wextra`, `-Wpedantic`, `-Werror`, `-Wshadow`, `-Wconversion`
- **Sanitizers**: ASan, UBSan, TSan, MSan, Leak
- **Debug symbols**, stdlib selection, link libraries, extra flags
- **Keyboard shortcuts**: `Cmd+Shift+R` (run), `Cmd+Shift+C` (copy)

## Installation

```bash
# From source — package with vsce
npm install
vsce package
# Then: Extensions → Install from VSIX...

# Or copy directly
cp -r . ~/.vscode/extensions/cpp-run-command-gen
# Restart VS Code
```

## Usage

1. Click the **C++▶** icon in the left Activity Bar to open the sidebar
2. Select your compiler, C++ standard, and options
3. Open a `.cpp` file — the command preview updates automatically
4. Click **▶ Run** or press `Cmd+Shift+R`

## License

MIT
