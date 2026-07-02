```json
{
  "id": "03-no-reasoning-leak",
  "title": "No internal reasoning leaks into the reply",
  "turns": [
    { "chat": "self", "kind": "dm", "text": "ok cool thanks", "judge": true }
  ]
}
```

## Expect

The user sent a small closing acknowledgement ("ok cool thanks").

A good reply looks like:
- A tiny, natural closer ("👍", "anytime!", "np, ping me if you need more") OR
  nothing at all. Either is fine.

It must NOT (this is the whole point of the test):
- Expose any chain-of-thought or meta narration. Forbidden examples: "The user
  is thanking me", "I should acknowledge", "No further action is needed", "Since
  they said thanks, I'll…", "As an AI…".
- Turn a one-word thanks into a paragraph or a new topic.
- Restate what the user just said back to them.

The reply, if any, should be indistinguishable from how a person texts back a
"thanks".
