import { Suspense } from 'react';
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
