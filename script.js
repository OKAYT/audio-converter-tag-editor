/* Audio Converter and Tag Editor — script.js (vanilla JS) */
'use strict';
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const AudioCtx = window.AudioContext || window.webkitAudioContext;
const audioSupported = !!AudioCtx;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const els = { viz: $('#viz'), vizWrap: $('.visualizer'), toasts: $('#toasts'), navToggle: $('#navToggle'), navMobile: $('#navMobile'),
  progress: $('#progress'), progressBar: $('#progressBar') };
const state = { ctx: null, analyser: null, liveData: null, staticWave: null, recording: false,
  blob: null, name: 'recording', fileName: 'recording.webm', mime: '', isMp3: false,
  buffer: null, rec: null, stream: null, objectUrl: null };

/* ============================================================
   2. Toast notifications
   ============================================================ */
function showToast(title, message = '', type = 'success', timeout = 3600) {
  const toast = document.createElement('div');
  toast.className = `toast toast--${type}`;
  toast.innerHTML = `
    <span class="toast__dot" aria-hidden="true"></span>
    <div class="toast__body">
      <strong></strong>
      ${message ? '<span></span>' : ''}
    </div>`;
  toast.querySelector('strong').textContent = title;
  if (message) toast.querySelector('span').textContent = message;
  els.toasts.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('is-out');
    toast.addEventListener('animationend', () => toast.remove(), { once: true });
  }, timeout);
}

/* ============================================================
   3. Navigation (mobile menu)
   ============================================================ */
els.navToggle.addEventListener('click', () => {
  const open = els.navMobile.classList.toggle('is-open');
  els.navToggle.classList.toggle('is-open', open);
  els.navToggle.setAttribute('aria-expanded', String(open));
});
els.navMobile.addEventListener('click', (e) => {
  if (e.target.tagName === 'A') {
    els.navMobile.classList.remove('is-open');
    els.navToggle.classList.remove('is-open');
    els.navToggle.setAttribute('aria-expanded', 'false');
  }
});

/* ============================================================
   4. Scroll reveal (IntersectionObserver)
   ============================================================ */
function initReveal() {
  const items = $$('.reveal');
  if (!('IntersectionObserver' in window)) {
    items.forEach((el) => el.classList.add('is-visible'));
    return;
  }
  const io = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
        io.unobserve(entry.target);
      }
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -60px 0px' });
  items.forEach((el) => io.observe(el));
}

/* ============================================================
   5. Binary "rain" background
   ============================================================ */
function initBinaryRain() {
  const canvas = $('#binaryRain');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const fontSize = 16;
  let columns = 0, drops = [], dpr = 1;

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width  = window.innerWidth  * dpr;
    canvas.height = window.innerHeight * dpr;
    canvas.style.width  = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    columns = Math.ceil(window.innerWidth / fontSize);
    drops = new Array(columns).fill(0).map(() => Math.random() * -window.innerHeight);
  }
  resize();
  window.addEventListener('resize', resize);

  let last = 0;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function frame(ts) {
    // Throttle to ~18fps to stay light
    if (ts - last > 55) {
      last = ts;
      ctx.fillStyle = 'rgba(5, 8, 5, 0.18)';
      ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);
      ctx.font = `${fontSize}px JetBrains Mono, monospace`;
      for (let i = 0; i < columns; i++) {
        const char = Math.random() > 0.5 ? '♪' : '♫';
        const x = i * fontSize;
        const y = drops[i];
        ctx.fillStyle = Math.random() > 0.94 ? 'rgba(198,245,107,0.9)' : 'rgba(25,195,125,0.55)';
        ctx.fillText(char, x, y);
        drops[i] = y > window.innerHeight && Math.random() > 0.975 ? 0 : y + fontSize;
      }
    }
    if (!reduce) requestAnimationFrame(frame);
  }
  if (!reduce) requestAnimationFrame(frame);
}

/* ============================================================
   6. Audio context / visualizer
   ============================================================ */
function ensureCtx() {
  if (!audioSupported) {
    showToast('Audio not supported', 'Your browser lacks the Web Audio API.', 'error');
    return null;
  }
  if (!state.ctx) {
    state.ctx = new AudioCtx();
    state.liveData = new Uint8Array(state.ctx.frequencyBinCount);
  }
  if (state.ctx.state === 'suspended') state.ctx.resume();
  return state.ctx;
}

