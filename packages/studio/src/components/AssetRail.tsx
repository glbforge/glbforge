import { useRef, useState } from 'react';
import { api, type AssetDetail, type AssetSummary } from '../api';
import type { GenTask } from '../App';

const IMAGE_RE = /\.(png|jpe?g|webp|svg)$/i;

interface PendingImage { name: string; bytes: ArrayBuffer; mime: string }

export function AssetRail(props: {
  assets: AssetSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onRun: (label: string, task: () => Promise<AssetDetail | void>) => Promise<void>;
  meshyAvailable: boolean;
  tasks: GenTask[];
  onGenerate: (name: string, bytes: ArrayBuffer, mime: string, pbr: boolean) => Promise<void>;
  onDismissTask: (taskId: string) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [pending, setPending] = useState<PendingImage | null>(null);
  const [pbr, setPbr] = useState(true);
  const [layered, setLayered] = useState(true);

  const extrude = (image: PendingImage) =>
    props.onRun(`forging ${image.name}`, () =>
      api.extrude(image.name, image.bytes, {
        bevel: 0.015, profile: 'mobile-hero', layers: layered ? 4 : undefined,
      }));

  const ingest = async (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      const bytes = await file.arrayBuffer();
      if (IMAGE_RE.test(file.name)) {
        const image = { name: file.name, bytes, mime: file.type || 'image/png' };
        // SVGs are flat by definition; Meshy wants raster input anyway.
        if (props.meshyAvailable && !file.name.toLowerCase().endsWith('.svg')) {
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
        Drop a <b>GLB</b> to analyze<br />or an <b>image</b> to make 3D
        <input
          ref={fileInput} type="file" multiple hidden
          accept=".glb,.png,.jpg,.jpeg,.webp,.svg"
          onChange={(e) => e.target.files && void ingest(e.target.files)}
        />
      </div>

      {pending && (
        <div className="choice">
          <div className="choice-name">{pending.name}</div>
          <button onClick={() => { void extrude(pending); setPending(null); }}>
            ⚒ Forge logo → 3D <span className="choice-sub">instant · free · exact silhouette</span>
          </button>
          <label className="check">
            <input type="checkbox" checked={layered} onChange={(e) => setLayered(e.target.checked)} />
            layered colors (acrylic look)
          </label>
          <button className="ghost" onClick={() => { void props.onGenerate(pending.name, pending.bytes, pending.mime, pbr); setPending(null); }}>
            ✨ Generate with Meshy <span className="choice-sub">textured model · ~5–10 min · credits</span>
          </button>
          <label className="check">
            <input type="checkbox" checked={pbr} onChange={(e) => setPbr(e.target.checked)} />
            PBR maps (Meshy)
          </label>
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
