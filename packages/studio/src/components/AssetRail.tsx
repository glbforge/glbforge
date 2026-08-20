import { useRef, useState } from 'react';
import { api, type AssetDetail, type AssetSummary } from '../api';

const IMAGE_RE = /\.(png|jpe?g|webp|svg)$/i;

export function AssetRail(props: {
  assets: AssetSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onRun: (label: string, task: () => Promise<AssetDetail | void>) => Promise<void>;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  const ingest = async (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      const bytes = await file.arrayBuffer();
      if (IMAGE_RE.test(file.name)) {
        // Flat artwork routes to deterministic extrusion, not generation.
        await props.onRun(`extruding ${file.name}`, () =>
          api.extrude(file.name, bytes, { bevel: 0.015, profile: 'mobile-hero' }));
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
        Drop a <b>GLB</b> to analyze<br />or a <b>logo / SVG</b> to forge into 3D
        <input
          ref={fileInput} type="file" multiple hidden
          accept=".glb,.png,.jpg,.jpeg,.webp,.svg"
          onChange={(e) => e.target.files && void ingest(e.target.files)}
        />
      </div>
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