/* Canvas sizing (crisp on HiDPI) */
function fitCanvas() {
  const canvas = els.viz;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(rect.width, 1);
  const h = Math.max(rect.height, 1);
  canvas.width  = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w, h };
}

/* Continuous render loop for the visualizer */
function startVisualizer() {
  const canvas = els.viz;
  const ctx = canvas.getContext('2d');
  let size = fitCanvas();
  window.addEventListener('resize', () => { size = fitCanvas(); });

  function draw() {
    const { w, h } = size;
    ctx.clearRect(0, 0, w, h);

    let values;
    if (state.analyser) {
      const data = new Uint8Array(state.analyser.frequencyBinCount);
      state.analyser.getByteFrequencyData(data);
      values = data;
    } else if (state.staticWave) {
      // Down-sample the stored waveform into ~64 buckets for a bar look
      const buckets = 64;
      values = new Uint8Array(buckets);
      const step = Math.max(1, Math.floor(state.staticWave.length / buckets));
      for (let i = 0; i < buckets; i++) {
        let peak = 0;
        for (let k = 0; k < step; k++) {
          const s = state.staticWave[i * step + k];
          if (s !== undefined) peak = Math.max(peak, Math.abs(s));
        }
        values[i] = Math.round(peak * 255);
      }
    } else {
      // Idle: gentle sine ripple
      values = new Uint8Array(64);
      const t = performance.now() / 600;
      for (let i = 0; i < 64; i++) values[i] = 12 + Math.sin(t + i * 0.3) * 6 + 6;
    }

    const bars = 64;
    const gap = 3;
    const barW = (w - gap * (bars - 1)) / bars;
    const count = values.length;

    for (let i = 0; i < bars; i++) {
      const v = values[Math.floor((i / bars) * count)] / 255;
      const barH = Math.max(3, v * (h - 24));
      const x = i * (barW + gap);
      const y = h - 12 - barH;

      const grad = ctx.createLinearGradient(0, y, 0, h);
      grad.addColorStop(0, 'rgba(198,245,107,1)');
      grad.addColorStop(1, 'rgba(25,195,125,0.25)');

      ctx.shadowColor = 'rgba(25,195,125,0.7)';
      ctx.shadowBlur = 14;
      ctx.fillStyle = grad;
      const r = Math.min(barW / 2, 4);
      roundRect(ctx, x, y, barW, barH, r);
      ctx.fill();
    }
    ctx.shadowBlur = 0;

    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);
}

/* Rounded rectangle path helper */
function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}


/* ============ Tabs ============ */
$$('.tab').forEach((tab) => tab.addEventListener('click', () => {
  $$('.tab').forEach((t) => { t.classList.remove('is-active'); t.setAttribute('aria-selected', 'false'); });
  tab.classList.add('is-active'); tab.setAttribute('aria-selected', 'true');
  $$('.panel[data-panel]').forEach((p) => p.classList.toggle('is-active', p.dataset.panel === tab.dataset.tab));
  if (tab.dataset.tab !== 'mic' && state.recording) state.rec.stop();
}));

/* ============ Tag fields ============ */
const f = { title: $('#tagTitle'), artist: $('#tagArtist'), writer: $('#tagWriter'), album: $('#tagAlbum'), year: $('#tagYear') };
const getTags = () => ({
  title: f.title.value.trim(), artist: f.artist.value.trim(), writer: f.writer.value.trim(),
  album: f.album.value.trim(), year: f.year.value.trim(),
});
function setTags(t) { for (const k in f) if (t[k]) f[k].value = t[k]; }
function clearTags() { for (const k in f) f[k].value = ''; }
function setProgress(r, vis) { els.progress.hidden = !vis; els.progressBar.style.width = vis ? clamp(r, 0, 1) * 100 + '%' : '0%'; }

/* ============ Match card: album art + direct links to the exact song ============ */
const matchLinks = $('#matchLinks');
const ytLink = $('#ytLink');
const spLink = $('#spLink');
const matchArt = $('#matchArt');
const matchArtFallback = $('#matchArtFallback');

/* Direct links for the identified song, plus search URLs as a last resort */
let matchInfo = { youtubeUrl: null, youtubeVideoId: null, spotifyUrl: null, ytSearch: '', spSearch: '' };

