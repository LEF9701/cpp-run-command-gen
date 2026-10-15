# Changelog

## 2.1.0 — 2026-10-15

First Marketplace release.

### Fixed
- **Windows terminals:** commands now use the syntax of your default shell. PowerShell (the Windows default) previously failed on `cd /d`, `&&` and running the program; cmd and Git Bash also work. Override with the `cppRunGen.shell` setting.
- **Unwanted auto-saves:** the extension no longer saves your file every time you switch editors or change an option. It saves only when you press Run.
- **Error pop-ups:** switching to a non-C++ tab no longer shows "No source files selected". The preview keeps showing the last C/C++ file you used.
- **Copy ignored edits:** Copy now copies the command as you edited it in the preview.
- **Missing Run icon** in the panel and editor title bar.
- **Activity-bar icon** showed a plain triangle; the "C++" is now visible.
- **MSVC:** adds `/EHsc` and `/nologo`, maps C++11 → `/std:c++14` and C++23/26 → `/std:c++latest`, maps `-Werror` → `/WX`, supports `/fsanitize=address`, and links libraries as `name.lib`.

### Added
- Your options are remembered across VS Code restarts; the source-file list is remembered per workspace.
- **Reset Options to Defaults** command (panel toolbar and Command Palette).
- Preview shows which shell syntax it is using, and an **edited** badge with a **reset** link when you change the command by hand.
- `Ctrl+Enter` inside the preview runs the edited command.
- Options a compiler doesn't support are greyed out, with hints for sanitizer combinations that can't work together.
- The webview now uses a strict Content Security Policy.

### Changed
- Shortcuts moved to **Ctrl+Alt+R** (run) and **Ctrl+Alt+C** (copy) — `Cmd+Alt` on macOS. The old `Ctrl+Shift+R` / `Ctrl+Shift+C` overrode VS Code's built-in Refactor and Open External Terminal.
- The extension now loads only when a C/C++ file or the panel is opened, instead of at every startup.
- Run step uses a path relative to the source folder (`./main`), so the preview is shorter.

## 2.0.0

- Sidebar panel with multi-file list, drag-to-reorder, editable command preview.
