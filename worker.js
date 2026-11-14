// Cloudflare Worker: mints short-lived Reactor session tokens so the API key never reaches the browser.
// Setup: Workers & Pages -> Create -> Hello World -> paste this file -> Deploy.
// Then Settings -> Variables and Secrets -> add a Secret named REACTOR_API_KEY with your rk_... key.
const ALLOWED_ORIGINS = ['https://aarensunny.github.io', 'http://localhost:8000'];

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin',
    };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (req.method !== 'POST') return new Response('POST only', { status: 405, headers: cors });
    if (!ALLOWED_ORIGINS.includes(origin)) return new Response('origin not allowed', { status: 403, headers: cors });
    if (!env.REACTOR_API_KEY) return new Response('REACTOR_API_KEY secret is not set', { status: 500, headers: cors });

    const r = await fetch('https://api.reactor.inc/tokens', {
      method: 'POST',
      headers: { 'Reactor-API-Key': env.REACTOR_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        authorization_details: [{ type: 'session', resources: { models: { match: ['reactor/visko-orbis-stable'] } } }],
      }),
    });
    return new Response(await r.text(), { status: r.status, headers: { ...cors, 'Content-Type': 'application/json' } });
  },
};
