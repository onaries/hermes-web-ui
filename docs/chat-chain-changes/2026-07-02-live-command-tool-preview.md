---
date: 2026-07-02
commit: pending
feature: Live Codex Command previews
impact: Live tool rows for Codex `Command` now show the command arguments instead of stdout/stderr result previews such as SSH X11 forwarding warnings.
---

The live tool-call panel now treats Codex `Command` like terminal tools: command/cmd arguments are the preview source, and terminal-like live rows no longer fall back to result output when an argument preview is unavailable. Other live tool previews such as approval/write_file status text keep their existing preview behavior.
