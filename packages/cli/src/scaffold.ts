import { cp, mkdir, writeFile } from 'node:fs/promises';
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

  const files: Record<string, string> = {
    'package.json': JSON.stringify({
      name: basename(outDir),
      private: true,
      type: 'module',
      scripts: { dev: 'vite', build: 'tsc -b && vite build', preview: 'vite preview' },
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
    <title>XUI Viewer</title>
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
    'src/App.tsx': `import { Suspense } from 'react';
import { Canvas } from '@react-three/fiber';
import {
  Center,
  Environment,
  Lightformer,
  OrbitControls,
  Stats,
  useGLTF,
} from '@react-three/drei';

function Model() {
  // drei's useGLTF wires up the meshopt decoder automatically.
  const { scene } = useGLTF('/model.glb');
  return <primitive object={scene} />;
}

export default function App() {
  return (
    <Canvas camera={{ position: [0, 0.8, 2.2], fov: 45 }} shadows dpr={[1, 2]}>
      <Suspense fallback={null}>
        <Center>
          <Model />
        </Center>
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

useGLTF.preload('/model.glb');
`,
  };

  for (const [rel, content] of Object.entries(files)) {
    await writeFile(join(outDir, rel), content);
  }
}
