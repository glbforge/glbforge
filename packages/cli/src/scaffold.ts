import { cp, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';

/**
 * Emits a minimal, self-contained Vite + React Three Fiber viewer for an
 * optimized GLB. Deliberately not a workspace package: the output is meant
 * to be copied into (or become) the user's own project.
 */
export async function scaffoldViewer(glbPath: string, outDir: string): Promise<void> {
  await mkdir(join(outDir, 'src'), { recursive: true });
  await mkdir(join(outDir, 'public'), { recursive: true });
  await cp(glbPath, join(outDir, 'public', 'model.glb'));

  // Sibling LOD files (from `glbforge optimize --lods`) ride along automatically.
  const lodBase = glbPath.replace(/\.glb$/i, '');
  const lods: number[] = [];
  for (let i = 1; existsSync(`${lodBase}.lod${i}.glb`); i++) {
    await cp(`${lodBase}.lod${i}.glb`, join(outDir, 'public', `model.lod${i}.glb`));
    lods.push(i);
  }

  const files: Record<string, string> = {
    'package.json': JSON.stringify({
      name: basename(outDir),
      private: true,
      type: 'module',
      scripts: {
        dev: 'vite', build: 'tsc -b && vite build', preview: 'vite preview',
        // KTX2 transcoder wasm must be served locally for KTX2-encoded GLBs.
        postinstall: "node -e \"const fs=require('fs');const src='node_modules/three/examples/jsm/libs/basis';if(fs.existsSync(src))fs.cpSync(src,'public/basis',{recursive:true})\"",
      },
      dependencies: {
        react: '^18.3.0',
        'react-dom': '^18.3.0',
        three: '^0.169.0',
        '@react-three/fiber': '^8.17.0',
        '@react-three/drei': '^9.114.0',
      },
      devDependencies: {
        typescript: '^5.6.0',
        vite: '^5.4.0',
        '@vitejs/plugin-react': '^4.3.0',
        '@types/react': '^18.3.0',
        '@types/react-dom': '^18.3.0',
        '@types/three': '^0.169.0',
      },
    }, null, 2),

    'vite.config.ts': `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({ plugins: [react()] });
`,

    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler',
        jsx: 'react-jsx', strict: true, skipLibCheck: true, noEmit: true,
        lib: ['ES2022', 'DOM', 'DOM.Iterable'],
      },
      include: ['src'],
    }, null, 2),

    'index.html': `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>GLBForge Viewer</title>
    <style>html, body, #root { margin: 0; height: 100%; background: #101014; }</style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,

    'src/main.tsx': `import { createRoot } from 'react-dom/client';
import App from './App';

createRoot(document.getElementById('root')!).render(<App />);
`,

    // Environment is built from Lightformers (procedural) so the viewer
    // works offline — drei's HDR presets fetch from a CDN at runtime.
    'src/App.tsx': `import { Suspense${lods.length ? ', useMemo' : ''} } from 'react';
import { Canvas } from '@react-three/fiber';
import { useThree } from '@react-three/fiber';
import {
  Bounds,
  Center,
  ${lods.length ? 'Detailed,\n  ' : ''}Environment,
  Lightformer,
  OrbitControls,
  Stats,
  useGLTF,
} from '@react-three/drei';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';

// Transcoder wasm is copied into public/basis by the postinstall script.
const ktx2Loader = new KTX2Loader().setTranscoderPath('/basis/');

${lods.length ? modelWithLods(lods) : `function Model() {
  const gl = useThree((state) => state.gl);
  // drei's useGLTF wires up the meshopt decoder automatically; the extension
  // callback adds KTX2 texture support (harmless for non-KTX2 assets).
  const { scene } = useGLTF('/model.glb', true, true, (loader) => {
    loader.setKTX2Loader(ktx2Loader.detectSupport(gl));
  });
  return <primitive object={scene} />;
}`}

export default function App() {
  return (
    <Canvas camera={{ position: [0, 0.8, 2.2], fov: 45 }} shadows dpr={[1, 2]}>
      <Suspense fallback={null}>
        {/* Bounds auto-frames whatever size the asset is. */}
        <Bounds fit clip observe margin={1.2}>
          <Center>
            <Model />
          </Center>
        </Bounds>
        <Environment resolution={256}>
          {/* Simple studio: key, fill, rim, plus a bounce card below. */}
          <Lightformer position={[3, 2, 3]} scale={5} intensity={7} color="#ffffff" />
          <Lightformer position={[-3, 1, 2]} scale={4} intensity={3.5} color="#dfe8ff" />
          <Lightformer position={[0, 3, -4]} scale={4} intensity={4} color="#fff2d8" />
          <Lightformer position={[0, -2, 2]} rotation-x={Math.PI / 2} scale={4} intensity={1.5} color="#ffffff" />
        </Environment>
      </Suspense>
      <OrbitControls makeDefault enableDamping target={[0, 0, 0]} />
      <Stats />
    </Canvas>
  );
}

// NOTE: no useGLTF.preload here — preload would cache a loader without the
// KTX2 extension callback (detectSupport needs the live renderer anyway).
`,
  };

  for (const [rel, content] of Object.entries(files)) {
    await writeFile(join(outDir, rel), content);
  }
}

/** Model component source for scaffold output when LOD siblings exist. */
function modelWithLods(lods: number[]): string {
  const urls = ["'/model.glb'", ...lods.map((i) => `'/model.lod${i}.glb'`)];
  // Distance thresholds: primary up close, then one step per LOD.
  const distances = [0, ...lods.map((i) => i * 4)];
  return `function Model() {
  const gl = useThree((state) => state.gl);
  const extend = (loader: any) => loader.setKTX2Loader(ktx2Loader.detectSupport(gl));
  // Primary + LOD chain. LOD files are geometry-only (glbforge optimize --lods
  // strips materials), so the primary's materials are shared into them below.
  const gltfs = useGLTF([${urls.join(', ')}], true, true, extend);
  const [full, ...lods] = gltfs;

  useMemo(() => {
    const materials: Record<string, unknown> = {};
    let firstMaterial: unknown = null;
    full.scene.traverse((o: any) => {
      if (o.isMesh) {
        materials[o.name] = o.material;
        firstMaterial ??= o.material;
      }
    });
    for (const lod of lods) {
      lod.scene.traverse((o: any) => {
        if (o.isMesh) o.material = materials[o.name] ?? firstMaterial;
      });
    }
  }, [gltfs]);

  return (
    <Detailed distances={[${distances.join(', ')}]}>
      <primitive object={full.scene} />
${lods.map((_, k) => `      <primitive object={lods[${k}].scene} />`).join('\n')}
    </Detailed>
  );
}`;
}
