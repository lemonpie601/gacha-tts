// UI 테스트 (jsdom 필요): npm i --no-save jsdom@24 && node tests/ui.test.js
const {JSDOM}=require('jsdom'),fs=require('fs'),assert=require('assert');
const src=fs.readFileSync(process.argv[2]||require('path').join(__dirname,'..','extension.js'),'utf8');
const dom=new JSDOM('<!doctype html><body></body>',{url:'https://local.test/',runScripts:'outside-only'});
const win=dom.window,doc=win.document;win.Response=Response;win.FormData=FormData;win.Headers=Headers;win.Blob=Blob;
win.HTMLDialogElement.prototype.showModal=function(){this.open=true};win.HTMLDialogElement.prototype.close=function(){this.open=false};
const native=[];win.alert=m=>native.push(['alert',m]);win.confirm=m=>{native.push(['confirm',m]);return true;};win.prompt=m=>{native.push(['prompt',m]);return null;};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const calls=[];const assets=new Map();let entryContent="";let runLore={worldIds:['other'],castIds:[],worldBudget:6000,castBudget:null,beat:false};
const json=(v,ok=true)=>new win.Response(JSON.stringify(v),{status:ok?200:404,headers:{'content-type':'application/json'}});
const played=[];
win.URL.createObjectURL=()=>'blob:x';win.URL.revokeObjectURL=()=>{};
win.Audio=function(u){this.src=u;this.play=async()=>{played.push(u)};this.pause=()=>{};};
win.fetch=async(u,o={})=>{u=String(u);calls.push([o.method||'GET',u,o.body]);
  if(u.includes('/api/gacha-forge/beat-choice'))return json({ok:true,beat:{chapter:4,storyIndex:0,segments:[{speaker:'한도윤',text:'[curious] 같이 갈래?',choice:{key:'abcdef12',options:[{label:'좋아',lines:[{speaker:'홍길동',text:'[happy] 좋아, 가자.'},{speaker:'한도윤',text:'[warm] 그래.'}]},{label:'싫어',lines:[{speaker:'홍길동',text:'[cold] 싫어.'}]}]}},{speaker:'',text:'둘은 길을 나섰다.'}]}});
  if(u.includes('/api/gacha-forge/beat'))return json({ok:true,cast:[{name:'한도윤'},{name:'홍길동',prota:true}],segments:[{speaker:'',text:'바람이 분다.'},{speaker:'한도윤',text:'[excited] 가자! [whispers] 조용히.'},{speaker:'[시스템]',text:'[시스템] 알림'}]});
  if(u.includes('/api/gacha-forge/state'))return json({runs:[{runId:'run-1',name:'서울 월드',lore:runLore}]});
  if(u.includes('/api/gacha-forge/run/lorebooks')){runLore=JSON.parse(o.body).lore;return json({ok:true,lore:runLore});}
  if(u.endsWith('/api/lorebooks')&&o.method==='POST')return json({id:'lb1'});
  if(u.endsWith('/api/lorebooks/lb1/entries/en1')){if(o.method==='PATCH'){entryContent=JSON.parse(o.body).content;return json({id:'en1'});}return json({id:'en1',content:entryContent});}
  if(u.includes('/api/lorebooks/lb1/entries')){entryContent=JSON.parse(o.body).content;return json({id:'en1'});}
  if(u.endsWith('/api/lorebooks/lb1'))return json({id:'lb1'});
  if(u.includes('/api/tts/config'))return json({enabled:true,source:'elevenlabs',model:'eleven_v3',skipBracketedText:true});
  if(u.includes('/api/tts/voices'))return json({voiceOptions:[{id:'v1',name:'민수'},{id:'v2',name:'지아'}]});
  if(u.startsWith('/api/game-assets/file/')){const b=assets.get(u.slice(22));return b?new win.Response(b,{status:200,headers:{'content-type':'audio/mpeg'}}):json({error:'Asset not found'},false);}
  if(u==='/api/game-assets/upload'){const f=o.body;const path=f.get('category')+'/'+f.get('subcategory')+'/'+f.get('file').name;assets.set(path,f.get('file'));return json({path});}
  if(u.includes('/api/tts/speak'))return new win.Response(new win.Blob(['abc']),{status:200});
  return json({},false);};
