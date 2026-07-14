// 007 voice processing — ElevenLabs STT/TTS client with injected fetch, and
// the outbox 'voice' kind delivering TTS output as a ptt voice note.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { voiceEnabled, transcribeAudio, synthesizeVoice } from '../src/voice.js';

const CFG = {
  apiKey: 'k-test',
  voiceId: 'v-default',
  ttsModel: 'eleven_flash_v2_5',
  sttModel: 'scribe_v1',
  ttsFormat: 'opus_48000_64',
  timeoutMs: 5000,
  maxSttSeconds: 600,
};

function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, opts });
    return handler(url, opts);
  };
  impl.calls = calls;
  return impl;
}

test('voiceEnabled follows the api key', () => {
  assert.equal(voiceEnabled(CFG), true);
  assert.equal(voiceEnabled({ ...CFG, apiKey: '' }), false);
  assert.equal(voiceEnabled(undefined), false);
});

test('transcribeAudio posts multipart to /v1/speech-to-text and returns trimmed text', async () => {
  const f = fakeFetch(async () => ({
    ok: true,
    json: async () => ({ text: '  hello from a voice note  ' }),
  }));
  const out = await transcribeAudio(Buffer.from('ogg-bytes'), {
    mimetype: 'audio/ogg; codecs=opus', fetchImpl: f, cfg: CFG,
  });
  assert.equal(out, 'hello from a voice note');
  const { url, opts } = f.calls[0];
  assert.match(url, /\/v1\/speech-to-text$/);
  assert.equal(opts.headers['xi-api-key'], 'k-test');
  assert.ok(opts.body instanceof FormData);
  assert.equal(opts.body.get('model_id'), 'scribe_v1');
});

test('transcribeAudio surfaces API errors with status and body excerpt', async () => {
  const f = fakeFetch(async () => ({
    ok: false, status: 401, text: async () => 'bad key',
  }));
  await assert.rejects(
    transcribeAudio(Buffer.from('x'), { fetchImpl: f, cfg: CFG }),
    /stt 401: bad key/,
  );
});

test('synthesizeVoice hits the voice endpoint with the opus format and returns ogg bytes', async () => {
  const f = fakeFetch(async () => ({
    ok: true,
    arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer,
  }));
  const { buffer, mimetype } = await synthesizeVoice('shalom', { fetchImpl: f, cfg: CFG });
  assert.deepEqual([...buffer], [1, 2, 3]);
  assert.equal(mimetype, 'audio/ogg; codecs=opus');
  const { url, opts } = f.calls[0];
  assert.match(url, /\/v1\/text-to-speech\/v-default\?output_format=opus_48000_64$/);
  const body = JSON.parse(opts.body);
  assert.equal(body.text, 'shalom');
  assert.equal(body.model_id, 'eleven_flash_v2_5');
});

test('synthesizeVoice: explicit voice_id overrides the default', async () => {
  const f = fakeFetch(async () => ({
    ok: true, arrayBuffer: async () => new ArrayBuffer(0),
  }));
  await synthesizeVoice('hi', { voiceId: 'v-custom', fetchImpl: f, cfg: CFG });
  assert.match(f.calls[0].url, /text-to-speech\/v-custom\?/);
});

test('synthesizeVoice refuses without any voice id (status 400)', async () => {
  await assert.rejects(
    synthesizeVoice('hi', { fetchImpl: fakeFetch(async () => ({})), cfg: { ...CFG, voiceId: '' } }),
    (e) => e.status === 400 && /voice/i.test(e.message),
  );
});
