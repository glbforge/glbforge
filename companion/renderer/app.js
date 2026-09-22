/**
 * Renderer: a GLB in a transparent window that plays its clips, looks at the
 * cursor, and answers the main process's commands (load / play / emote / say).
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const canvas = document.getElementById('view');
const bubble = document.getElementById('bubble');
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

// look-at (cursor) → gesture (procedural) → model (normalized) hierarchy
const look = new THREE.Group(); scene.add(look);
const gesture = new THREE.Group(); look.add(gesture);
let model = null, mixer = null, clips = [], current = null, idleName = null;
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
  current = null;
  pushState({ loaded: true, clips: clips.map((c) => ({ name: c.name, duration: Math.round(c.duration * 1e6) / 1e6 })), playing: null, error: null });
  if (idleName !== null) play({ clip: idleName, loop: true });
  return { clips: clips.map((c) => c.name), idle: idleName };
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
  current = action;
  pushState({ playing: c.name });
  return { playing: c.name, loop, duration: c.duration };
}

// --- procedural gestures on any GLB (no clip needed) ---
let tween = null;
function emote({ gesture: name = 'hop', seconds }) {
  const dur = seconds ?? { hop: 0.6, spin: 1.0, nod: 0.7, shake: 0.6, wave: 1.2 }[name];
  if (dur === undefined) throw new Error(`unknown gesture "${name}" (hop | spin | nod | shake | wave)`);
  const t0 = clock.elapsedTime;
  tween = { name, t0, dur };
  return { gesture: name, seconds: dur };
}
function applyGesture(now) {
  gesture.position.set(0, 0, 0); gesture.rotation.set(0, 0, 0); gesture.scale.setScalar(1);
  if (!tween) return;
  const u = Math.min(1, (now - tween.t0) / tween.dur);
  const arc = Math.sin(Math.PI * u);
  switch (tween.name) {
    case 'hop': gesture.position.y = 0.18 * arc; gesture.scale.set(1 + 0.06 * (1 - arc) ** 4, 1 - 0.1 * (1 - arc) ** 4, 1 + 0.06 * (1 - arc) ** 4); break;
    case 'spin': gesture.rotation.y = 2 * Math.PI * (0.5 - 0.5 * Math.cos(Math.PI * u)); break;
    case 'nod': gesture.rotation.x = 0.28 * Math.sin(2 * Math.PI * u) * (1 - u * 0.3); break;
    case 'shake': gesture.rotation.y = 0.35 * Math.sin(3 * Math.PI * u) * (1 - u); break;
    case 'wave': gesture.rotation.z = 0.12 * Math.sin(4 * Math.PI * u) * arc; gesture.position.y = 0.03 * arc; break;
  }
  if (u >= 1) tween = null;
}

// --- speech bubble ---
let bubbleTimer = null;
function say({ text, seconds = 4 }) {
  clearTimeout(bubbleTimer);
  if (!text) { bubble.classList.remove('show'); pushState({ bubble: null }); return { shown: false }; }
  bubble.textContent = text;
  bubble.classList.add('show');
  pushState({ bubble: text });
  bubbleTimer = setTimeout(() => { bubble.classList.remove('show'); pushState({ bubble: null }); }, seconds * 1000);
  return { shown: true, seconds };
}

// --- cursor gaze: the model turns a little toward the pointer ---
const gaze = { x: 0, y: 0 };
setInterval(async () => {
  const c = await window.companion.cursor();
  if (!c) return;
  const inRange = c.x > -1.5 && c.x < 2.5 && c.y > -1.5 && c.y < 2.5;
  gaze.x = inRange ? THREE.MathUtils.clamp((c.x - 0.5) * 0.9, -0.45, 0.45) : 0;
  gaze.y = inRange ? THREE.MathUtils.clamp((c.y - 0.5) * 0.35, -0.18, 0.18) : 0;
}, 120);

// --- drag to move, click to react ---
const greetings = ['hi!', 'need anything?', '*stretches*', 'still here.', 'nice cursor.'];
let greet = 0;
canvas.addEventListener('mousedown', (e) => { if (e.button !== 0) return; canvas.classList.add('dragging'); window.companion.dragStart(); });
window.addEventListener('mouseup', async () => {
  if (!canvas.classList.contains('dragging')) return;
  canvas.classList.remove('dragging');
  const { moved } = await window.companion.dragEnd();
  if (!moved) { emote({ gesture: 'hop' }); say({ text: greetings[greet++ % greetings.length], seconds: 2.5 }); }
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
  look.rotation.x += (gaze.y - look.rotation.x) * 0.08;
  applyGesture(clock.elapsedTime);
  renderer.render(scene, camera);
}
frame();

load().then((r) => status(`${r.clips.length} clip(s)${r.idle ? `, playing ${r.idle}` : ''}`)).catch((e) => { pushState({ loaded: false, error: e.message }); status(e.message, 8000); });
