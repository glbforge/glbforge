import { useCallback, useEffect, useState } from 'react';
import { api, type AssetDetail, type AssetSummary } from './api';
import { AssetRail } from './components/AssetRail';
import { Viewport } from './components/Viewport';
import { Inspector } from './components/Inspector';

export default function App() {
  const [assets, setAssets] = useState<AssetSummary[]>([]);
  const [selected, setSelected] = useState<AssetDetail | null>(null);
  const [compare, setCompare] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (selectId?: string) => {
    const list = await api.list();
    setAssets(list);
    if (selectId) setSelected(await api.get(selectId));
  }, []);

  useEffect(() => {
    refresh().then(async () => {
      const list = await api.list();
      if (list.length > 0) setSelected(await api.get(list[0].id));
    }).catch((err) => setError(String(err.message ?? err)));
  }, [refresh]);

  const select = useCallback(async (id: string) => {
    setSelected(await api.get(id));
    setCompare(false);
  }, []);

  const run = useCallback(async (label: string, task: () => Promise<AssetDetail | void>) => {
    setBusy(label);
    setError(null);
    try {
      const result = await task();
      if (result) {
        await refresh(result.id);
      } else {
        await refresh(undefined);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [refresh]);

  const parent = selected?.parentId ? assets.find((a) => a.id === selected.parentId) : null;

  return (
    <div className="studio">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">⬢</span> GLBForge <span className="brand-sub">Studio</span>
        </div>
        {busy && <div className="busy">⚙ {busy}…</div>}
        {error && <div className="error" onClick={() => setError(null)}>{error} ✕</div>}
      </header>
      <div className="panes">
        <AssetRail assets={assets} selectedId={selected?.id ?? null} onSelect={select} onRun={run} />
        <Viewport
          asset={selected}
          compareWith={compare && parent ? parent.id : null}
        />
        <Inspector
          asset={selected}
          parent={parent ?? null}
          compare={compare}
          onCompareChange={setCompare}
          onRun={run}
          onSelect={select}
        />
      </div>
    </div>
  );
}
