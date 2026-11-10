/*
  AudioTag — song recognition proxy worker (Cloudflare Workers)

  How it works
  ------------
  The website sends the recorded/uploaded audio here. This worker:

    1. First tries AudD with YOUR token kept as the Cloudflare secret AUDD_TOKEN
       (in case you ever subscribe to a paid plan — nothing to change, it just works).
    2. If AudD rejects the request (inactive/no subscription/no quota), it falls back
       to SHAZAM through RapidAPI, using YOUR own free key from rapidapi.com kept as
       the Cloudflare secret RAPIDAPI_KEY. That free tier is generous and anonymous
       "light use" is no longer supported by AudD.
    3. Shazam's answer is converted into exactly the same JSON shape AudD returns
       ({status, result:{title, artist, album, release_date, song_link}}), so the
       website's script.js works unchanged with either engine.

  Cloudflare secrets (Worker → Settings → Variables and Secrets):
    AUDD_TOKEN   optional — your dashboard.audd.io token (used if it becomes active)
    RAPIDAPI_KEY REQUIRED for Shazam — your free key from rapidapi.com
    RAPIDAPI_HOST   optional — override the Shazam API host (see provider list below)
    RAPIDAPI_PATH   optional — override the recognize endpoint path
    RAPIDAPI_BODY   optional — 'multipart' (default) or 'raw' for unusual providers

  Never put any key in this file or in the website code.
*/

export default {
  async fetch(request, env) {
    // Allow the website's browsers to send files to us from any origin
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': '*',
        },
      });
    }
    if (request.method !== 'POST') {
      return new Response('POST audio files to this URL', { status: 405 });
    }
    try {
      if (!request.headers.get('content-type') || !/multipart/i.test(request.headers.get('content-type'))) {
        return json({ error: { error_message: 'Send the audio as multipart/form-data (file field).' } }, 400);
      }
      const fd = await request.formData(); // body can be read only once, keep it
      const file = fd.get('file'); // the audio blob, reused for the fallback engine

      let audError = null;

      /* --- Engine 1: AudD (only if a token secret exists) --- */
      if (env && env.AUDD_TOKEN) {
        fd.append('api_token', env.AUDD_TOKEN);
        try {
          const res = await fetch('https://api.audd.io/', { method: 'POST', body: fd });
          const text = await res.text();
          const data = parseJson(text);
          if (data && data.status !== 'error' && data.result) {
            return audResponse(text, res.status, 'audd');
          }
          if (data && data.error) audError = cleanAudError(data);
        } catch (e) { audError = { error_message: 'AudD request failed: ' + e.message }; }
      }

      /* --- Engine 2: Shazam via RapidAPI (free tier) --- */
      if (env && env.RAPIDAPI_KEY && file) {
        const providers = shazamProviders(env);
        const bytes = await file.arrayBuffer();
        const lastErr = { message: '' };
        const tried = []; // safe diagnostics: host + status + short reply (never the key)

        for (const p of providers) {
          let res;
          try {
            res = await fetch('https://' + p.host + p.path, {
              method: 'POST',
              headers: {
                'X-RapidAPI-Key': env.RAPIDAPI_KEY,
                'X-RapidAPI-Host': p.host,
                'Content-Type': p.type === 'raw' ? file.type || 'application/octet-stream' : undefined,
              },
              body: p.type === 'raw' ? bytes : multipartForShazam(file, bytes),
            });
          } catch (e) {
            tried.push({ host: p.host, error: e.message });
            lastErr.message = p.host + ': ' + e.message;
            continue;
          }

          const text = await res.text();
          tried.push({ host: p.host, status: res.status, reply: text.slice(0, 160) });
          const data = parseJson(text);

          // RapidAPI answers 403 when the key is NOT subscribed to this particular API
          if (res.status === 403 || /not subscribed|Invalid API key/i.test(text)) {
            lastErr.message = p.host + ': ' + (data && data.message ? data.message : 'not subscribed to this API');
            continue; // try the next Shazam provider
          }

          const result = shazamToAudd(data);
          if (result) {
            return audResponse(JSON.stringify(result), 200, 'shazam');
          }
          // Reached the provider, but nothing recognized (or an unexpected body)
          if (res.status === 200 || (data && (data.message || data.error || data.detail))) {
            lastErr.message = p.host + ': ' + (res.status === 200 ? 'no match' : ('HTTP ' + res.status));
            continue;
          }
          lastErr.message = p.host + ': HTTP ' + res.status;
        }

        // Key exists but every Shazam provider failed/unsubscribed/no match
        const noMatch = providers.some((p) => /no match/.test(lastErr.message));
        return json({
          status: 'error',
          error: { error_message: noMatch
            ? 'No song match found. Try a clearer or longer clip.'
            : 'Shazam engine unavailable (' + (lastErr.message || 'check RAPIDAPI_KEY') + ')' },
          diagnostics: tried,
        }, 200);
      }

      /* --- Nothing to fall back to: report the AudD error, if any --- */
      return json(audError || {
        error: { error_message: 'No recognition engine configured. Add RAPIDAPI_KEY (and see README) as a Cloudflare secret.' },
      }, 200);
    } catch (err) {
      return json({ error: { error_message: 'Proxy error: ' + (err && err.message) } }, 502);
    }
  },
};