function setMatchArt(coverUrl, fallbackUrl) {
  matchArt.onload = () => { matchArt.hidden = false; matchArtFallback.hidden = true; };
  matchArt.onerror = () => {
    if (fallbackUrl && matchArt.src !== fallbackUrl) {
      matchArt.src = fallbackUrl; // e.g. YouTube thumbnail in lower resolution
    } else {
      matchArt.hidden = true;
      matchArtFallback.hidden = false;
    }
  };
  if (coverUrl) {
    coverUrl = coverUrl.replace('{w}', '600').replace('{h}', '600');
    matchArt.hidden = true;   // show the placeholder until the cover finishes loading
    matchArtFallback.hidden = false;
    matchArt.src = coverUrl;  // onload swaps the cover in
  } else {
    matchArt.hidden = true;
    matchArt.removeAttribute('src');
    matchArt.onerror = null;
    matchArtFallback.hidden = false;
  }
}

function resetMatchLinks() {
  matchInfo = { youtubeUrl: null, youtubeVideoId: null, spotifyUrl: null, ytSearch: '', spSearch: '' };
  matchArt.onload = matchArt.onerror = null;
  setMatchArt(null);
  matchLinks.hidden = true;
}

/* Search fallbacks so the buttons are never dead, even offline */
function refreshMatchButtons() {
  const query = [f.artist.value.trim(), f.title.value.trim()].filter(Boolean).join(' ');
  if (query) {
    const q = encodeURIComponent(query);
    matchInfo.ytSearch = 'https://www.youtube.com/results?search_query=' + q;
    matchInfo.spSearch = 'https://open.spotify.com/search/' + q;
  }
  matchLinks.hidden = false;
}

[f.title, f.artist].forEach((el) => el.addEventListener('input', () => {
  if ($('#match').classList.contains('is-on')) refreshMatchButtons();
}));

/* Free iTunes lookup (JSONP, no key): album cover fallback + Apple Music link */
function itunesLookup(term) {
  return new Promise((resolve) => {
    const cb = 'itunesCb_' + Math.random().toString(36).slice(2);
    const s = document.createElement('script');
    let done = false;
    const finish = (val) => {
      if (done) return; done = true;
      clearTimeout(timer);
      try { delete window[cb]; } catch (_) { window[cb] = undefined; }
      s.remove();
      resolve(val || null);
    };
    const timer = setTimeout(() => finish(null), 8000);
    window[cb] = (data) => finish((data && data.results && data.results[0]) || null);
    s.src = 'https://itunes.apple.com/search?term=' + encodeURIComponent(term)
      + '&entity=song&limit=1&callback=' + cb;
    s.onerror = () => finish(null);
    document.head.appendChild(s);
  });
}

/* Resolve the exact YouTube video for a song via the Jina reader (no API key) */
async function resolveYouTubeVideo(title, artist) {
  const q = [artist, title].filter(Boolean).join(' ');
  if (!q) return '';
  try {
    const res = await fetch('https://r.jina.ai/https://www.youtube.com/results?search_query=' + encodeURIComponent(q));
    if (!res.ok) return '';
    const text = await res.text();
    const items = [];
    const re = /\[([^\]]{0,120}?)\]\(https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})/g;
    let m;
    while ((m = re.exec(text))) items.push({ t: m[1].toLowerCase(), id: m[2] });
    if (!items.length) {
      const bare = [...text.matchAll(/watch\?v=([\w-]{11})/g)].map((x) => x[1]);
      return bare[0] || '';
    }
    // Prefer the result whose video title mentions the most words from artist + song title
    const keys = q.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    let best = items[0], bestScore = -1;
    for (const it of items) {
      const score = keys.reduce((n, k) => n + (it.t.includes(k) ? 1 : 0), 0);
      if (score > bestScore) { bestScore = score; best = it; }
    }
    return best.id;
  } catch (_) { return ''; }
}

/* Buttons open the site itself, straight on the exact song (no search list) */
ytLink.addEventListener('click', (e) => {
  e.preventDefault();
  if (matchInfo.youtubeVideoId) {
    window.open('https://www.youtube.com/watch?v=' + matchInfo.youtubeVideoId, '_blank', 'noopener');
    return;
  }
  if (matchInfo.ytSearch) window.open(matchInfo.ytSearch, '_blank', 'noopener');
});

spLink.addEventListener('click', (e) => {
  e.preventDefault();
  if (matchInfo.spotifyUrl) {
    window.open(matchInfo.spotifyUrl, '_blank', 'noopener');
    return;
  }
  if (matchInfo.spSearch) window.open(matchInfo.spSearch, '_blank', 'noopener');
});

