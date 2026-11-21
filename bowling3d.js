/* SSPACE Bowling Club — Three.js 3D lane + Supabase Realtime rooms.
 * Multiplayer is an unranked, invite-code prototype. Do not treat browser scores as anti-cheat verified.
 */
(() => {
  let THREE = null, CANNON = null;
  async function ensure3DModules() {
    if (THREE && CANNON) return;
    status('Chargement des moteurs 3D…');
    const [threeModule, cannonModule] = await Promise.all([
      import('https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js'),
      import('https://cdn.jsdelivr.net/npm/cannon-es@0.20.0/dist/cannon-es.js')
    ]);
    THREE = threeModule; CANNON = cannonModule;
  }
  const $ = (id) => document.getElementById(id);
  const modal = $('bowlingModal');
  if (!modal) return;
  const state = {
    renderer: null, scene: null, camera: null, physics: null, ballBody: null, pinBodies: [], clock: null, raf: 0,
    ball: null, pins: [], pinMeshes: [], rolling: false, rollT: 0, rollPower: 0.78,
    rollAim: 0, rollSpin: 0, currentUser: null, channel: null, roomCode: null,
    multiplayer: false, host: false, activeUser: null, players: {}, frame: 1,
    myTotal: 0, opponentTotal: 0, myName: 'Moi', opponentName: 'Adversaire',
    lastPins: 0, mode: 'solo', ready: false
  };

  function esc(s='') { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function show(el) { el?.classList.remove('hidden'); }
  function hide(el) { el?.classList.add('hidden'); }
  function status(message) { $('bowlingStatus').textContent = message; }
  function setModal(open) { modal.classList.toggle('hidden', !open); document.body.classList.toggle('bowling-open', open); if (open) setTimeout(resize, 80); else stopRender(); }
  function user() { return state.currentUser || window.sspaceCurrentUser || null; }

  function createRenderer() {
    state.clock ||= new THREE.Clock();
    const host = $('bowlingCanvas');
    if (state.renderer) { resize(); renderLoop(); return; }
    try {
      state.renderer = new THREE.WebGLRenderer({antialias:true, alpha:false, powerPreference:'high-performance'});
      state.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.8));
      state.renderer.shadowMap.enabled = true;
      state.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      state.renderer.outputColorSpace = THREE.SRGBColorSpace;
      state.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      state.renderer.toneMappingExposure = 1.15;
      host.replaceChildren(state.renderer.domElement);
      state.scene = new THREE.Scene();
      state.scene.background = new THREE.Color('#080d19');
      state.scene.fog = new THREE.Fog('#080d19', 18, 42);
      state.camera = new THREE.PerspectiveCamera(43, 1, 0.1, 100);
      state.camera.position.set(0, 4.1, 12.2);
      state.camera.lookAt(0, 0.8, -1.4);
      const hemi = new THREE.HemisphereLight('#dbe8ff', '#17101a', 2.15); state.scene.add(hemi);
      const key = new THREE.DirectionalLight('#ffe2a3', 3.1); key.position.set(-4, 9, 6); key.castShadow = true; key.shadow.mapSize.set(2048,2048); state.scene.add(key);
      const rim = new THREE.PointLight('#58aaff', 38, 20); rim.position.set(4,3,-5); state.scene.add(rim);
      const gold = new THREE.PointLight('#d89b42', 25, 18); gold.position.set(-4,2,1); state.scene.add(gold);
      buildLane();
      buildPins();
      buildBall();
      buildPhysics();
      resize();
      state.ready = true;
      renderLoop();
    } catch (e) {
      host.innerHTML = '<div class="bowling-fallback">Ton appareil ne semble pas prendre en charge WebGL. Essaie avec un navigateur récent et l’accélération graphique activée.</div>';
      console.error('SSPACE Bowling WebGL:', e);
    }
  }

  function mat(color, roughness=.45, metalness=.05) { return new THREE.MeshStandardMaterial({color, roughness, metalness}); }
  function addBox(w,h,d,x,y,z,material,receive=true) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w,h,d), material);
    mesh.position.set(x,y,z); mesh.receiveShadow = receive; mesh.castShadow = true; state.scene.add(mesh); return mesh;
  }
  function buildLane() {
    addBox(2.55,.22,21.5,0,-.12,-1.1,mat('#a9783d',.3));
    const wood = new THREE.MeshStandardMaterial({color:'#b98247',roughness:.32,metalness:.02});
    for(let i=0;i<13;i++) addBox(.185,.012,21.2,-1.1+i*.183,.002,-1.1, new THREE.MeshStandardMaterial({color:i%2?'#c18b50':'#a9743d',roughness:.35}));
    addBox(.36,.32,21.6,-1.48,-.04,-1.1,mat('#242b3b',.28,.35));
    addBox(.36,.32,21.6,1.48,-.04,-1.1,mat('#242b3b',.28,.35));
    addBox(4.2,.16,3.4,0,-.12,10.9,mat('#151d2d',.65));
    // lane arrows / aiming marks
    const arrowMat = new THREE.MeshStandardMaterial({color:'#f4d18c',emissive:'#7c4e1c',emissiveIntensity:.25});
    for(let i=-3;i<=3;i++) {
      const tri = new THREE.Mesh(new THREE.ConeGeometry(.075,.22,3),arrowMat);
      tri.rotation.x=Math.PI/2; tri.position.set(i*.27,.018,2.1-Math.abs(i)*.08); state.scene.add(tri);
    }
    const back = addBox(7,.35,.35,0,.05,-12.1,mat('#18243a',.38,.3));
    // polished side rails
    addBox(5,.18,.45,0,2.1,-11.9,mat('#1d2941',.25,.4));
    for(let x=-2.2;x<=2.2;x+=.22) { const led=new THREE.PointLight(x%0.44===0?'#d7a957':'#4c91d9',.6,3); led.position.set(x,1.7,-11.7);state.scene.add(led); }
  }
  function pinGeometry() {
    const pts = [new THREE.Vector2(0,.02),new THREE.Vector2(.13,.02),new THREE.Vector2(.17,.13),new THREE.Vector2(.15,.3),new THREE.Vector2(.105,.48),new THREE.Vector2(.075,.62),new THREE.Vector2(.09,.77),new THREE.Vector2(.13,.88),new THREE.Vector2(.105,1.02),new THREE.Vector2(0,1.05)];
    return new THREE.LatheGeometry(pts,20);
  }
  const pinGeo = pinGeometry();
  function makePin(x,z) {
    const group = new THREE.Group(); group.position.set(x,.01,z); group.userData={home:new THREE.Vector3(x,.01,z),down:false,velocity:new THREE.Vector3(),fall:0};
    const body = new THREE.Mesh(pinGeo,mat('#f4f3ed',.22,.08)); body.castShadow=true; body.receiveShadow=true; group.add(body);
    const stripe = new THREE.Mesh(new THREE.TorusGeometry(.108,.026,8,24),new THREE.MeshStandardMaterial({color:'#c83235',roughness:.35,emissive:'#5b1013',emissiveIntensity:.1})); stripe.rotation.x=Math.PI/2; stripe.position.y=.78; group.add(stripe);
    state.scene.add(group); return group;
  }
  function buildPins() {
    state.pinMeshes=[];
    const rows=[[-.28,-5.1],[.0,-5.1],[.28,-5.1],[-.42,-5.52],[-.14,-5.52],[.14,-5.52],[.42,-5.52],[-.28,-5.94],[0,-5.94],[.28,-5.94]];
    rows.forEach(([x,z])=>state.pinMeshes.push(makePin(x,z)));
    state.pins=state.pinMeshes;
  }
  function buildBall() {
    const geometry = new THREE.SphereGeometry(.34,48,32);
    const material = new THREE.MeshPhysicalMaterial({color:'#263b69',metalness:.48,roughness:.19,clearcoat:1,clearcoatRoughness:.08});
    state.ball = new THREE.Mesh(geometry,material); state.ball.position.set(0,.34,8.5); state.ball.castShadow=true; state.scene.add(state.ball);
    const holes = new THREE.Group();
    const holeMat = new THREE.MeshStandardMaterial({color:'#050914',roughness:.12});
    [[-.12,.09,.31],[.11,.12,.29],[0,-.12,.31]].forEach(([x,y,z])=>{const h=new THREE.Mesh(new THREE.SphereGeometry(.052,16,12),holeMat);h.position.set(x,y,z);holes.add(h)});
    state.ball.add(holes);
  }
  function buildPhysics() {
    const world = new CANNON.World({gravity:new CANNON.Vec3(0,-9.82,0)});
    world.broadphase = new CANNON.SAPBroadphase(world);
    world.solver.iterations = 14;
    world.allowSleep = true;
    const floorMat = new CANNON.Material('lane');
    const pinMat = new CANNON.Material('pin');
    const ballMat = new CANNON.Material('ball');
    world.addContactMaterial(new CANNON.ContactMaterial(floorMat,pinMat,{friction:.42,restitution:.12}));
    world.addContactMaterial(new CANNON.ContactMaterial(ballMat,pinMat,{friction:.18,restitution:.08}));
    world.addContactMaterial(new CANNON.ContactMaterial(pinMat,pinMat,{friction:.35,restitution:.18}));
    const floor = new CANNON.Body({mass:0,material:floorMat,shape:new CANNON.Box(new CANNON.Vec3(1.62,.11,10.8))});
    floor.position.set(0,-.12,-1.1); world.addBody(floor);
    const ball = new CANNON.Body({mass:6,material:ballMat,shape:new CANNON.Sphere(.34),linearDamping:.12,angularDamping:.16});
    ball.position.set(0,.34,8.5); ball.allowSleep=true; world.addBody(ball);
    state.pinBodies = state.pinMeshes.map(pin=>{
      const body = new CANNON.Body({mass:.19,material:pinMat,linearDamping:.12,angularDamping:.2});
      body.addShape(new CANNON.Sphere(.13),new CANNON.Vec3(0,-.37,0));
      body.addShape(new CANNON.Sphere(.105),new CANNON.Vec3(0,-.13,0));
      body.addShape(new CANNON.Sphere(.075),new CANNON.Vec3(0,.08,0));
      body.position.set(pin.position.x,.51,pin.position.z);body.allowSleep=true;world.addBody(body);return body;
    });
    state.physics=world;state.ballBody=ball;
  }
  function resize() {
    if(!state.renderer||!state.camera)return;
    const host=$('bowlingCanvas'); const w=Math.max(300,host.clientWidth),h=Math.max(260,host.clientHeight);
    state.renderer.setSize(w,h,false);state.camera.aspect=w/h;state.camera.updateProjectionMatrix();
  }
  function resetPins() {
    state.pinMeshes.forEach((p,i)=>{p.position.copy(p.userData.home);p.rotation.set(0,0,0);p.userData.down=false;p.userData.velocity.set(0,0,0);p.userData.fall=0;p.visible=true;const b=state.pinBodies[i];if(b){b.position.set(p.userData.home.x,.51,p.userData.home.z);b.quaternion.set(0,0,0,1);b.velocity.set(0,0,0);b.angularVelocity.set(0,0,0);b.force.set(0,0,0);b.torque.set(0,0,0);b.sleepState=0;b.wakeUp()}});
    state.ball.position.set(0,.34,8.5);state.ball.rotation.set(0,0,0);if(state.ballBody){state.ballBody.position.set(0,.34,8.5);state.ballBody.quaternion.set(0,0,0,1);state.ballBody.velocity.set(0,0,0);state.ballBody.angularVelocity.set(0,0,0);state.ballBody.wakeUp()}state.rolling=false;state.rollT=0;
  }
  function renderLoop() {
    cancelAnimationFrame(state.raf);
    const tick=()=>{
      state.raf=requestAnimationFrame(tick);
      const dt=Math.min(state.clock.getDelta(),.035);
      if(state.physics){
        state.physics.step(1/60,dt,3);
        state.pinMeshes.forEach((mesh,i)=>{const body=state.pinBodies[i];mesh.position.set(body.position.x,body.position.y-.5,body.position.z);mesh.quaternion.set(body.quaternion.x,body.quaternion.y,body.quaternion.z,body.quaternion.w);});
        if(state.ballBody){state.ball.position.set(state.ballBody.position.x,state.ballBody.position.y,state.ballBody.position.z);state.ball.quaternion.set(state.ballBody.quaternion.x,state.ballBody.quaternion.y,state.ballBody.quaternion.z,state.ballBody.quaternion.w);}
      }
      if(state.rolling){state.rollT+=dt;const ballZ=state.ballBody?.position.z??state.ball.position.z;if(state.rollT>2.65||ballZ<-7.2||state.rollT>1.5&&state.ballBody?.velocity.length()<.6)finishRoll();}
      state.renderer?.render(state.scene,state.camera);
    }; tick();
  }
  function finishRoll() {
    state.rolling=false;
    const pins=state.pinBodies.length?state.pinBodies.filter(b=>b.position.y<.28||(2*Math.acos(Math.min(1,Math.abs(b.quaternion.w))))>.55).length:state.pinMeshes.filter(p=>p.userData.down).length;
    state.lastPins=pins;
    if(state.mode==='solo') { state.myTotal+=pins; state.frame++; }
    else { state.myTotal+=pins; state.frame++; }
    updateScoreboard();
    $('bowlingLastShot').textContent=`${pins} quille${pins>1?'s':''} abattue${pins>1?'s':''}`;
    $('bowlingRoll').disabled=state.multiplayer && state.activeUser!==user()?.id;
    if(state.multiplayer && state.channel) {
      state.channel.send({type:'broadcast',event:'shot',payload:{user_id:user()?.id,pins,frame:state.frame-1,total:state.myTotal,name:state.myName}}).catch(console.warn);
      state.activeUser=state.players.opponentId||null;
      status('Lancer envoyé. En attente du lancer adverse…');
    } else status(pins===10?'STRIKE ! Magnifique !':pins>=7?'Très beau lancer !':'Bien joué — à toi de rejouer.');
    if(state.frame>10 && !state.multiplayer) $('bowlingRoll').disabled=true;
    setTimeout(()=>{if(state.frame<=10)resetPins();},1300);
  }
  function updateScoreboard() {
    $('bowlingMyScore').textContent=String(state.myTotal);
    $('bowlingFrame').textContent=state.frame>10?'Terminé':String(state.frame);
    $('bowlingOpponentScore').textContent=String(state.opponentTotal);
    $('bowlingOpponentName').textContent=state.opponentName;
    $('bowlingMyName').textContent=state.myName;
  }
  function roll() {
    if(state.rolling || (state.multiplayer && state.activeUser!==user()?.id)) return;
    if(state.frame>10){status('Partie terminée. Lance une nouvelle partie.');return;}
    state.rollAim=Number($('bowlingAim').value)/100;
    state.rollPower=Number($('bowlingPower').value)/100;
    state.rollSpin=Number($('bowlingSpin').value)/100;
    state.rolling=true;state.rollT=0;if(state.ballBody){state.ballBody.wakeUp();state.ballBody.velocity.set(state.rollAim*3.2,0,-(10+state.rollPower*7));state.ballBody.angularVelocity.set(state.rollSpin*5.5,0,state.rollAim*-2.2)}$('bowlingRoll').disabled=true;status('La boule est lancée…');
  }
  function resetMatch() {
    state.frame=1;state.myTotal=0;state.opponentTotal=0;state.lastPins=0;resetPins();updateScoreboard();$('bowlingRoll').disabled=false;$('bowlingLastShot').textContent='Prêt pour le premier lancer';
  }
  async function disconnectRoom() { if(state.channel){try{await state.channel.unsubscribe()}catch(_){}state.channel=null;}state.roomCode=null;state.multiplayer=false;state.players={}; }
  async function enterRoom(code,host=false) {
    const db=window.sspaceDb;const u=user();
    if(!db||!u)throw new Error('Connecte-toi à SSPACE avant de jouer en ligne.');
    await disconnectRoom();state.currentUser=u;state.multiplayer=true;state.host=host;state.mode='multi';state.roomCode=code;state.myName=u.user_metadata?.display_name||u.email?.split('@')[0]||'Joueur';state.activeUser=null;
    $('bowlingRoomCode').textContent=code;show($('bowlingRoomBadge'));status(host?'Salon créé. En attente de ton adversaire…':'Connexion au salon…');
    const ch=db.channel('sspace-bowling-'+code,{config:{broadcast:{self:false},presence:{key:u.id}}});state.channel=ch;
    ch.on('presence',{event:'sync'},()=>{
      const all=ch.presenceState();const ids=Object.keys(all);
      state.players.opponentId=ids.find(id=>id!==u.id)||null;
      const peer=state.players.opponentId?all[state.players.opponentId]?.[0]:null;
      if(peer){state.opponentName=peer.name||'Adversaire';$('bowlingOpponentName').textContent=state.opponentName;status('Adversaire connecté. Que la meilleure partie commence !');if(host){state.activeUser=u.id;$('bowlingRoll').disabled=false;ch.send({type:'broadcast',event:'turn',payload:{user_id:u.id}})}}else if(host){$('bowlingRoll').disabled=true;status('Salon créé. En attente de ton adversaire…')}
    });
    ch.on('broadcast',{event:'turn'},({payload})=>{state.activeUser=payload.user_id;$('bowlingRoll').disabled=state.activeUser!==u.id;status(state.activeUser===u.id?'À toi de jouer !':'C’est au tour de ton adversaire.');});
    ch.on('broadcast',{event:'shot'},({payload})=>{
      if(payload.user_id===u.id)return;
      state.opponentTotal=Number(payload.total)||0;state.opponentName=payload.name||state.opponentName;updateScoreboard();
      state.activeUser=u.id;$('bowlingRoll').disabled=false;status(`${state.opponentName} a renversé ${payload.pins} quilles. À toi !`);resetPins();
      ch.send({type:'broadcast',event:'turn',payload:{user_id:u.id}});
    });
    ch.on('broadcast',{event:'restart'},({payload})=>{resetMatch();state.activeUser=payload?.by||null;$('bowlingRoll').disabled=state.activeUser!==u.id;status(state.activeUser===u.id?'Nouvelle partie démarrée. À toi !':'Nouvelle partie démarrée. Ton adversaire commence.')});
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Le salon ne répond pas. Vérifie la connexion Realtime de Supabase.')),9000);ch.subscribe(async s=>{if(s==='SUBSCRIBED'){clearTimeout(timer);await ch.track({user_id:u.id,name:state.myName,joined_at:new Date().toISOString()});const pres=ch.presenceState();state.players.opponentId=Object.keys(pres).find(id=>id!==u.id)||null;resolve()}else if(s==='CHANNEL_ERROR'||s==='TIMED_OUT'){clearTimeout(timer);reject(new Error('Impossible de rejoindre le salon Realtime.'))}})});
    if(!host){state.activeUser=state.players.opponentId;$('bowlingRoll').disabled=true;}else if(!state.players.opponentId){$('bowlingRoll').disabled=true;}
    updateScoreboard();
  }
  async function createRoom() {
    const code=Math.random().toString(36).slice(2,7).toUpperCase();
    try { await enterRoom(code,true);$('bowlingInviteText').textContent=`Code à partager : ${code}`;show($('bowlingRoomInvite')); }
    catch(e){status(e.message);}
  }
  async function joinRoom() {
    const code=prompt('Entre le code du salon Bowling SSPACE (5 caractères) :');if(!code)return;
    try { await enterRoom(code.trim().toUpperCase(),false);hide($('bowlingRoomInvite')); }
    catch(e){status(e.message);}
  }
  async function copyInvite() {
    const code=state.roomCode;if(!code)return;
    const text=`Rejoins-moi au Bowling 3D SSPACE ! Code du salon : ${code}`;
    try{await navigator.clipboard.writeText(text);status('Invitation copiée. Envoie-la à ton ami dans le chat !');}catch(_){prompt('Copie ce code et envoie-le à ton ami :',text)}
  }
  async function openFromChat() {
    if(!user()){alert('Connecte-toi à SSPACE pour lancer une partie.');return;}
    setModal(true);$('bowlingLobby').classList.remove('hidden');$('bowlingGamePanel').classList.add('hidden');status('Choisis comment tu veux jouer.');
  }
  async function startSolo() {
    await disconnectRoom();state.mode='solo';state.multiplayer=false;state.currentUser=user();state.myName=state.currentUser?.user_metadata?.display_name||state.currentUser?.email?.split('@')[0]||'Moi';state.opponentName='';state.opponentTotal=0;hide($('bowlingRoomBadge'));hide($('bowlingRoomInvite'));$('bowlingLobby').classList.add('hidden');$('bowlingGamePanel').classList.remove('hidden');$('bowlingOpponentCard').classList.add('hidden');try{await ensure3DModules();createRenderer()}catch(e){status('Moteur 3D indisponible : vérifie Internet puis réessaie.');console.error(e);return}resetMatch();status('Mode entraînement — vise, règle la puissance et lance !');$('bowlingRoll').disabled=false;
  }
  async function startMulti() {
    state.opponentName='En attente…';$('bowlingLobby').classList.add('hidden');$('bowlingGamePanel').classList.remove('hidden');$('bowlingOpponentCard').classList.remove('hidden');try{await ensure3DModules();createRenderer()}catch(e){status('Moteur 3D indisponible : vérifie Internet puis réessaie.');console.error(e);return}resetMatch();await createRoom();
  }
  $('bowlingClose').addEventListener('click',async()=>{await disconnectRoom();setModal(false)});
  $('bowlingSolo').addEventListener('click',startSolo);
  $('bowlingCreateRoom').addEventListener('click',startMulti);
  $('bowlingJoinRoom').addEventListener('click',async()=>{state.opponentName='Adversaire';$('bowlingLobby').classList.add('hidden');$('bowlingGamePanel').classList.remove('hidden');$('bowlingOpponentCard').classList.remove('hidden');try{await ensure3DModules();createRenderer()}catch(e){status('Moteur 3D indisponible : vérifie Internet puis réessaie.');console.error(e);return}resetMatch();await joinRoom()});
  $('bowlingCopyInvite').addEventListener('click',copyInvite);
  $('bowlingRoll').addEventListener('click',roll);
  $('bowlingAgain').addEventListener('click',()=>{resetMatch();if(state.multiplayer&&state.channel){state.activeUser=user()?.id;$('bowlingRoll').disabled=false;state.channel.send({type:'broadcast',event:'restart',payload:{by:user()?.id}})}status('Nouvelle partie prête !')});
  $('bowlingAim').addEventListener('input',e=>$('bowlingAimValue').textContent=`${e.target.value}%`);
  $('bowlingPower').addEventListener('input',e=>$('bowlingPowerValue').textContent=`${e.target.value}%`);
  $('bowlingSpin').addEventListener('input',e=>$('bowlingSpinValue').textContent=`${e.target.value}%`);
  window.addEventListener('resize',resize);
  document.addEventListener('click',e=>{const btn=e.target.closest('[data-chat-bowling]');if(btn){btn.closest('.chat-more-menu')?.classList.add('hidden');openFromChat();}});
  window.SSPACE_BOWLING={open:openFromChat,openFromChat};
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!modal.classList.contains('hidden'))$('bowlingClose').click()});
})();
