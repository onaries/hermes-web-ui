---
date: 2026-07-02
commit: pending
feature: mobile chat header session title
impact: Mobile chat headers keep the active session title visible with compact typography instead of hiding it, while preserving workspace badge truncation.
files:
  - packages/client/src/components/hermes/chat/ChatPanel.vue
---

Restore active session title visibility on narrow/mobile chat headers. The upstream mobile chrome rule hid `.header-session-title`, making all sessions look untitled from the active chat view.
