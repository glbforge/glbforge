/**
 * `optimize({ textureFormat: 'ktx2' })` is GLBForge's own "~8x less VRAM"
 * texture path (packages/core/src/ktx2.ts). Feeding a KTX2-textured GLB to
 * the exact loader wiring `renderer/app.js` used to ship (GLTFLoader +
 * MeshoptDecoder, no KTX2Loader) throws synchronously, before anything
 * renders: `THREE.GLTFLoader: setKTX2Loader must be called before loading
 * KTX2 textures`. No other product surface in this repo exercises this path
 * — model-viewer/three.js meshopt wiring is covered elsewhere, but nothing
 * touched the companion's own KTX2 handling until this test.
 *
 * `fixtures/ktx2-quad.glb` is a minimal real repro: a single textured quad
 * built with @gltf-transform/core and compressed with the same
 * `ktx2Compress()` the CLI/MCP call, via `basisu`.
 *
 * This is a static + functional pair on purpose: the static check fails if
 * `app.js`'s wiring is ever reverted; the functional check proves *why* that
 * specific wiring is the fix (not just that some string is present).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

const FIXTURE = new URL('./fixtures/ktx2-quad.glb', import.meta.url);
const APP_JS = new URL('../renderer/app.js', import.meta.url);
const MISSING_LOADER_ERROR = /setKTX2Loader must be called/;

async function readFixtureArrayBuffer() {
  const buf = await readFile(FIXTURE);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function parse(loader, arrayBuffer) {
  return new Promise((resolve, reject) => loader.parse(arrayBuffer, '', resolve, reject));
}

test('renderer/app.js registers a KTX2Loader on the GLTFLoader', async () => {
  const src = await readFile(APP_JS, 'utf8');
  assert.match(src, /from ['"]three\/addons\/loaders\/KTX2Loader\.js['"]/, 'app.js must import KTX2Loader');
  assert.match(src, /loader\.setKTX2Loader\(/, 'app.js must call loader.setKTX2Loader(...)');
});

test('without a KTX2Loader, GLBForge\'s own KTX2 texture output cannot be parsed (documents the bug)', async () => {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const arrayBuffer = await readFixtureArrayBuffer();
  await assert.rejects(() => parse(loader, arrayBuffer), MISSING_LOADER_ERROR);
});

test('wiring a KTX2Loader the way app.js now does clears that specific failure', async () => {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const ktx2Loader = new KTX2Loader().setTranscoderPath('/node_modules/three/examples/jsm/libs/basis/');
  loader.setKTX2Loader(ktx2Loader);
  const arrayBuffer = await readFixtureArrayBuffer();
  // Full transcode needs a Worker + WebGL context (a real Electron renderer
  // has both; this Node test has neither), so the parse can still fail —
  // just never with the "no loader registered" error the bug reproduced.
  await assert.rejects(() => parse(loader, arrayBuffer), (err) => {
    assert.doesNotMatch(err.message, MISSING_LOADER_ERROR);
    return true;
  });
});
