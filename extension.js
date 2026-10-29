/* 가챠 TTS v0.7.0 — Gacha Forge 대사 음성(ElevenLabs via Marinara TTS). 월드별 보이스 설정, 감정 태그 로어북 연결. */
(() => {
  'use strict';
  if (globalThis.__gfTtsExtension) return;
  globalThis.__gfTtsExtension = true;

  const ID = 'gtts';
  const STORE = 'gf-tts-v1';
  const HOST_TAG = 'marinara-capability-gacha-forge';
  const LORE_NAME = '가챠 TTS · 음성 감정 태그';
  const LORE_TAG = 'gacha-forge-tts';
  // English lowercase tags only, so Korean bracket text such as [시스템] is never touched.
  const TAG_RE = /\[[a-z][a-z' -]{0,30}\][ \t]?/g;
  const NARRATOR_RE = /^(?:|\?+|narrator|narration|system|나레이션|내레이션|시스템)$/iu;
  const TEXT_KEYS = new Set(['text', 'line', 'dialogue', 'content', 'prose', 'narration']);
  const SAMPLE_TEXT = '[happy] 안녕하세요. 앞으로 이 목소리로 대사를 읽어 드릴게요.';

  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const now = () => new Date().toLocaleString('ko-KR');
  const keyOf = n => String(n || '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 60);
  const norm = s => String(s || '').normalize('NFC').replace(TAG_RE, '').replace(/[\s"“”'‘’「」『』*_~…·.,!?]/g, '');
  const stripTags = s => String(s || '').replace(TAG_RE, '');
  const hash = t => { let h = 2166136261; for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 16777619) >>> 0; return h.toString(36); };

  // ---------- 저장 ----------
  const initial = () => ({ v: 1, at: 0, world: '', worlds: {}, global: { enabled: true, volume: 1, interrupt: true, prefetch: false, stripTags: true, serverCache: true }, lore: { id: '', name: '', entryId: '', error: '' } });
  let data;
  try { data = JSON.parse(localStorage.getItem(STORE) || 'null') || initial(); } catch { data = initial(); }
  if (!data || data.v !== 1 || typeof data.worlds !== 'object') data = initial();
  data.global = { ...initial().global, ...(data.global || {}) };
  data.lore = { ...initial().lore, ...(data.lore || {}) };
  const blankWorld = (name) => ({ name: name || '', auto: true, narrate: false, narrator: '', fallback: '', emotion: true, linkedOnce: false, speakers: {} });
  function world(runId) { return runId ? data.worlds[runId] : null; }
  function current() { return world(data.world); }
  function save() {
    data.at = Date.now();
    try { localStorage.setItem(STORE, JSON.stringify(data)); } catch (e) { console.warn('[가챠 TTS] 저장 실패', e); }
    syncSchedule();
  }

  // 다른 기기와 설정 동기화 (마리나라 확장 저장소, 설정만이라 작음).
  // 통째로 덮어쓰면 스토리만 진행한 기기가 다른 기기에서 고른 보이스를 지워 버리므로, 사용자가 바꾼 시각(t, gt)으로 항목별로 합칩니다.
  const WORLD_KEYS = ['name', 'auto', 'narrate', 'narrator', 'fallback', 'emotion', 'narrVol', 'narrRate', 'fallbackF', 'fallbackM'];
  function mergeData(local, remote) {
    if (!remote || remote.v !== 1 || typeof remote.worlds !== 'object') return false;
    let changed = false;
    const take = (to, from, keys) => { for (const k of keys) if (k in from && to[k] !== from[k]) { to[k] = from[k]; changed = true; } };
    for (const [id, rw] of Object.entries(remote.worlds || {})) {
      if (!rw || typeof rw !== 'object') continue;
      const lw = local.worlds[id];
      if (!lw) { local.worlds[id] = { ...blankWorld(rw.name), ...rw, speakers: { ...(rw.speakers || {}) } }; changed = true; continue; }
      if ((rw.t || 0) > (lw.t || 0)) { take(lw, rw, WORLD_KEYS); lw.t = rw.t; }
      else if (!rw.t && !lw.t) { for (const k of ['narrator', 'fallback']) if (!lw[k] && rw[k]) { lw[k] = rw[k]; changed = true; } }
      if (rw.linkedOnce && !lw.linkedOnce) { lw.linkedOnce = true; changed = true; }
      for (const [k, rs] of Object.entries(rw.speakers || {})) {
        if (!rs || typeof rs !== 'object') continue;
        const ls = lw.speakers[k];
        if (!ls) { lw.speakers[k] = { ...rs }; changed = true; continue; }
        if ((rs.t || 0) > (ls.t || 0)) { take(ls, rs, ['voice', 'mute', 'vol', 'rate', 'gender', 'gUser']); ls.t = rs.t; }
        else if (!rs.t && !ls.t && !ls.voice && rs.voice) { ls.voice = rs.voice; changed = true; }
        if (rs.prota && !ls.prota) { ls.prota = true; changed = true; }
        if ((rs.lines || 0) > (ls.lines || 0)) ls.lines = rs.lines;
      }
    }
    if ((remote.gt || 0) > (local.gt || 0) && remote.global) { local.global = { ...initial().global, ...remote.global }; local.gt = remote.gt; changed = true; }
    const RL = remote.lore;
    if (RL && RL.id && (!local.lore.id || (RL.id !== local.lore.id && (remote.at || 0) > (local.at || 0)))) { local.lore = { ...initial().lore, ...RL }; changed = true; }
    return changed;
  }
  let syncT = 0;
  function host() { try { const m = typeof marinara === 'object' && marinara ? marinara : globalThis.marinara; return m && m.storage && typeof m.storage.get === 'function' && typeof m.storage.patch === 'function' ? m : null; } catch { return null; } }
  function syncSchedule(ms = 1500) {
    if (!host()) return;
    if (syncT) clearTimeout(syncT);
    syncT = setTimeout(() => { syncT = 0; syncPush(); }, ms);
  }
  // 올리기 직전에 서버 쪽을 먼저 합쳐, 다른 기기가 그 사이 바꾼 보이스를 덮지 않습니다.
  async function syncPush() {
    const h = host(); if (!h) return;
    try {
      const rec = (await h.storage.get())?.gtts;
      if (rec?.json && mergeData(data, JSON.parse(rec.json))) applyMerged();
      await h.storage.patch({ gtts: { at: data.at, json: JSON.stringify({ ...data, world: undefined }) } });
    } catch {}
  }
  function flushSync() { if (syncT) { clearTimeout(syncT); syncT = 0; syncPush(); } }
  function applyMerged() {
    try { localStorage.setItem(STORE, JSON.stringify(data)); } catch {}
    const w = current();
    if (lastLine && w) lastLine.voice = voiceFor(w, lastLine);
    refresh();
  }
  let pulling = false;
  async function syncPull() {
    const h = host(); if (!h || pulling) return;
    pulling = true;
    try {
      const rec = (await h.storage.get())?.gtts;
      if (!rec) { if (Object.keys(data.worlds).length) syncSchedule(); return; }
      if (mergeData(data, JSON.parse(rec.json))) applyMerged();
    } catch {} finally { pulling = false; }
  }
  // 사용자가 직접 바꾼 설정만 시각을 남깁니다. 스토리 진행으로 바뀌는 화자 줄 수 등은 시각을 바꾸지 않습니다.
  function touched(o) { o.t = Date.now(); }

  // ---------- 마리나라 API ----------
  async function api(path, method = 'GET', body) {
    const m = typeof marinara === 'object' && marinara ? marinara : globalThis.marinara || {};
    let admin = ''; try { admin = String(localStorage.getItem('marinara_admin_secret') || '').trim(); } catch {}
    const opts = { method, credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json', 'x-marinara-csrf': '1', ...(admin ? { 'X-Admin-Secret': admin } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) };
    const r = typeof m.apiFetch === 'function' ? await m.apiFetch(path.replace(/^\/api\//, ''), opts) : await fetch(path, opts);
    const j = await r.json().catch(() => null);
    if (!r.ok) throw Object.assign(Error(String(j?.error || j?.message || ('HTTP ' + r.status))), { status: r.status });
    return j;
  }

  let ttsConfig = null, ttsConfigError = '', voices = [], voicesError = '';
  let configReady = null;
  function loadTtsConfig() {
    return (configReady = (async () => {
      try { ttsConfig = await api('/api/tts/config'); ttsConfigError = ''; } catch (e) { ttsConfig = null; ttsConfigError = String(e.message || e); }
      refresh();
    })());
  }
  // 마리나라 TTS 속도가 실제로 음성에 들어가는 경우에만 저장 이름에 붙입니다. 속도 1.0은 예전 이름 그대로라 이미 저장된 음성을 계속 씁니다.
  // 마리나라는 ElevenLabs에 0.7~1.2로 잘라 보내고, eleven_v3에는 속도를 보내지 않습니다.
  function speedTag() {
    const c = ttsConfig; if (!c) return '';
    let sp = Number(c.speed); if (!Number.isFinite(sp)) return '';
    if (!c.source || c.source === 'elevenlabs') { if (/v3/i.test(String(c.model || ''))) return ''; sp = Math.min(1.2, Math.max(0.7, sp)); }
    sp = Math.round(sp * 100) / 100;
    return sp === 1 ? '' : '\u0000speed=' + sp;
  }
  async function loadVoices() {
    try {
      const v = await api('/api/tts/voices');
      const raw = Array.isArray(v?.voiceOptions) ? v.voiceOptions : Array.isArray(v?.voices) ? v.voices.map(x => typeof x === 'string' ? { id: x, name: x } : { id: x?.voice_id || x?.id, name: x?.name }) : [];
      voices = raw.filter(x => x && x.id).map(x => ({ id: String(x.id), name: String(x.name || x.id) }));
      voicesError = voices.length ? '' : '보이스 목록이 비어 있습니다.';
    } catch (e) { voicesError = '보이스 목록을 불러오지 못했습니다: ' + String(e.message || e); }
    refresh();
  }

  // ---------- 음성 생성·재생 ----------
  const clips = new Map(); // key -> Promise<objectURL>
  let audio = null, playingKey = '', lastError = '';
  function clipKey(voice, text) { return hash(voice + '\u0000' + text); }
  function speechText(text) {
    let t = String(text || '').trim();
    t = t.replace(/^(["“「『])([\s\S]*)(["”」』])$/, '$2').trim();
    return t;
  }
  // 만든 음성은 마리나라 서버의 게임 에셋 폴더(sfx/.gacha-tts)에 mp3로 남겨, 다른 기기나 새로고침 뒤에도 다시 만들지 않습니다.
  // 점(.)으로 시작하는 폴더는 게임 에셋 목록에서 빠지므로 게임 효과음·음악 선택에 섞이지 않습니다.
  const SERVER_DIR = 'sfx/.gacha-tts';
  function serverName(voice, text) {
    const s = voice + '\u0000' + text, pad = h => h.padStart(7, '0');
    return pad(hash(s)) + pad(hash('gtts\u0000' + s)) + s.length.toString(36);
  }
  function authHeaders(extra) {
    let admin = ''; try { admin = String(localStorage.getItem('marinara_admin_secret') || '').trim(); } catch {}
    return { 'x-marinara-csrf': '1', ...(admin ? { 'X-Admin-Secret': admin } : {}), ...extra };
  }
  async function serverGet(name) {
    const r = await fetch('/api/game-assets/file/' + SERVER_DIR + '/' + name.slice(0, 2) + '/' + name + '.mp3', { credentials: 'same-origin', headers: authHeaders() });
    if (!r.ok) return null;
    const blob = await r.blob();
    return blob.size ? blob : null;
  }
  async function serverPut(name, blob) {
    const form = new FormData();
    form.append('category', 'sfx');
    form.append('subcategory', SERVER_DIR.slice(4) + '/' + name.slice(0, 2));
    form.append('file', blob, name + '.mp3');
    const r = await fetch('/api/game-assets/upload', { method: 'POST', credentials: 'same-origin', headers: authHeaders(), body: form });
    if (!r.ok && r.status !== 409) throw Error('서버에 음성을 저장하지 못했습니다 (HTTP ' + r.status + ')');
    stats.saved++;
  }
  const stats = { server: 0, made: 0, saved: 0, saveError: '' };
  function fetchClip(voice, text, speaker) {
    // 속도를 알아야 저장 이름이 정해지므로 TTS 설정을 처음 한 번은 기다립니다.
    if (!ttsConfig && !ttsConfigError) return (configReady || loadTtsConfig()).then(() => fetchClip(voice, text, speaker));
    const tag = speedTag(), k = clipKey(voice, text + tag);
    if (clips.has(k)) return clips.get(k);
    const p = (async () => {
      const useServer = data.global.serverCache !== false, name = serverName(voice, text + tag);
      if (useServer) {
        const saved = await serverGet(name).catch(() => null);
        if (saved) { stats.server++; return URL.createObjectURL(saved); }
      }
      const r = await fetch('/api/tts/speak', {
        method: 'POST', credentials: 'same-origin',
        headers: authHeaders({ 'Content-Type': 'application/json', 'X-Marinara-TTS-Line': '1' }),
        body: JSON.stringify({ text, voice, ...(speaker ? { speaker } : {}) }),
      });
      if (!r.ok) { const j = await r.json().catch(() => null); throw Error(j?.error || ('음성 생성 실패 (HTTP ' + r.status + ')')); }
      const blob = await r.blob();
      if (!blob.size) throw Error('음성 응답이 비어 있습니다.');
      stats.made++;
      // mp3만 서버에 남깁니다. 저장 실패는 재생을 막지 않습니다.
      if (useServer && /mpeg|mp3/i.test(blob.type || r.headers.get('content-type') || 'audio/mpeg')) {
        serverPut(name, blob).then(() => { stats.saveError = ''; }, e => { stats.saveError = String(e.message || e); console.warn('[가챠 TTS]', stats.saveError); }).finally(refresh);
      }
      return URL.createObjectURL(blob);
    })();
    clips.set(k, p);
    p.catch(() => clips.delete(k));
    while (clips.size > 60) { const [old, op] = clips.entries().next().value; clips.delete(old); op.then(u => URL.revokeObjectURL(u)).catch(() => {}); }
    return p;
  }
  function stop() {
    if (audio) { audio.onended = null; audio.pause(); audio = null; }
    playingKey = ''; playingTone = ''; paintButton();
  }
  // ---------- 인물별 음량·속도 ----------
  // 음량은 공통 음량에 곱하고(최대 150%), 속도는 재생 속도로 바꿔 음높이는 그대로 둡니다. 다시 만들지 않으므로 요금이 들지 않습니다.
  const VOL_MAX = 1.5, RATE_MIN = 0.5, RATE_MAX = 2;
  const clamp = (v, lo, hi, d) => { v = Number(v); return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d; };
  let playingTone = '', audioCtx = null;
  function toneKeyOf(seg) { return NARRATOR_RE.test(seg.speaker || '') ? '__narr' : keyOf(seg.speaker); }
  function toneOf(w, tk) {
    if (!w || !tk) return { vol: 1, rate: 1 };
    const o = tk === '__narr' ? { vol: w.narrVol, rate: w.narrRate } : w.speakers[tk] || {};
    return { vol: clamp(o.vol ?? 1, 0, VOL_MAX, 1), rate: clamp(o.rate ?? 1, RATE_MIN, RATE_MAX, 1) };
  }
  function applyTone(a, tone) {
    const gain = clamp(data.global.volume, 0, 1, 1) * tone.vol;
    a.preservesPitch = true; a.mozPreservesPitch = true; a.webkitPreservesPitch = true;
    a.defaultPlaybackRate = tone.rate; a.playbackRate = tone.rate;
    if (gain <= 1 && !a.__gain) { a.volume = gain; return; }
    // 100%를 넘기면 Web Audio로 키웁니다. 쓸 수 없으면 100%로 둡니다.
    try {
      if (!a.__gain) {
        audioCtx = audioCtx || new (globalThis.AudioContext || globalThis.webkitAudioContext)();
        if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
        const g = audioCtx.createGain(); audioCtx.createMediaElementSource(a).connect(g); g.connect(audioCtx.destination); a.__gain = g;
      }
      a.volume = 1; a.__gain.gain.value = gain;
    } catch { a.volume = Math.min(1, gain); }
  }
  function retone() { const w = current(); if (audio && playingTone) applyTone(audio, toneOf(w, playingTone)); }
  async function play(voice, text, speaker, key, tk) {
    if (!voice || !text) return;
    stop();
    playingKey = key || clipKey(voice, text); playingTone = tk || ''; paintButton();
    const mine = playingKey;
    try {
      const url = await fetchClip(voice, text, speaker);
      if (playingKey !== mine) return;
      audio = new Audio(url);
      applyTone(audio, toneOf(current(), playingTone));
      audio.onended = () => { if (playingKey === mine) { playingKey = ''; audio = null; paintButton(); } };
      await audio.play();
      lastError = '';
    } catch (e) {
      if (playingKey === mine) { playingKey = ''; paintButton(); }
      lastError = String(e.message || e);
      console.warn('[가챠 TTS]', lastError);
      refresh();
    }
  }

  // ---------- 가챠 포지 통신 관찰 ----------
  const beats = []; // 최근 장면: {runId, chapter, index, segments:[{speaker, text, plain, n}]}
  function nameOfRun(x) { return String(x?.name || x?.title || x?.worldName || x?.world?.name || '').trim().slice(0, 100); }
  function attachRun(runId, name) {
    runId = String(runId || '').trim();
    if (!runId || runId.length > 128) return;
    if (!data.worlds[runId]) { data.worlds[runId] = blankWorld(name || ('게임 월드 ' + runId.slice(0, 8))); save(); }
    const w = data.worlds[runId];
    if (name && w.name !== name) { w.name = name; save(); }
    if (data.world !== runId) { data.world = runId; save(); refresh(); }
    autoLink(runId);
  }
  function rememberSpeaker(w, name, extra) {
    const n = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 60), k = keyOf(n);
    if (!k || NARRATOR_RE.test(n)) return null;
    const s = w.speakers[k] || (w.speakers[k] = { name: n, voice: '', lines: 0 });
    if (extra) Object.assign(s, extra);
    return s;
  }
  function absorb(v, req, path) {
    if (!v || typeof v !== 'object') return;
    const runId = req.runId || v.activeRun?.runId || v.activeRunId || v.run?.runId;
    let name = nameOfRun(v.activeRun) || nameOfRun(v.run);
    if (!name && Array.isArray(v.runs)) name = nameOfRun(v.runs.find(x => x?.runId === runId));
    if (Array.isArray(v.runs)) for (const r of v.runs) if (r?.runId && r.lore) lore.set(r.runId, cleanLore(r.lore));
    for (const r of [v.activeRun, v.run]) if (r?.runId && r.lore) lore.set(r.runId, cleanLore(r.lore));
    // /state는 모든 월드를 나열하므로 이미 아는 월드의 이름을 맞춰 둡니다.
    if (Array.isArray(v.runs)) for (const r of v.runs) { const n = nameOfRun(r), x = r?.runId && data.worlds[r.runId]; if (x && n && x.name !== n) { x.name = n; save(); } }
    if (!runId) return;
    attachRun(runId, name);
    const w = world(runId); if (!w) return;
    let changed = false;
    if (Array.isArray(v.cast)) for (const u of v.cast) {
      const sp = u?.name && rememberSpeaker(w, u.name, u.prota ? { prota: true } : null);
      if (!sp) continue;
      changed = true;
      const g = genderOf(u);
      if (g && !sp.gUser && sp.gender !== g) sp.gender = g;
    }
    const run = v.activeRun?.runId === runId ? v.activeRun : v.run?.runId === runId ? v.run : Array.isArray(v.runs) ? v.runs.find(x => x?.runId === runId) : null;
    if (run?.protagonist?.name && rememberSpeaker(w, run.protagonist.name, { prota: true })) changed = true;
    const segs = Array.isArray(v.segments) ? v.segments : Array.isArray(v.beat?.segments) ? v.beat.segments : null;
    if (segs) {
      const list = [];
      for (const s of segs.slice(0, 400)) {
        if (!s || typeof s !== 'object') continue;
        const text = typeof s.text === 'string' ? s.text : typeof s.line === 'string' ? s.line : typeof s.dialogue === 'string' ? s.dialogue : '';
        if (!text.trim()) continue;
        const speaker = String(s.speaker || '').trim();
        const sp = rememberSpeaker(w, speaker);
        if (sp) { sp.lines = (sp.lines || 0) + 1; changed = true; }
        const item = { speaker, text, plain: stripTags(text), n: norm(text) };
        // Gacha Choice(대답 선택지) 패치: 고른 답의 대사(choice.options[].lines)는 장면 대사 번호가 그대로인 채로 나옵니다.
        const opts = Array.isArray(s.choice?.options) ? s.choice.options : null;
        if (opts) item.choice = opts.slice(0, 4).map(o => (Array.isArray(o?.lines) ? o.lines : []).slice(0, 3).filter(y => y && typeof y.text === 'string' && y.text.trim()).map(y => {
          const sp = String(y.speaker || '').trim(), r = rememberSpeaker(w, sp);
          if (r) changed = true;
          return { speaker: sp, text: y.text, plain: stripTags(y.text), n: norm(y.text) };
        }));
        list.push(item);
      }
      if (list.length) {
        const chapter = String(req.chapter ?? v.chapter ?? v.beat?.chapter ?? '');
        const index = String(req.storyIndex ?? v.storyIndex ?? v.beat?.storyIndex ?? '');
        const at = beats.findIndex(b => b.runId === runId && b.chapter === chapter && b.index === index && b.segments.length === list.length);
        if (at >= 0) beats.splice(at, 1);
        beats.push({ runId, chapter, index, path, segments: list });
        while (beats.length > 12) beats.shift();
        matchedKey = ''; schedule(50);
      }
    }
    if (changed) save();
    refresh();
  }
  // 대사의 영어 감정 태그는 화면에서 숨깁니다. 음성용 원문은 위에서 따로 보관합니다.
  function stripDeep(v, key, depth = 0) {
    if (depth > 12 || v == null) return [v, false];
    if (typeof v === 'string') { if (!TEXT_KEYS.has(key)) return [v, false]; const s = stripTags(v); return [s, s !== v]; }
    if (Array.isArray(v)) { let ch = false; const out = v.map(x => { const [y, c] = stripDeep(x, key, depth + 1); ch = ch || c; return y; }); return [ch ? out : v, ch]; }
    if (typeof v === 'object') { let ch = false; const out = {}; for (const [k, x] of Object.entries(v)) { const [y, c] = stripDeep(x, k.toLowerCase(), depth + 1); out[k] = y; ch = ch || c; } return [ch ? out : v, ch]; }
    return [v, false];
  }
  const priorFetch = window.fetch;
  window.fetch = async function (input, init) {
    const result = priorFetch.apply(this, arguments);
    let url, req = {};
    try {
      url = new URL(typeof input === 'string' ? input : input?.url || String(input), location.href);
      if (url.origin !== location.origin) return result;
      // 마리나라 설정 화면에서 TTS 설정(속도 등)을 바꾸면 다시 읽습니다.
      if (/\/api\/tts\/config\/?$/.test(url.pathname) && /^(PUT|POST|PATCH)$/i.test(init?.method || '')) { result.then(r => { if (r.ok) setTimeout(loadTtsConfig, 0); }, () => {}); return result; }
      if (!url.pathname.startsWith('/api/gacha-forge/')) return result;
      if (typeof init?.body === 'string') { try { const b = JSON.parse(init.body); if (b && typeof b === 'object') req = b; } catch {} }
      if (req.runId) attachRun(req.runId);
    } catch { return result; }
    const res = await result;
    try {
      const type = res.headers?.get?.('content-type') || '';
      if (!res.ok || !type.includes('json') || Number(res.headers.get('content-length') || 0) > 4 * 1024 * 1024) return res;
      const v = await res.clone().json();
      absorb(v, req, url.pathname);
      if (!data.global.stripTags) return res;
      const [out, changed] = stripDeep(v, '');
      if (!changed) return res;
      const headers = new Headers(res.headers); headers.delete('content-length'); headers.delete('content-encoding');
      return new Response(JSON.stringify(out), { status: res.status, statusText: res.statusText, headers });
    } catch { return res; }
  };

  // ---------- 화면의 현재 대사 찾기 ----------
  let gameHost = null, gameRoot = null, gameObserver = null, tickT = 0, lineKey = '', matchedKey = '', settleT = 0, lastLine = null;
  function vnState() {
    const vn = gameRoot?.querySelector('.vn'); if (!vn) return null;
    const cap = gameRoot.querySelector('.vn-caption')?.textContent || '';
    const cnt = (gameRoot.querySelector('.vn-count')?.textContent || '').match(/(\d+)\s*\/\s*(\d+)/);
    const lineEl = vn.querySelector('.vn-line,.vn-text,.vn-body');
    return { text: vn.textContent || '', lineText: lineEl?.textContent || '', caption: cap, line: cnt ? +cnt[1] : 0, total: cnt ? +cnt[2] : 0 };
  }
  // 순수 함수: 화면 글자와 보관한 장면의 대사를 비교해 가장 그럴듯한 한 줄을 고릅니다.
  function matchLine(vn, list, runId) {
    const vis = norm(vn.text), part = norm(vn.lineText);
    let best = null, bestScore = 0, partial = [];
    list.forEach((b, bi) => {
      if (runId && b.runId !== runId) return;
      b.segments.forEach((s, i) => {
        if (!s.n) return;
        let score = 0;
        if (vis.includes(s.n)) score = s.n.length + 10;
        else if (part.length >= 4 && s.n.startsWith(part)) partial.push({ b, s, i });
        if (!score) return;
        if (vn.line && i === vn.line - 1 && (!vn.total || vn.total === b.segments.length)) score += 1000;
        score += bi; // 최근 장면 우선
        if (score > bestScore) { bestScore = score; best = { beat: b, seg: b.segments[i], i }; }
      });
    });
    if (!best && partial.length === 1) best = { beat: partial[0].b, seg: partial[0].s, i: partial[0].i };
    return best;
  }
  function voiceFor(w, seg) {
    const narr = NARRATOR_RE.test(seg.speaker);
    if (narr) return w.narrate ? w.narrator || '' : '';
    const k = keyOf(seg.speaker), s = w.speakers[k];
    if (s?.mute) return '';
    return s?.voice || aliasVoice(w, k) || genderVoice(w, s || aliasOf(w, k)) || w.fallback || '';
  }
  // 성별별 기본 보이스: 인물에 성별이 정해져 있고 그 성별의 기본 보이스가 있을 때.
  function genderVoice(w, s) { return s?.gender === 'f' ? w.fallbackF || '' : s?.gender === 'm' ? w.fallbackM || '' : ''; }
  function defaultFor(w, s) { return genderVoice(w, s) || w.fallback || ''; }
  function aliasOf(w, k) {
    if (k.length < 2) return null;
    const hits = Object.entries(w.speakers).filter(([n]) => n !== k && n.length >= 2 && (n.includes(k) || k.includes(n)));
    return hits.length === 1 ? hits[0][1] : null;
  }
  // 게임이 인물 성별을 알려 주면 그대로 씁니다. 사용자가 직접 고른 성별은 바꾸지 않습니다.
  function genderOf(u) {
    const raw = [u?.gender, u?.sex, u?.pronouns, u?.profile?.gender, u?.card?.gender].find(x => typeof x === 'string' && x.trim());
    if (!raw) return '';
    const g = raw.trim().toLowerCase();
    if (/^(f|female|woman|girl|she|여|여성|여자|소녀)/.test(g)) return 'f';
    if (/^(m|male|man|boy|he|남|남성|남자|소년)/.test(g)) return 'm';
    return '';
  }
  // 대사의 화자 이름이 등장인물 이름과 조금 다를 때(예: '도윤' / '한도윤') 보이스를 지정한 쪽을 씁니다. 후보가 하나일 때만.
  function aliasVoice(w, k) {
    if (k.length < 2) return '';
    const hits = Object.entries(w.speakers).filter(([n, x]) => n !== k && x.voice && !x.mute && n.length >= 2 && (n.includes(k) || k.includes(n)));
    return hits.length === 1 ? hits[0][1].voice : '';
  }
  // 타자기 효과 중에도 주기적으로 보도록 디바운스가 아니라 스로틀로 둡니다.
  function schedule(ms = 120) { if (tickT) return; tickT = setTimeout(() => { tickT = 0; tick(); }, ms); }
  let lastHit = null;
  function tick(retry = 0) {
    if (!data.global.enabled) return;
    const vn = vnState(); if (!vn) return;
    const k = vn.caption + '|' + vn.line + '/' + vn.total + (vn.line ? '' : '|' + norm(vn.text).slice(0, 40));
    if (k === matchedKey) { if (lastHit?.seg.choice) branchTick(vn); return; }
    if (k !== lineKey) { lineKey = k; if (data.global.interrupt && lastLine) stop(); }
    const w = current();
    const hit = w && screenHit(vn);
    if (!hit) {
      // 타자기 효과로 글자가 아직 다 나오지 않았을 수 있어 잠시 뒤 다시 봅니다.
      if (retry < 4) { if (settleT) clearTimeout(settleT); settleT = setTimeout(() => { settleT = 0; if (lineKey === k) tick(retry + 1); }, 450); }
      return;
    }
    matchedKey = k; lastHit = hit;
    const id = hit.beat.chapter + ':' + hit.beat.index + ':' + hit.i + ':' + hash(hit.seg.text);
    if (lastLine?.id === id) return;
    speak(w, hit.seg, id);
    if (data.global.prefetch) {
      const next = hit.beat.segments[hit.i + 1], nv = next && voiceFor(w, next);
      if (nv) fetchClip(nv, speechText(next.text), next.speaker).catch(() => {});
    }
  }
  // 빠르게 넘기면 대사 번호가 먼저 바뀌고 글자는 앞 대사가 잠시 남아 있습니다. 그때 앞 대사로 잘못 맞추면
  // 새 대사를 그 번호에 묶어 버려 읽지 않으므로, 장면의 대사 수가 번호와 맞을 때는 번호가 가리키는 줄만 받습니다.
  function screenHit(vn) {
    const hit = matchLine(vn, beats, data.world);
    if (hit && vn.line && vn.total && hit.beat.segments.length === vn.total && hit.i !== vn.line - 1) return null;
    return hit;
  }
  const AUTO_DELAY = 200;
  function speak(w, seg, id) {
    lastLine = { id, speaker: seg.speaker, text: seg.text, plain: seg.plain, voice: voiceFor(w, seg) };
    refresh();
    if (!w.auto || !lastLine.voice) return;
    const voice = lastLine.voice, text = speechText(lastLine.text), tk = toneKeyOf(seg);
    // 이미 만든 음성은 바로, 새로 만들 음성은 잠깐 기다렸다가 그대로 보고 있을 때만 만듭니다. 빠르게 넘긴 대사에 요금이 들지 않게 합니다.
    if (clips.has(clipKey(voice, text + speedTag()))) return play(voice, text, seg.speaker, id, tk);
    setTimeout(() => { if (lastLine?.id === id) play(voice, text, seg.speaker, id, tk); }, AUTO_DELAY);
  }
  // 대답 선택지를 고른 뒤 나오는 답 대사: 대사 번호가 그대로라 화면 글자로만 구분합니다.
  function branchTick(vn) {
    const w = current(); if (!w) return;
    const vis = norm(vn.lineText || vn.text), part = norm(vn.lineText);
    // 아직 질문 대사(선택지가 붙은 줄)가 보이는 중이면 답 대사가 아닙니다.
    if (lastHit.seg.n && vis.includes(lastHit.seg.n)) return;
    let best = null, partial = [];
    lastHit.seg.choice.forEach((lines, o) => lines.forEach((l, j) => {
      if (!l.n) return;
      if (vis.includes(l.n)) { if (!best || l.n.length > best.l.n.length) best = { l, o, j }; }
      else if (part.length >= 4 && l.n.startsWith(part)) partial.push({ l, o, j });
    }));
    if (!best && partial.length === 1) best = partial[0];
    if (!best) return;
    const id = lastHit.beat.chapter + ':' + lastHit.beat.index + ':' + lastHit.i + ':c' + best.o + '.' + best.j + ':' + hash(best.l.text);
    if (lastLine?.id === id) return;
    if (data.global.interrupt) stop();
    speak(w, best.l, id);
  }
  function replay() {
    if (playingKey) return stop();
    const w = current();
    // 누른 순간 화면의 대사를 다시 찾습니다. 앞에서 놓친 대사가 남아 있어도 지금 보이는 대사를 읽습니다.
    const vn = vnState(), branch = lastLine?.id?.includes(':c') && lineKey === matchedKey;
    if (w && vn && !branch) {
      const hit = screenHit(vn);
      if (hit) {
        const id = hit.beat.chapter + ':' + hit.beat.index + ':' + hit.i + ':' + hash(hit.seg.text);
        matchedKey = lineKey; lastHit = hit;
        if (lastLine?.id !== id) lastLine = { id, speaker: hit.seg.speaker, text: hit.seg.text, plain: hit.seg.plain, voice: voiceFor(w, hit.seg) };
      }
    }
    if (!lastLine) return notify('아직 인식한 대사가 없습니다. 스토리를 진행해 주세요.');
    const voice = w ? voiceFor(w, lastLine) : '';
    if (!voice) {
      if (NARRATOR_RE.test(lastLine.speaker || '')) return notify(w?.narrate ? '내레이터 보이스가 없습니다. 설정 → TTS에서 골라 주세요.' : '지금 대사는 내레이션입니다. 내레이션은 설정 → TTS의 "내레이션도 읽기"를 켜야 읽습니다.', 'bad');
      return notify(lastLine.speaker + (w?.speakers[keyOf(lastLine.speaker)]?.mute ? '은(는) 끔으로 설정되어 있습니다.' : '에 지정된 보이스가 없습니다. 설정 → TTS에서 지정해 주세요.'), 'bad');
    }
    play(voice, speechText(lastLine.text), lastLine.speaker, lastLine.id, toneKeyOf(lastLine));
  }

  // ---------- 감정 태그 로어북 (한 번 만들어 두고 월드에 들어올 때 연결) ----------
  const lore = new Map(); // runId -> 월드 로어북 설정
  function cleanLore(l) {
    const ids = v => [...new Set((Array.isArray(v) ? v : []).map(x => String(x || '').trim()).filter(Boolean))].slice(0, 24);
    const num = v => v === null || v === undefined || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null);
    return { worldIds: ids(l?.worldIds), castIds: ids(l?.castIds), worldBudget: num(l?.worldBudget), castBudget: num(l?.castBudget), beat: l?.beat === true || l?.beat === 'true' };
  }
  // v0.1~0.3이 만든 지침. 사용자가 고치지 않았으면 새 지침으로 바꿔 줍니다.
  const LORE_TEXT_V1 = [
    '[음성 감정 태그 · 가챠 TTS]',
    '인물이 소리 내어 말하는 대사(text)에는 ElevenLabs 음성 연출 태그를 영어 소문자 대괄호로 넣으세요.',
    '예: [happy] [sad] [angry] [excited] [nervous] [curious] [sarcastic] [whispers] [shouts] [laughs] [chuckles] [sighs] [crying] [gasps] [short pause] [long pause]',
    '- 대사 맨 앞에 하나를 두고, 감정이 바뀌는 곳에만 하나 더 넣습니다. 한 대사에 최대 세 개까지.',
    '- 태그는 영어 그대로 쓰고 번역하지 마세요. 내레이션, 화자 이름(speaker), 장소, 선택지에는 넣지 마세요.',
    '- 태그는 화면에서 자동으로 숨겨지고 음성에만 쓰입니다. 대사 내용은 평소와 똑같이 쓰세요.',
  ].join('\n');
  const LORE_VER = 2;
  function loreText() {
    return [
      '[음성 감정 태그 · 가챠 TTS]',
      '인물이 소리 내어 말하는 대사(text)에 ElevenLabs 음성 연출 태그를 영어 소문자 대괄호로 넣으세요. 태그는 화면에서 숨겨지고 음성에만 쓰입니다.',
      '',
      '■ 태그가 적용되는 범위 (가장 중요)',
      '- 태그는 바로 뒤의 말투를 다음 태그가 나올 때까지 계속 바꿉니다. 끝을 표시하지 않으면 대사 끝까지 이어집니다.',
      '- 그래서 강한 태그([shouts] [yelling] [screams] [whispers] [crying] [sobbing] [furious] [panicked])는 그 구절에만 쓰고, 구절이 끝나면 바로 다음 문장 앞에 본래 감정 태그를 다시 붙여 되돌리세요.',
      '  예) [shouts] 멈춰! [tense] …지금 움직이면 다 무너져. [softly] 괜찮아, 천천히.',
      '- 고함·속삭임·울음은 대사 전체가 아니라 실제로 그렇게 말하는 짧은 구절에만 씁니다.',
      '',
      '■ 쓰는 위치와 개수',
      '- 대사 첫머리에 반드시 하나. 이후 문장이나 구절에서 감정·강도·말투가 바뀔 때마다 하나씩 더 붙입니다. 개수 제한은 없지만, 한 문장 앞에 감정 태그는 하나만 둡니다.',
      '- 웃음·한숨 같은 소리 태그는 감정 태그와 별개로, 그 소리가 나는 자리에 넣습니다. 예) [annoyed] 또야? [sighs] [tired] 알았어, 내가 할게.',
      '- 같은 감정이라도 강도를 나눠 쓰세요: 짜증 [irritated] → 화남 [angry] → 격분 [furious], 불안 [uneasy] → 두려움 [scared] → 공포 [terrified].',
      '',
      '■ 감정 (기분과 결)',
      '기쁨: [happy] [cheerful] [delighted] [excited] [elated] [content] [relieved] [proud] [amused]',
      '애정·장난: [warm] [affectionate] [tender] [gentle] [playful] [teasing] [mischievously] [flirty] [smug]',
      '수줍음·당황: [shy] [embarrassed] [flustered] [awkward] [sheepish]',
      '불안·두려움: [uneasy] [nervous] [anxious] [worried] [scared] [terrified] [panicked]',
      '슬픔: [sad] [melancholic] [wistful] [lonely] [hurt] [heartbroken] [regretful] [resigned]',
      '분노·불쾌: [annoyed] [irritated] [frustrated] [angry] [furious] [bitter] [resentful] [disgusted]',
      '냉담·비꼼: [cold] [indifferent] [dismissive] [contemptuous] [sarcastic] [deadpan]',
      '진지·의지: [serious] [tense] [firm] [determined] [confident] [commanding] [solemn]',
      '놀람·궁금: [surprised] [shocked] [startled] [confused] [curious] [suspicious] [thoughtful] [skeptical]',
      '지침: [tired] [exhausted] [sleepy] [bored] [weak] [in pain]',
      '',
      '■ 말투 (다음 태그까지 이어짐 — 끝나면 되돌리기)',
      '[softly] [quietly] [whispers] [murmurs] [mutters] [calmly] [slowly] [rushed] [hesitant] [stammering] [breathless] [trembling] [pleading] [through gritted teeth] [loudly] [shouts] [yelling] [screams] [sing-song]',
      '',
      '■ 소리 (그 자리에서 한 번)',
      '[laughs] [chuckles] [giggles] [snickers] [scoffs] [snorts] [sighs] [exhales] [inhales deeply] [gasps] [gulps] [sniffles] [sobs] [groans] [hums] [clears throat] [tsk]',
      '',
      '■ 쉼',
      '[short pause] [pause] [long pause] — 말을 고르거나 머뭇거리는 곳에. 말줄임표(…)와 함께 써도 됩니다.',
      '',
      '■ 지킬 것',
      '- 태그는 위의 영어 그대로 쓰고 번역하지 마세요. 목록에 없는 영어 태그도 쓸 수 있지만 영어 소문자로만 씁니다.',
      '- 내레이션, 화자 이름(speaker), 장소, 선택지에는 넣지 마세요.',
      '- 대사 내용은 평소와 똑같이 쓰고, 태그 때문에 문장을 늘리거나 바꾸지 마세요.',
    ].join('\n');
  }
  // 확장이 만든 그대로인 지침만 새 버전으로 바꿉니다. 사용자가 고친 내용은 덮어쓰지 않습니다.
  async function upgradeLoreText(force) {
    const L = data.lore;
    if (!L.id || !L.entryId || (!force && L.textVer >= LORE_VER)) return false;
    const path = '/api/lorebooks/' + encodeURIComponent(L.id) + '/entries/' + encodeURIComponent(L.entryId);
    const entry = await api(path);
    const content = String(entry?.content ?? entry?.entry?.content ?? '').trim();
    const untouched = content === LORE_TEXT_V1 || (L.textHash && hash(content) === L.textHash) || content === loreText();
    if (!force && !untouched) { L.textVer = LORE_VER; L.edited = true; save(); return false; }
    await api(path, 'PATCH', { content: loreText() });
    Object.assign(L, { textVer: LORE_VER, textHash: hash(loreText()), edited: false, updatedAt: now() });
    save();
    return true;
  }
  async function ensureLorebook() {
    const L = data.lore;
    if (L.id) {
      try { await api('/api/lorebooks/' + encodeURIComponent(L.id)); upgradeLoreText().catch(() => {}); return L.id; }
      catch (e) { if (e.status !== 404) throw e; L.id = ''; L.entryId = ''; }
    }
    const book = await api('/api/lorebooks', 'POST', { name: LORE_NAME, description: '가챠 TTS 확장이 만든 로어북입니다. 대사에 음성 감정 태그를 넣도록 안내합니다. 내용은 자유롭게 고쳐도 됩니다.', enabled: true, isGlobal: false, tags: [LORE_TAG] });
    const entry = await api('/api/lorebooks/' + encodeURIComponent(book.id) + '/entries', 'POST', { name: '음성 감정 태그', content: loreText(), constant: true, enabled: true, order: 1, keys: [], position: 0, description: '가챠 TTS' });
    Object.assign(L, { id: book.id, name: LORE_NAME, entryId: entry?.id || '', error: '', createdAt: now(), textVer: LORE_VER, textHash: hash(loreText()), edited: false });
    // 월드마다 다시 한 번 자동 연결할 수 있게 합니다.
    for (const w of Object.values(data.worlds)) w.linkedOnce = false;
    save();
    return book.id;
  }
  async function readLore(runId) {
    const st = await api('/api/gacha-forge/state');
    absorbLore(st);
    const l = lore.get(runId);
    if (!l) throw Error('게임에서 이 월드의 로어북 설정을 읽지 못했습니다.');
    return l;
  }
  function absorbLore(v) { for (const r of [...(Array.isArray(v?.runs) ? v.runs : []), v?.activeRun, v?.run]) if (r?.runId && r.lore) lore.set(r.runId, cleanLore(r.lore)); }
  async function connect(runId, on) {
    const w = world(runId); if (!w) throw Error('월드를 찾지 못했습니다.');
    const id = on ? await ensureLorebook() : data.lore.id;
    if (!id) return;
    const l = await readLore(runId); // 다른 확장의 변경을 덮지 않도록 직전에 다시 읽습니다.
    const rest = l.worldIds.filter(x => x !== id);
    const next = on ? { ...l, worldIds: [id, ...rest].slice(0, 24), beat: true } : { ...l, worldIds: rest };
    const r = await api('/api/gacha-forge/run/lorebooks', 'POST', { runId, lore: next });
    if (r && r.ok === false) throw Error(String(r.error || '게임이 설정 변경을 거부했습니다.'));
    lore.set(runId, cleanLore(r?.lore || next));
    w.linkedOnce = true; w.loreError = ''; save();
  }
  const linking = new Set(), linkFailed = new Set();
  function autoLink(runId) {
    const w = world(runId);
    if (!w || !w.emotion || w.linkedOnce || linking.has(runId) || linkFailed.has(runId)) return;
    linking.add(runId);
    setTimeout(() => {
      connect(runId, true).then(() => { refresh(); })
        .catch(e => { linkFailed.add(runId); const x = world(runId); if (x) { x.loreError = String(e.message || e); save(); } })
        .finally(() => linking.delete(runId));
    }, 1500);
  }
  function linkedState(runId) {
    const l = lore.get(runId);
    if (!data.lore.id) return '로어북 없음';
    if (!l) return '확인 전';
    return l.worldIds.includes(data.lore.id) ? (l.beat ? '연결됨' : '연결됨 · 스토리 장면 사용 꺼짐') : '연결 안 됨';
  }

  // ---------- 스토리 도구 막대(자동·넘기기·기록)의 '듣기' 버튼 ----------
  const ICON_SPEAK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6"/><path d="M18 6.5a7.5 7.5 0 0 1 0 11"/></svg>';
  const ICON_STOP = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6.5" y="6.5" width="11" height="11" rx="1.5"/></svg>';
  function paintButton() {
    const b = gameRoot?.querySelector('button[data-gtts="speak"]');
    if (b) {
      const on = !!playingKey, label = on ? '멈춤' : '듣기';
      // 같은 상태면 다시 쓰지 않아 게임 화면 관찰이 반복되지 않게 합니다.
      if (b.dataset.state !== label) { b.dataset.state = label; b.innerHTML = (on ? ICON_STOP : ICON_SPEAK) + label; }
      b.toggleAttribute('data-on', on);
      b.title = on ? '음성 멈춤' : '현재 대사 듣기' + (data.global.enabled && current()?.auto ? ' (자동 재생 켜짐)' : '');
    }
    if (view.shown) refresh();
  }
  function placeButtons() {
    const tools = gameRoot?.querySelector('.vn-tools');
    if (!tools || tools.querySelector('button[data-gtts="speak"]')) return;
    const b = document.createElement('button'); b.type = 'button'; b.className = 'vn-tool'; b.dataset.gtts = 'speak';
    b.setAttribute('aria-label', '현재 대사 듣기');
    b.addEventListener('pointerdown', e => e.stopPropagation());
    b.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); replay(); });
    tools.prepend(b);
    paintButton();
  }
  // 스토리 화면(.vn)이 사라지거나 가려지면(타이틀·월드 목록으로 나가기, 가챠 포지 닫기) 대사 음성을 멈춥니다. 설정 화면의 미리 듣기는 그대로 둡니다.
  function storyShown() {
    const vn = gameHost?.isConnected && gameRoot?.querySelector('.vn');
    return !!(vn && vn.isConnected && !vn.closest('[hidden]') && vn.getClientRects().length);
  }
  function stopIfLeft() { if (playingKey && !playingKey.startsWith('preview:') && !storyShown()) stop(); }
  setInterval(stopIfLeft, 700);
  function mount() {
    const h = document.querySelector(HOST_TAG);
    if (h !== gameHost || (h && h.shadowRoot !== gameRoot)) {
      if (gameObserver) { gameObserver.disconnect(); gameObserver = null; }
      gameHost = h; gameRoot = h?.shadowRoot || null;
      if (gameRoot) {
        gameObserver = new MutationObserver(records => {
          if (records.every(r => view.root.contains(r.target))) return;
          placeButtons(); schedule(); stopIfLeft();
          // 대사 글자(타자기 효과)·선택지 버튼 변화마다 설정 화면을 찾으면 레이아웃 계산이 반복돼 느려지므로 건너뜁니다.
          if (records.some(r => { const el = r.target.nodeType === 1 ? r.target : r.target.parentElement; return !el?.closest?.('.vn'); })) mountSettings();
        });
        gameObserver.observe(gameRoot, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['data-screen', 'hidden'] });
      }
    }
    placeButtons(); mountSettings(); stopIfLeft();
  }

  // ---------- 가챠 포지 설정 화면 왼쪽 목록에 'TTS' 항목 ----------
  // 게임 자체 클래스(st-sect, st-plate, ob-control, ob-toggle, st-compress)로 그려 게임 화면처럼 보이게 합니다.
  const CSS = `
.gtts-view{display:flex;flex-direction:column;gap:var(--sp-2,10px);flex:1 1 auto;min-width:0;min-height:0;overflow:auto}
.gtts-view .st-plate{display:flex;flex-direction:column;gap:var(--sp-2,10px)}
.gtts-sub{font-size:var(--t-tiny,11px);letter-spacing:.04em;color:var(--steel-faint,#7e93ae);margin:0}
.gtts-sub b{color:var(--text,#e8ecf6)}
.gtts-bad{color:var(--alarm,#ff6b6b)}
.gtts-good{color:var(--jade,#3cc9a0)}
.gtts-two{display:grid;grid-template-columns:1fr 1fr;gap:var(--sp-2,10px) var(--sp-3,16px)}
.gtts-row{display:flex;flex-wrap:wrap;align-items:center;gap:var(--sp-1,6px)}
.gtts-spk{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.4fr) auto auto auto auto;align-items:center;gap:var(--sp-1,6px) var(--sp-2,10px);padding:calc(var(--f,10px)*.35) 0;border-top:1px solid var(--steel-dark,#34435e)}
.gtts-spk:first-child{border-top:0}
.gtts-spk .nm{font-family:var(--display,inherit);font-weight:700;font-size:var(--t-sm,13px);color:var(--text,#e8ecf6);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gtts-spk .nm small{font-weight:500;font-size:var(--t-tiny,11px);color:var(--steel-faint,#7e93ae);margin-left:.4em}
.gtts-spk select{min-width:0;width:100%}
.gtts-tone{grid-column:1/-1;display:grid;grid-template-columns:1fr 1fr auto;align-items:center;gap:var(--sp-1,6px) var(--sp-3,16px);padding:0 0 calc(var(--f,10px)*.3)}
.gtts-tone label{display:flex;align-items:center;gap:var(--sp-1,6px);font-size:var(--t-tiny,11px);color:var(--steel-faint,#7e93ae);white-space:nowrap}
.gtts-tone output{min-width:3.2em;text-align:right;color:var(--text,#e8ecf6);font-variant-numeric:tabular-nums}
.gtts-spk .st-chip[aria-pressed="true"]{border-color:var(--coral,#f2643c);color:var(--coral,#f2643c)}
.gtts-line{font-size:var(--t-sm,13px);line-height:1.6;color:var(--text,#e8ecf6);padding:calc(var(--f,10px)*.6) calc(var(--f,10px)*.8);border-left:3px solid var(--coral,#f2643c);background:color-mix(in srgb,var(--ink-2,#1a2436) 82%,transparent)}
.gtts-line i{font-style:normal;color:var(--epic,#a77bff);font-size:.85em}
.gtts-view input[type=range]{accent-color:var(--coral,#f2643c);width:100%}
.gtts-view .ob-toggle .ob-bx[aria-checked="true"]{background:var(--coral,#f2643c);border-color:var(--coral,#f2643c);color:var(--on-coral,#fff)}
.gtts-view .ob-toggle .ob-bx[aria-checked="false"] span{visibility:hidden}
.gtts-view .st-compress[disabled]{opacity:.45;cursor:default}
.gtts-view .st-compress.-go{background:var(--coral,#f2643c);border-color:var(--coral,#f2643c);color:var(--on-coral,#fff)}
@media (max-width:760px){.gtts-two{grid-template-columns:1fr}.gtts-spk{grid-template-columns:minmax(0,1fr) minmax(0,1.6fr) auto auto auto}.gtts-spk .gtts-mute{display:none}.gtts-tone{grid-template-columns:1fr}}
`;
  const view = { tone: new Set(), root: document.createElement('div'), body: null, shown: false, tab: null, rail: null, pane: null, hidden: [], deselected: [], title: null };
  view.root.className = 'gtts-view';
  view.root.setAttribute('data-gtts-view', '1');
  view.root.innerHTML = '<style>' + CSS + '</style><div class="gtts-body" style="display:contents"></div>';
  view.body = view.root.lastChild;
  view.root.addEventListener('click', onClick);
  view.root.addEventListener('change', onChange);
  view.root.addEventListener('input', e => {
    const t = e.target;
    if (t.dataset.g === 'volume') { data.global.volume = Number(t.value); retone(); return; }
    // 인물별 음량·속도: 끌면 재생 중인 음성에 바로 반영합니다.
    if (t.dataset.tone) {
      const w = world(t.dataset.run); if (!w) return;
      const tk = t.dataset.tk, field = t.dataset.tone, v = Number(t.value);
      if (tk === '__narr') { w[field === 'vol' ? 'narrVol' : 'narrRate'] = v; touched(w); }
      else { const sp = w.speakers[tk]; if (!sp) return; sp[field] = v; touched(sp); }
      const out = t.parentElement?.querySelector('output'); if (out) out.textContent = toneLabel(field, v);
      if (playingTone === tk) retone();
    }
  });

  function findSettings() {
    for (const s of gameRoot?.querySelectorAll('[data-screen="settings"]') || []) if (s.isConnected && s.getClientRects().length) return s;
    return null;
  }
  function makeTab() {
    const t = document.createElement('button');
    t.type = 'button'; t.className = 'st-sect'; t.setAttribute('role', 'tab'); t.setAttribute('aria-selected', 'false'); t.dataset.gtts = 'tab';
    t.innerHTML = '<span class="k">음성</span><span class="n">TTS</span>';
    t.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); if (!view.shown) showView(); });
    return t;
  }
  function hideView() {
    for (const [n, v, p] of view.hidden) if (n.isConnected) n.style.setProperty('display', v, p);
    for (const n of view.deselected) if (n.isConnected) n.setAttribute('aria-selected', 'true');
    if (view.title && view.title.el.isConnected) view.title.el.textContent = view.title.text;
    view.hidden = []; view.deselected = []; view.title = null;
    view.root.remove(); view.shown = false;
    if (view.tab) view.tab.setAttribute('aria-selected', 'false');
  }
  function showView() {
    const screen = findSettings(); if (!screen) return;
    const pane = screen.querySelector('.st-pane'), rail = screen.querySelector('.st-rail');
    if (!pane || !rail) return;
    if (view.shown && view.pane !== pane) hideView();
    if (!view.shown) {
      for (const n of pane.children) { if (n === view.root) continue; view.hidden.push([n, n.style.getPropertyValue('display'), n.style.getPropertyPriority('display')]); n.style.setProperty('display', 'none', 'important'); }
      pane.append(view.root); view.pane = pane; view.shown = true;
      loadTtsConfig(); if (!voices.length) loadVoices();
      render();
    }
    // 게임이 다시 그릴 때마다 자기 탭을 선택 상태로 돌리므로 우리 탭을 선택 상태로 유지합니다.
    for (const n of rail.children) if (n !== view.tab && n.getAttribute('aria-selected') === 'true') { n.setAttribute('aria-selected', 'false'); if (!view.deselected.includes(n)) view.deselected.push(n); }
    view.tab.setAttribute('aria-selected', 'true');
    const h2 = screen.querySelector('.head-id h2') || gameRoot.querySelector('.head-id h2');
    if (h2 && h2.textContent !== 'TTS') { if (!view.title || view.title.el !== h2) view.title = { el: h2, text: h2.textContent }; h2.textContent = 'TTS'; }
  }
  const boundRails = new WeakSet();
  function mountSettings() {
    const screen = findSettings();
    if (!screen) { if (view.shown) hideView(); return; }
    const rail = screen.querySelector('.st-rail'); if (!rail) return;
    if (!view.tab || !rail.contains(view.tab)) { view.tab = rail.querySelector('[data-gtts="tab"]') || makeTab(); if (!rail.contains(view.tab)) rail.append(view.tab); }
    if (!boundRails.has(rail)) {
      boundRails.add(rail);
      // 게임의 다른 항목을 누르면 화면을 그대로 돌려줍니다.
      rail.addEventListener('click', e => { if (!e.target.closest?.('[data-gtts]') && view.shown) hideView(); }, true);
    }
    if (view.shown) showView();
  }
  function refresh() { if (view.shown) render(); }

  const toggle = (attr, on, label, hint) => '<label class="ob-toggle"><button class="ob-bx" type="button" role="checkbox" aria-checked="' + !!on + '" ' + attr + ' aria-label="' + esc(label) + '"><span>✓</span></button><span class="bt"><b>' + esc(label) + '</b>' + (hint ? '<span class="bd">' + esc(hint) + '</span>' : '') + '</span></label>';
  const plate = (title, kicker, inner) => '<div class="st-plate"><div class="hd"><h3>' + esc(title) + '</h3><span class="k">' + esc(kicker) + '</span></div>' + inner + '</div>';
  const btn = (label, act, extra = '') => '<button class="st-compress" type="button" data-act="' + act + '" ' + extra + '>' + esc(label) + '</button>';
  function voiceSelect(attr, value, emptyLabel) {
    const known = voices.some(v => v.id === value);
    return '<select class="ob-control" ' + attr + '><option value="">' + esc(emptyLabel) + '</option>' +
      voices.map(v => '<option value="' + esc(v.id) + '"' + (v.id === value ? ' selected' : '') + '>' + esc(v.name) + '</option>').join('') +
      (value && !known ? '<option value="' + esc(value) + '" selected>직접 입력: ' + esc(value) + '</option>' : '') +
      '<option value="__custom">보이스 ID 직접 입력…</option></select>';
  }
  function configHtml() {
    if (ttsConfigError) return '<p class="gtts-sub gtts-bad">마리나라 TTS 설정을 읽지 못했습니다: ' + esc(ttsConfigError) + '</p>';
    if (!ttsConfig) return '<p class="gtts-sub">마리나라 TTS 설정 확인 중…</p>';
    const c = ttsConfig, warn = [];
    if (c.enabled !== true) warn.push('마리나라 TTS가 꺼져 있습니다. 연결 → TTS에서 켜 주세요.');
    if (c.source && c.source !== 'elevenlabs') warn.push('TTS 공급자가 ElevenLabs가 아닙니다 (' + c.source + ').');
    if (c.model && !/v3|v4/i.test(c.model)) warn.push('모델 ' + c.model + '은(는) 감정 태그를 지원하지 않을 수 있습니다. eleven_v3 이상을 권장합니다.');
    if (c.skipBracketedText) warn.push('"대괄호 텍스트 건너뛰기"가 켜져 있어 감정 태그가 음성에 전달되지 않습니다.');
    return '<p class="gtts-sub">마리나라 TTS: ' + (c.enabled ? '<b class="gtts-good">켜짐</b>' : '<b class="gtts-bad">꺼짐</b>') + ' · ' + esc(c.source || '?') + ' · ' + esc(c.model || '?') + '</p>' +
      warn.map(x => '<p class="gtts-sub gtts-bad">' + esc(x) + '</p>').join('') +
      (c.skipBracketedText ? '<div class="gtts-row">' + btn('대괄호 건너뛰기 끄기', 'fix-brackets') + '</div>' : '');
  }
  function nowHtml(w) {
    const L = lastLine;
    if (!L) return '<p class="gtts-sub">아직 인식한 대사가 없습니다. 스토리를 진행하면 여기에 현재 대사가 나옵니다.</p>';
    return '<div class="gtts-line"><b>' + esc(L.speaker || '내레이션') + '</b> ' + esc(L.text).replace(/\[[a-z][a-z' -]{0,30}\]/g, m => '<i>' + m + '</i>') + '</div>' +
      '<div class="gtts-row">' + btn(playingKey ? '멈춤' : '다시 듣기', 'replay', 'class="st-compress -go"') +
      '<span class="gtts-sub">보이스: ' + (L.voice ? '<b>' + esc(voices.find(v => v.id === L.voice)?.name || L.voice) + '</b>' : '<span class="gtts-bad">지정 안 됨</span>') + '</span></div>' +
      (lastError ? '<p class="gtts-sub gtts-bad">' + esc(lastError) + '</p>' : '');
  }
  const toneLabel = (field, v) => field === 'vol' ? Math.round(clamp(v ?? 1, 0, VOL_MAX, 1) * 100) + '%' : '×' + clamp(v ?? 1, RATE_MIN, RATE_MAX, 1).toFixed(2);
  const toneSet = o => clamp(o.vol ?? 1, 0, VOL_MAX, 1) !== 1 || clamp(o.rate ?? 1, RATE_MIN, RATE_MAX, 1) !== 1;
  // 조절 버튼: 기본값과 다르면 강조합니다.
  const toneChip = (k, o) => '<button class="st-chip" type="button" data-act="tone" data-tk="' + esc(k) + '" aria-pressed="' + (view.tone.has(k) || toneSet(o)) + '" title="음량·속도">' + (toneSet(o) ? toneLabel('vol', o.vol) + ' ' + toneLabel('rate', o.rate) : '조절') + '</button>';
  function toneRow(runId, k, vol, rate) {
    const a = ' data-run="' + esc(runId) + '" data-tk="' + esc(k) + '"';
    return '<div class="gtts-tone">' +
      '<label>음량 <input type="range" min="0" max="' + VOL_MAX + '" step="0.05" data-tone="vol"' + a + ' value="' + clamp(vol ?? 1, 0, VOL_MAX, 1) + '"><output>' + toneLabel('vol', vol) + '</output></label>' +
      '<label>속도 <input type="range" min="' + RATE_MIN + '" max="' + RATE_MAX + '" step="0.05" data-tone="rate"' + a + ' value="' + clamp(rate ?? 1, RATE_MIN, RATE_MAX, 1) + '"><output>' + toneLabel('rate', rate) + '</output></label>' +
      btn('기본값', 'tone-reset', a) + '</div>';
  }
  function render() {
    if (!view.shown) return;
    const keep = view.root.scrollTop, runId = data.world, w = current(), G = data.global;
    if (!w) {
      view.body.innerHTML = plate('TTS', '음성', '<p class="gtts-sub">아직 월드를 확인하지 못했습니다. 월드를 열고 스토리를 한 번 진행한 뒤 다시 열어 주세요.</p>' + configHtml());
      return;
    }
    const r = ' data-run="' + esc(runId) + '"';
    const speakers = Object.entries(w.speakers).sort((a, b) => (b[1].prota ? 1 : 0) - (a[1].prota ? 1 : 0) || (b[1].lines || 0) - (a[1].lines || 0));
    const rows = speakers.map(([k, s]) => '<div class="gtts-spk"><span class="nm" title="' + esc(s.name) + '">' + esc(s.name) + (s.prota ? '<small>주인공</small>' : s.lines ? '<small>' + s.lines + '줄</small>' : '') + '</span>' +
      voiceSelect('data-spk="' + esc(k) + '"' + r, s.voice || '', defaultFor(w, s) ? (genderVoice(w, s) ? (s.gender === 'f' ? '여자' : '남자') + ' 기본 보이스 사용' : '기본 보이스 사용') : '읽지 않음') +
      btn('▶', 'preview', 'data-voice="' + esc(s.voice || defaultFor(w, s)) + '" data-tk="' + esc(k) + '" title="미리 듣기"' + (s.voice || defaultFor(w, s) ? '' : ' disabled')) +
      '<button class="st-chip" type="button" data-act="gender" data-k="' + esc(k) + '"' + r + ' aria-pressed="' + !!s.gender + '" title="성별: 누르면 바뀝니다 (여 → 남 → 미정)">' + (s.gender === 'f' ? '여' : s.gender === 'm' ? '남' : '성별') + '</button>' +
      toneChip(k, s) +
      '<button class="st-chip gtts-mute" type="button" data-mute="' + esc(k) + '"' + r + ' aria-pressed="' + !!s.mute + '">끔</button>' +
      (view.tone.has(k) ? toneRow(runId, k, s.vol, s.rate) : '') + '</div>').join('');
    const st = linkedState(runId), L = data.lore;
    view.body.innerHTML =
      plate('현재 대사', esc(w.name), nowHtml(w)) +
      plate('재생', '이 월드',
        '<div class="gtts-two">' +
        toggle('data-w="auto"' + r, w.auto, '대사 자동 재생', '대사가 화면에 나오면 바로 읽습니다') +
        toggle('data-w="narrate"' + r, w.narrate, '내레이션도 읽기', '내레이터 보이스를 골라 주세요') + '</div>' +
        '<div class="gtts-two">' +
        '<div class="ob-field"><div class="ob-labelrow"><label>기본 보이스</label></div>' + voiceSelect('data-wv="fallback"' + r, w.fallback, '읽지 않음') + '<span class="gtts-sub">보이스를 지정하지 않은 인물에게 씁니다</span></div>' +
        '<div class="ob-field"><div class="ob-labelrow"><label>여자 기본 보이스</label></div>' + voiceSelect('data-wv="fallbackF"' + r, w.fallbackF || '', w.fallback ? '기본 보이스 사용' : '읽지 않음') + '<span class="gtts-sub">성별을 [여]로 정한 인물</span></div>' +
        '<div class="ob-field"><div class="ob-labelrow"><label>남자 기본 보이스</label></div>' + voiceSelect('data-wv="fallbackM"' + r, w.fallbackM || '', w.fallback ? '기본 보이스 사용' : '읽지 않음') + '<span class="gtts-sub">성별을 [남]으로 정한 인물</span></div>' +
        (w.narrate ? '<div class="ob-field"><div class="ob-labelrow"><label>내레이터</label></div>' + voiceSelect('data-wv="narrator"' + r, w.narrator, '읽지 않음') + '</div>' : '') + '</div>' +
        (w.narrate ? '<div class="gtts-spk"><span class="nm">내레이터 음량·속도</span><span></span>' + btn('▶', 'preview', 'data-voice="' + esc(w.narrator || '') + '" data-tk="__narr" title="미리 듣기"' + (w.narrator ? '' : ' disabled')) + '<span></span>' + toneChip('__narr', { vol: w.narrVol, rate: w.narrRate }) + '<span></span>' + (view.tone.has('__narr') ? toneRow(runId, '__narr', w.narrVol, w.narrRate) : '') + '</div>' : '')) +
      plate('인물별 보이스', '이 월드',
        '<p class="gtts-sub">장면에 나온 화자가 자동으로 추가됩니다. 보이스는 이 월드에만 적용됩니다.</p>' +
        '<div>' + (rows || '<p class="gtts-sub">아직 인식한 화자가 없습니다.</p>') + '</div>' +
        '<div class="gtts-row">' + btn('화자 직접 추가', 'add-speaker', r) + btn('보이스 목록 새로고침', 'reload-voices') + '</div>' +
        (voicesError ? '<p class="gtts-sub gtts-bad">' + esc(voicesError) + '</p>' : '')) +
      plate('감정 태그 로어북', '이 월드',
        '<p class="gtts-sub">공용 로어북 <b>' + esc(LORE_NAME) + '</b>을(를) 이 월드의 로어북 맨 앞에 연결해 AI가 대사에 [happy] 같은 감정 태그를 넣게 합니다. 태그는 화면에서 숨겨지고 음성에만 쓰입니다. 월드에 처음 들어올 때 한 번 자동으로 연결합니다.</p>' +
        toggle('data-w="emotion"' + r, w.emotion, '감정 태그 로어북 사용') +
        '<p class="gtts-sub">상태: <b>' + esc(st) + '</b>' + (w.loreError ? ' · <span class="gtts-bad">' + esc(w.loreError) + '</span>' : '') + (L.id ? '' : ' · 로어북은 처음 연결할 때 만듭니다') + '</p>' +
        '<div class="gtts-row">' + (st.startsWith('연결됨') ? btn('연결 해제', 'unlink', r) : btn('지금 연결', 'link', r + ' class="st-compress -go"')) + btn('상태 확인', 'check-link', r) + btn('지침용 문구 복사', 'copy-guide') + (L.id && L.entryId ? btn('기본 지침으로 바꾸기', 'reset-lore') : '') + '</div>' +
        (L.edited ? '<p class="gtts-sub">로어북 지침을 직접 고치셔서 새 기본 지침(v' + LORE_VER + ')으로 자동으로 바꾸지 않았습니다. 바꾸려면 [기본 지침으로 바꾸기]를 눌러 주세요.</p>' : (L.updatedAt ? '<p class="gtts-sub">지침을 최신 버전으로 바꿨습니다 · ' + esc(L.updatedAt) + '</p>' : '')) +
        '<p class="gtts-sub">로어북 내용은 마리나라 로어북 화면에서 자유롭게 고칠 수 있고, 확장이 덮어쓰지 않습니다. 스토리 지침에 직접 넣고 싶다면 문구를 복사해 붙여 넣고 위 항목을 꺼 주세요.</p>') +
      plate('공통', '모든 월드',
        '<div class="gtts-two">' +
        toggle('data-g="enabled"', G.enabled, '확장 사용') +
        toggle('data-g="interrupt"', G.interrupt, '넘기면 음성 멈춤', '다음 대사로 넘기면 재생 중인 음성을 멈춥니다') +
        toggle('data-g="prefetch"', G.prefetch, '다음 대사 미리 만들기', '빨라지지만 건너뛴 대사도 요금이 듭니다') +
        toggle('data-g="stripTags"', G.stripTags, '화면에서 감정 태그 숨기기') +
        toggle('data-g="serverCache"', G.serverCache !== false, '만든 음성을 서버에 저장', '기기를 바꾸거나 새로고침해도 같은 대사는 다시 만들지 않습니다') + '</div>' +
        (G.serverCache !== false ? '<p class="gtts-sub">이번 접속: 서버에서 불러옴 <b>' + stats.server + '</b> · 새로 만듦 <b>' + stats.made + '</b> · 서버에 저장 <b>' + stats.saved + '</b>' + (stats.saveError ? ' · <span class="gtts-bad">' + esc(stats.saveError) + '</span>' : '') + '</p><p class="gtts-sub">저장 위치: 마리나라 데이터 폴더의 game-assets/sfx/.gacha-tts (게임 효과음 목록에는 나오지 않습니다)</p>' : '') +
        '<div class="ob-field"><div class="ob-labelrow"><label>음량</label></div><input type="range" min="0" max="1" step="0.05" data-g="volume" value="' + esc(G.volume) + '"></div>' +
        configHtml());
    view.root.scrollTop = keep;
  }
  // ---------- 자체 알림·확인 창 ----------
  // 브라우저 기본 alert/confirm/prompt는 전체 화면을 풀어 버리므로, 게임 화면(전체 화면 요소) 안에 직접 그립니다.
  const UI_CSS = `
.gtts-veil{position:fixed;inset:0;z-index:2147483000;display:grid;place-items:center;background:rgba(6,10,18,.55);font-family:var(--body,inherit)}
.gtts-modal{width:min(440px,calc(100vw - 32px));max-height:calc(100dvh - 32px);overflow:auto;display:flex;flex-direction:column;gap:var(--sp-2,10px);padding:var(--sp-3,16px);
  background:var(--ink-2,#1a2436);border:1px solid var(--steel-dark,#34435e);border-top:3px solid var(--coral,#f2643c);color:var(--text,#e8ecf6);
  --cut:.6em;clip-path:var(--clip-card,none);border-radius:var(--radius,6px);box-shadow:0 18px 50px #000a;animation:gtts-in .16s ease-out}
.gtts-modal h3{margin:0;font-family:var(--display,inherit);font-stretch:var(--stretch,normal);font-weight:700;font-size:var(--t-md,15px);letter-spacing:.06em}
.gtts-modal p{margin:0;font-size:var(--t-sm,13px);line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere}
.gtts-modal input,.gtts-modal textarea{width:100%;box-sizing:border-box;font:inherit;font-size:var(--t-sm,13px);color:var(--text,#e8ecf6);background:var(--ink-3,#1e2a40);border:1px solid var(--steel-dark,#34435e);padding:calc(var(--f,10px)*.5) calc(var(--f,10px)*.7);border-radius:var(--radius-sm,3px)}
.gtts-modal input:focus,.gtts-modal textarea:focus{outline:none;border-color:var(--coral,#f2643c)}
.gtts-modal .gtts-acts{display:flex;justify-content:flex-end;gap:var(--sp-1,6px)}
.gtts-modal button{cursor:pointer;font-family:var(--display,inherit);font-weight:700;font-size:var(--t-xs,12px);letter-spacing:.1em;padding:calc(var(--f,10px)*.5) calc(var(--f,10px)*1.2);
  background:transparent;border:1px solid var(--steel-dark,#34435e);color:var(--text,#e8ecf6);border-radius:var(--radius-sm,3px)}
.gtts-modal button:hover{border-color:var(--coral,#f2643c)}
.gtts-modal button.-go{background:var(--coral,#f2643c);border-color:var(--coral,#f2643c);color:var(--on-coral,#fff)}
.gtts-toast{position:fixed;left:50%;bottom:calc(var(--sp-3,16px)*2);transform:translateX(-50%);z-index:2147483001;max-width:min(520px,calc(100vw - 32px));
  padding:calc(var(--f,10px)*.7) calc(var(--f,10px)*1.2);background:var(--ink-2,#1a2436);border:1px solid var(--steel-dark,#34435e);border-left:3px solid var(--coral,#f2643c);
  color:var(--text,#e8ecf6);font-size:var(--t-sm,13px);line-height:1.5;border-radius:var(--radius-sm,3px);box-shadow:0 10px 30px #0009;animation:gtts-in .16s ease-out;pointer-events:none}
.gtts-toast[data-tone=bad]{border-left-color:var(--alarm,#ff6b6b)}
@keyframes gtts-in{from{opacity:0;transform:translateY(6px)}}
.gtts-toast{animation-name:gtts-toast-in}@keyframes gtts-toast-in{from{opacity:0;transform:translate(-50%,6px)}}
`;
  function uiLayer() {
    // 전체 화면 중인 요소(보통 가챠 포지) 안에 있어야 보입니다.
    const fsEl = document.fullscreenElement;
    const root = gameRoot && (!fsEl || fsEl === gameHost || fsEl.contains(gameHost)) ? gameRoot : fsEl || document.body;
    if (![...root.children].some(n => n.dataset?.gttsUi)) { const st = document.createElement('style'); st.dataset.gttsUi = '1'; st.textContent = UI_CSS; root.append(st); }
    return root;
  }
  let toastT = 0;
  function notify(msg, tone = '') {
    const root = uiLayer();
    for (const n of [...root.children]) if (n.classList?.contains('gtts-toast')) n.remove();
    const t = document.createElement('div'); t.className = 'gtts-toast'; t.setAttribute('role', 'status'); if (tone) t.dataset.tone = tone;
    t.textContent = msg; root.append(t);
    clearTimeout(toastT); toastT = setTimeout(() => t.remove(), 3200);
  }
  // ask(제목, 내용, {input, value, multiline, ok, cancel}) → 확인: 입력값 또는 true, 취소: null
  function ask(title, msg, o = {}) {
    return new Promise(resolve => {
      const root = uiLayer();
      const veil = document.createElement('div'); veil.className = 'gtts-veil';
      const field = o.input ? (o.multiline ? '<textarea rows="8" readonly></textarea>' : '<input type="text" autocomplete="off" spellcheck="false">') : '';
      veil.innerHTML = '<div class="gtts-modal" role="dialog" aria-modal="true"><h3></h3>' + (msg ? '<p></p>' : '') + field +
        '<div class="gtts-acts">' + (o.cancel === false ? '' : '<button type="button" data-a="no">' + esc(o.cancel || '취소') + '</button>') + '<button type="button" class="-go" data-a="ok">' + esc(o.ok || '확인') + '</button></div></div>';
      veil.querySelector('h3').textContent = title;
      if (msg) veil.querySelector('p').textContent = msg;
      const inp = veil.querySelector('input,textarea');
      if (inp) inp.value = o.value || '';
      const done = ok => { veil.remove(); resolve(ok ? (inp && !o.multiline ? inp.value : true) : null); };
      // 게임이 클릭·키 입력으로 대사를 넘기지 않도록 여기서 멈춥니다.
      for (const type of ['pointerdown', 'mousedown', 'click', 'wheel', 'touchstart']) veil.addEventListener(type, e => e.stopPropagation());
      veil.addEventListener('keydown', e => {
        e.stopPropagation();
        if (e.key === 'Escape') { e.preventDefault(); done(false); }
        else if (e.key === 'Enter' && !(inp && o.multiline)) { e.preventDefault(); done(true); }
      });
      veil.addEventListener('click', e => { const a = e.target.closest('[data-a]')?.dataset.a; if (a) done(a === 'ok'); else if (e.target === veil) done(false); });
      root.append(veil);
      setTimeout(() => { if (inp) { inp.focus(); inp.select(); } else veil.querySelector('.-go').focus(); }, 0);
    });
  }
  async function busy(el, fn) {
    if (el) el.disabled = true;
    try { await fn(); } catch (e) { notify(String(e.message || e), 'bad'); } finally { if (el) el.disabled = false; refresh(); }
  }
  function onClick(e) {
    const t = e.target.closest('[data-act],[role=checkbox],[data-mute]'); if (!t) return;
    e.preventDefault();
    const run = t.dataset.run, w = world(run);
    if (t.getAttribute('role') === 'checkbox') {
      const on = t.getAttribute('aria-checked') !== 'true';
      if (t.dataset.g) { data.global[t.dataset.g] = on; data.gt = Date.now(); save(); paintButton(); return refresh(); }
      if (t.dataset.w && w) {
        const k = t.dataset.w; w[k] = on; touched(w); save(); paintButton();
        if (k === 'emotion') connect(run, on).catch(err => { w.loreError = String(err.message || err); save(); }).finally(refresh);
        return refresh();
      }
      return;
    }
    if (t.dataset.mute && w) { const s = w.speakers[t.dataset.mute]; if (s) { s.mute = !s.mute; touched(s); save(); if (lastLine && current() === w) lastLine.voice = voiceFor(w, lastLine); } return refresh(); }
    const act = t.dataset.act;
    if (act === 'replay') { replay(); return refresh(); }
    if (act === 'preview') { const v = t.dataset.voice; if (v) play(v, SAMPLE_TEXT, '', 'preview:' + v, t.dataset.tk || ''); return; }
    if (act === 'gender' && w) {
      const sp = w.speakers[t.dataset.k];
      if (sp) { sp.gender = sp.gender === 'f' ? 'm' : sp.gender === 'm' ? '' : 'f'; sp.gUser = true; touched(sp); save(); if (lastLine && current() === w) lastLine.voice = voiceFor(w, lastLine); }
      return refresh();
    }
    if (act === 'tone') { const k = t.dataset.tk; view.tone.has(k) ? view.tone.delete(k) : view.tone.add(k); return refresh(); }
    if (act === 'tone-reset' && w) {
      const k = t.dataset.tk;
      if (k === '__narr') { w.narrVol = 1; w.narrRate = 1; touched(w); }
      else { const sp = w.speakers[k]; if (sp) { sp.vol = 1; sp.rate = 1; touched(sp); } }
      save(); retone(); return refresh();
    }
    if (act === 'reload-voices') return busy(t, loadVoices);
    if (act === 'add-speaker' && w) { ask('화자 추가', '가챠 포지 대사에 표시되는 이름 그대로 적어 주세요.', { input: true, ok: '추가' }).then(n => { if (n && n.trim() && rememberSpeaker(w, n)) { save(); refresh(); } }); return; }
    if (act === 'link' && w) { w.emotion = true; touched(w); return busy(t, () => connect(run, true)); }
    if (act === 'unlink' && w) return busy(t, () => connect(run, false));
    if (act === 'check-link') return busy(t, () => readLore(run));
    if (act === 'reset-lore') {
      ask('기본 지침으로 바꾸기', '로어북 「' + LORE_NAME + '」의 지침을 확장의 최신 기본 지침으로 덮어씁니다. 직접 고친 내용은 사라집니다.', { ok: '바꾸기' }).then(ok => {
        if (ok) busy(t, async () => { await upgradeLoreText(true); notify('지침을 최신 기본 지침으로 바꿨습니다. 다음 장면부터 반영됩니다.'); });
      });
      return;
    }
    if (act === 'copy-guide') {
      const txt = loreText(), show = () => ask('지침용 문구', '아래 문구를 복사해 스토리 지침에 붙여 넣어 주세요.', { input: true, multiline: true, value: txt, cancel: false, ok: '닫기' });
      (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject()).then(() => notify('복사했습니다. 가챠 포지 스토리 지침에 붙여 넣어 주세요.'), show);
      return;
    }
    if (act === 'fix-brackets') {
      ask('대괄호 건너뛰기 끄기', '마리나라 TTS 설정의 "대괄호 텍스트 건너뛰기"를 끕니다. 다른 TTS 설정은 그대로 둡니다.', { ok: '끄기' }).then(ok => {
        if (ok) busy(t, async () => { const c = await api('/api/tts/config'); await api('/api/tts/config', 'PUT', { ...c, skipBracketedText: false }); await loadTtsConfig(); });
      });
    }
  }
  function onChange(e) {
    const t = e.target, run = t.dataset.run, w = world(run);
    if (t.dataset.g === 'volume') { data.gt = Date.now(); save(); return; }
    if (t.dataset.tone) { save(); return refresh(); }
    if (!w || t.tagName !== 'SELECT') return;
    if (t.value === '__custom') {
      ask('보이스 ID 입력', 'ElevenLabs 보이스 ID를 입력해 주세요.', { input: true }).then(v => { v = (v || '').trim(); if (v) setVoice(t, w, v); else refresh(); });
      return;
    }
    setVoice(t, w, t.value);
  }
  function setVoice(t, w, value) {
    if (t.dataset.wv) { w[t.dataset.wv] = value; touched(w); }
    else if (t.dataset.spk) { const s = w.speakers[t.dataset.spk]; if (s) { s.voice = value; touched(s); } }
    save();
    if (lastLine && current() === w) lastLine.voice = voiceFor(w, lastLine);
    refresh();
  }

  // ---------- 시작 ----------
  syncPull();
  // 예전 버전이 만든 지침을 새 지침으로 바꿉니다 (직접 고친 경우 제외).
  setTimeout(() => upgradeLoreText().catch(() => {}), 4000);
  mount();
  new MutationObserver(() => { if (!gameRoot || !gameHost?.isConnected) mount(); }).observe(document.documentElement, { childList: true, subtree: true });
  loadTtsConfig();
  setInterval(() => { if (document.visibilityState !== 'hidden') loadTtsConfig(); }, 60000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { syncPull(); loadTtsConfig(); } else { stop(); flushSync(); } });
  addEventListener('pagehide', () => { stop(); flushSync(); });
  // 같은 기기의 다른 탭에서 바꾼 설정
  addEventListener('storage', e => { if (e.key !== STORE || !e.newValue) return; try { if (mergeData(data, JSON.parse(e.newValue))) applyMerged(); } catch {} });
  // 다른 기기에서 바꾼 보이스를 새로고침 없이 받아옵니다.
  setInterval(() => { if (document.visibilityState !== 'hidden') syncPull(); }, 20000);

  globalThis.__gfTts = { get lastLine() { return lastLine; }, clips, speedTag, loadTtsConfig, mergeData, toneOf, get audio() { return audio; }, fetchClip, upgradeLoreText, LORE_TEXT_V1, matchLine, norm, stripTags, stripDeep, voiceFor, cleanLore, loreText, get data() { return data; }, get beats() { return beats; } };
})();
