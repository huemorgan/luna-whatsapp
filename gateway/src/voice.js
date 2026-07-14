// ElevenLabs voice processing (007): inbound voice notes → text (Scribe STT),
// outbound text → voice notes (TTS as Ogg Opus — WhatsApp's native ptt format,
// so no transcoding step). The whole feature is dormant unless
// ELEVENLABS_API_KEY is set; every caller must check voiceEnabled() first.
//
// fetchImpl is injectable so the unit tests never touch the network.

import { config } from './config.js';

const API_BASE = 'https://api.elevenlabs.io';

export function voiceEnabled(cfg = config.eleven) {
  return !!cfg?.apiKey;
}

// Voice note bytes → transcript text. Returns '' when ElevenLabs hears nothing.
export async function transcribeAudio(buf, {
  mimetype = 'audio/ogg',
  language,
  fetchImpl = fetch,
  cfg = config.eleven,
} = {}) {
  const form = new FormData();
  form.append('file', new Blob([buf], { type: mimetype }), 'voice.ogg');
  form.append('model_id', cfg.sttModel);
  form.append('tag_audio_events', 'false');
  if (language) form.append('language_code', language);
  const r = await fetchImpl(`${API_BASE}/v1/speech-to-text`, {
    method: 'POST',
    headers: { 'xi-api-key': cfg.apiKey },
    body: form,
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });
  if (!r.ok) {
    throw new Error(`elevenlabs stt ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
  const data = await r.json();
  return (data.text || '').trim();
}

// Text → Ogg Opus voice-note bytes.
export async function synthesizeVoice(text, {
  voiceId,
  fetchImpl = fetch,
  cfg = config.eleven,
} = {}) {
  const vid = voiceId || cfg.voiceId;
  if (!vid) {
    throw Object.assign(
      new Error('no ElevenLabs voice configured — set ELEVENLABS_VOICE_ID or pass voice_id'),
      { status: 400 },
    );
  }
  const r = await fetchImpl(
    `${API_BASE}/v1/text-to-speech/${encodeURIComponent(vid)}?output_format=${cfg.ttsFormat}`,
    {
      method: 'POST',
      headers: { 'xi-api-key': cfg.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ text, model_id: cfg.ttsModel }),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    },
  );
  if (!r.ok) {
    throw new Error(`elevenlabs tts ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
  return {
    buffer: Buffer.from(await r.arrayBuffer()),
    mimetype: 'audio/ogg; codecs=opus',
  };
}
