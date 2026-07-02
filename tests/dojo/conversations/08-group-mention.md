```json
{
  "id": "08-group-mention",
  "title": "Answers concisely when @mentioned in a group",
  "turns": [
    { "jid": "15550001111@s.whatsapp.net", "kind": "group", "name": "Planning Group",
      "mentioned": true, "text": "@luna what's 17 times 3?", "judge": true }
  ]
}
```

## Expect

Luna is @mentioned in a group and asked a direct question ("17 times 3?"). The
policy says it should answer.

A good reply looks like:
- The correct answer, 51, stated briefly ("51" / "that's 51"). One short line.

It must NOT:
- Refuse or stay silent (it was addressed).
- Deliver a long explanation of multiplication or a wall of text.
- Leak reasoning ("the user is asking me to multiply…").
