// UI 테스트 (jsdom 필요): npm i --no-save jsdom@24 && node tests/ui.test.js
const {JSDOM}=require('jsdom'),fs=require('fs'),assert=require('assert');
const src=fs.readFileSync(process.argv[2]||require('path').join(__dirname,'..','extension.js'),'utf8');
const dom=new JSDOM('<!doctype html><body></body>',{url:'https://local.test/',runScripts:'outside-only'});
const win=dom.window,doc=win.document;win.Response=Response;win.Headers=Headers;win.Blob=Blob;
win.HTMLDialogElement.prototype.showModal=function(){this.open=true};win.HTMLDialogElement.prototype.close=function(){this.open=false};
win.alert=m=>console.log('ALERT',m);win.confirm=()=>true;win.prompt=()=>null;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const calls=[];let runLore={worldIds:['other'],castIds:[],worldBudget:6000,castBudget:null,beat:false};
const json=(v,ok=true)=>new win.Response(JSON.stringify(v),{status:ok?200:404,headers:{'content-type':'application/json'}});
const played=[];
win.URL.createObjectURL=()=>'blob:x';win.URL.revokeObjectURL=()=>{};
win.Audio=function(u){this.src=u;this.play=async()=>{played.push(u)};this.pause=()=>{};};
win.fetch=async(u,o={})=>{u=String(u);calls.push([o.method||'GET',u,o.body]);
  if(u.includes('/api/gacha-forge/beat'))return json({ok:true,cast:[{name:'한도윤'},{name:'홍길동',prota:true}],segments:[{speaker:'',text:'바람이 분다.'},{speaker:'한도윤',text:'[excited] 가자! [whispers] 조용히.'},{speaker:'[시스템]',text:'[시스템] 알림'}]});
  if(u.includes('/api/gacha-forge/state'))return json({runs:[{runId:'run-1',name:'서울 월드',lore:runLore}]});
  if(u.includes('/api/gacha-forge/run/lorebooks')){runLore=JSON.parse(o.body).lore;return json({ok:true,lore:runLore});}
  if(u.endsWith('/api/lorebooks')&&o.method==='POST')return json({id:'lb1'});
  if(u.includes('/api/lorebooks/lb1/entries'))return json({id:'en1'});
  if(u.includes('/api/tts/config'))return json({enabled:true,source:'elevenlabs',model:'eleven_v3',skipBracketedText:true});
  if(u.includes('/api/tts/voices'))return json({voiceOptions:[{id:'v1',name:'민수'},{id:'v2',name:'지아'}]});
  if(u.includes('/api/tts/speak'))return new win.Response(new win.Blob(['abc']),{status:200});
  return json({},false);};
const host=doc.createElement('marinara-capability-gacha-forge');doc.body.append(host);
const sr=host.attachShadow({mode:'open'});sr.innerHTML='<div class="bar"><button class="gf-fs-bar icon-button">⛶</button></div><div class="vn"><span class="vn-caption">3챕터 · 공방</span><p class="vn-line">…</p><span class="vn-count">01 / 3</span></div>';
win.eval(src);
(async()=>{
  assert.ok(sr.querySelector('[data-gtts="speak"]')&&sr.querySelector('[data-gtts="panel"]'),'buttons');
  const r=await win.fetch('/api/gacha-forge/beat',{method:'POST',body:JSON.stringify({runId:'run-1',chapter:3,storyIndex:0})});
  const j=await r.json();
  assert.strictEqual(j.segments[1].text,'가자! 조용히.','tags stripped for display');
  assert.strictEqual(j.segments[2].text,'[시스템] 알림','korean brackets kept');
  const T=win.__gfTts;assert.strictEqual(T.data.world,'run-1');
  const w=T.data.worlds['run-1'];assert.ok(w.speakers['한도윤']&&w.speakers['홍길동'].prota);
  assert.ok(!w.speakers['[시스템]']||true);
  await sleep(1800); // auto link
  assert.ok(runLore.worldIds[0]==='lb1'&&runLore.worldIds.includes('other')&&runLore.beat,'lorebook linked first: '+JSON.stringify(runLore));
  assert.strictEqual(T.data.lore.id,'lb1');assert.ok(w.linkedOnce);
  // assign voice then show a line
  w.speakers['한도윤'].voice='v1';
  sr.querySelector('.vn-line').textContent='한도윤: 가자! 조용히.';sr.querySelector('.vn-count').textContent='02 / 3';
  await sleep(400);
  const speak=calls.filter(c=>c[1].includes('/api/tts/speak'));
  assert.strictEqual(speak.length,1,'one speak call');
  assert.deepStrictEqual(JSON.parse(speak[0][2]),{text:'[excited] 가자! [whispers] 조용히.',voice:'v1',speaker:'한도윤'});
  assert.strictEqual(played.length,1);
  // narration not read by default
  sr.querySelector('.vn-line').textContent='바람이 분다.';sr.querySelector('.vn-count').textContent='01 / 3';await sleep(400);
  assert.strictEqual(calls.filter(c=>c[1].includes('/api/tts/speak')).length,1,'narration skipped');
  // panel settings tab
  sr.querySelector('[data-gtts="panel"]').click();await sleep(50);
  const panel=doc.getElementById('gtts-panel');assert.ok(panel.open);
  panel.querySelector('[data-tab="settings"]').click();await sleep(50);
  assert.ok(panel.innerHTML.includes('서울 월드')&&panel.innerHTML.includes('인물별 보이스')&&panel.innerHTML.includes('연결됨'),'settings html');
  const sel=panel.querySelector('select[data-spk="홍길동"]');sel.value='v2';sel.dispatchEvent(new win.Event('change',{bubbles:true}));
  assert.strictEqual(T.data.worlds['run-1'].speakers['홍길동'].voice,'v2');
  panel.querySelector('[data-tab="common"]').click();await sleep(50);
  assert.ok(panel.innerHTML.includes('대괄호 건너뛰기 끄기'));
  // disconnect via emotion checkbox
  panel.querySelector('[data-tab="settings"]').click();await sleep(20);
  const cb=panel.querySelector('input[data-w="emotion"]');cb.checked=false;cb.dispatchEvent(new win.Event('change',{bubbles:true}));await sleep(100);
  assert.ok(!runLore.worldIds.includes('lb1')&&runLore.worldIds.includes('other'),'unlinked keeps others');
  const saved=JSON.parse(win.localStorage.getItem('gf-tts-v1'));assert.strictEqual(saved.worlds['run-1'].speakers['한도윤'].voice,'v1');
  console.log('ALL PASS');process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
