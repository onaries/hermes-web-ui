---
date: 2026-07-03
commit: pending
feature: Chat input file mention selection cleanup
impact: Selecting a file from the `@` mention autocomplete removes the typed mention token immediately, before file content loading finishes, so only the normal attachment chip remains in the composer.
---

# Chat input file mention selection cleanup

Changed file: `packages/client/src/components/hermes/chat/ChatInput.vue`

File mention selection now clears the active `@...` token synchronously and closes the dropdown before asynchronously reading the selected file into the existing attachment flow.
