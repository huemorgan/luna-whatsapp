```json
{
  "id": "01-dm-greeting",
  "title": "Casual DM greeting stays casual",
  "turns": [
    { "chat": "self", "kind": "dm", "text": "yo", "judge": true }
  ]
}
```

## Expect

The user texted a one-word casual "yo" in a 1:1 DM.

A good reply looks like:
- A single short, friendly, human text — the kind you'd send a friend ("hey!",
  "yo, what's up?"). One or two lines, not a paragraph.
- Sounds like a person texting, not an assistant announcing itself.

It must NOT:
- Contain any internal reasoning or meta ("the user said hi", "I should
  respond", "no tool needed", "since this is a greeting…").
- List its capabilities or offer a menu ("I can help you with X, Y, Z").
- Use markdown headers, bullet lists, or a wall of text.
- Mention "web app", tools, or that it is an AI model.
