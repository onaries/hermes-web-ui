---
date: 2026-07-03
commit: pending
feature: Extensionless markdown artifacts
impact: Artifact previews now detect markdown-like generated files even when the path or display name has no `.md` extension, so headings, lists, links, and inline code render through MarkdownRenderer instead of raw preformatted text.
---

# Extensionless markdown artifacts

Changed file: `packages/client/src/stores/hermes/artifacts.ts`

Generated artifacts without filename extensions are no longer treated only as generic files. Artifact kind detection now uses basename-only extensions, Markdown name hints, and fetched content signals to promote markdown-like text to `markdown` before rendering.
