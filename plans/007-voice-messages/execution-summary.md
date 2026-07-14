# 007 execution summary — voice messages (ElevenLabs)

Executed 2026-07-14. Luna receives and sends WhatsApp voice notes.
Gateway + plugin v0.12.0 shipped together.

## What was built

### Inbound — voice note → text (STT)
- `gateway/src/voice.js`: `transcribeAudio` → ElevenLabs `/v1/speech-to-text`
  (Scribe, `ELEVENLABS_STT_MODEL`, default `scribe_v1`; auto language
  detection covers Hebrew).
- `session.js handleMessage`: inbound `kind:"audio"` + voice enabled →
  `downloadMediaMessage` → transcript becomes the `body` in both the capture
  row and the inbound envelope, with `transcribed: true`. Any failure (or
  audio > `WA_STT_MAX_SECONDS`, default 600) degrades to the pre-007 empty
  body — never blocks the message.
- Plugin needs no inbound change: the transcript reads as text.

### Outbound — text → voice note (TTS)
- `voice.js synthesizeVoice` → ElevenLabs `/v1/text-to-speech/{voice}` with
  `output_format=opus_48000_64` — Ogg Opus, WhatsApp's native voice-note
  codec, sent as `ptt: true` with zero transcoding (no ffmpeg).
- New HMAC endpoint `POST /send-voice {chat_jid, text, voice_id?, reply_to?}`
  → outbox kind `voice`. Full 006 pacing/budget/breaker discipline applies;
  synthesis happens at DELIVERY time in `deliverOutboxRow`, so canceling a
  queued voice send never spends ElevenLabs credits.
- Plugin: `wa_send_voice` tool (skill `whatsapp`, 16 tools) + client
  `send_voice`; queued sends annotated "Do NOT re-send"; skill body teaches
  when to speak vs type.

### Feature flag
Entirely dormant without `ELEVENLABS_API_KEY`: inbound keeps the old empty
audio body, `/send-voice` answers 503 `{code:"voice_disabled"}`, `/health`
reports `voice: false`.

## Env (gateway)
| var | default | meaning |
|---|---|---|
| `ELEVENLABS_API_KEY` | — | master switch |
| `ELEVENLABS_VOICE_ID` | — | Luna's voice (required to send; pick in the ElevenLabs voice library) |
| `ELEVENLABS_TTS_MODEL` | `eleven_flash_v2_5` | supports Hebrew, cheap/fast |
| `ELEVENLABS_STT_MODEL` | `scribe_v1` | `scribe_v2` also valid |
| `ELEVENLABS_TTS_FORMAT` | `opus_48000_64` | Ogg Opus @48kHz |
| `ELEVENLABS_TIMEOUT_MS` | `60000` | per API call |
| `WA_STT_MAX_SECONDS` | `600` | skip STT on longer audio |

## Tests
Gateway 80 (`node --test`), plugin 116 (pytest) — all passing. Voice client
tested with injected fetch (multipart shape, opus URL, error surfacing,
voice_id override/requirement); tool tested for sync/queued/disabled paths.

## Watch items
- STT cost ~$0.40/audio-hour, TTS ~1 credit/char on flash — fine at chat
  volume; `WA_STT_MAX_SECONDS` caps the worst case.
- `transcribed` flag rides the envelope but the plugin doesn't yet render
  "(voice)" in context blocks — cosmetic, add if confusion shows up.
- Voice notes sent as replies (`reply_to`) quote correctly; groups work like
  DMs (same send path).
