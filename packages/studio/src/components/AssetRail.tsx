import { useEffect, useRef, useState } from 'react';
import { api, isTouch, normalizeImage, type AssetDetail, type AssetSummary } from '../api';
// Subpath imports, not the barrel: these two modules are dependency-free, and
// reaching them through '@glbforge/core' pulls the whole pipeline (gltf-transform
// and all) into the main bundle for the sake of two pure functions.
import { liftSubject, cutoutRgba, tuneMatte, DEFAULT_TOLERANCE, type Matte } from '@glbforge/core/matte';
import { sniffFileKind, isImageKind, describeBytes, type FileKind } from '@glbforge/core/sniff';
import type { GenTask } from '../App';

// Neither the name nor the MIME type is the authority: a phone picker can hand
// over `image` with no extension and an empty `type`, and a Files provider can
// type a photo `application/octet-stream`. The bytes decide (`sniffFileKind`),
// and these two are only the fallback for a format the sniffer does not know.
const IMAGE_RE = /\.(png|jpe?g|webp|svg|heic|heif|avif|gif|bmp|tiff?)$/i;
const looksLikeImage = (file: File, kind: FileKind) =>
  isImageKind(kind)
  || (kind === 'unknown' && (file.type.startsWith('image/') || IMAGE_RE.test(file.name)));

interface PendingImage { name: string; bytes: ArrayBuffer; mime: string }


/**
 * The cut, live, while the slider moves.
 *
 * A tolerance you cannot see is a tolerance you cannot choose: before this the
 * only way to judge a value was to forge it, look at the 3D result, undo, and
 * guess again. The lift itself is pure and cheap, so at preview resolution it
 * re-runs per slider step — decode once, re-mask on every change.
 */