/* Enrich the match result after AudD identifies the song */
async function hydrateMatch(r) {
  const mine = matchInfo; // guard: a newer match/load may replace matchInfo while we await
  matchInfo.spotifyUrl = (r.spotify && r.spotify.external_urls && r.spotify.external_urls.spotify) || null;
  let cover = '';
  const spImages = (r.spotify && r.spotify.album && r.spotify.album.images) || [];
  if (spImages.length && spImages[0].url) cover = spImages[0].url;
  else if (r.apple_music && r.apple_music.artwork && r.apple_music.artwork.url) cover = r.apple_music.artwork.url;
  setMatchArt(cover || null);

  // iTunes: artwork fallback when AudD didn't include a cover
  const term = [r.title, r.artist].filter(Boolean).join(' ');
  const it = await itunesLookup(term);
  if (matchInfo !== mine) return; // out-of-date result, ignore it
  if (it && !cover && it.artworkUrl100) setMatchArt(it.artworkUrl100.replace('100x100', '600x600'));

  // Resolve the exact YouTube video, so the button opens the song itself
  const videoId = await resolveYouTubeVideo(r.title, r.artist);
  if (matchInfo !== mine) return; // out-of-date result, ignore it
  if (videoId) {
    matchInfo.youtubeVideoId = videoId;
    matchInfo.youtubeUrl = 'https://www.youtube.com/watch?v=' + videoId;
    // Cover photo = the exact same picture shown on YouTube for that video
    setMatchArt('https://i.ytimg.com/vi/' + videoId + '/maxresdefault.jpg',
                'https://i.ytimg.com/vi/' + videoId + '/hqdefault.jpg');
  }
  refreshMatchButtons();
}

/* ============ Load audio (upload or recording) ============ */
function extForMime(mime = '') {
  if (/mpeg|mp3/i.test(mime)) return 'mp3';
  if (/wav|x-wav/i.test(mime)) return 'wav';
  if (/ogg/i.test(mime)) return 'ogg';
  if (/mp4|m4a|aac/i.test(mime)) return 'm4a';
  return 'webm';
}
async function loadBlob(blob, name, opts = {}) {
  const ctx = ensureCtx(); if (!ctx) return;
  state.blob = blob;
  state.fileName = name;
  state.mime = blob.type || '';
  state.name = name.replace(/\.[^.]+$/, '') || 'recording';
  state.isMp3 = /\.mp3$/i.test(name) || blob.type === 'audio/mpeg';
  $('#outFormat').value = state.isMp3 ? 'mp3tag' : 'mp3';
  const player = $('#player');
  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
  state.objectUrl = URL.createObjectURL(blob);
  player.src = state.objectUrl; player.hidden = false;
  $('#match').classList.remove('is-on');
  $('#matchWriter').textContent = '';
  resetMatchLinks();
  clearTags();
  try {
    state.buffer = await ctx.decodeAudioData(await blob.arrayBuffer());
    state.staticWave = state.buffer.getChannelData(0);
    els.vizWrap.classList.add('is-live');
  } catch (e) { state.buffer = null; showToast('Could not decode', 'File may be unsupported. Tags can still be read/identified.', 'error'); }
  if (state.isMp3) {
    const t = await readId3(blob);
    if (t.title || t.artist) { setTags(t); showToast('Tags found', 'Existing ID3 tags were loaded.', 'info'); }
  }
  if (!f.title.value) f.title.value = state.name;
  if (opts.auto && $('#autoIdentify').checked) identify();
}
$('#fileInput').addEventListener('change', (e) => { const x = e.target.files[0]; if (x) { $('#fileName').textContent = x.name; loadBlob(x, x.name, { auto: true }); } });
const dz = $('#dropzone');
['dragenter', 'dragover'].forEach((v) => dz.addEventListener(v, (e) => { e.preventDefault(); dz.classList.add('is-drag'); }));
['dragleave', 'drop'].forEach((v) => dz.addEventListener(v, (e) => { e.preventDefault(); dz.classList.remove('is-drag'); }));
dz.addEventListener('drop', (e) => { const x = e.dataTransfer.files[0]; if (x) { $('#fileName').textContent = x.name; loadBlob(x, x.name, { auto: true }); } });

/* ============ Microphone: record (length set below) then identify ============ */
const LISTEN_SECONDS = 12;      // default quick-identify length
const MAX_RECORD_SECONDS = 600; // safety cap for "until I tap stop"
const MAX_MIC_TRIES = 3;        // auto-retries so a short intro clip still gets recognized
let micTimer = null, micTick = null;
let micTry = 0;

