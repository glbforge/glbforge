/**
 * Deterministic fixtures for every agent-feedback failure mode. Built in
 * code (LFS is not pulled in CI) and, for the USD-only cases, as small
 * .usda text files. `writeAgentFixtures(dir)` materializes all of them.
 */
import { Document } from '@gltf-transform/core';
import { createNodeIO } from '../src/index.js';

/** Grid mesh: (n+1)^2 vertices, 2n^2 triangles, optional UVs / normals, size in metres. */
export function makeGrid(doc: Document, n: number, size: number, opts: { uvs?: boolean; normals?: boolean; name?: string } = {}) {
  const buffer = doc.getRoot().listBuffers()[0] ?? doc.createBuffer();
  const verts = (n + 1) * (n + 1);
  const pos = new Float32Array(verts * 3), uv = new Float32Array(verts * 2), nrm = new Float32Array(verts * 3);
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
    const k = j * (n + 1) + i;
    pos[k * 3] = (i / n - 0.5) * size; pos[k * 3 + 1] = Math.sin((i / n) * Math.PI) * Math.sin((j / n) * Math.PI) * size * 0.3; pos[k * 3 + 2] = (j / n - 0.5) * size;
    uv[k * 2] = i / n; uv[k * 2 + 1] = j / n;
    nrm[k * 3 + 1] = 1;
  }
  const idx: number[] = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const acc = (type: 'VEC2' | 'VEC3' | 'SCALAR', arr: Float32Array | Uint32Array) => doc.createAccessor().setType(type).setArray(arr).setBuffer(buffer);
  const prim = doc.createPrimitive().setAttribute('POSITION', acc('VEC3', pos)).setIndices(acc('SCALAR', new Uint32Array(idx)));
  if (opts.uvs) prim.setAttribute('TEXCOORD_0', acc('VEC2', uv));
  if (opts.normals) prim.setAttribute('NORMAL', acc('VEC3', nrm));
  return doc.createMesh(opts.name ?? 'grid').addPrimitive(prim);
}

function basicMaterial(doc: Document, name = 'mat') {
  return doc.createMaterial(name).setBaseColorFactor([0.8, 0.3, 0.2, 1]).setRoughnessFactor(0.6);
}

/** Centimetre-scale asset: a 0.5 cm wide grid (largest dimension 0.005 m). */
export function centimeterScale(): Document {
  const doc = new Document();
  const mesh = makeGrid(doc, 4, 0.005, { uvs: true, normals: true });
  mesh.listPrimitives()[0].setMaterial(basicMaterial(doc));
  doc.createScene().addChild(doc.createNode('tiny').setMesh(mesh));
  return doc;
}

/** Skeleton with no bound mesh: the skin exists and a clip animates its joint, but no node uses it. */
export function skeletonNoBoundMesh(): Document {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const mesh = makeGrid(doc, 4, 1, { uvs: true, normals: true });
  mesh.listPrimitives()[0].setMaterial(basicMaterial(doc));
  const root = doc.createNode('root');
  const upper = doc.createNode('upper').setTranslation([0, 1, 0]);
  root.addChild(upper);
  const ibm = doc.createAccessor().setType('MAT4').setBuffer(buffer).setArray(new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -1, 0, 1]));
  doc.createSkin('rig').setSkeleton(root).addJoint(root).addJoint(upper).setInverseBindMatrices(ibm);
  const s = Math.SQRT1_2;
  const sampler = doc.createAnimationSampler()
    .setInput(doc.createAccessor().setType('SCALAR').setArray(new Float32Array([0, 1])).setBuffer(buffer))
    .setOutput(doc.createAccessor().setType('VEC4').setArray(new Float32Array([0, 0, 0, 1, 0, 0, s, s])).setBuffer(buffer));
  doc.createAnimation('wave').addSampler(sampler).addChannel(doc.createAnimationChannel().setTargetNode(upper).setTargetPath('rotation').setSampler(sampler));
  doc.createScene().addChild(root).addChild(doc.createNode('body').setMesh(mesh)); // mesh node has NO skin
  return doc;
}

