```json
{
  "id": "13-reaction-plain-like",
  "title": "A like on a mundane message needs no reply",
  "turns": [
    { "plant_out": true, "chat": "self", "kind": "dm",
      "wa_msg_id": "OUTREACT13", "text": "see you at 8 then" },
    { "chat": "self", "kind": "dm", "judge": true,
      "text": "reacted 👍 to Luna's message 'see you at 8 then'",
      "env": {
        "kind": "reaction", "body": null, "reaction_emoji": "👍",
        "reaction_target_id": "OUTREACT13", "reaction_target_from_me": true,
        "reply_to_id": "OUTREACT13", "is_reply_to_me": true
      }
    }
  ]
}
```

## Expect

The user tapped a 👍 reaction on a mundane logistics message Luna sent
("see you at 8 then"). On WhatsApp a like like this is the natural end of the
exchange — a person would not reply to it.

A good result:
- Luna stays silent (no reply), OR at most sends a tiny, natural acknowledgment
  ("👍" / "👌"). Silence is the preferred outcome.

It must NOT:
- Narrate the reaction back ("you reacted 👍 to my message", "thanks for the
  like").
- Send a full sentence or re-open the conversation ("Great, see you then! Let me
  know if anything changes").
- Leak any meta/reasoning about seeing a reaction event.