function MattePreview(props: {
  image: PendingImage;
  tolerance: number;
  onMeasured: (matte: Matte | null) => void;
  /** Called once per image with the best tolerance the sweep found. */
  onTuned: (tolerance: number) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [source, setSource] = useState<ImageData | null>(null);
  const [failed, setFailed] = useState(false);

  // Decode once per image, small: 256px is enough to judge a silhouette and
  // keeps the re-mask under a frame.
  useEffect(() => {
    let alive = true;
    const url = URL.createObjectURL(new Blob([props.image.bytes], { type: props.image.mime }));
    const img = new Image();
    img.onload = () => {
      if (!alive) return;
      const scale = Math.min(1, 256 / Math.max(img.naturalWidth, img.naturalHeight, 1));
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const h = Math.max(1, Math.round(img.naturalHeight * scale));
      const off = document.createElement('canvas');
      off.width = w; off.height = h;
      const ctx = off.getContext('2d')!;
      ctx.drawImage(img, 0, 0, w, h);
      setSource(ctx.getImageData(0, 0, w, h));
      URL.revokeObjectURL(url);
    };
    img.onerror = () => { if (alive) { setFailed(true); URL.revokeObjectURL(url); } };
    img.src = url;
    return () => { alive = false; };
  }, [props.image]);

  // Tune once per image, before the first draw: the slider should open at the
  // best value this photograph allows, not at a constant that happens to suit
  // some other photograph. Eight passes at 256px is a few milliseconds.
  useEffect(() => {
    if (!source) return;
    const px = new Uint8Array(source.data.buffer.slice(0));
    props.onTuned(tuneMatte(px, source.width, source.height).tolerance);
  }, [source]);

  useEffect(() => {
    if (!source || !canvas.current) return;
    const px = new Uint8Array(source.data.buffer.slice(0));
    const matte = liftSubject(px, source.width, source.height, { tolerance: props.tolerance });
    const cut = cutoutRgba(px, matte, 0.12);
    const el = canvas.current;
    el.width = source.width; el.height = source.height;
    el.getContext('2d')!.putImageData(
      new ImageData(new Uint8ClampedArray(cut.buffer, cut.byteOffset, cut.byteLength), source.width, source.height),
      0, 0,
    );
    props.onMeasured(matte);
  }, [source, props.tolerance]);

  if (failed) return null;
  return <canvas ref={canvas} className="matte-preview" />;
}

export function AssetRail(props: {
  assets: AssetSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onRun: (label: string, task: () => Promise<AssetDetail | void>) => Promise<void>;
  meshyAvailable: boolean;
  tasks: GenTask[];
  onGenerate: (name: string, bytes: ArrayBuffer, mime: string, pbr: boolean, provider?: string) => Promise<void>;
  generators?: Record<string, boolean>;
  genCosts?: Record<string, number>;
  onDismissTask: (taskId: string) => void;
  history?: Array<{ task_id: string; kind: string; created_at: number }>;
  onReimport?: (taskId: string) => Promise<void>;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const touch = isTouch();
  // No `accept` on phones and tablets: iOS and Android filter the picker by the
  // UTI/MIME each extension maps to, and `.glb` maps to nothing — every GLB in
  // Files greys out and cannot be chosen. On desktop the filter is a
  // convenience with no such cost.
  const acceptTypes = touch ? undefined : '.glb,model/gltf-binary,.png,.jpg,.jpeg,.webp,.svg';
  const [over, setOver] = useState(false);
  const [pending, setPending] = useState<PendingImage | null>(null);
  const [photoHint, setPhotoHint] = useState(false);
  const canGenerate = props.meshyAvailable
    || Object.values(props.generators ?? {}).some(Boolean);
  const [pbr, setPbr] = useState(true);
  const [genModel, setGenModel] = useState('meshy');
  const [layered, setLayered] = useState(true);
  const [pillow, setPillow] = useState(false);
  const [sculpt, setSculpt] = useState(false);
  const [preset, setPreset] = useState('');
  const [matteTolerance, setMatteTolerance] = useState(DEFAULT_TOLERANCE);
  const [autoTuned, setAutoTuned] = useState<number | null>(null);
  const [previewMatte, setPreviewMatte] = useState<Matte | null>(null);

  // The forge traces a silhouette, so it refuses a photograph — core says so in
  // CLI terms ("pass --mode/--threshold"), which is no help inside a browser.
  // `ship` answers the same refusal by routing to a generator; here that would
  // spend the user's credits without asking, so offer it instead: put the
  // choice back up, say why, and let them pick.
  const PHOTOGRAPHIC = /photograph|noisy mask|fills the whole canvas/i;

  const extrude = (image: PendingImage, matte?: 'auto') =>
    props.onRun(matte ? `lifting the subject from ${image.name}` : `forging ${image.name}`, async () => {
      try {
        return await api.extrude(image.name, image.bytes, {
          bevel: pillow || sculpt ? 0 : 0.015, profile: 'mobile-hero',
          // 'auto', never a hard 4: k-means returns four clusters whether or
          // not the artwork has four colours, and on a photo or a gradient
          // that is stacked slabs with noisy contours. `ship` learned this;
          // the Studio was still asking for 4.
          layers: layered ? 'auto' : undefined,
          pillow: pillow ? 0.035 : undefined,
          emboss: sculpt ? 0.012 : undefined,
          preset: preset || undefined,
          matte,
          matteTolerance: matte ? matteTolerance : undefined,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // A matte run that fails says so in its own words ("Could not lift a
        // subject…") and must not loop back into another lift offer.
        if (!PHOTOGRAPHIC.test(message) || matte) throw err;
        setPending(image);
        setPhotoHint(true);
        throw new Error(
          'That looks like a photo, not flat artwork — the forge traces a silhouette and a '
          + 'photo fills the frame. Try lifting the subject off its background (offered below)'
          + (canGenerate ? ', or generate true 3D.' : ', or use artwork with a clear background.'),
        );
      }
    });

  const ingest = async (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      const bytes = await file.arrayBuffer();
      const kind = sniffFileKind(new Uint8Array(bytes));
      if (looksLikeImage(file, kind)) {
        const image = await normalizeImage(file, bytes, kind);
        setPhotoHint(false);
        setPreviewMatte(null);
        setAutoTuned(null);
        // SVGs are flat by definition; Meshy wants raster input anyway.
        if (props.meshyAvailable && !image.name.toLowerCase().endsWith('.svg')) {
          setPending(image);
        } else {
          await extrude(image);
        }
      } else if (kind === 'glb' || kind === 'gltf' || (kind === 'unknown' && /\.(glb|gltf)$/i.test(file.name))) {
        await props.onRun(`analyzing ${file.name}`, () =>
          api.upload(file.name, bytes, 'mobile-hero'));
      } else {
        // Say what it is instead of letting the GLB parser say "Invalid glTF
        // 2.0 binary" — a true statement about the wrong question.
        await props.onRun(`reading ${file.name}`, () => Promise.reject(new Error(
          kind === 'unknown'
            ? `${file.name} is not a GLB or an image this browser can read (${describeBytes(new Uint8Array(bytes))}). `
              + 'Drop a .glb, or a PNG / JPEG / WebP / SVG / HEIC.'
            : `${file.name} is a ${kind.toUpperCase()} file. The Studio takes GLB and glTF models, `
              + 'and PNG / JPEG / WebP / SVG / HEIC images.',
        )));
      }
    }
  };

  const roots = props.assets.filter((a) => !a.parentId);
  const childrenOf = (id: string) => props.assets.filter((a) => a.parentId === id);

  const row = (asset: AssetSummary, variant: boolean) => (
    <div
      key={asset.id}
      className={`asset ${variant ? 'variant' : ''} ${asset.id === props.selectedId ? 'selected' : ''}`}
      onClick={() => props.onSelect(asset.id)}
      title={asset.name}
    >
      <span className="asset-name">{variant ? '↳ ' : ''}{asset.name}</span>
      <span className={`asset-score ${asset.passed ? 'pass' : 'fail'}`}>{asset.score}</span>
    </div>
  );

  return (
    <div className="rail">
      <div
        className={`drop ${over ? 'over' : ''}`}
        onClick={() => fileInput.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); void ingest(e.dataTransfer.files); }}
      >
        {touch
          ? <>Tap to choose a <b>GLB</b><br />or an <b>image</b> to make 3D</>
          : <>Drop a <b>GLB</b> to analyze<br />or an <b>image</b> to make 3D</>}
        <input
          ref={fileInput} type="file" multiple hidden accept={acceptTypes}
          onChange={(e) => e.target.files && void ingest(e.target.files)}
        />
      </div>

      {pending && (
        <div className="choice">
          <div className="choice-name">{pending.name}</div>
          {photoHint && (
            <>
              <div className="choice-hint">
                The forge could not trace this one — it fills the frame, the way a photo does.
                Lifting the subject cuts it off its background first, which works when the
                background is plain; it refuses rather than guessing when it is not.
                {canGenerate ? ' For a scene rather than an object, generate true 3D instead.' : ''}
              </div>
              <button onClick={() => { void extrude(pending, 'auto'); setPending(null); }}>
                ✂ Lift subject and forge <span className="choice-sub">instant · free · a sticker of the object</span>
              </button>
              <MattePreview
                image={pending}
                tolerance={matteTolerance}
                onMeasured={setPreviewMatte}
                onTuned={(t) => { setAutoTuned(t); setMatteTolerance(t); }}
              />
              {previewMatte && (
                <div className="matte-readout">
                  <b className={previewMatte.confidence < 0.6 ? 'weak' : 'good'}>
                    {(previewMatte.confidence * 100).toFixed(0)}% confident
                  </b>
                  {' · '}{(previewMatte.coverage * 100).toFixed(0)}% kept
                  {' · '}{previewMatte.components} piece{previewMatte.components === 1 ? '' : 's'}
                  {previewMatte.holes > 0 && `, ${previewMatte.holes} hole${previewMatte.holes === 1 ? '' : 's'}`}
                </div>
              )}
              <label className="slider">
                <span>
                  cut tolerance {matteTolerance}
                  {autoTuned !== null && (matteTolerance === autoTuned
                    ? <b className="auto-tag"> auto</b>
                    : <button className="link" type="button" onClick={() => setMatteTolerance(autoTuned)}>reset to auto ({autoTuned})</button>)}
                </span>
                <input
                  type="range" min={12} max={70} step={2} value={matteTolerance}
                  onChange={(e) => setMatteTolerance(Number(e.target.value))}
                />
                <span className="choice-sub">
                  lower keeps more of the object, higher takes more of the background
                </span>
              </label>
            </>
          )}
          <button className={photoHint ? 'ghost' : undefined} onClick={() => { void extrude(pending); setPending(null); }}>
            ⚒ Forge logo → 3D <span className="choice-sub">instant · free · exact silhouette</span>
          </button>
          <label className="check">
            <input type="checkbox" checked={layered} onChange={(e) => setLayered(e.target.checked)} />
            layered colors (acrylic look)
          </label>
          <label className="check">
            <input type="checkbox" checked={pillow} onChange={(e) => setPillow(e.target.checked)} />
            pillow (puffy sticker)
          </label>
          <label className="check">
            <input type="checkbox" checked={sculpt} onChange={(e) => setSculpt(e.target.checked)} />
            sculpt relief (from artwork shading)
          </label>
          <select value={preset} onChange={(e) => setPreset(e.target.value)}>
            <option value="">material: default</option>
            <option value="enamel">enamel pin</option>
            <option value="chrome">chrome</option>
            <option value="neon">neon</option>
            <option value="acrylic">acrylic</option>
            <option value="rubber">rubber</option>
          </select>
          {canGenerate && Object.keys(props.generators ?? {}).length > 1 && (
            <select value={genModel} onChange={(e) => setGenModel(e.target.value)}>
              {props.generators?.meshy && <option value="meshy">Meshy 7 — richest textures</option>}
              {props.generators?.hunyuan && <option value="hunyuan">Hunyuan3D-2 — open, high quality</option>}
              {props.generators?.trellis && <option value="trellis">TRELLIS — open, balanced</option>}
              {props.generators?.triposr && <option value="triposr">TripoSR — fastest</option>}
            </select>
          )}
          {canGenerate && (
          <button className={photoHint ? undefined : 'ghost'} onClick={() => { void props.onGenerate(pending.name, pending.bytes, pending.mime, pbr, genModel); setPending(null); }}>
            ✨ Generate true 3D <span className="choice-sub">
              {genModel === 'meshy'
                ? `~5–10 min · ${pbr ? (props.genCosts?.pbr ?? 3) + ' credits (PBR)' : (props.genCosts?.textured ?? 2) + ' credits'}`
                : `~1–3 min · ${props.genCosts?.[genModel] ?? 1} credit${(props.genCosts?.[genModel] ?? 1) > 1 ? 's' : ''}`}
            </span>
          </button>
          )}
          {canGenerate && genModel === 'meshy' && (
            <label className="check">
              <input type="checkbox" checked={pbr} onChange={(e) => setPbr(e.target.checked)} />
              PBR maps (Meshy)
            </label>
          )}
          <button className="ghost" onClick={() => setPending(null)}>cancel</button>
        </div>
      )}

      {props.tasks.length > 0 && <div className="rail-section">Generating</div>}
      {props.tasks.map((task) => (
        <div key={task.taskId} className="asset task" title={task.error ?? task.taskId}>
          <span className="asset-name">
            {task.status === 'FAILED' ? '✗ ' : '✨ '}{task.name}
          </span>
          {task.status === 'FAILED'
            ? <span className="asset-score fail" onClick={() => props.onDismissTask(task.taskId)}>dismiss</span>
            : <span className="asset-score">{task.status === 'IMPORTING' ? 'importing…' : `${task.progress}%`}</span>}
        </div>
      ))}

      {(props.history?.length ?? 0) > 0 && <div className="rail-section">Your generations</div>}
      {props.history?.map((h) => (
        <div key={h.task_id} className="asset task" title={new Date(h.created_at).toLocaleString()}>
          <span className="asset-name">☁ meshy-{h.task_id.slice(0, 8)}</span>
          <span className="asset-score" style={{ cursor: 'pointer' }} onClick={() => void props.onReimport?.(h.task_id)}>import</span>
        </div>
      ))}

      {roots.length > 0 && <div className="rail-section">Assets</div>}
      {roots.map((asset) => (
        <div key={asset.id}>
          {row(asset, false)}
          {childrenOf(asset.id).map((child) => row(child, true))}
        </div>
      ))}
    </div>
  );
}