/** Blend shape with no driver: a morph target, zero default weight, no weights animation. */
export function blendShapeUndriven(): Document {
  const doc = new Document();
  const mesh = makeGrid(doc, 4, 1, { uvs: true, normals: true });
  const prim = mesh.listPrimitives()[0];
  prim.setMaterial(basicMaterial(doc));
  const count = prim.getAttribute('POSITION')!.getCount();
  const delta = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) delta[i * 3 + 1] = 0.2;
  const target = doc.createPrimitiveTarget('puff').setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(delta).setBuffer(doc.getRoot().listBuffers()[0]));
  prim.addTarget(target);
  mesh.setWeights([0]);
  doc.createScene().addChild(doc.createNode('morpher').setMesh(mesh));
  return doc;
}

/** Mesh with no material. */
export function meshNoMaterial(): Document {
  const doc = new Document();
  const mesh = makeGrid(doc, 4, 1, { uvs: true, normals: true });
  doc.createScene().addChild(doc.createNode('bare').setMesh(mesh));
  return doc;
}

/** Over the ios_ar triangle budget (100k): a 240x240 grid = 115,200 triangles. */
export function overIosArBudget(): Document {
  const doc = new Document();
  const mesh = makeGrid(doc, 240, 1, { uvs: true, normals: true, name: 'dense' });
  mesh.listPrimitives()[0].setMaterial(basicMaterial(doc));
  doc.createScene().addChild(doc.createNode('dense').setMesh(mesh));
  return doc;
}

/** ~50k triangles, textured, for the validate(quick) timing test. */
export function fiftyKTriangles(): Document {
  const doc = new Document();
  const mesh = makeGrid(doc, 158, 1, { uvs: true, normals: true, name: 'fiftyk' }); // 2*158^2 = 49,928
  mesh.listPrimitives()[0].setMaterial(basicMaterial(doc));
  doc.createScene().addChild(doc.createNode('fiftyk').setMesh(mesh));
  return doc;
}

/** glTF (JSON + external files) whose texture file is missing. */
export function textureBrokenPathGltf(): { json: string; bin: Uint8Array } {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
  const uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
  const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
  const bin = new Uint8Array(positions.byteLength + uvs.byteLength + indices.byteLength);
  bin.set(new Uint8Array(positions.buffer), 0);
  bin.set(new Uint8Array(uvs.buffer), positions.byteLength);
  bin.set(new Uint8Array(indices.buffer), positions.byteLength + uvs.byteLength);
  const json = {
    asset: { version: '2.0', generator: 'glbforge-fixtures' },
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name: 'quad' }],
    meshes: [{ name: 'quad', primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2, material: 0 }] }],
    materials: [{ name: 'painted', pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
    textures: [{ source: 0, name: 'albedo' }],
    images: [{ uri: 'textures/missing-albedo.png' }],
    buffers: [{ uri: 'quad.bin', byteLength: bin.byteLength }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.byteLength },
      { buffer: 0, byteOffset: positions.byteLength, byteLength: uvs.byteLength },
      { buffer: 0, byteOffset: positions.byteLength + uvs.byteLength, byteLength: indices.byteLength },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 4, type: 'VEC2' },
      { bufferView: 2, componentType: 5123, count: 6, type: 'SCALAR' },
    ],
  };
  return { json: JSON.stringify(json, null, 2), bin };
}

/** usda: no defaultPrim. */
export const USDA_MISSING_DEFAULT_PRIM = `#usda 1.0
(
    metersPerUnit = 1
    upAxis = "Y"
)

def Xform "Root"
{
    def Mesh "Quad"
    {
        point3f[] points = [(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0)]
        int[] faceVertexCounts = [4]
        int[] faceVertexIndices = [0, 1, 2, 3]
        normal3f[] normals = [(0, 0, 1), (0, 0, 1), (0, 0, 1), (0, 0, 1)] (
            interpolation = "vertex"
        )
    }
}
`;

