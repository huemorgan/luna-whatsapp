```json
{
  "id": "12-multiple-images",
  "title": "Multiple generated images delivered in one turn",
  "turns": [
    { "chat": "self", "kind": "dm", "text": "make me two images: one of a green apple, and one of a yellow banana. send both", "judge": true }
  ]
}
```

## Expect

The user explicitly asks for TWO images in one turn. Luna should generate both
and deliver both as native media (this proves multi-file delivery, not just a
single image).

A good result:
- **Two media items of kind `image`** are delivered (see the MEDIA list) — one
  apple, one banana.
- Short or no caption.

Partial (not a full pass):
- Exactly one image delivered.

FAIL if:
- No media delivered, or Luna claims it can't, or only pasted text/paths.