/* ---------- Helpers ---------- */

function shazamProviders(env) {
  // Custom override first (secrets RAPIDAPI_HOST / RAPIDAPI_PATH / RAPIDAPI_BODY)
  const list = [];
  if (env.RAPIDAPI_HOST) {
    list.push({
      host: env.RAPIDAPI_HOST.toLowerCase(),
      path: env.RAPIDAPI_PATH || '/v1/tracks/recognize',
      type: (env.RAPIDAPI_BODY || 'multipart').toLowerCase(),
    });
  }
  // Default free-tier Shazam recognition APIs on RapidAPI.
  // The worker tries each in turn and skips any the key is not subscribed to,
  // so you only need to subscribe to ONE of them in the BASIC (free) plan.
  list.push(
    { host: 'shazam-core.p.rapidapi.com', path: '/v1/tracks/recognize', type: 'multipart' },
    { host: 'shazam-api25.p.rapidapi.com', path: '/tracks/recognize', type: 'multipart' },
    { host: 'shazam-song-recognition-api.p.rapidapi.com', path: '/recognize/file', type: 'raw' },
    { host: 'shazam-api-free.p.rapidapi.com', path: '/shazam/recognize', type: 'multipart' },
  );
  return list;
}

// Wrap the audio in a multipart body like a browser file upload would
function multipartForShazam(file, bytes) {
  const fd = new FormData();
  fd.append('file', new Blob([bytes], { type: file.type || 'audio/webm' }), file.name || 'audio');
  fd.append('upload_file', new Blob([bytes], { type: file.type || 'audio/webm' }), file.name || 'audio');
  return fd;
}

// Convert any of Shazam's response variants into AudD's response shape
function shazamToAudd(data) {
  const t = data && (data.track
    || (data.matches && data.matches[0] && data.matches[0].track)
    || data.result && data.result.track);
  if (!t || !t.title) return null;

  // Sections[].metadata carries Album / Released / Label etc.
  const meta = [];
  (t.sections || []).forEach((s) => (s.metadata || []).forEach((m) => meta.push(m)));
  const find = (name) => {
    const m = meta.find((m) => String(m.title || '').toLowerCase().startsWith(name));
    return m ? String(m.text || '') : '';
  };

  let artist = String(t.subtitle || '');
  artist = artist.split(/\s[—–-]\s/)[0].trim(); // "Artist — Title" → keep the artist

  const album = find('album');
  const released = find('released') || find('releasedate');
  const releaseDate = released
    ? (/^\d{4}$/.test(released) ? released + '-01-01' : released.slice(0, 10))
    : '';

  const cover = t.images && (t.images.coverarthq || t.images.coverart);

  return {
    status: 'success',
    result: {
      title: t.title,
      artist: artist,
      album: album,
      release_date: releaseDate,
      song_link: (t.hub && t.hub.options && t.hub.options.length && t.hub.options[0].external_url)
        || (t.share && t.share.href)
        || t.url
        || '',
      // Reused by the website for instant cover art (map to AudD's apple_music shape)
      apple_music: cover ? { artwork: { url: cover } } : undefined,
    },
  };
}

function cleanAudError(data) {
  return {
    error: {
      error_message: String((data.error && data.error.error_message) || 'AudD request failed.'),
      error_code: data.error && data.error.error_code,
    },
  };
}

function audResponse(text, status, engine) {
  let out = text;
  if (engine === 'shazam') { /* already the right shape */ }
  return new Response(out, {
    status,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'application/json',
      'X-Engine': engine,
    },
  });
}

function parseJson(text) {
  try { return JSON.parse(text); } catch (_) { return null; }
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
  });
}
