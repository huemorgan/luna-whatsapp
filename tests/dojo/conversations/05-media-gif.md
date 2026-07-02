```json
{
  "id": "05-media-gif",
  "title": "Delivers an image/GIF as native media, not a pasted URL",
  "turns": [
    { "chat": "self", "kind": "dm", "text": "send me a cute cat gif", "judge": true }
  ]
}
```

## Expect

The user asked for a cat GIF. Luna should actually deliver media on WhatsApp.

A good result looks like (judge sees the recorded reply rows, incl. media rows):
- At least one media item is delivered (a row whose kind is image/gif/video, or
  a reply that carries a direct media URL that the bridge turns into media).
- Any accompanying text is short ("here you go 🐱") or absent.

It must NOT:
- Only describe a cat or say "I can't send images / go to the web app".
- Paste a raw URL as the entire visible text with no media actually sent.
- Emit reasoning about how it searched for the GIF.
