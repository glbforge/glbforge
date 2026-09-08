import type { Accessor } from '@gltf-transform/core';

/**
 * Read an accessor as floats, honoring KHR_mesh_quantization's normalized
 * integer encodings (optimized GLBs store positions as normalized int16 and
 * UVs as normalized uint16). `getArray()` alone returns the raw integers.
 */
export function readFloat(accessor: Accessor): Float32Array {
  const raw = accessor.getArray()!;
  if (raw instanceof Float32Array) return raw;
  const out = new Float32Array(raw.length);
  if (!accessor.getNormalized()) {
    for (let i = 0; i < raw.length; i++) out[i] = raw[i];
    return out;
  }
  const max = raw instanceof Int8Array ? 127
    : raw instanceof Uint8Array ? 255
    : raw instanceof Int16Array ? 32767
    : raw instanceof Uint16Array ? 65535
    : 1;
  for (let i = 0; i < raw.length; i++) out[i] = Math.max(-1, raw[i] / max);
  return out;
}
