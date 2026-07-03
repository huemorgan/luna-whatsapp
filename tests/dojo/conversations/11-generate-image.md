```json
{
  "id": "11-generate-image",
  "title": "Generated image is actually delivered as media",
  "turns": [
    { "chat": "self", "kind": "dm", "text": "make me an image of a red vintage bicycle against a white wall", "judge": true }
  ]
}
```

## Expect

The user asks Luna to CREATE an image. Luna has an image-generation tool. This is
the exact case that failed before: the agent generated the image but replied with
only a local file reference, so nothing reached WhatsApp.

A good result:
- At least one **media item of kind `image` is delivered** (see the MEDIA list).
  The image is the generated bicycle, delivered natively — not a pasted path/URL
  sitting in the text.
- Any caption is short ("here you go 🚲") or empty.

It is a FAIL if:
- No media is delivered (text-only reply, e.g. "here's your image images/…png"
  with nothing in MEDIA).
- Luna says it can't generate images / "no image plugin" / "use the web app".
- The reply is just a raw file path or URL with no actual media delivered.
