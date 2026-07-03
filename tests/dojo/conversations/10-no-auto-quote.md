```json
{
  "id": "10-no-auto-quote",
  "title": "Normal DM reply is not a quote-reply",
  "turns": [
    { "chat": "self", "kind": "dm", "text": "what's the capital of Portugal?", "judge": true }
  ]
}
```

## Expect

A plain question in a 1:1 DM. On WhatsApp, people just send the next message —
they don't "reply/quote" every line. Reflexive quoting is what makes Luna feel
like a bot.

A good result:
- The answer is correct and short ("Lisbon").
- **The reply is NOT sent as a quote-reply** — check the "Reply was sent as a
  WhatsApp quote-reply" flag: it must be **False**.

It is a FAIL if:
- The reply quotes the user's message (quote-reply flag True) in this normal 1:1
  exchange.
- The answer is wrong, or padded into a paragraph, or leaks reasoning.
