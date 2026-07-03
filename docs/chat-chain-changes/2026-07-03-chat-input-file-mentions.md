---
date: 2026-07-03
commit: pending
feature: Chat input file mentions
impact: Typing `@` in the chat composer now opens a workspace file autocomplete. Selecting a file attaches its current contents through the existing attachment flow and removes the typed mention token.
---

# Chat input file mentions

Changed file: `packages/client/src/components/hermes/chat/ChatInput.vue`

The composer reuses the existing Files API and attachment pipeline for a minimal file mention flow. It scans the active session workspace with a capped client-side traversal, filters matches by filename/path, and attaches the chosen file as a normal upload-backed attachment.
