# @glbforge/meshy

Typed [Meshy](https://meshy.ai) API client used by
[glbforge](https://www.npmjs.com/package/glbforge).

- `createImageTo3D` / `createTextTo3DPreview` / `createTextTo3DRefine`
- `createRemesh` / `createRetexture` / `getBalance`
- `waitForTask` — polling with exponential backoff on 429/5xx
- `downloadModel` — glb/fbx/usdz/obj/stl

Auth via `MESHY_API_KEY` (or `new MeshyClient({apiKey})`).

Docs: **https://github.com/glbforge/glbforge**
