```json
{
  "id": "02-hebrew-mirroring",
  "title": "Replies in the user's language (Hebrew)",
  "turns": [
    { "chat": "self", "kind": "dm", "text": "מה כדאי לעשות בשדה בוקר עם ילדים ליום אחד?", "judge": true }
  ]
}
```

## Expect

The user asked, in Hebrew, "what's worth doing in Sde Boker with kids for one
day?"

A good reply looks like:
- Written in Hebrew (mirror the user's language). Not English.
- A short, practical answer — a few concrete ideas (e.g. Ben-Gurion's tomb /
  the Zin lookout, Ein Avdat, the alpaca farm), phrased conversationally.
- Chat-length: a few lines or a short list, not an essay.

It must NOT:
- Answer in English when the user wrote Hebrew.
- Leak internal reasoning or meta commentary.
- Refuse or say it can't help with local knowledge.
