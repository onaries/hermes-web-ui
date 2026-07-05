---
date: 2026-07-04
commit: pending
feature: Chat file mention search
impact: `@query` in the chat composer now searches the active workspace through the Files API instead of relying on the old capped client-side scan, while selection still attaches the file through the existing attachment flow.
---

The Files API exposes a bounded recursive search endpoint for workspace files.
The chat composer calls it for `@` mentions and keeps the same token cleanup and
attachment-chip behavior after selecting a result. As the user keeps typing after
`@`, the composer clears stale candidates immediately, issues a fresh search for
the new query, and ignores late responses from older queries so the dropdown
follows the typed characters in real time. Selecting a result reads the file
content and wraps that content in the attachment `File` object before upload.
