export * from './types.js';
export { readUsdc } from './usdc-read.js';
export { readUsda, coerce as coerceUsdaValue } from './usda-read.js';
export { readUsdz, findUsdzEntry, type UsdzContainer, type UsdzEntry } from './usdz-read.js';
export { lz4DecompressBlock, tfDecompress, decompressInts32, decompressInts64, fromHalf } from './compression.js';

import type { UsdLayerData } from './types.js';
import { readUsdc } from './usdc-read.js';
import { readUsda } from './usda-read.js';

/** Read a single USD layer from bytes, sniffing crate vs ASCII. */
export function readUsdLayer(bytes: Uint8Array): UsdLayerData {
  const head = new TextDecoder().decode(bytes.subarray(0, 8));
  if (head === 'PXR-USDC') return readUsdc(bytes);
  return readUsda(new TextDecoder().decode(bytes));
}
