import { useEffect, useState } from 'react';
import { api, type AssetDetail, type AssetSummary } from '../api';

const mb = (bytes: number) => (bytes / 1048576).toFixed(1) + 'MB';
const num = (value: number) => value.toLocaleString('en-US');

function ScoreRing({ score }: { score: number }) {
  const radius = 32, circumference = 2 * Math.PI * radius;
  const color = score >= 80 ? 'var(--good)' : score >= 50 ? 'var(--warn)' : 'var(--bad)';
  return (
    <div className="score-ring">
      <svg width="74" height="74">
        <circle cx="37" cy="37" r={radius} fill="none" stroke="var(--line)" strokeWidth="6" />
        <circle
          cx="37" cy="37" r={radius} fill="none" stroke={color} strokeWidth="6"
          strokeLinecap="round" strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - score / 100)}
        />
      </svg>
      <div className="score-num" style={{ color }}>{score}</div>
    </div>
  );
}

function BudgetRow({ label, value, max, format }: {
  label: string; value: number; max: number; format: (n: number) => string;
}) {
  const ratio = Math.min(1, value / max);
  return (
    <div className="budget-row">
      <div className="budget-head">
        <span>{label}</span>
        <span className="val">{format(value)} / {format(max)}</span>
      </div>
      <div className="bar"><div className={`bar-fill ${value > max ? 'over' : ''}`} style={{ width: `${ratio * 100}%` }} /></div>
    </div>
  );
}

export function Inspector(props: {
  asset: AssetDetail | null;
  parent: AssetSummary | null;
  compare: boolean;
  onCompareChange: (on: boolean) => void;
  onRun: (label: string, task: () => Promise<AssetDetail | void>) => Promise<void>;
  onSelect: (id: string) => void;
}) {
  const [profile, setProfile] = useState('mobile-hero');
  const [profiles, setProfiles] = useState<string[]>(['mobile-hero']);
  const [ktx2, setKtx2] = useState(false);
  const [meshy, setMeshy] = useState(false);

  useEffect(() => {
    api.profiles().then((p) => setProfiles(Object.keys(p))).catch(() => {});
    api.meshyAvailable().then((m) => setMeshy(m.available)).catch(() => {});
  }, []);

  const { asset } = props;
  if (!asset) return <div className="inspector"><div className="section-title">Inspector</div><div style={{ color: 'var(--dim)' }}>Nothing selected.</div></div>;

  const r = asset.report;

  return (
    <div className="inspector">
      <div className="score-row">
        <ScoreRing score={r.score} />
        <div>
          <div className={`verdict ${r.passed ? 'pass' : 'fail'}`}>
            {r.passed ? '✓ within budget' : '✗ over budget'}
          </div>
          <div className="profile-name">{r.profile.name} · {num(r.geometry.triangles)} tris · {mb(r.file.bytes)}</div>
        </div>
      </div>

      <div className="budget">
        <BudgetRow label="Triangles" value={r.geometry.triangles} max={r.profile.maxTriangles} format={num} />
        <BudgetRow label="File size" value={r.file.bytes} max={r.profile.maxFileBytes} format={mb} />
        <BudgetRow label="Texture payload" value={r.textureBytesTotal} max={r.profile.maxTextureBytes} format={mb} />
        <BudgetRow label="GPU memory (est.)" value={r.textureVramTotal} max={r.profile.maxTextureVramBytes} format={mb} />
        <BudgetRow label="Draw calls" value={r.geometry.drawCallEstimate} max={r.profile.maxDrawCalls} format={num} />
      </div>

      {props.parent && (
        <>
          <div className="section-title">vs. original</div>
          <Delta label="file" from={props.parent.bytes} to={asset.bytes} format={mb} />
          <Delta label="triangles" from={props.parent.triangles} to={asset.triangles} format={num} />
          <label className="check" style={{ margin: '8px 0' }}>
            <input type="checkbox" checked={props.compare} onChange={(e) => props.onCompareChange(e.target.checked)} />
            compare in viewport
          </label>
          <button className="ghost" onClick={() => props.onSelect(props.parent!.id)}>view original</button>
        </>
      )}

      <div className="section-title">Actions</div>
      <div className="actions">
        <div className="row">
          <select value={profile} onChange={(e) => setProfile(e.target.value)}>
            {profiles.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
        <label className="check">
          <input type="checkbox" checked={ktx2} onChange={(e) => setKtx2(e.target.checked)} />
          KTX2 textures (~8× less GPU memory)
        </label>
        <button onClick={() => void props.onRun(`optimizing ${asset.name}`, () => api.optimize(asset.id, { profile, ktx2 }))}>
          ⚒ Optimize for {profile}
        </button>
        <button
          className="ghost"
          onClick={() => void props.onRun(`re-analyzing ${asset.name}`, () => api.reanalyze(asset.id, profile))}
        >
          Re-analyze with {profile}
        </button>
        <button className="ghost" onClick={() => void api.downloadStl(asset.id, asset.name)}>⬇ Export STL (80mm)</button>
        <button className="ghost" onClick={() => void api.downloadGlb(asset.id, asset.name)}>⬇ Download GLB</button>
        {meshy && <div style={{ color: 'var(--dim)', fontSize: 11 }}>Meshy connected — drop an image on the rail to forge or generate.</div>}
      </div>

      {r.findings.length > 0 && <div className="section-title">Findings ({r.findings.length})</div>}
      {r.findings.map((f, i) => (
        <div key={i} className={`finding ${f.severity}`}>
          <div className="rule">{f.ruleId}</div>
          <div>{f.message}</div>
          {f.suggestion && <div className="hint">→ {f.suggestion}</div>}
        </div>
      ))}
    </div>
  );
}

function Delta({ label, from, to, format }: { label: string; from: number; to: number; format: (n: number) => string }) {
  const pct = from > 0 ? Math.round((1 - to / from) * 100) : 0;
  return (
    <div className="delta">
      <span>{label}</span>
      <span>{format(from)} → <span className="to">{format(to)}</span> ({pct > 0 ? '−' : '+'}{Math.abs(pct)}%)</span>
    </div>
  );
}
