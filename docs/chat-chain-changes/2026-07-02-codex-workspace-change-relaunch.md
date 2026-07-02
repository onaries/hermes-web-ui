---
date: 2026-07-02
commit: pending
feature: coding-agent workspace relaunch
impact: Coding-agent sessions restart their runner when the selected workspace changes; Codex resumes the same native conversation while passing the new workspace as the exec root.
files:
  - packages/server/src/services/hermes/run-chat/handle-coding-agent-run.ts
  - packages/server/src/services/agent-runner/coding-agent-run-manager.ts
  - packages/server/src/services/coding-agents.ts
---

Codex/Claude coding-agent runs now treat workspace changes as launch-incompatible so the stale runner is replaced. Codex keeps the existing native session id and invokes `codex exec --cd <workspace> resume ...`, preserving conversation context while applying the selected folder as the working root.