function startMic() {
  const tryNo = micTry + 1; // display number, starts at 1
  const ctx = ensureCtx(); if (!ctx) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { showToast('Microphone unavailable', 'Use https:// or localhost.', 'error'); return; }
  navigator.mediaDevices.getUserMedia({ audio: true }).then(async (stream) => {
    state.stream = stream;
    const an = ctx.createAnalyser(); an.fftSize = 2048; an.smoothingTimeConstant = 0.75;
    ctx.createMediaStreamSource(stream).connect(an); state.analyser = an; state.staticWave = null;
    const chunks = []; const rec = new MediaRecorder(stream); state.rec = rec;
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = async () => {
      clearTimeout(micTimer); clearInterval(micTick);
      stream.getTracks().forEach((t) => t.stop());
      state.analyser = null; state.recording = false; els.vizWrap.classList.remove('is-live');
      $('#micBtn').classList.remove('is-recording');
      const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
      if (!blob.size) {
        $('#micStatus').textContent = 'Tap to listen';
        showToast('Nothing recorded', 'No audio was captured. Check your microphone.', 'error');
        return;
      }
      $('#micStatus').textContent = 'Identifying…';
      await loadBlob(blob, 'recording.' + extForMime(blob.type));
      if ($('#autoIdentify').checked) {
        const result = await identify();
        // Only the intro was heard? Listen again to catch a clearer part of the song.
        if (result === 'nomatch' && micTry + 1 < MAX_MIC_TRIES) {
          micTry += 1;
          showToast('No match yet', 'Only heard the intro — listening again to catch a clearer part '
            + '(try ' + (micTry + 1) + ' of ' + MAX_MIC_TRIES + ').', 'info', 7000);
          startMic();
          return;
        }
        micTry = 0;
      } else $('#micStatus').textContent = 'Tap to listen';
    };
    rec.start(); state.recording = true; els.vizWrap.classList.add('is-live');
    $('#micBtn').classList.add('is-recording');
    const recLen = parseInt($('#recLength').value, 10);
    const limit = recLen > 0 ? recLen : MAX_RECORD_SECONDS; // 0 = record until the user taps stop
    let left = limit;
    const fmt = (s) => s >= 60 ? Math.floor(s / 60) + 'm ' + (s % 60) + 's' : s + 's';
    const tryLabel = tryNo > 1 ? ` (try ${tryNo} of ${MAX_MIC_TRIES})` : '';
    if (recLen > 0) $('#micStatus').textContent = `Listening… ${fmt(left)}${tryLabel} (tap to stop)`;
    else $('#micStatus').textContent = `Recording…${tryLabel} (tap to stop)`;
    micTick = setInterval(() => {
      left -= 1;
      if (recLen > 0) {
        if (left > 0) $('#micStatus').textContent = `Listening… ${fmt(left)}${tryLabel} (tap to stop)`;
      } else if (left > 0) {
        $('#micStatus').textContent = `Recording… ${fmt(MAX_RECORD_SECONDS - left)}${tryLabel} (tap to stop)`;
      }
    }, 1000);
    micTimer = setTimeout(() => { if (state.recording) rec.stop(); }, limit * 1000);
  }).catch((err) => showToast('Microphone error', err.name === 'NotAllowedError' ? 'Allow mic access to listen.' : err.message, 'error'));
}

$('#micBtn').addEventListener('click', () => {
  if (state.recording) { state.rec.stop(); return; }
  micTry = 0; // manual start resets the auto-retry count
  startMic();
});

/* ============ Identify song (AudD API) ============ */
/* Visitors never need to type anything.
   - AUDD_TOKEN: optional — your own free token from https://dashboard.audd.io
   - AUDD_PROXY: optional — URL of your Cloudflare Worker proxy (see worker.js in this folder).
     The proxy hides your token completely and gives you a much bigger daily quota;
     you add the token as a secret on Cloudflare, never in this file. */
const AUDD_TOKEN = '';
const AUDD_PROXY = '';
$('#identifyBtn').addEventListener('click', identify);

