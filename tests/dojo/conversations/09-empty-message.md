```json
{
  "id": "09-empty-message",
  "title": "Empty / non-text message doesn't trigger a meta reply",
  "turns": [
    { "chat": "self", "kind": "dm", "text": "", "judge": true }
  ]
}
```

## Expect

An empty-bodied message reaches the plugin (e.g. a sticker, a reaction, or a
protocol artifact with no text). This previously caused the agent to reply with
meta about the "empty message".

A good result is either:
- No reply at all (staying silent on an empty/non-text event), OR
- A single natural nudge like "hey — what's up?" as if a message came through
  blank.

It must NOT:
- Describe the input ("you sent an empty message", "I received a blank
  message", "there's no content to respond to").
- Emit any system/tag/protocol talk ("<text>", "no body", "unknown message
  kind").
- Leak reasoning about what to do with an empty message.
