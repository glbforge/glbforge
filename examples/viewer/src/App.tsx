import { Suspense, useMemo } from 'react';
import { Canvas } from '@react-three/fiber';
import { useThree } from '@react-three/fiber';
import {
  Center,
  Detailed,
  Environment,
  Lightformer,
  OrbitControls,
  Stats,
  useGLTF,
} from '@react-three/drei';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';

// Transcoder wasm is copied into public/basis by the postinstall script.
const ktx2Loader = new KTX2Loader().setTranscoderPath('/basis/');

function Model() {
  const gl = useThree((state) => state.gl);
  const extend = (loader: any) => loader.setKTX2Loader(ktx2Loader.detectSupport(gl));
  // Primary + LOD chain. LOD files are geometry-only (xui optimize --lods
  // strips materials), so the primary's materials are shared into them below.
  const gltfs = useGLTF(['/model.glb', '/model.lod1.glb', '/model.lod2.glb'], true, true, extend);
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
    <Detailed distances={[0, 4, 8]}>
      <primitive object={full.scene} />
      <primitive object={lods[0].scene} />
      <primitive object={lods[1].scene} />
    </Detailed>
  );
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

// NOTE: no useGLTF.preload here — preload would cache a loader without the
// KTX2 extension callback (detectSupport needs the live renderer anyway).
