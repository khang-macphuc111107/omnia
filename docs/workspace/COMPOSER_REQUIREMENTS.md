# Rich composer — requirements intake

Status: requested, not implemented or runtime-verified by this intake.
Source: user request in thread 01a1bce9-bcd9-75f3-b63a-28b855d6978f, 2026-11-11, plus 15 supplied screenshots. Images illustrate menus, tabs, attachment tray, editing toolbar and subagent views; they do not establish product behavior. Private collaborator conversation remains external.

## Interaction contract

- Compose rich text with headings, title, bold, italic, underline, font family/size/color, indentation, numbered/bullet/check lists and tables. Preserve semantic blocks when exporting text.
- Render Markdown and LaTeX during editing. Offer visual equation/symbol palettes for mathematics, physics and chemistry with rendered previews and editable placeholders.
- Accept image and other-file paste and drag/drop. Both inline insertion and attachment tray must remain available within the same session.
- Paste of an attachment asks inline-at-caret versus tray, with accessible keyboard selection and cancel; cancel must not mutate the draft.
- During drag over editable content, display and update insertion caret; dropping inserts at that location. Dropping over application outside the input routes to tray. Dropping outside the app is not captured.
- Inline attachment is an ordered document node with stable attachment ID and surrounding text. The provider request preserves the order and reference between text and attachments; unsupported providers receive explicit labeled serialization with limitations.
- Tray and inline nodes can refer to the same stored payload without duplicate uploads. Define removal, move, copy, undo/redo and replacement semantics; no silent content loss.
- Preserve originals for conversions. Show original/derived relationship, MIME, size, extraction status, conversion errors and cancellation. Unsupported/encrypted input must remain attachable or clearly unresolved; do not claim unread contents were read.
- Persist recoverable drafts, ordered nodes and attachment states across restart. Queue sends only when required conversions/uploads complete or the user explicitly accepts omissions.

## Acceptance matrix

Verify inline/tray paste and drop; start/middle/end caret; multi-file batches; image/text mixtures; long text, IME Vietnamese and Unicode math; invalid/large/unsupported files; conversion failure/cancel/retry; undo/redo; restart; provider incapable of multimodal input; keyboard and screen reader; zoom/DPI/resize; upload progress and send ordering. Observe actual rendered UI and backend request, not just DOM or unit assertions.

## Performance and architecture

Native-first requirement remains in force. Quoted collaborator conversation mentions C++; this is historical design input, not a command replacing directly requested native Rust. Record an architecture decision and measured resource budgets before selecting rich text/math rendering dependencies. Existing web compatibility implementations are not proof of native parity.

## Open decisions

Exact supported rich document interchange; Markdown constructs with no font/color equivalent; provider payload mappings; conversion size/time budgets; cross-platform native rendering; drag behavior while selecting text; default paste focus. Resolve through prototype evidence and user-visible specs before claiming done.
