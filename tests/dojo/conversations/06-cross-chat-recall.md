```json
{
  "id": "06-cross-chat-recall",
  "title": "Recalls something said in a different chat (headline feature)",
  "turns": [
    { "chat": "work_group", "kind": "group", "name": "Monday Offsite", "plant": true,
      "text": "Roy: heads up team, I'm flying to Berlin next Tuesday for the offsite, back Friday" },
    { "chat": "self", "kind": "dm", "text": "when am i traveling again? i forgot", "judge": true }
  ]
}
```

## Expect

Earlier, in a *group* chat, the owner said he's flying to Berlin next Tuesday
(back Friday). Now, in a *separate 1:1 DM*, he asks Luna to remind him of his
travel. Cross-chat memory is the headline feature.

A good reply looks like:
- Recalls the Berlin trip: mentions Berlin, and "next Tuesday" (and ideally
  "back Friday"). Short and natural.

It must NOT:
- Say it has no idea / no record / "you didn't tell me".
- Claim it can't see other chats or ask the user to repeat it.
- Dump the raw context block or expose reasoning.