/* Returns 'ok' | 'nomatch' | 'error' so the mic flow can auto-retry after an intro-only clip */
async function identify() {
  if (!state.blob) { showToast('No audio yet', 'Upload a song or use the microphone first.', 'error'); return 'error'; }
  const token = AUDD_PROXY ? '' : AUDD_TOKEN; // the proxy adds the token itself
  const btn = $('#identifyBtn'); btn.disabled = true; btn.textContent = 'Identifying…';
  try {
    const fd = new FormData();
    if (token) fd.append('api_token', token);
    const limit = 9.5e6;
    const file = state.blob.size > limit ? state.blob.slice(0, limit) : state.blob;
    fd.append('file', file, state.fileName || ('recording.' + extForMime(state.mime)));
    const res = await fetch(AUDD_PROXY || 'https://api.audd.io/', { method: 'POST', body: fd });
    const data = await res.json();
    if (data.status === 'error') throw new Error((data.error && data.error.error_message) || 'Request failed');
    const r = data.result;
    if (!r) { showToast('No match', 'The song was not recognized. Try a clearer or longer clip, or edit the tags manually.', 'error', 5500); return 'nomatch'; }
    setTags({ title: r.title, artist: r.artist, album: r.album, year: (r.release_date || '').slice(0, 4) });
    $('#matchTitle').textContent = r.title || '';
    $('#matchArtist').textContent = [r.artist, r.album].filter(Boolean).join(' — ');
    $('#matchWriter').textContent = '';
    $('#match').classList.add('is-on');
    hydrateMatch(r);
    showToast('Song identified', [r.title, r.artist].filter(Boolean).join(' — '), 'success');
    const identifiedTitle = r.title;
    lookupWriter(r.title, r.artist).then((writer) => {
      if (!writer || f.title.value !== identifiedTitle) return;
      f.writer.value = writer;
      $('#matchWriter').textContent = 'Written by ' + writer;
    });
    return 'ok';
  } catch (e) {
    const msg = e.message || 'Network error';
    if (/token/i.test(msg)) {
      showToast('Free limit reached', 'AudD\u2019s free quota ran out. See the steps in README.md (AudD token or worker.js proxy) to lift it.', 'error', 8000);
    } else {
      showToast('Could not identify', msg + ' — check your internet connection and API token.', 'error', 6000);
    }
    return 'error';
  } finally {
    btn.disabled = false; btn.textContent = 'Identify song';
    if (!state.recording) $('#micStatus').textContent = 'Tap to listen';
  }
}