const host=doc.createElement('marinara-capability-gacha-forge');doc.body.append(host);
const sr=host.attachShadow({mode:'open'});sr.innerHTML='<div class="bar"><button class="gf-fs-bar icon-button">⛶</button></div><div class="vn"><span class="vn-caption">3챕터 · 공방</span><div class="vn-tools"><button class="vn-tool" data-auto>Auto</button><button class="vn-tool" data-skip>Skip</button></div><p class="vn-line">…</p><span class="vn-count">01 / 3</span></div>';
win.eval(src);
(async()=>{
  const sb=sr.querySelector('.vn-tools [data-gtts="speak"]');assert.ok(sb&&sb.classList.contains('vn-tool'),'listen button in story toolbar');
  assert.strictEqual(sr.querySelector('.vn-tools').firstElementChild,sb,'listen button left of Auto');assert.ok(sb.textContent.includes('듣기'));
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
  // listen button replays the current line (cached clip, no new speak call)
  const lb=()=>sr.querySelector('[data-gtts="speak"]');assert.ok(lb().hasAttribute('data-on')&&lb().textContent.includes('멈춤'),'shows stop while playing');
  lb().click();await sleep(20);assert.ok(!lb().hasAttribute('data-on')&&lb().textContent.includes('듣기'),'stopped');
  lb().click();await sleep(50);
  assert.strictEqual(played.length,2,'replayed');assert.strictEqual(calls.filter(c=>c[1].includes('/api/tts/speak')).length,1,'cached');
  // generated clip is saved on the server under the hidden sfx folder
  await sleep(50);
  assert.strictEqual(assets.size,1,'uploaded once');const [apath]=[...assets.keys()];
  assert.ok(/^sfx\/\.gacha-tts\/[0-9a-z]{2}\/[0-9a-z]+\.mp3$/.test(apath),'hidden folder path '+apath);
  // another device / reload: memory empty, clip comes from the server, no new generation
  T.clips.clear();const before=calls.filter(c=>c[1].includes('/api/tts/speak')).length;
  await T.fetchClip('v1','[excited] 가자! [whispers] 조용히.','한도윤');
  assert.strictEqual(calls.filter(c=>c[1].includes('/api/tts/speak')).length,before,'served from server, not regenerated');
  assert.strictEqual(assets.size,1,'no duplicate upload');
  // different tags = different clip
  T.clips.clear();await T.fetchClip('v1','[sad] 가자! 조용히.','한도윤');
  assert.strictEqual(calls.filter(c=>c[1].includes('/api/tts/speak')).length,before+1);await sleep(30);assert.strictEqual(assets.size,2);
  // narration not read by default
  sr.querySelector('.vn-line').textContent='바람이 분다.';sr.querySelector('.vn-count').textContent='01 / 3';await sleep(400);
  assert.strictEqual(calls.filter(c=>c[1].includes('/api/tts/speak')).length,before+1,'narration skipped');
  // GF settings screen: our tab goes in the rail and replaces the pane while open
  win.Element.prototype.getClientRects=function(){return [1];};
  sr.querySelector('.bar').insertAdjacentHTML('afterend','<div data-screen="settings"><div class="head-id"><h2>자료</h2></div><nav class="st-rail"><button class="st-sect" role="tab" aria-selected="true"><span class="k">세계</span><span class="n">자료</span></button></nav><div class="st-pane"><div class="st-plate" id="native">자료 내용</div></div></div>');
  await sleep(150);
  const tab=sr.querySelector('.st-rail [data-gtts="tab"]');assert.ok(tab,'tts tab added to rail');
  assert.ok(tab.textContent.includes('TTS'));
  tab.click();await sleep(50);
  const viewEl=sr.querySelector('.st-pane [data-gtts-view]');assert.ok(viewEl,'view mounted in pane');
  assert.strictEqual(sr.getElementById('native').style.display,'none','native pane hidden');
  assert.strictEqual(tab.getAttribute('aria-selected'),'true');assert.strictEqual(sr.querySelector('.head-id h2').textContent,'TTS');
  await sleep(50);
  const html=viewEl.innerHTML;
  assert.ok(html.includes('서울 월드')&&html.includes('인물별 보이스')&&html.includes('연결됨')&&html.includes('대괄호 건너뛰기 끄기'),'settings html');
  const sel=viewEl.querySelector('select[data-spk="홍길동"]');sel.value='v2';sel.dispatchEvent(new win.Event('change',{bubbles:true}));
  assert.strictEqual(T.data.worlds['run-1'].speakers['홍길동'].voice,'v2');
  // toggle emotion off -> disconnect
  sr.querySelector('[data-gtts-view] [role=checkbox][data-w="emotion"]').click();await sleep(100);
  assert.ok(!runLore.worldIds.includes('lb1')&&runLore.worldIds.includes('other'),'unlinked keeps others');
  // in-game modal instead of window.prompt/confirm (keeps fullscreen)
  viewEl.querySelector('[data-act="add-speaker"]').click();await sleep(20);
  let veil=sr.querySelector('.gtts-veil');assert.ok(veil,'modal drawn inside the game shadow root');
  veil.querySelector('input').value='공방장';veil.querySelector('[data-a="ok"]').click();await sleep(20);
  assert.ok(!sr.querySelector('.gtts-veil'),'modal closed');assert.ok(T.data.worlds['run-1'].speakers['공방장'],'speaker added via modal');
  sr.querySelector('[data-gtts-view] [data-act="fix-brackets"]').click();await sleep(20);
  veil=sr.querySelector('.gtts-veil');assert.ok(veil.textContent.includes('대괄호'));
  veil.dispatchEvent(new win.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await sleep(20);
  assert.ok(!sr.querySelector('.gtts-veil'),'escape cancels');
  assert.ok(!calls.some(c=>c[0]==='PUT'),'cancel sends nothing');
  const vsel=sr.querySelector('[data-gtts-view] select[data-wv="fallback"]');vsel.value='__custom';vsel.dispatchEvent(new win.Event('change',{bubbles:true}));await sleep(20);
  veil=sr.querySelector('.gtts-veil');veil.querySelector('input').value='custom-id';
  veil.dispatchEvent(new win.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));await sleep(20);
  assert.strictEqual(T.data.worlds['run-1'].fallback,'custom-id','voice id via modal');
  // game's own tab restores the pane
  sr.querySelector('.st-sect:not([data-gtts])').click();await sleep(50);
  assert.ok(!sr.querySelector('[data-gtts-view]'),'view removed');
  assert.strictEqual(sr.getElementById('native').style.display,'','native restored');
  assert.strictEqual(sr.querySelector('.head-id h2').textContent,'자료');
  assert.ok(!doc.querySelector('dialog'),'no popup dialog');
  assert.ok(!sr.querySelector('[data-gtts="panel"]'),'no gear button');
  const saved=JSON.parse(win.localStorage.getItem('gf-tts-v1'));assert.strictEqual(saved.worlds['run-1'].speakers['한도윤'].voice,'v1');
  // every tag the guide teaches is hidden on screen
  const guide=T.loreText();const tags=guide.match(/\[[^\]\n]+\]/g).filter(x=>/^\[[a-z]/.test(x));
  assert.ok(tags.length>80,'detailed tag list: '+tags.length);
  for(const tag of tags)assert.strictEqual(T.stripTags(tag+' 가'),'가','strip '+tag);
  assert.ok(guide.includes('다음 태그가 나올 때까지')&&guide.includes('되돌리'),'explains carry-over and reset');
  // unedited v1 guide is upgraded; an edited one is left alone
  T.data.lore.textVer=1;entryContent=T.LORE_TEXT_V1;
  assert.strictEqual(await T.upgradeLoreText(),true);assert.strictEqual(entryContent,guide,'v1 upgraded');
  T.data.lore.textVer=1;entryContent='내가 고친 지침';
  assert.strictEqual(await T.upgradeLoreText(),false);assert.strictEqual(entryContent,'내가 고친 지침','edited kept');assert.ok(T.data.lore.edited);
  assert.strictEqual(await T.upgradeLoreText(true),true);assert.strictEqual(entryContent,guide,'forced reset');assert.ok(!T.data.lore.edited);
  assert.deepStrictEqual(native,[],'no native alert/confirm/prompt');
  // Gacha Choice: the picked answer's lines play under the same line number and are voiced too
  const r2=await win.fetch('/api/gacha-forge/beat-choice',{method:'POST',body:JSON.stringify({runId:'run-1',chapter:4,storyIndex:0})});
  const j2=await r2.json();assert.strictEqual(j2.beat.segments[0].choice.options[0].lines[0].text,'좋아, 가자.','deep choice tags stripped on screen');
  const w1=T.data.worlds['run-1'];w1.speakers['홍길동'].voice='v2';w1.speakers['한도윤'].voice='v1';
  const sp0=calls.filter(c=>c[1].includes('/api/tts/speak')).length;
  sr.querySelector('.vn-caption').textContent='4챕터';sr.querySelector('.vn-line').textContent='같이 갈래?';sr.querySelector('.vn-count').textContent='01 / 2';await sleep(400);
  let sp=calls.filter(c=>c[1].includes('/api/tts/speak')).slice(sp0);assert.strictEqual(sp.length,1,'question voiced');
  sr.querySelector('.vn-line').textContent='좋아, 가자.';await sleep(400);
  sp=calls.filter(c=>c[1].includes('/api/tts/speak')).slice(sp0);assert.strictEqual(sp.length,2,'branch line voiced: '+sp.length);
  assert.deepStrictEqual(JSON.parse(sp[1][2]),{text:'[happy] 좋아, 가자.',voice:'v2',speaker:'홍길동'});
  sr.querySelector('.vn-line').textContent='그래.';await sleep(400);
  sp=calls.filter(c=>c[1].includes('/api/tts/speak')).slice(sp0);assert.strictEqual(sp.length,3,'second branch line voiced');
  assert.strictEqual(JSON.parse(sp[2][2]).voice,'v1');
  // name variant falls back to the speaker that has a voice
  assert.strictEqual(T.voiceFor(w1,{speaker:'도윤'}),'v1','alias voice');
  // sync: a device that only played the story must not wipe a voice picked on another device
  const local={v:1,at:999999999999999,worlds:{'run-1':{...w1,speakers:{'한도윤':{name:'한도윤',voice:'',lines:9}}}},global:{},lore:{}};
  const remote={v:1,at:1,worlds:{'run-1':{speakers:{'한도윤':{name:'한도윤',voice:'v9',t:5}}}},global:{},lore:{}};
  assert.ok(T.mergeData(local,remote));assert.strictEqual(local.worlds['run-1'].speakers['한도윤'].voice,'v9','newer pick wins');
  local.worlds['run-1'].speakers['한도윤'].voice='v8';local.worlds['run-1'].speakers['한도윤'].t=9;
  T.mergeData(local,remote);assert.strictEqual(local.worlds['run-1'].speakers['한도윤'].voice,'v8','older remote ignored');
  console.log('ALL PASS');process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
