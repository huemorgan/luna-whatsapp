```json
{
  "id": "04-web-search",
  "title": "Uses web search instead of deferring to the web app",
  "turns": [
    { "chat": "self", "kind": "dm", "text": "what's one big AI news headline from this week? just one line with the source", "judge": true }
  ]
}
```

## Expect

The user asked for a current AI news headline — this requires live web access.

A good reply looks like:
- One concrete, specific headline that reads like real recent news, with a
  source name or link (e.g. "OpenAI …" — The Verge). One line, as asked.
- Evidence the agent actually looked it up (specific, current-sounding, not a
  vague evergreen statement).

It must NOT:
- Say "I can't browse the web", "check the web app", "I don't have real-time
  access", or otherwise punt the capability elsewhere.
- Refuse or give a generic non-answer ("there's a lot happening in AI").
- Dump internal reasoning or a description of the search it ran.
