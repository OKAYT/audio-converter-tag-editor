/*
  AudioTag — AudD proxy worker (Cloudflare Workers)

  What it does
  ------------
  The website sends the recorded/uploaded audio here; this worker adds YOUR
  AudD API token (stored as a secret on Cloudflare, never visible in the
  website or in public code) and forwards the request to api.audd.io.

  How to install (5 minutes, free)
  -------------------------------
  1. Get a free AudD API token:
     a. Go to https://dashboard.audd.io and sign up (free).
     b. Confirm your email.
     c. In the dashboard, copy your API token.

  2. Publish this worker:
     a. Go to https://dash.cloudflare.com and sign in (create a free account if needed).
     b. Click "Workers & Pages" -> "Create application" -> "Create Worker".
     c. Give it any name (for example "audiodetector-proxy") and click "Deploy"
        (the default hello-world code is fine for now).
     d. Click "Edit code", delete everything, paste the ENTIRE code below,
        then click "Deploy".
     e. Back on the worker page: Settings -> Variables and Secrets -> "Add".
        - Type:   Secret
        - Name:   AUDD_TOKEN
        - Value:  paste your AudD token
        Click "Deploy" again to save.

  3. Connect your website:
     a. Open script.js
     b. Find the line:  const AUDD_PROXY = '';
     c. Put your worker URL between the quotes, for example:
           const AUDD_PROXY = 'https://audiodetector-proxy.yourname.workers.dev';
     d. Done. Your site now has ~100,000 recognitions per day and no visible token.

  Cloudflare free plan limits: 100,000 requests/day, 10,000 requests/hour.
*/

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
        },
      });
    }
    if (request.method !== 'POST') {
      return new Response('POST audio files to this URL', { status: 405 });
    }
    try {
      if (!env || !env.AUDD_TOKEN) {
        return json({ error: { error_message: 'Proxy not configured: missing AUDD_TOKEN secret.' } }, 500);
      }
      const fd = await request.formData();
      fd.append('api_token', env.AUDD_TOKEN);
      const res = await fetch('https://api.audd.io/', { method: 'POST', body: fd });
      const text = await res.text();
      return new Response(text, {
        status: res.status,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Content-Type': res.headers.get('content-type') || 'application/json',
        },
      });
    } catch (err) {
      return json({ error: { error_message: 'Proxy error: ' + (err && err.message) } }, 502);
    }
  },
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
  });
}
