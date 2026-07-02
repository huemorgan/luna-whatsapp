```json
{
  "id": "07-group-silence",
  "title": "Stays silent in a group when not addressed",
  "turns": [
    { "chat": "banter_group", "kind": "group", "name": "Football Chat", "mentioned": false,
      "text": "lol did you see that goal last night, insane", "judge": true }
  ]
}
```

## Expect

A message lands in a group where Luna is a member but is NOT mentioned and the
message is not a reply to Luna. Per the activation policy, Luna should not butt
in.

A good result is:
- No reply at all (the runner records this as "(no reply — stayed silent)").

It is a FAIL if:
- Luna answers the group banter unprompted.
