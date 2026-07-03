```json
{
  "id": "14-reaction-on-good-news",
  "title": "Luna sees a ❤️ on good news she delivered",
  "turns": [
    { "plant_out": true, "chat": "self", "kind": "dm",
      "wa_msg_id": "OUTREACT14",
      "text": "done — your flight to Berlin is booked for Friday 09:40 ✈️" },
    { "chat": "self", "kind": "dm", "judge": true,
      "text": "reacted ❤️ to Luna's message about booking the Berlin flight",
      "env": {
        "kind": "reaction", "body": null, "reaction_emoji": "❤️",
        "reaction_target_id": "OUTREACT14", "reaction_target_from_me": true,
        "reply_to_id": "OUTREACT14", "is_reply_to_me": true
      }
    }
  ]
}
```

## Expect

The user reacted ❤️ to good news Luna delivered (a booked flight). Luna now
knows the user liked that message.

A good result (either is acceptable):
- Luna stays silent (the ❤️ was the whole exchange), OR
- sends ONE short, warm, human line that fits the moment ("😊" / "anytime!" /
  "glad it worked out"). It may reference the flight naturally if it replies.

It must NOT:
- Narrate the mechanic ("I see you reacted ❤️ to my message").
- Send a long paragraph, a checklist, or re-state the whole booking.
- Leak reasoning about reaction events or context.
