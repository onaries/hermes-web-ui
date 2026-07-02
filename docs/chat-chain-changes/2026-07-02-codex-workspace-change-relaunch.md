---
date: 2026-07-02
commit: pending
feature: coding-agent workspace relaunch
impact: Codex/Claude coding-agent sessions restart their runner when the selected workspace changes instead of reusing a runner/native thread from the previous directory.
files:
  - packages/server/src/services/hermes/run-chat/handle-coding-agent-run.ts
  - packages/server/src/services/agent-runner/coding-agent-run-manager.ts
  - packages/server/src/services/coding-agents.ts
---

Codex/Claude coding-agent runs now treat workspace changes as launch-incompatible. Changing a session workspace stops the stale runner, starts a new one in the selected directory, and avoids resuming a native Codex thread from the old workspace.