/** usda: Z-up asset (a character-like box taller along Z). */
export const USDA_Z_UP = `#usda 1.0
(
    defaultPrim = "Root"
    metersPerUnit = 1
    upAxis = "Z"
)

def Xform "Root"
{
    def Cube "Body"
    {
        double size = 1
        float3 xformOp:scale = (0.4, 0.4, 1.8)
        uniform token[] xformOpOrder = ["xformOp:scale"]
    }
}
`;

/** usda: centimetre-scale asset (metersPerUnit 0.01, 50 units wide = 0.5 m — plus a tiny prop of 0.5 units = 5 mm). */
export const USDA_CENTIMETERS = `#usda 1.0
(
    defaultPrim = "Root"
    metersPerUnit = 0.01
    upAxis = "Y"
)

def Xform "Root"
{
    def Cube "Prop"
    {
        double size = 0.5
    }
}
`;

/** usda: skeleton with no bound mesh. */
export const USDA_SKELETON_UNBOUND = `#usda 1.0
(
    defaultPrim = "Root"
    endTimeCode = 24
    metersPerUnit = 1
    startTimeCode = 0
    timeCodesPerSecond = 24
    upAxis = "Y"
)

def SkelRoot "Root"
{
    def Skeleton "Skel" (
        prepend apiSchemas = ["SkelBindingAPI"]
    )
    {
        uniform matrix4d[] bindTransforms = [( (1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 1, 0), (0, 0, 0, 1) ), ( (1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 1, 0), (0, 1, 0, 1) )]
        uniform token[] joints = ["root", "root/upper"]
        uniform matrix4d[] restTransforms = [( (1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 1, 0), (0, 0, 0, 1) ), ( (1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 1, 0), (0, 1, 0, 1) )]
        rel skel:animationSource = </Root/Skel/Anim>

        def SkelAnimation "Anim"
        {
            uniform token[] joints = ["root", "root/upper"]
            quatf[] rotations.timeSamples = {
                0: [(1, 0, 0, 0), (1, 0, 0, 0)],
                24: [(1, 0, 0, 0), (0.7071068, 0.7071068, 0, 0)],
            }
            half3[] scales.timeSamples = {
                0: [(1, 1, 1), (1, 1, 1)],
                24: [(1, 1, 1), (1, 1, 1)],
            }
            float3[] translations.timeSamples = {
                0: [(0, 0, 0), (0, 1, 0)],
                24: [(0, 0, 0), (0, 1, 0)],
            }
        }
    }

    def Mesh "Body"
    {
        point3f[] points = [(0, 0, 0), (1, 0, 0), (1, 2, 0), (0, 2, 0)]
        int[] faceVertexCounts = [3, 3]
        int[] faceVertexIndices = [0, 1, 2, 0, 2, 3]
    }
}
`;

/** usda: blend shape declared on the mesh but never driven. */
export const USDA_BLENDSHAPE_UNDRIVEN = `#usda 1.0
(
    defaultPrim = "Root"
    metersPerUnit = 1
    upAxis = "Y"
)

def SkelRoot "Root"
{
    def Skeleton "Skel"
    {
        uniform matrix4d[] bindTransforms = [( (1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 1, 0), (0, 0, 0, 1) )]
        uniform token[] joints = ["root"]
        uniform matrix4d[] restTransforms = [( (1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 1, 0), (0, 0, 0, 1) )]
    }

    def Mesh "Face" (
        prepend apiSchemas = ["SkelBindingAPI"]
    )
    {
        point3f[] points = [(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0)]
        int[] faceVertexCounts = [4]
        int[] faceVertexIndices = [0, 1, 2, 3]
        int[] primvars:skel:jointIndices = [0, 0, 0, 0] (
            elementSize = 1
            interpolation = "vertex"
        )
        float[] primvars:skel:jointWeights = [1, 1, 1, 1] (
            elementSize = 1
            interpolation = "vertex"
        )
        rel skel:skeleton = </Root/Skel>
        uniform token[] skel:blendShapes = ["smile"]
        rel skel:blendShapeTargets = </Root/Face/smile>

        def BlendShape "smile"
        {
            uniform vector3f[] offsets = [(0, 0.1, 0), (0, 0.1, 0), (0, 0, 0), (0, 0, 0)]
        }
    }
}
`;

