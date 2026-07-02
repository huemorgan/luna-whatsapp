# Dojo conversation test results

_Run: 2026-07-02 15:11 · judge: claude-sonnet-4-6 · real bridge → running Luna._

| # | Scenario | Verdict |
|---|----------|---------|
| 01 | Casual DM greeting stays casual | ✅ pass |
| 02 | Replies in the user's language (Hebrew) | 🟡 partial |
| 03 | No internal reasoning leaks into the reply | ✅ pass |
| 04 | Uses web search instead of deferring to the web app | ✅ pass |
| 05 | Delivers an image/GIF as native media, not a pasted URL | ✅ pass |
| 06 | Recalls something said in a different chat (headline feature) | ✅ pass |
| 07 | Stays silent in a group when not addressed | ✅ pass |
| 08 | Answers concisely when @mentioned in a group | ✅ pass |
| 09 | Empty / non-text message doesn't trigger a meta reply | ✅ pass |

## 01-dm-greeting — Casual DM greeting stays casual

**Verdict: ✅ pass**

**User sent:** yo

**Luna replied:**

```
yo! what's up?
```

**Matched:** Short friendly casual reply; Sounds like a person texting; No markdown, no capability listing, no meta-reasoning

**Missed:** —

**Judge notes:** Perfect match: 'yo! what's up?' is exactly the kind of brief, human response the rubric calls for.

---

## 02-hebrew-mirroring — Replies in the user's language (Hebrew)

**Verdict: 🟡 partial**

**User sent:** מה כדאי לעשות בשדה בוקר עם ילדים ליום אחד?

**Luna replied:**

```
כבר שלחתי לך את זה כמה פעמים 😄 אבל הנה בקצרה:

1. קבר בן גוריון -- תצפית על נחל צין
2. חוות האלפקות -- להאכיל ולגעת בחיות
3. עין עבדת -- מסלול מים קצר (לבדוק שיש מים)
4. טיול ג'יפים קצר למשפחות
5. טרקטורונים בגן עדן במדבר

כמה בני הילדים? אדייק לך יותר
```

**Matched:** Written in Hebrew; Short practical list with concrete ideas (Ben-Gurion tomb, Ein Avdat, alpaca farm); Chat-length, conversational tone

**Missed:** Opening line 'כבר שלחתי לך את זה כמה פעמים' is fabricated meta-commentary — there is no prior conversation, so this is false and misleading

**Judge notes:** The content and format are solid, but the opening sentence falsely claims to have sent this information multiple times before, which is fabricated context that never happened — a form of hallucinated meta-narration.

---

## 03-no-reasoning-leak — No internal reasoning leaks into the reply

**Verdict: ✅ pass**

**User sent:** ok cool thanks

**Luna replied:**

```
בכיף, תהנו! 🏜️
```

**Matched:** tiny natural closer; no meta narration or chain-of-thought; no restating or new topic

**Missed:** —

**Judge notes:** Short, friendly sign-off with an emoji — perfectly natural as a WhatsApp closing reply.

---

## 04-web-search — Uses web search instead of deferring to the web app

**Verdict: ✅ pass**

**User sent:** what's one big AI news headline from this week? just one line with the source

**Luna replied:**

```
"Nvidia will take a cut of some customers' cloud revenues in exchange for helping them buy its AI chips" -- The Information
```

**Matched:** Concrete specific headline provided; Source name included; Single line format as requested; No capability-punting or refusal

**Missed:** —

**Judge notes:** Luna delivered a specific, plausible, current-sounding headline with a named source in exactly the format requested, without any hedging or capability disclaimers.

---

## 05-media-gif — Delivers an image/GIF as native media, not a pasted URL

**Verdict: ✅ pass**

**User sent:** send me a cute cat gif

**Luna replied:**

```
here you go 🐱
```

- media: `image` → https://media.giphy.com/media/XcFOsVuOTdPKVAxDMr/giphy.gif

**Matched:** Media item delivered as image/gif; Accompanying text is short and appropriate ('here you go 🐱')

**Missed:** —

**Judge notes:** Luna delivered a cat GIF via a direct Giphy URL with a brief, friendly caption — fully satisfies the rubric.

---

## 06-cross-chat-recall — Recalls something said in a different chat (headline feature)

**Verdict: ✅ pass**

**User sent:** when am i traveling again? i forgot

**Luna replied:**

```
you're flying to Berlin next Tuesday for the offsite, back Friday ✈️
```

**Matched:** Mentions Berlin; States next Tuesday departure; States back Friday; Short and natural tone; Uses travel emoji appropriately

**Missed:** —

**Judge notes:** Luna perfectly demonstrated cross-chat memory recall, surfacing the Berlin trip details concisely without any meta-commentary or capability caveats.

---

## 07-group-silence — Stays silent in a group when not addressed

**Verdict: ✅ pass**

**User sent:** lol did you see that goal last night, insane

**Luna replied:**

```
(no reply — stayed silent)
```

**Matched:** Luna stayed silent as required by the activation policy when not mentioned

**Missed:** —

**Judge notes:** Luna correctly did not butt into group banter where it was neither mentioned nor directly addressed.

---

## 08-group-mention — Answers concisely when @mentioned in a group

**Verdict: ✅ pass**

**User sent:** @luna what's 17 times 3?

**Luna replied:**

```
51
```

**Matched:** Correct answer 51 stated concisely in one word

**Missed:** —

**Judge notes:** Perfect minimal response — correct answer, no unnecessary elaboration, no leaked reasoning.

---

## 09-empty-message — Empty / non-text message doesn't trigger a meta reply

**Verdict: ✅ pass**

**User sent:** _(empty message)_

**Luna replied:**

```
(no reply — stayed silent)
```

**Matched:** No reply at all (staying silent on an empty/non-text event)

**Missed:** —

**Judge notes:** Luna stayed silent, which is explicitly listed as a good outcome for empty/non-text events.

---
