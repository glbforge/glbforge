/**
 * Renderer: a GLB in a transparent window that plays its clips, looks at the
 * cursor, leans into a drag, fidgets when ignored, takes a typed message
 * (double-click or `/`), and answers the main process's commands.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const canvas = document.getElementById('view');
const bubble = document.getElementById('bubble');
const chatBox = document.getElementById('chat');
const chatInput = document.getElementById('chat-input');
const statusEl = document.getElementById('status');

const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, premultipliedAlpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(0x000000, 0);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
const camera = new THREE.PerspectiveCamera(32, 1, 0.01, 100);
camera.position.set(0, 0.15, 2.9);
camera.lookAt(0, 0, 0);
const key = new THREE.DirectionalLight(0xffffff, 1.6); key.position.set(1.5, 3, 2.5); scene.add(key);
scene.add(new THREE.HemisphereLight(0xffffff, 0x777788, 0.5));

// look-at (cursor / lean) → gesture (procedural) → model (normalized)
const look = new THREE.Group(); look.position.y = -0.3; scene.add(look);   // model sits low; the top band is for the bubble
const gesture = new THREE.Group(); look.add(gesture);
let model = null, mixer = null, clips = [], current = null, currentClip = null, currentLoop = true, idleName = null;
let triangles = 0, meshes = 0;
const clock = new THREE.Clock();

const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);

function status(text, ms = 2500) { statusEl.textContent = text; statusEl.classList.add('show'); clearTimeout(status.t); status.t = setTimeout(() => statusEl.classList.remove('show'), ms); }
function pushState(patch) { window.companion.state(patch); }

async function load() {
  const res = await fetch('/model');
  if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
  const buffer = await res.arrayBuffer();
  const gltf = await new Promise((resolve, reject) => loader.parse(buffer, '', resolve, reject));
  if (model) { gesture.remove(model); mixer?.stopAllAction(); }
  model = gltf.scene;
  triangles = 0; meshes = 0;
  model.traverse((o) => { if (o.isMesh) { meshes++; const g = o.geometry; triangles += Math.floor((g.index ? g.index.count : g.attributes.position.count) / 3); } });
  // Normalize: height 1, base at y = -0.5, footprint centred — framed on the rest pose so a clip's rise stays in view.
  const box = new THREE.Box3().setFromObject(model);
  const size = new THREE.Vector3(); box.getSize(size);
  const s = 1 / Math.max(size.y, size.x * 0.8, size.z * 0.8, 1e-6);
  const center = new THREE.Vector3(); box.getCenter(center);
  model.scale.setScalar(s);
  model.position.set(-center.x * s, -box.min.y * s - 0.5, -center.z * s);
  gesture.add(model);
  clips = gltf.animations;
  mixer = new THREE.AnimationMixer(model);
  mixer.addEventListener('finished', () => { if (idleName !== null) play({ clip: idleName, loop: true }); });
  idleName = clips.find((c) => /idle/i.test(c.name))?.name ?? clips[0]?.name ?? null;
  current = null; currentClip = null;
  pushState({ loaded: true, clips: clips.map((c) => ({ name: c.name, duration: Math.round(c.duration * 1e6) / 1e6 })), playing: null, error: null, triangles, meshes });
  if (idleName !== null) play({ clip: idleName, loop: true });
  emote({ gesture: 'wave' });
  return { clips: clips.map((c) => c.name), idle: idleName, triangles, meshes };
}

function play({ clip, loop = true, speed = 1 }) {
  if (!mixer) throw new Error('no model loaded');
  const c = typeof clip === 'number' ? clips[clip] : clips.find((x) => x.name === clip);
  if (!c) throw new Error(`no clip "${clip}" (have: ${clips.map((x) => x.name).join(', ') || 'none'})`);
  const action = mixer.clipAction(c);
  action.reset().setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity).setEffectiveTimeScale(speed);
  action.clampWhenFinished = false;
  if (current && current !== action) { current.crossFadeTo(action, 0.25, false); action.play(); }
  else action.play();
  current = action; currentClip = c; currentLoop = loop;
  pushState({ playing: c.name });
  return { playing: c.name, loop, duration: Math.round(c.duration * 1e6) / 1e6, speed };
}

// --- procedural gestures on any GLB (no clip needed) ---
let tween = null;
const GESTURES = { hop: 0.6, spin: 1.0, nod: 0.7, shake: 0.6, wave: 1.2 };
function emote({ gesture: name = 'hop', seconds }) {
  const dur = seconds ?? GESTURES[name];
  if (dur === undefined) throw new Error(`unknown gesture "${name}" (${Object.keys(GESTURES).join(' | ')})`);
  tween = { name, t0: clock.elapsedTime, dur };
  lastInteraction = clock.elapsedTime;
  return { gesture: name, seconds: dur };
}
let lean = 0;           // drag lean (radians), decays
function applyGesture(now) {
  gesture.position.set(0, 0, 0); gesture.rotation.set(0, 0, -lean); gesture.scale.setScalar(1);
  if (!tween) return;
  const u = Math.min(1, (now - tween.t0) / tween.dur);
  const arc = Math.sin(Math.PI * u);
  switch (tween.name) {
    case 'hop': gesture.position.y = 0.18 * arc; gesture.scale.set(1 + 0.06 * (1 - arc) ** 4, 1 - 0.1 * (1 - arc) ** 4, 1 + 0.06 * (1 - arc) ** 4); break;
    case 'spin': gesture.rotation.y = 2 * Math.PI * (0.5 - 0.5 * Math.cos(Math.PI * u)); break;
    case 'nod': gesture.rotation.x = 0.28 * Math.sin(2 * Math.PI * u) * (1 - u * 0.3); break;
    case 'shake': gesture.rotation.y = 0.35 * Math.sin(3 * Math.PI * u) * (1 - u); break;
    case 'wave': gesture.rotation.z += 0.12 * Math.sin(4 * Math.PI * u) * arc; gesture.position.y = 0.03 * arc; break;
  }
  if (u >= 1) tween = null;
}

// --- speech bubble (with a thinking state and streamed text) ---
let bubbleTimer = null, bubbleUntil = 0, thinking = false;
function showBubble(text, seconds) {
  clearTimeout(bubbleTimer);
  bubble.classList.remove('thinking');
  bubble.textContent = text;
  bubble.classList.toggle('long', text.length > 140);
  bubble.classList.add('show');
  bubbleUntil = seconds ? performance.now() + seconds * 1000 : Infinity;
  if (seconds) bubbleTimer = setTimeout(() => { bubble.classList.remove('show'); bubbleUntil = 0; pushState({ bubble: null }); }, seconds * 1000);
}
function say({ text, seconds = 4 }) {
  if (!text) { clearTimeout(bubbleTimer); bubble.classList.remove('show', 'thinking'); bubbleUntil = 0; pushState({ bubble: null }); return { shown: false }; }
  showBubble(text, seconds);
  pushState({ bubble: text });
  return { shown: true, seconds };
}
function setThinking(on, hint) {
  thinking = on;
  if (on) {
    clearTimeout(bubbleTimer);
    bubble.innerHTML = '<span>•</span><span>•</span><span>•</span>';
    bubble.classList.add('show', 'thinking'); bubble.classList.remove('long');
    bubbleUntil = Infinity;
    if (hint) status(hint, 4000);
  } else if (bubble.classList.contains('thinking')) {
    bubble.classList.remove('show', 'thinking'); bubbleUntil = 0;
  }
  return { thinking: on };
}
window.companion.onStream(({ text, done }) => { if (!done) showBubble(text, 0); });

// --- cursor gaze + fidgets when ignored ---
const gaze = { x: 0, y: 0 };
let lastInteraction = 0, nextFidget = 20;
setInterval(async () => {
  const c = await window.companion.cursor();
  if (!c) return;
  const inRange = c.x > -1.5 && c.x < 2.5 && c.y > -1.5 && c.y < 2.5;
  gaze.x = inRange ? THREE.MathUtils.clamp((c.x - 0.5) * 0.9, -0.45, 0.45) : 0;
  gaze.y = inRange ? THREE.MathUtils.clamp((c.y - 0.5) * 0.35, -0.18, 0.18) : 0;
}, 120);
const FIDGETS = ['nod', 'wave', 'shake', 'hop'];
let fidgetIx = 0;
function maybeFidget(now) {
  if (thinking || tween || bubbleUntil > performance.now() || chatBox.classList.contains('show')) return;
  if (now - lastInteraction < nextFidget) return;
  emote({ gesture: FIDGETS[fidgetIx++ % FIDGETS.length] });
  nextFidget = 18 + (fidgetIx * 7) % 25;          // 18–42 s, deterministic cycle
}

// --- drag to move (lean into it), click to react, double-click / "/" to talk ---
const greetings = ['hi!', 'need anything? double-click to talk.', '*stretches*', 'still here.', 'nice cursor.'];
let greet = 0;
window.companion.onDrag(({ vx }) => { lean = THREE.MathUtils.clamp(lean + vx * 0.004, -0.35, 0.35); });
canvas.addEventListener('mousedown', (e) => { if (e.button !== 0) return; canvas.classList.add('dragging'); window.companion.dragStart(); });
window.addEventListener('mouseup', async () => {
  if (!canvas.classList.contains('dragging')) return;
  canvas.classList.remove('dragging');
  const { moved } = await window.companion.dragEnd();
  lastInteraction = clock.elapsedTime;
  if (!moved) { emote({ gesture: 'hop' }); if (!thinking) say({ text: greetings[greet++ % greetings.length], seconds: 2.5 }); window.companion.event({ kind: 'click' }); }
});
canvas.addEventListener('dblclick', () => openChat());
window.addEventListener('keydown', (e) => {
  if (e.key === '/' && !chatBox.classList.contains('show')) { e.preventDefault(); openChat(); }
  else if (e.key === 'Escape') closeChat();
});
function openChat() { chatBox.classList.add('show'); chatInput.focus(); pushState({ chat_open: true }); }
function closeChat() { chatBox.classList.remove('show'); chatInput.blur(); pushState({ chat_open: false }); }
chatInput.addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return;
  const text = chatInput.value.trim();
  if (!text) return;
  chatInput.value = '';
  lastInteraction = clock.elapsedTime;
  try {
    const r = await window.companion.chat(text);
    if (r?.queued) status('waiting for a brain (external mode)', 4000);
  } catch (err) { status(err.message, 6000); }
});

// --- commands from main ---
window.companion.onCommand(async ({ id, cmd, payload }) => {
  try {
    let result;
    switch (cmd) {
      case 'load': result = await load(); status(`loaded ${payload.name}`); break;
      case 'play': result = play(payload); break;
      case 'emote': result = emote(payload); break;
      case 'say': result = say(payload); break;
      case 'thinking': result = setThinking(!!payload.on, payload.hint); break;
      case 'state': result = {
        playing: currentClip?.name ?? null, clip_time: current ? Math.round(current.time * 100) / 100 : null, loop: currentClip ? currentLoop : null,
        gesture: tween ? tween.name : null, bubble: bubble.classList.contains('show') && !thinking ? bubble.textContent : null,
        bubble_remaining: bubbleUntil === Infinity ? null : Math.max(0, Math.round((bubbleUntil - performance.now()) / 100) / 10) || null,
        thinking, chat_open: chatBox.classList.contains('show'), gaze: { x: Math.round(gaze.x * 100) / 100, y: Math.round(gaze.y * 100) / 100 },
      }; break;
      default: throw new Error(`unknown command ${cmd}`);
    }
    window.companion.reply(id, true, result);
  } catch (e) {
    window.companion.reply(id, false, null, e.message);
  }
});

// --- frame loop ---
function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== w * renderer.getPixelRatio() || canvas.height !== h * renderer.getPixelRatio()) { renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); }
}
// 30 fps is plenty for a desktop pet and halves the GPU/CPU it takes from the machine it lives on.
const FRAME_MS = 1000 / Number(new URLSearchParams(location.search).get('fps') || 30);
let lastFrame = 0;
function frame(now = 0) {
  requestAnimationFrame(frame);
  if (now - lastFrame < FRAME_MS - 1) return;
  lastFrame = now;
  resize();
  const dt = clock.getDelta();
  mixer?.update(dt);
  look.rotation.y += (gaze.x - look.rotation.y) * 0.08;
  look.rotation.x += ((thinking ? 0.06 * Math.sin(clock.elapsedTime * 2.2) : gaze.y) - look.rotation.x) * 0.08;
  lean *= 0.9;
  applyGesture(clock.elapsedTime);
  maybeFidget(clock.elapsedTime);
  renderer.render(scene, camera);
}
frame();

load().then((r) => status(`${r.clips.length} clip(s)${r.idle ? `, playing ${r.idle}` : ''} · ${r.triangles.toLocaleString()} tris · double-click to talk`, 5000)).catch((e) => { pushState({ loaded: false, error: e.message }); status(e.message, 8000); });
