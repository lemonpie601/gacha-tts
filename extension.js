/* 가챠 TTS v0.1.0 — Gacha Forge 대사 음성(ElevenLabs via Marinara TTS). 월드별 보이스 설정, 감정 태그 로어북 연결. */
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
  const initial = () => ({ v: 1, at: 0, world: '', worlds: {}, global: { enabled: true, volume: 1, interrupt: true, prefetch: false, stripTags: true }, lore: { id: '', name: '', entryId: '', error: '' } });
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
  let syncT = 0;
  function host() { try { const m = typeof marinara === 'object' && marinara ? marinara : globalThis.marinara; return m && m.storage && typeof m.storage.get === 'function' && typeof m.storage.patch === 'function' ? m : null; } catch { return null; } }
  function syncSchedule() {
    const h = host(); if (!h) return;
    if (syncT) clearTimeout(syncT);
    syncT = setTimeout(() => { syncT = 0; h.storage.patch({ gtts: { at: data.at, json: JSON.stringify({ ...data, world: undefined }) } }).catch(() => {}); }, 4000);
  }
  async function syncPull() {
    const h = host(); if (!h) return;
    try {
      const rec = (await h.storage.get())?.gtts;
      if (!rec || !(rec.at > (data.at || 0))) { if (!rec && Object.keys(data.worlds).length) syncSchedule(); return; }
      const remote = JSON.parse(rec.json);
      if (!remote || remote.v !== 1) return;
      data = { ...initial(), ...remote, world: data.world, global: { ...initial().global, ...remote.global }, lore: { ...initial().lore, ...remote.lore } };
      try { localStorage.setItem(STORE, JSON.stringify(data)); } catch {}
      if (panel) render();
    } catch {}
  }

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
  async function loadTtsConfig() {
    try { ttsConfig = await api('/api/tts/config'); ttsConfigError = ''; } catch (e) { ttsConfig = null; ttsConfigError = String(e.message || e); }
    if (panel && tab !== 'play') render();
  }
  async function loadVoices() {
    try {
      const v = await api('/api/tts/voices');
      const raw = Array.isArray(v?.voiceOptions) ? v.voiceOptions : Array.isArray(v?.voices) ? v.voices.map(x => typeof x === 'string' ? { id: x, name: x } : { id: x?.voice_id || x?.id, name: x?.name }) : [];
      voices = raw.filter(x => x && x.id).map(x => ({ id: String(x.id), name: String(x.name || x.id) }));
      voicesError = voices.length ? '' : '보이스 목록이 비어 있습니다.';
    } catch (e) { voicesError = '보이스 목록을 불러오지 못했습니다: ' + String(e.message || e); }
    if (panel && tab === 'settings') render();
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
  function fetchClip(voice, text, speaker) {
    const k = clipKey(voice, text);
    if (clips.has(k)) return clips.get(k);
    const p = (async () => {
      let admin = ''; try { admin = String(localStorage.getItem('marinara_admin_secret') || '').trim(); } catch {}
      const r = await fetch('/api/tts/speak', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'x-marinara-csrf': '1', 'X-Marinara-TTS-Line': '1', ...(admin ? { 'X-Admin-Secret': admin } : {}) },
        body: JSON.stringify({ text, voice, ...(speaker ? { speaker } : {}) }),
      });
      if (!r.ok) { const j = await r.json().catch(() => null); throw Error(j?.error || ('음성 생성 실패 (HTTP ' + r.status + ')')); }
      const blob = await r.blob();
      if (!blob.size) throw Error('음성 응답이 비어 있습니다.');
      return URL.createObjectURL(blob);
    })();
    clips.set(k, p);
    p.catch(() => clips.delete(k));
    while (clips.size > 60) { const [old, op] = clips.entries().next().value; clips.delete(old); op.then(u => URL.revokeObjectURL(u)).catch(() => {}); }
    return p;
  }
  function stop() {
    if (audio) { audio.onended = null; audio.pause(); audio = null; }
    playingKey = ''; paintButton();
  }
  async function play(voice, text, speaker, key) {
    if (!voice || !text) return;
    stop();
    playingKey = key || clipKey(voice, text); paintButton();
    const mine = playingKey;
    try {
      const url = await fetchClip(voice, text, speaker);
      if (playingKey !== mine) return;
      audio = new Audio(url);
      audio.volume = Math.max(0, Math.min(1, Number(data.global.volume) || 0));
      audio.onended = () => { if (playingKey === mine) { playingKey = ''; audio = null; paintButton(); } };
      await audio.play();
      lastError = '';
    } catch (e) {
      if (playingKey === mine) { playingKey = ''; paintButton(); }
      lastError = String(e.message || e);
      console.warn('[가챠 TTS]', lastError);
      if (panel && tab === 'play') render();
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
    if (data.world !== runId) { data.world = runId; save(); if (panel) render(); }
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
    if (Array.isArray(v.cast)) for (const u of v.cast) { if (u?.name && rememberSpeaker(w, u.name, u.prota ? { prota: true } : null)) changed = true; }
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
        list.push({ speaker, text, plain: stripTags(text), n: norm(text) });
      }
      if (list.length) {
        const chapter = String(req.chapter ?? v.chapter ?? v.beat?.chapter ?? '');
        const index = String(req.storyIndex ?? v.storyIndex ?? v.beat?.storyIndex ?? '');
        const at = beats.findIndex(b => b.runId === runId && b.chapter === chapter && b.index === index && b.segments.length === list.length);
        if (at >= 0) beats.splice(at, 1);
        beats.push({ runId, chapter, index, path, segments: list });
        while (beats.length > 12) beats.shift();
        lineKey = ''; schedule(50);
      }
    }
    if (changed) save();
    if (panel && tab === 'settings') render();
  }
  // 대사의 영어 감정 태그는 화면에서 숨깁니다. 음성용 원문은 위에서 따로 보관합니다.
  function stripDeep(v, key, depth = 0) {
    if (depth > 8 || v == null) return [v, false];
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
      if (url.origin !== location.origin || !url.pathname.startsWith('/api/gacha-forge/')) return result;
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
  let gameHost = null, gameRoot = null, gameObserver = null, tickT = 0, lineKey = '', settleT = 0, lastLine = null;
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
    const s = w.speakers[keyOf(seg.speaker)];
    if (s?.mute) return '';
    return s?.voice || w.fallback || '';
  }
  function schedule(ms = 120) { if (tickT) clearTimeout(tickT); tickT = setTimeout(() => { tickT = 0; tick(); }, ms); }
  function tick(retry = 0) {
    if (!data.global.enabled) return;
    const vn = vnState(); if (!vn) return;
    const k = vn.caption + '|' + vn.line + '/' + vn.total + (vn.line ? '' : '|' + norm(vn.text).slice(0, 40));
    if (k === lineKey && retry === 0) return;
    if (k !== lineKey) { lineKey = k; if (data.global.interrupt) stop(); }
    const w = current();
    const hit = w && matchLine(vn, beats, data.world);
    if (!hit) {
      // 타자기 효과로 글자가 아직 다 나오지 않았을 수 있어 잠시 뒤 다시 봅니다.
      if (retry < 4) { if (settleT) clearTimeout(settleT); settleT = setTimeout(() => { settleT = 0; if (lineKey === k) tick(retry + 1); }, 450); }
      return;
    }
    const id = hit.beat.chapter + ':' + hit.beat.index + ':' + hit.i + ':' + hash(hit.seg.text);
    if (lastLine?.id === id) return;
    lastLine = { id, speaker: hit.seg.speaker, text: hit.seg.text, plain: hit.seg.plain, voice: voiceFor(w, hit.seg) };
    if (panel && tab === 'play') render();
    if (w.auto && lastLine.voice) play(lastLine.voice, speechText(lastLine.text), lastLine.speaker, id);
    if (data.global.prefetch) {
      const next = hit.beat.segments[hit.i + 1], nv = next && voiceFor(w, next);
      if (nv) fetchClip(nv, speechText(next.text), next.speaker).catch(() => {});
    }
  }
  function replay() {
    if (playingKey) return stop();
    if (!lastLine) return openPanel();
    const w = current(); const voice = w ? voiceFor(w, lastLine) : '';
    if (!voice) { alert((lastLine.speaker || '내레이션') + '에 지정된 보이스가 없습니다. 가챠 TTS 설정에서 지정해 주세요.'); return openPanel('settings'); }
    play(voice, speechText(lastLine.text), lastLine.speaker, lastLine.id);
  }

  // ---------- 감정 태그 로어북 (한 번 만들어 두고 월드에 들어올 때 연결) ----------
  const lore = new Map(); // runId -> 월드 로어북 설정
  function cleanLore(l) {
    const ids = v => [...new Set((Array.isArray(v) ? v : []).map(x => String(x || '').trim()).filter(Boolean))].slice(0, 24);
    const num = v => v === null || v === undefined || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null);
    return { worldIds: ids(l?.worldIds), castIds: ids(l?.castIds), worldBudget: num(l?.worldBudget), castBudget: num(l?.castBudget), beat: l?.beat === true || l?.beat === 'true' };
  }
  function loreText() {
    return [
      '[음성 감정 태그 · 가챠 TTS]',
      '인물이 소리 내어 말하는 대사(text)에는 ElevenLabs 음성 연출 태그를 영어 소문자 대괄호로 넣으세요.',
      '예: [happy] [sad] [angry] [excited] [nervous] [curious] [sarcastic] [whispers] [shouts] [laughs] [chuckles] [sighs] [crying] [gasps] [short pause] [long pause]',
      '- 대사 맨 앞에 하나를 두고, 감정이 바뀌는 곳에만 하나 더 넣습니다. 한 대사에 최대 세 개까지.',
      '- 태그는 영어 그대로 쓰고 번역하지 마세요. 내레이션, 화자 이름(speaker), 장소, 선택지에는 넣지 마세요.',
      '- 태그는 화면에서 자동으로 숨겨지고 음성에만 쓰입니다. 대사 내용은 평소와 똑같이 쓰세요.',
    ].join('\n');
  }
  async function ensureLorebook() {
    const L = data.lore;
    if (L.id) {
      try { await api('/api/lorebooks/' + encodeURIComponent(L.id)); return L.id; }
      catch (e) { if (e.status !== 404) throw e; L.id = ''; L.entryId = ''; }
    }
    const book = await api('/api/lorebooks', 'POST', { name: LORE_NAME, description: '가챠 TTS 확장이 만든 로어북입니다. 대사에 음성 감정 태그를 넣도록 안내합니다. 내용은 자유롭게 고쳐도 됩니다.', enabled: true, isGlobal: false, tags: [LORE_TAG] });
    const entry = await api('/api/lorebooks/' + encodeURIComponent(book.id) + '/entries', 'POST', { name: '음성 감정 태그', content: loreText(), constant: true, enabled: true, order: 1, keys: [], position: 0, description: '가챠 TTS' });
    Object.assign(L, { id: book.id, name: LORE_NAME, entryId: entry?.id || '', error: '', createdAt: now() });
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
  const linking = new Set();
  function autoLink(runId) {
    const w = world(runId);
    if (!w || !w.emotion || w.linkedOnce || linking.has(runId)) return;
    linking.add(runId);
    setTimeout(() => {
      connect(runId, true).then(() => { if (panel) render(); })
        .catch(e => { const x = world(runId); if (x) { x.loreError = String(e.message || e); save(); } })
        .finally(() => linking.delete(runId));
    }, 1500);
  }
  function linkedState(runId) {
    const l = lore.get(runId);
    if (!data.lore.id) return '로어북 없음';
    if (!l) return '확인 전';
    return l.worldIds.includes(data.lore.id) ? (l.beat ? '연결됨' : '연결됨 · 스토리 장면 사용 꺼짐') : '연결 안 됨';
  }

  // ---------- 상단바 버튼 ----------
  const ICON_SPEAK = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6"/><path d="M18 6.5a7.5 7.5 0 0 1 0 11"/></svg>';
  const ICON_STOP = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><rect x="6.5" y="6.5" width="11" height="11" rx="1.5"/></svg>';
  const ICON_GEAR = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></svg>';
  function paintButton() {
    const b = gameRoot?.querySelector('button[data-gtts="speak"]'); if (!b) return;
    const on = !!playingKey;
    b.innerHTML = on ? ICON_STOP : ICON_SPEAK;
    b.title = on ? '음성 멈춤' : '현재 대사 다시 듣기';
    b.style.opacity = data.global.enabled && current()?.auto !== false ? '' : '.5';
  }
  function placeButtons() {
    if (!gameRoot || gameRoot.querySelector('button[data-gtts="speak"]')) return;
    const fs = [...gameRoot.querySelectorAll('.gf-fs-bar')].find(el => el.classList.contains('icon-button'));
    if (!fs || !fs.parentElement) return;
    const mk = (kind, title, fn) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'icon-button'; b.dataset.gtts = kind;
      b.title = title; b.setAttribute('aria-label', title);
      b.addEventListener('pointerdown', e => e.stopPropagation());
      b.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); fn(); });
      fs.parentElement.insertBefore(b, fs); return b;
    };
    mk('speak', '현재 대사 다시 듣기', replay);
    mk('panel', '가챠 TTS 설정', () => openPanel()).innerHTML = ICON_GEAR;
    paintButton();
  }
  function mount() {
    const h = document.querySelector(HOST_TAG);
    if (h !== gameHost || (h && h.shadowRoot !== gameRoot)) {
      if (gameObserver) { gameObserver.disconnect(); gameObserver = null; }
      gameHost = h; gameRoot = h?.shadowRoot || null;
      if (gameRoot) {
        gameObserver = new MutationObserver(() => { placeButtons(); schedule(); });
        gameObserver.observe(gameRoot, { childList: true, subtree: true, characterData: true });
      }
    }
    placeButtons();
  }

  // ---------- 패널 ----------
  const style = document.createElement('style');
  style.textContent = `
#${ID}-panel{width:min(760px,calc(100vw - 24px));max-height:calc(100dvh - 24px);padding:0;border:1px solid #3a3d4a;border-radius:14px;background:#17181f;color:#e8e9ef;font:14px/1.55 "Pretendard","Noto Sans KR",system-ui,sans-serif;overflow:hidden}
#${ID}-panel::backdrop{background:#0009}
#${ID}-panel .g-head{display:flex;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid #2c2e3a}
#${ID}-panel .g-head h2{margin:0;font-size:16px;flex:1}
#${ID}-panel .g-tabs{display:flex;gap:4px}
#${ID}-panel .g-tabs button[aria-selected=true]{background:#4a55c8;border-color:#4a55c8;color:#fff}
#${ID}-panel .g-body{padding:14px 16px;overflow:auto;max-height:calc(100dvh - 90px)}
#${ID}-panel .g-cols{display:grid;grid-template-columns:200px minmax(0,1fr);gap:14px}
#${ID}-panel .g-worlds{display:flex;flex-direction:column;gap:4px}
#${ID}-panel .g-worlds button{text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#${ID}-panel .g-worlds button[aria-current=true]{border-color:#7b84f0;background:#262a4a}
#${ID}-panel .g-card{border:1px solid #2c2e3a;border-radius:10px;padding:12px;margin-bottom:12px;background:#1d1f28}
#${ID}-panel .g-card>b{display:block;margin-bottom:6px}
#${ID}-panel .g-muted{color:#9a9cad;font-size:12.5px;margin:4px 0}
#${ID}-panel .g-danger{color:#f08a8a}
#${ID}-panel .g-ok{color:#8fd6a5}
#${ID}-panel button,#${ID}-panel select,#${ID}-panel input,#${ID}-panel textarea{font:inherit;color:inherit;background:#252733;border:1px solid #3a3d4a;border-radius:7px;padding:5px 10px}
#${ID}-panel button{cursor:pointer}
#${ID}-panel button.primary{background:#4a55c8;border-color:#4a55c8;color:#fff}
#${ID}-panel button:disabled{opacity:.5;cursor:default}
#${ID}-panel label{display:flex;align-items:center;gap:8px;margin:6px 0}
#${ID}-panel .g-row{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:8px}
#${ID}-panel .g-spk{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.3fr) auto auto;gap:6px;align-items:center;padding:5px 0;border-top:1px solid #262833}
#${ID}-panel .g-spk select{min-width:0;width:100%}
#${ID}-panel .g-line{font-size:16px;line-height:1.7;padding:10px 12px;border-left:3px solid #7b84f0;background:#1d1f28;border-radius:6px}
#${ID}-panel .g-tag{color:#b9a3ff;font-size:.85em}
#${ID}-panel textarea{width:100%;box-sizing:border-box}
@media (max-width:640px){#${ID}-panel .g-cols{grid-template-columns:1fr}#${ID}-panel .g-worlds{flex-direction:row;overflow-x:auto}#${ID}-panel .g-spk{grid-template-columns:minmax(0,1fr) minmax(0,1.4fr) auto}#${ID}-panel .g-spk .g-mute{display:none}}
`;
  document.head.append(style);

  let panel = null, tab = 'play', selWorld = '';
  function openPanel(t) {
    if (panel && !t) { panel.close(); panel.remove(); panel = null; return; }
    if (t) tab = t;
    if (!panel) {
      panel = document.createElement('dialog'); panel.id = ID + '-panel'; panel.setAttribute('aria-label', '가챠 TTS');
      document.body.append(panel);
      panel.addEventListener('cancel', e => { e.preventDefault(); openPanel(); });
      panel.addEventListener('click', onClick);
      panel.addEventListener('change', onChange);
      panel.showModal();
    }
    selWorld = data.worlds[selWorld] ? selWorld : data.world || Object.keys(data.worlds)[0] || '';
    loadTtsConfig(); if (!voices.length) loadVoices(); syncPull();
    render();
  }
  function voiceSelect(attr, value, emptyLabel) {
    const known = voices.some(v => v.id === value);
    return '<select ' + attr + '><option value="">' + esc(emptyLabel) + '</option>' +
      voices.map(v => '<option value="' + esc(v.id) + '"' + (v.id === value ? ' selected' : '') + '>' + esc(v.name) + '</option>').join('') +
      (value && !known ? '<option value="' + esc(value) + '" selected>직접 입력: ' + esc(value) + '</option>' : '') +
      '<option value="__custom">보이스 ID 직접 입력…</option></select>';
  }
  function configHtml() {
    if (ttsConfigError) return '<p class="g-danger">TTS 설정을 읽지 못했습니다: ' + esc(ttsConfigError) + '</p>';
    if (!ttsConfig) return '<p class="g-muted">TTS 설정 확인 중…</p>';
    const c = ttsConfig, warn = [];
    if (c.enabled !== true) warn.push('마리나라 TTS가 꺼져 있습니다. 연결 → TTS에서 켜 주세요.');
    if (c.source && c.source !== 'elevenlabs') warn.push('TTS 공급자가 ElevenLabs가 아닙니다 (' + esc(c.source) + ').');
    if (c.model && !/v3|v4/i.test(c.model)) warn.push('모델 ' + esc(c.model) + '은(는) 감정 태그를 지원하지 않을 수 있습니다. eleven_v3 이상을 권장합니다.');
    return '<p class="g-muted">마리나라 TTS: ' + (c.enabled ? '<span class="g-ok">켜짐</span>' : '<span class="g-danger">꺼짐</span>') + ' · ' + esc(c.source || '?') + ' · ' + esc(c.model || '?') + '</p>' +
      warn.map(x => '<p class="g-danger">' + x + '</p>').join('') +
      (c.skipBracketedText ? '<p class="g-danger">"대괄호 텍스트 건너뛰기"가 켜져 있어 감정 태그가 음성에 전달되지 않습니다.</p><div class="g-row"><button data-act="fix-brackets">대괄호 건너뛰기 끄기</button></div>' : '');
  }
  function playHtml() {
    const w = current();
    const L = lastLine;
    const line = L ? '<div class="g-line"><b>' + esc(L.speaker || '내레이션') + '</b><br>' + esc(L.text).replace(/\[[a-z][a-z' -]{0,30}\]/g, m => '<span class="g-tag">' + m + '</span>') + '</div>' +
      '<p class="g-muted">보이스: ' + (L.voice ? esc(voices.find(v => v.id === L.voice)?.name || L.voice) : '<span class="g-danger">지정 안 됨</span>') + '</p>' : '<p class="g-muted">아직 인식한 대사가 없습니다. 가챠 포지에서 스토리를 열어 주세요.</p>';
    return '<div class="g-card"><b>현재 대사</b>' + line +
      '<div class="g-row"><button class="primary" data-act="replay"' + (L ? '' : ' disabled') + '>' + (playingKey ? '멈춤' : '다시 듣기') + '</button></div>' +
      (lastError ? '<p class="g-danger">' + esc(lastError) + '</p>' : '') + '</div>' +
      '<div class="g-card"><b>빠른 설정</b><p class="g-muted">현재 월드: ' + (w ? '<b>' + esc(w.name) + '</b>' : '없음') + '</p>' +
      '<label><input type="checkbox" data-g="enabled"' + (data.global.enabled ? ' checked' : '') + '> 확장 사용</label>' +
      (w ? '<label><input type="checkbox" data-w="auto" data-run="' + esc(data.world) + '"' + (w.auto ? ' checked' : '') + '> 이 월드에서 대사 자동 재생</label>' : '') +
      '<label>음량 <input type="range" min="0" max="1" step="0.05" data-g="volume" value="' + esc(data.global.volume) + '" style="flex:1"></label>' + configHtml() + '</div>';
  }
  function worldHtml(runId) {
    const w = world(runId);
    if (!w) return '<p class="g-muted">아직 인식한 월드가 없습니다. 가챠 포지에서 월드를 열면 여기에 추가됩니다.</p>';
    const r = ' data-run="' + esc(runId) + '"';
    const speakers = Object.entries(w.speakers).sort((a, b) => (b[1].prota ? 1 : 0) - (a[1].prota ? 1 : 0) || (b[1].lines || 0) - (a[1].lines || 0));
    const rows = speakers.map(([k, s]) => '<div class="g-spk"><span>' + esc(s.name) + (s.prota ? ' <small class="g-muted">주인공</small>' : '') + (s.lines ? ' <small class="g-muted">' + s.lines + '줄</small>' : '') + '</span>' +
      voiceSelect('data-spk="' + esc(k) + '"' + r, s.voice || '', w.fallback ? '기본 보이스 사용' : '읽지 않음') +
      '<button data-act="preview" data-voice="' + esc(s.voice || w.fallback || '') + '"' + (s.voice || w.fallback ? '' : ' disabled') + ' title="미리 듣기">▶</button>' +
      '<label class="g-mute" style="margin:0"><input type="checkbox" data-mute="' + esc(k) + '"' + r + (s.mute ? ' checked' : '') + '> 끔</label></div>').join('');
    const st = linkedState(runId);
    return '<div class="g-card"><b>' + esc(w.name) + '</b><p class="g-muted">게임 월드 ID ' + esc(runId.slice(0, 12)) + (runId === data.world ? ' · 지금 플레이 중' : '') + '</p>' +
      '<label><input type="checkbox" data-w="auto"' + r + (w.auto ? ' checked' : '') + '> 대사 자동 재생</label>' +
      '<label><input type="checkbox" data-w="narrate"' + r + (w.narrate ? ' checked' : '') + '> 내레이션도 읽기</label>' +
      (w.narrate ? '<div class="g-spk" style="grid-template-columns:minmax(0,1fr) minmax(0,1.3fr) auto"><span>내레이터</span>' + voiceSelect('data-wv="narrator"' + r, w.narrator, '읽지 않음') + '<button data-act="preview" data-voice="' + esc(w.narrator) + '"' + (w.narrator ? '' : ' disabled') + '>▶</button></div>' : '') +
      '<div class="g-spk" style="grid-template-columns:minmax(0,1fr) minmax(0,1.3fr) auto"><span>기본 보이스<br><small class="g-muted">보이스를 지정하지 않은 인물</small></span>' + voiceSelect('data-wv="fallback"' + r, w.fallback, '읽지 않음') + '<button data-act="preview" data-voice="' + esc(w.fallback) + '"' + (w.fallback ? '' : ' disabled') + '>▶</button></div></div>' +
      '<div class="g-card"><b>인물별 보이스</b><p class="g-muted">가챠 포지 장면에 나온 화자가 자동으로 추가됩니다. 보이스는 이 월드에만 적용됩니다.</p>' +
      (rows || '<p class="g-muted">아직 인식한 화자가 없습니다.</p>') +
      '<div class="g-row"><button data-act="add-speaker"' + r + '>화자 직접 추가</button><button data-act="reload-voices">보이스 목록 새로고침</button></div>' +
      (voicesError ? '<p class="g-danger">' + esc(voicesError) + '</p>' : '') + '</div>' +
      '<div class="g-card"><b>감정 태그 로어북</b><p class="g-muted">공용 로어북 하나(' + esc(LORE_NAME) + ')를 이 월드의 로어북 맨 앞에 연결해, AI가 대사에 [happy] 같은 감정 태그를 넣게 합니다. 태그는 화면에서 숨겨지고 음성에만 쓰입니다. 월드에 처음 들어올 때 한 번 자동으로 연결합니다.</p>' +
      '<label><input type="checkbox" data-w="emotion"' + r + (w.emotion ? ' checked' : '') + '> 이 월드에 감정 태그 로어북 사용</label>' +
      '<p class="g-muted">상태: <b>' + esc(st) + '</b>' + (w.loreError ? ' · <span class="g-danger">' + esc(w.loreError) + '</span>' : '') + '</p>' +
      '<div class="g-row">' + (st.startsWith('연결됨') ? '<button data-act="unlink"' + r + '>연결 해제</button>' : '<button class="primary" data-act="link"' + r + '>지금 연결</button>') + '<button data-act="check-link"' + r + '>상태 확인</button></div></div>' +
      '<div class="g-row"><button data-act="forget-world"' + r + ' class="g-danger">이 월드 설정 삭제</button></div>';
  }
  function commonHtml() {
    const L = data.lore;
    return '<div class="g-card"><b>공통</b>' +
      '<label><input type="checkbox" data-g="enabled"' + (data.global.enabled ? ' checked' : '') + '> 확장 사용</label>' +
      '<label><input type="checkbox" data-g="interrupt"' + (data.global.interrupt ? ' checked' : '') + '> 다음 대사로 넘기면 재생 중인 음성 멈춤</label>' +
      '<label><input type="checkbox" data-g="prefetch"' + (data.global.prefetch ? ' checked' : '') + '> 다음 대사 음성 미리 만들기 (응답이 빨라지지만 넘긴 대사도 요금이 듭니다)</label>' +
      '<label><input type="checkbox" data-g="stripTags"' + (data.global.stripTags ? ' checked' : '') + '> 화면에서 영어 감정 태그 숨기기</label>' +
      '<label>음량 <input type="range" min="0" max="1" step="0.05" data-g="volume" value="' + esc(data.global.volume) + '" style="flex:1"></label>' + configHtml() + '</div>' +
      '<div class="g-card"><b>감정 태그 로어북</b>' +
      (L.id ? '<p class="g-muted">로어북: <b>' + esc(L.name || L.id) + '</b>' + (L.createdAt ? ' · 만든 시각 ' + esc(L.createdAt) : '') + '</p><p class="g-muted">내용은 마리나라 로어북 화면에서 자유롭게 고칠 수 있습니다. 확장이 덮어쓰지 않습니다.</p>' : '<p class="g-muted">아직 만들지 않았습니다. 월드에 처음 들어올 때 자동으로 만들어 연결합니다.</p>') +
      (L.error ? '<p class="g-danger">' + esc(L.error) + '</p>' : '') +
      '<div class="g-row">' + (L.id ? '' : '<button class="primary" data-act="make-lore">지금 만들기</button>') + '<button data-act="copy-guide">지침용 문구 복사</button></div>' +
      '<p class="g-muted">로어북 대신 가챠 포지 스토리 지침에 직접 넣고 싶다면 [지침용 문구 복사]를 눌러 붙여 넣으세요. 그 경우 월드 설정에서 감정 태그 로어북 사용을 꺼 주세요.</p></div>';
  }
  function render() {
    if (!panel) return;
    const keep = panel.querySelector('.g-body')?.scrollTop || 0;
    const tabs = [['play', '재생'], ['settings', '설정'], ['common', '공통']];
    const ids = Object.keys(data.worlds);
    if (!data.worlds[selWorld]) selWorld = data.world || ids[0] || '';
    let body;
    if (tab === 'settings') {
      body = '<div class="g-cols"><nav class="g-worlds">' + (ids.length ? ids.map(id => '<button data-act="pick-world" data-run="' + esc(id) + '" aria-current="' + (id === selWorld) + '" title="' + esc(data.worlds[id].name) + '">' + (id === data.world ? '● ' : '') + esc(data.worlds[id].name) + '</button>').join('') : '<p class="g-muted">월드 없음</p>') + '</nav><div>' + worldHtml(selWorld) + '</div></div>';
    } else body = tab === 'common' ? commonHtml() : playHtml();
    panel.innerHTML = '<div class="g-head"><h2>가챠 TTS</h2><div class="g-tabs">' + tabs.map(([k, l]) => '<button data-tab="' + k + '" aria-selected="' + (tab === k) + '">' + l + '</button>').join('') + '</div><button data-act="close" aria-label="닫기">✕</button></div><div class="g-body">' + body + '</div>';
    panel.querySelector('.g-body').scrollTop = keep;
  }
  async function busy(el, fn) {
    if (el) el.disabled = true;
    try { await fn(); } catch (e) { alert(String(e.message || e)); } finally { if (el) el.disabled = false; render(); }
  }
  function onClick(e) {
    const t = e.target.closest('[data-tab],[data-act]'); if (!t) return;
    if (t.dataset.tab) { tab = t.dataset.tab; return render(); }
    const act = t.dataset.act, run = t.dataset.run, w = world(run);
    if (act === 'close') return openPanel();
    if (act === 'replay') { replay(); return render(); }
    if (act === 'pick-world') { selWorld = run; return render(); }
    if (act === 'preview') { const v = t.dataset.voice; if (v) play(v, SAMPLE_TEXT, '', 'preview:' + v); return; }
    if (act === 'reload-voices') return busy(t, loadVoices);
    if (act === 'add-speaker' && w) { const n = prompt('추가할 화자 이름 (가챠 포지 대사에 표시되는 이름 그대로)'); if (n && rememberSpeaker(w, n)) { save(); render(); } return; }
    if (act === 'link' && w) { w.emotion = true; return busy(t, () => connect(run, true)); }
    if (act === 'unlink' && w) return busy(t, () => connect(run, false));
    if (act === 'check-link') return busy(t, () => readLore(run));
    if (act === 'make-lore') return busy(t, async () => { try { await ensureLorebook(); data.lore.error = ''; } catch (err) { data.lore.error = String(err.message || err); throw err; } finally { save(); } });
    if (act === 'copy-guide') { const txt = loreText(); navigator.clipboard?.writeText(txt).then(() => alert('복사했습니다. 가챠 포지 스토리 지침에 붙여 넣어 주세요.'), () => prompt('아래 문구를 복사해 주세요:', txt)); return; }
    if (act === 'fix-brackets') {
      if (!confirm('마리나라 TTS 설정의 "대괄호 텍스트 건너뛰기"를 끕니다. 다른 TTS 설정은 그대로 둡니다. 진행할까요?')) return;
      return busy(t, async () => { const c = await api('/api/tts/config'); await api('/api/tts/config', 'PUT', { ...c, skipBracketedText: false }); await loadTtsConfig(); });
    }
    if (act === 'forget-world' && w) { if (!confirm(w.name + ' 월드의 보이스 설정을 삭제할까요? 게임 데이터와 로어북 연결은 그대로 둡니다.')) return; delete data.worlds[run]; if (data.world === run) data.world = ''; selWorld = ''; save(); return render(); }
  }
  function onChange(e) {
    const t = e.target, run = t.dataset.run, w = world(run);
    if (t.dataset.g) { data.global[t.dataset.g] = t.type === 'checkbox' ? t.checked : Number(t.value); save(); paintButton(); if (audio && t.dataset.g === 'volume') audio.volume = data.global.volume; if (t.type === 'checkbox') render(); return; }
    if (!w) return;
    let value = t.value;
    if (t.tagName === 'SELECT' && value === '__custom') { value = (prompt('ElevenLabs 보이스 ID를 입력해 주세요.') || '').trim(); if (!value) return render(); }
    if (t.dataset.w) {
      const k = t.dataset.w; w[k] = t.checked; save(); paintButton();
      if (k === 'emotion') { const on = t.checked; connect(run, on).catch(err => { w.loreError = String(err.message || err); save(); }).finally(render); }
      return render();
    }
    if (t.dataset.wv) { w[t.dataset.wv] = value; save(); return render(); }
    if (t.dataset.spk) { const s = w.speakers[t.dataset.spk]; if (s) { s.voice = value; save(); if (lastLine && current() === w) lastLine.voice = voiceFor(w, lastLine); } return render(); }
    if (t.dataset.mute) { const s = w.speakers[t.dataset.mute]; if (s) { s.mute = t.checked; save(); } }
  }

  // ---------- 시작 ----------
  syncPull();
  mount();
  new MutationObserver(() => { if (!gameRoot || !gameHost?.isConnected) mount(); }).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncPull(); else stop(); });

  globalThis.__gfTts = { matchLine, norm, stripTags, stripDeep, voiceFor, cleanLore, loreText, get data() { return data; }, get beats() { return beats; } };
})();