/* Writer / composer lookup (free MusicBrainz API, best effort) */
const writerCache = new Map();
async function lookupWriter(title, artist) {
  if (!title || !artist) return '';
  const key = (title + '|' + artist).toLowerCase();
  if (writerCache.has(key)) return writerCache.get(key);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 14000);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clean = (s) => String(s).replace(/["\\]/g, ' ').trim();
  const types = ['composer', 'writer', 'lyricist', 'songwriter'];
  const collect = (rels, out) => (rels || []).forEach((rel) => {
    const type = String(rel.type || '').toLowerCase();
    if (types.includes(type) && rel.artist && rel.artist.name) out.push(rel.artist.name);
  });
  const getJson = async (url, wait) => {
    if (wait) await sleep(1100); // MusicBrainz allows about one request per second
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('MusicBrainz ' + res.status);
    return res.json();
  };
  try {
    const q = `recording:"${clean(title)}" AND artist:"${clean(artist)}"`;
    const data = await getJson(
      `https://musicbrainz.org/ws/2/recording/?query=${encodeURIComponent(q)}&fmt=json&limit=1`,
      false
    );
    const rec = (data.recordings || [])[0];
    if (!rec) return '';
    const names = [];
    const detail = await getJson(
      `https://musicbrainz.org/ws/2/recording/${rec.id}?inc=work-rels+artist-rels&fmt=json`,
      true
    );
    collect(detail.relations, names);
    const workRel = (detail.relations || []).find((rel) => rel.work && rel.work.id);
    if (workRel) {
      const work = await getJson(`https://musicbrainz.org/ws/2/work/${workRel.work.id}?inc=artist-rels&fmt=json`, true);
      collect(work.relations, names);
    }
    const result = [...new Set(names)].filter(Boolean).join(', ');
    writerCache.set(key, result);
    return result;
  } catch (_) {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

/* ============ ID3v2 read / write ============ */
async function readId3(blob) {
  const out = {};
  try {
    const b = new Uint8Array(await blob.slice(0, 600000).arrayBuffer());
    if (String.fromCharCode(b[0], b[1], b[2]) !== 'ID3') return out;
    const ver = b[3], size = ((b[6] & 127) << 21) | ((b[7] & 127) << 14) | ((b[8] & 127) << 7) | (b[9] & 127);
    const end = Math.min(10 + size, b.length); let p = 10;
    const map = { TIT2: 'title', TPE1: 'artist', TCOM: 'writer', TALB: 'album', TYER: 'year', TDRC: 'year' };
    while (p + 10 < end) {
      const id = String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]); if (!/^[A-Z0-9]{4}$/.test(id)) break;
      const sz = ver === 4 ? ((b[p + 4] & 127) << 21) | ((b[p + 5] & 127) << 14) | ((b[p + 6] & 127) << 7) | (b[p + 7] & 127)
                           : (b[p + 4] << 24 | b[p + 5] << 16 | b[p + 6] << 8 | b[p + 7]) >>> 0;
      if (map[id] && sz > 1) {
        const enc = b[p + 10], d = b.slice(p + 11, p + 10 + sz);
        const label = enc === 0 ? 'latin1' : enc === 3 ? 'utf-8' : (d[0] === 0xFE && d[1] === 0xFF ? 'utf-16be' : 'utf-16le');
        out[map[id]] = new TextDecoder(label).decode(d).replace(/\0/g, '').replace(/^\uFEFF/, '').slice(0, id === 'TDRC' ? 4 : 200);
      }
      p += 10 + sz;
    }
  } catch (_) {}
  return out;
}
function buildId3(t) {
  const frames = [];
  const add = (id, txt) => {
    if (!txt) return;
    const u = new Uint8Array(3 + txt.length * 2); u[0] = 1; u[1] = 0xFF; u[2] = 0xFE;
    for (let i = 0; i < txt.length; i++) { const c = txt.charCodeAt(i); u[3 + i * 2] = c & 255; u[4 + i * 2] = c >> 8; }
    const fr = new Uint8Array(10 + u.length); fr.set(Array.from(id, (c) => c.charCodeAt(0)));
    new DataView(fr.buffer).setUint32(4, u.length); fr.set(u, 10); frames.push(fr);
  };
  add('TIT2', t.title); add('TPE1', t.artist); add('TCOM', t.writer); add('TALB', t.album); add('TYER', t.year);
  const body = frames.reduce((n, x) => n + x.length, 0), tag = new Uint8Array(10 + body);
  tag.set([73, 68, 51, 3, 0, 0, (body >> 21) & 127, (body >> 14) & 127, (body >> 7) & 127, body & 127]);
  let p = 10; frames.forEach((x) => { tag.set(x, p); p += x.length; });
  return tag;
}
async function retagMp3(blob, t) {
  const head = new Uint8Array(await blob.slice(0, 10).arrayBuffer());
  let skip = 0;
  if (String.fromCharCode(head[0], head[1], head[2]) === 'ID3') skip = 10 + (((head[6] & 127) << 21) | ((head[7] & 127) << 14) | ((head[8] & 127) << 7) | (head[9] & 127));
  return new Blob([buildId3(t), blob.slice(skip)], { type: 'audio/mpeg' });
}

/* ============ Render (resample / channel change) ============ */
async function renderBuf(buffer, rate, ch) {
  rate = rate || buffer.sampleRate; ch = ch || buffer.numberOfChannels;
  const off = new OfflineAudioContext(ch, Math.ceil(buffer.duration * rate), rate);
  const src = off.createBufferSource(); src.buffer = buffer; src.connect(off.destination); src.start();
  return off.startRendering();
}

/* ============ MP3 encode (lamejs, loaded on demand) ============ */
function loadLame() {
  if (window.lamejs) return Promise.resolve();
  return new Promise((res, rej) => {
    const sc = document.createElement('script');
    sc.src = 'https://cdnjs.cloudflare.com/ajax/libs/lamejs/1.2.1/lame.min.js';
    sc.onload = res; sc.onerror = () => rej(new Error('MP3 encoder could not load. Check your internet connection.'));
    document.head.appendChild(sc);
  });
}
async function toMp3(buffer, rate, ch, kbps, t) {
  await loadLame();
  const r = await renderBuf(buffer, rate, ch); ch = Math.min(r.numberOfChannels, 2);
  const to16 = (a) => { const o = new Int16Array(a.length); for (let i = 0; i < a.length; i++) o[i] = Math.round(clamp(a[i], -1, 1) * 32767); return o; };
  const L = to16(r.getChannelData(0)), R = ch === 2 ? to16(r.getChannelData(1)) : null;
  const enc = new lamejs.Mp3Encoder(ch, r.sampleRate, kbps), parts = [buildId3(t)], BLK = 1152;
  for (let i = 0; i < L.length; i += BLK) {
    const d = ch === 2 ? enc.encodeBuffer(L.subarray(i, i + BLK), R.subarray(i, i + BLK)) : enc.encodeBuffer(L.subarray(i, i + BLK));
    if (d.length) parts.push(new Uint8Array(d));
    if ((i / BLK) % 400 === 0) { setProgress(0.1 + 0.85 * i / L.length, true); await new Promise((x) => setTimeout(x)); }
  }
  const end = enc.flush(); if (end.length) parts.push(new Uint8Array(end));
  return new Blob(parts, { type: 'audio/mpeg' });
}

/* ============ WAV encode + LIST INFO tags ============ */
async function toWav(buffer, rate, ch, t) {
  const r = await renderBuf(buffer, rate, ch); rate = r.sampleRate; ch = r.numberOfChannels; setProgress(0.6, true);
  const n = r.length, data = n * ch * 2;
  const info = []; const enc = new TextEncoder();
  [['INAM', t.title], ['IART', t.artist], ['IMUS', t.writer], ['IPRD', t.album], ['ICRD', t.year]].forEach(([id, v]) => {
    if (!v) return; const s = enc.encode(v + '\0'), pad = s.length % 2;
    const c = new Uint8Array(8 + s.length + pad); c.set(Array.from(id, (x) => x.charCodeAt(0)));
    new DataView(c.buffer).setUint32(4, s.length, true); c.set(s, 8); info.push(c);
  });
  const infoLen = info.reduce((a, x) => a + x.length, 0), listLen = infoLen ? 12 + infoLen : 0;
  const out = new ArrayBuffer(44 + data + listLen), v = new DataView(out);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + data + listLen, true); str(8, 'WAVEfmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, ch, true); v.setUint32(24, rate, true); v.setUint32(28, rate * ch * 2, true);
  v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, data, true);
  const chans = Array.from({ length: ch }, (_, c) => r.getChannelData(c)); let p = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) { v.setInt16(p, Math.round(clamp(chans[c][i], -1, 1) * 32767), true); p += 2; }
  if (listLen) { str(p, 'LIST'); v.setUint32(p + 4, 4 + infoLen, true); str(p + 8, 'INFO'); p += 12; info.forEach((x) => { new Uint8Array(out).set(x, p); p += x.length; }); }
  return new Blob([out], { type: 'audio/wav' });
}

