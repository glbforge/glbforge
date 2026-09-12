import { useRef, useState } from 'react';
import { api, isTouch, normalizeImage, type AssetDetail, type AssetSummary } from '../api';
import type { GenTask } from '../App';

// Extensions are the fallback, not the test: a photo picked on a phone can
// arrive as HEIC, and files handed over by some providers carry no extension
// at all. `file.type` is what the OS actually says it is.
const IMAGE_RE = /\.(png|jpe?g|webp|svg|heic|heif|avif|gif|bmp|tiff?)$/i;
const looksLikeImage = (file: File) => file.type.startsWith('image/') || IMAGE_RE.test(file.name);

interface PendingImage { name: string; bytes: ArrayBuffer; mime: string }

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
          layers: layered ? 4 : undefined,
          pillow: pillow ? 0.035 : undefined,
          emboss: sculpt ? 0.012 : undefined,
          preset: preset || undefined,
          matte,
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
      if (looksLikeImage(file)) {
        const image = await normalizeImage(file, bytes);
        setPhotoHint(false);
        // SVGs are flat by definition; Meshy wants raster input anyway.
        if (props.meshyAvailable && !image.name.toLowerCase().endsWith('.svg')) {
          setPending(image);
        } else {
          await extrude(image);
        }
      } else {
        await props.onRun(`analyzing ${file.name}`, () =>
          api.upload(file.name, bytes, 'mobile-hero'));
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