/** usda: texture with a broken path. */
export const USDA_TEXTURE_BROKEN = `#usda 1.0
(
    defaultPrim = "Root"
    metersPerUnit = 1
    upAxis = "Y"
)

def Xform "Root"
{
    def Mesh "Quad" (
        prepend apiSchemas = ["MaterialBindingAPI"]
    )
    {
        point3f[] points = [(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0)]
        int[] faceVertexCounts = [4]
        int[] faceVertexIndices = [0, 1, 2, 3]
        texCoord2f[] primvars:st = [(0, 0), (1, 0), (1, 1), (0, 1)] (
            interpolation = "vertex"
        )
        rel material:binding = </Root/Materials/Painted>
    }

    def Scope "Materials"
    {
        def Material "Painted"
        {
            token outputs:surface.connect = </Root/Materials/Painted/PBRShader.outputs:surface>

            def Shader "PBRShader"
            {
                uniform token info:id = "UsdPreviewSurface"
                color3f inputs:diffuseColor.connect = </Root/Materials/Painted/Tex.outputs:rgb>
                token outputs:surface
            }

            def Shader "Tex"
            {
                uniform token info:id = "UsdUVTexture"
                asset inputs:file = @textures/does-not-exist.png@
                token inputs:sourceColorSpace = "sRGB"
                float3 outputs:rgb
            }
        }
    }
}
`;

/** usda: mesh with no material (and a material that binds nothing). */
export const USDA_MESH_NO_MATERIAL = `#usda 1.0
(
    defaultPrim = "Root"
    metersPerUnit = 1
    upAxis = "Y"
)

def Xform "Root"
{
    def Mesh "Bare"
    {
        point3f[] points = [(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0)]
        int[] faceVertexCounts = [4]
        int[] faceVertexIndices = [0, 1, 2, 3]
    }

    def Material "Unused"
    {
    }
}
`;

export const USDA_FIXTURES: Record<string, string> = {
  'missing-default-prim.usda': USDA_MISSING_DEFAULT_PRIM,
  'z-up.usda': USDA_Z_UP,
  'centimeters.usda': USDA_CENTIMETERS,
  'skeleton-unbound.usda': USDA_SKELETON_UNBOUND,
  'blendshape-undriven.usda': USDA_BLENDSHAPE_UNDRIVEN,
  'texture-broken.usda': USDA_TEXTURE_BROKEN,
  'mesh-no-material.usda': USDA_MESH_NO_MATERIAL,
};

export const GLB_FIXTURES: Record<string, () => Document> = {
  'centimeters.glb': centimeterScale,
  'skeleton-unbound.glb': skeletonNoBoundMesh,
  'blendshape-undriven.glb': blendShapeUndriven,
  'mesh-no-material.glb': meshNoMaterial,
  'over-ios-ar-budget.glb': overIosArBudget,
  'fifty-k.glb': fiftyKTriangles,
};

/** Write every fixture into `dir`; returns name → absolute path. */
export async function writeAgentFixtures(dir: string): Promise<Record<string, string>> {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  await mkdir(dir, { recursive: true });
  const io = await createNodeIO();
  const out: Record<string, string> = {};
  for (const [name, make] of Object.entries(GLB_FIXTURES)) {
    const path = join(dir, name);
    await writeFile(path, await io.writeBinary(make()));
    out[name] = path;
  }
  for (const [name, text] of Object.entries(USDA_FIXTURES)) {
    const path = join(dir, name);
    await writeFile(path, text);
    out[name] = path;
  }
  const broken = textureBrokenPathGltf();
  await writeFile(join(dir, 'texture-broken.gltf'), broken.json);
  await writeFile(join(dir, 'quad.bin'), broken.bin);
  out['texture-broken.gltf'] = join(dir, 'texture-broken.gltf');
  return out;
}
