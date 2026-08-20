import { Suspense, useEffect, useMemo, useState } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { Bounds, Center, Environment, Lightformer, OrbitControls, useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { api, type AssetDetail } from '../api';

const ktx2Loader = new KTX2Loader().setTranscoderPath('/basis/');

function useModel(url: string) {
  const gl = useThree((s) => s.gl);
  const { scene } = useGLTF(url, true, true, (loader) => {
    loader.setKTX2Loader(ktx2Loader.detectSupport(gl));
  });
  return scene;
}

/** Apply a clipping plane to every material in a scene (for A/B compare). */
function useClip(scene: THREE.Object3D, plane: THREE.Plane | null) {
  useEffect(() => {
    scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) {
        material.clippingPlanes = plane ? [plane] : [];
        material.clipShadows = true;
        material.needsUpdate = true;
      }
    });
  }, [scene, plane]);
}

function Single({ url }: { url: string }) {
  const scene = useModel(url);
  useClip(scene, null);
  return <primitive object={scene} />;
}

/**
 * Before/after in one scene: the original occupies the left of the slider
 * plane, the optimized variant the right. Same world space, so silhouette
 * and shading differences read directly.
 */
function Compare({ beforeUrl, afterUrl, split }: { beforeUrl: string; afterUrl: string; split: number }) {
  const before = useModel(beforeUrl);
  const after = useModel(afterUrl);

  const { planeLeft, planeRight } = useMemo(() => ({
    planeLeft: new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0),
    planeRight: new THREE.Plane(new THREE.Vector3(1, 0, 0), 0),
  }), []);

  // Map split (0..1) onto the combined bounding range in x.
  useEffect(() => {
    const box = new THREE.Box3().setFromObject(before);
    const x = box.min.x + (box.max.x - box.min.x) * split;
    planeLeft.constant = x;        // keeps points with px < x  (before)
    planeRight.constant = -x;      // keeps points with px > x  (after)
  }, [before, split, planeLeft, planeRight]);

  useClip(before, planeLeft);
  useClip(after, planeRight);

  return (
    <group>
      <primitive object={before} />
      <primitive object={after} />
    </group>
  );
}

export function Viewport(props: { asset: AssetDetail | null; compareWith: string | null }) {
  const [split, setSplit] = useState(0.5);

  if (!props.asset) {
    return (
      <div className="viewport">
        <div className="viewport-empty">
          <div style={{ fontSize: 40 }}>⬢</div>
          <div>Drop an asset to begin</div>
        </div>
      </div>
    );
  }

  const url = api.fileUrl(props.asset.id);
  const compareUrl = props.compareWith ? api.fileUrl(props.compareWith) : null;

  return (
    <div className="viewport">
      <div className="viewport-badge">
        {compareUrl ? 'original ⟷ optimized' : props.asset.name}
      </div>
      <Canvas
        key={props.asset.id + (compareUrl ?? '')}
        camera={{ position: [0, 0.6, 2.4], fov: 45 }}
        dpr={[1, 2]}
        gl={{ localClippingEnabled: true }}
      >
        <Suspense fallback={null}>
          <Bounds fit clip observe margin={1.25}>
            <Center>
              {compareUrl
                ? <Compare beforeUrl={compareUrl} afterUrl={url} split={split} />
                : <Single url={url} />}
            </Center>
          </Bounds>
          <Environment resolution={256}>
            <Lightformer position={[3, 2, 3]} scale={5} intensity={7} color="#ffffff" />
            <Lightformer position={[-3, 1, 2]} scale={4} intensity={3.5} color="#dfe8ff" />
            <Lightformer position={[0, 3, -4]} scale={4} intensity={4} color="#fff2d8" />
            <Lightformer position={[0, -2, 2]} rotation-x={Math.PI / 2} scale={4} intensity={1.5} color="#ffffff" />
          </Environment>
        </Suspense>
        <OrbitControls makeDefault enableDamping />
      </Canvas>
      {compareUrl && (
        <div className="compare-slider">
          <input
            type="range" min={0} max={1} step={0.01} value={split}
            onChange={(e) => setSplit(Number(e.target.value))}
          />
          <div className="compare-labels"><span>original</span><span>optimized</span></div>
        </div>
      )}
    </div>
  );
}