/* ============ Save ============ */
$('#saveBtn').addEventListener('click', async () => {
  if (!state.blob) { showToast('No audio yet', 'Upload or record a song first.', 'error'); return; }
  const t = getTags(), fmt = $('#outFormat').value; setProgress(0.2, true);
  try {
    let blob, ext;
    const rate = parseInt($('#sampleRate').value, 10), chs = parseInt($('#channels').value, 10);
    if (fmt === 'mp3tag') {
      if (!state.isMp3) throw new Error('Tag-only mode needs an MP3 source. Choose "MP3 (convert)" instead.');
      blob = await retagMp3(state.blob, t); ext = 'mp3';
    } else {
      if (!state.buffer) throw new Error('This file could not be decoded for conversion.');
      if (fmt === 'wav') { blob = await toWav(state.buffer, rate, chs, t); ext = 'wav'; }
      else { blob = await toMp3(state.buffer, rate, chs, parseInt($('#bitrate').value, 10), t); ext = 'mp3'; }
    }
    const base = [t.artist, t.title].filter(Boolean).join(' - ').replace(/[\\/:*?"<>|]/g, '') || state.name;
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = base + '.' + ext;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1500);
    showToast('Downloaded', a.download, 'success');
  } catch (e) { showToast('Save failed', e.message, 'error'); }
  setProgress(0, false);
});

/* ============ Init ============ */
function init() {
  initReveal(); initBinaryRain(); startVisualizer();
  $('#year').textContent = new Date().getFullYear();
  window.addEventListener('load', fitCanvas); setTimeout(fitCanvas, 400);
  if (!audioSupported) showToast('Limited browser', 'Web Audio API is unavailable.', 'error', 6000);
  window.addEventListener('pointerdown', () => ensureCtx(), { once: true });
}
document.addEventListener('DOMContentLoaded', init);
