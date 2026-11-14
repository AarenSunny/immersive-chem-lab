// Cloudflare Worker for Impossible Labs.
//   POST /          -> short-lived Reactor (Visko Orbis) session token. The API key never reaches the browser.
//   POST /assist    -> voice lab assistant: { audio: base64 WAV | text, context, history } -> { heard, reply }
//   POST /tts       -> { text } -> audio/mpeg (spoken reply)
// Setup: Settings -> Variables and Secrets -> Secret REACTOR_API_KEY (rk_...)
//        Settings -> Bindings -> Add -> Workers AI, variable name: AI
const ALLOWED_ORIGINS = ['https://aarensunny.github.io', 'http://localhost:8000'];

const STT_MODEL = '@cf/openai/whisper-large-v3-turbo';
const LLM_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const TTS_MODEL = '@cf/deepgram/aura-2-en';
const TTS_FALLBACK = '@cf/myshell-ai/melotts';

const SYSTEM = `You are Nova, the friendly lab assistant inside Impossible Labs, a mixed-reality training app on a Meta Quest headset.
Students practise things that are too dangerous, expensive, big or small to try for real: a chemistry lab, an electronics workbench and a factory lockout/tagout station, plus spaces teachers create.
The student is talking to you by voice and your answer is read aloud, so:
- Answer in one to three short spoken sentences. No lists, markdown, emojis or symbols like arrows; say chemical formulas as words.
- Use the LIVE LAB STATE to give specific, practical guidance about what they should try or what just happened, and explain the science or the safety reason in plain words.
- Mention real-world safety when relevant (for example: 30 percent peroxide burns skin; never reach into a press that is not locked out).
- If you do not know something about the lab, say so instead of inventing it. Answer unrelated questions briefly.`;

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin',
    };
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (req.method !== 'POST') return new Response('POST only', { status: 405, headers: cors });
    if (!ALLOWED_ORIGINS.includes(origin)) return new Response('origin not allowed', { status: 403, headers: cors });

    const path = new URL(req.url).pathname.replace(/\/+$/, '') || '/';

    // ---------- Orbis token ----------
    if (path === '/') {
      if (!env.REACTOR_API_KEY) return new Response('REACTOR_API_KEY secret is not set', { status: 500, headers: cors });
      const r = await fetch('https://api.reactor.inc/tokens', {
        method: 'POST',
        headers: { 'Reactor-API-Key': env.REACTOR_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          authorization_details: [{ type: 'session', resources: { models: { match: ['reactor/visko-orbis-stable'] } } }],
        }),
      });
      return new Response(await r.text(), { status: r.status, headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    if (!env.AI) return json({ error: 'Workers AI binding "AI" is not set (Settings -> Bindings -> Workers AI)' }, 500);

    // ---------- voice assistant ----------
    if (path === '/assist') {
      let body;
      try { body = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
      let heard = String(body.text || '').slice(0, 500).trim();
      try {
        if (!heard && body.audio) {
          if (body.audio.length > 3_000_000) return json({ error: 'audio too long' }, 413);
          const stt = await env.AI.run(STT_MODEL, { audio: body.audio, language: 'en', vad_filter: true });
          heard = String(stt.text ?? stt.transcription_info?.text ?? '').trim();
        }
        if (!heard) return json({ heard: '', reply: "Sorry, I didn't catch that. Poke the orange button and try again." });

        const history = Array.isArray(body.history) ? body.history.slice(-6) : [];
        const messages = [
          { role: 'system', content: SYSTEM + '\n\nLIVE LAB STATE:\n' + String(body.context || 'unknown').slice(0, 2500) },
          ...history.filter(m => m && (m.role === 'user' || m.role === 'assistant')).map(m => ({ role: m.role, content: String(m.content).slice(0, 600) })),
          { role: 'user', content: heard },
        ];
        const out = await env.AI.run(LLM_MODEL, { messages, max_tokens: 180, temperature: 0.5 });
        const reply = String(out.response ?? out.result?.response ?? '').trim() || "I'm not sure. Try asking that another way.";
        return json({ heard, reply });
      } catch (e) {
        return json({ error: 'assistant failed: ' + (e && e.message || e) }, 502);
      }
    }

    // ---------- text to speech ----------
    if (path === '/tts') {
      let body;
      try { body = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
      const text = String(body.text || '').slice(0, 800).trim();
      if (!text) return json({ error: 'no text' }, 400);
      try {
        const audio = await env.AI.run(TTS_MODEL, { text, speaker: 'asteria', encoding: 'mp3' }, { returnRawResponse: true });
        if (audio instanceof Response) return new Response(audio.body, { headers: { ...cors, 'Content-Type': 'audio/mpeg' } });
        if (audio && typeof audio.getReader === 'function') return new Response(audio, { headers: { ...cors, 'Content-Type': 'audio/mpeg' } });
        throw new Error('unexpected TTS output');
      } catch (e) {
        try {   // fallback voice
          const m = await env.AI.run(TTS_FALLBACK, { prompt: text, lang: 'en' });
          const bin = Uint8Array.from(atob(m.audio), c => c.charCodeAt(0));
          return new Response(bin, { headers: { ...cors, 'Content-Type': 'audio/mpeg' } });
        } catch (e2) {
          return json({ error: 'tts failed: ' + (e2 && e2.message || e2) }, 502);
        }
      }
    }

    return json({ error: 'not found' }, 404);
  },
};
