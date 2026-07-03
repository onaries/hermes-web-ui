---
date: 2026-07-03
commit: pending
feature: Chat input multiline height
impact: Desktop chat input now measures multiline content even when a configured input height is set, so Shift+Enter newlines expand the visible textarea instead of leaving earlier lines clipped or scrolled out of view. Manual drag-resized heights still remain fixed.
---

# Chat input multiline height

Changed file: `packages/client/src/components/hermes/chat/ChatInput.vue`

The single-chat textarea keeps measuring its content height after desktop display settings apply a configured input height. Non-manual configured heights now act as a minimum rather than a hard cap, while scroll position is reset when the visible height can fit the content.
