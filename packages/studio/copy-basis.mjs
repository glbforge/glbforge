// Ship the KTX2 transcoder with the studio bundle so KTX2 assets decode.
import { cpSync, existsSync, mkdirSync } from 'node:fs';
const src = 'node_modules/three/examples/jsm/libs/basis';
if (existsSync(src)) {
  mkdirSync('public/basis', { recursive: true });
  cpSync(src, 'public/basis', { recursive: true });
}
