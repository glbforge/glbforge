import { useCallback, useEffect, useRef, useState } from 'react';
import { api, detectBackend, getBackend, type AssetDetail, type AssetSummary } from './api';
import { AssetRail } from './components/AssetRail';
import { Viewport } from './components/Viewport';
import { Inspector } from './components/Inspector';

export default function App() {
  const [assets, setAssets] = useState<AssetSummary[]>([]);
  const [selected, setSelected] = useState<AssetDetail | null>(null);
  const [compare, setCompare] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [meshy, setMeshy] = useState(false);
  const [tasks, setTasks] = useState<GenTask[]>([]);
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;

  const refresh = useCallback(async (selectId?: string) => {
    const list = await api.list();
    setAssets(list);
    if (selectId) setSelected(await api.get(selectId));
  }, []);

  const [mode, setMode] = useState<'remote' | 'local' | null>(null);
  useEffect(() => {
    detectBackend().then(async (detected) => {
      setMode(detected);
      api.meshyAvailable().then((m) => setMeshy(m.available)).catch(() => {});
      await refresh();
      const list = await api.list();
      if (list.length > 0) setSelected(await api.get(list[0].id));
    }).catch((err) => setError(String(err.message ?? err)));
  }, [refresh]);

  // Poll active Meshy tasks; import finished ones as analyzed assets.
  useEffect(() => {
    if (!tasks.some((t) => t.status === 'PENDING' || t.status === 'IN_PROGRESS')) return;
    const timer = setInterval(async () => {
      for (const task of tasksRef.current) {
        if (task.status !== 'PENDING' && task.status !== 'IN_PROGRESS') continue;
        try {
          const st = await api.meshyTask(task.kind, task.taskId);
          if (st.status === 'SUCCEEDED') {
            setTasks((prev) => prev.map((t) => t.taskId === task.taskId ? { ...t, status: 'IMPORTING', progress: 100 } : t));
            const asset = await api.meshyImport(task.kind, task.taskId);
            setTasks((prev) => prev.filter((t) => t.taskId !== task.taskId));
            await refresh(asset.id);
          } else if (st.status === 'FAILED' || st.status === 'CANCELED') {
            setTasks((prev) => prev.map((t) => t.taskId === task.taskId ? { ...t, status: 'FAILED', error: st.error ?? 'failed' } : t));
          } else {
            setTasks((prev) => prev.map((t) => t.taskId === task.taskId ? { ...t, status: st.status as GenTask['status'], progress: st.progress } : t));
          }
        } catch { /* transient poll error — keep trying */ }
      }
    }, 4000);
    return () => clearInterval(timer);
  }, [tasks, refresh]);

  const generate = useCallback(async (name: string, bytes: ArrayBuffer, mime: string, pbr: boolean) => {
    setError(null);
    try {
      const { taskId, kind } = await api.meshyImage(bytes, mime, pbr);
      setTasks((prev) => [...prev, { taskId, kind, name, progress: 0, status: 'PENDING' }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

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
        {mode === 'local' && (
          <div className="mode-badge" title="The whole pipeline runs in your browser — assets never leave your device. For Meshy generation and KTX2, run: npx glbforge ui">
            ⚡ in-browser · private
          </div>
        )}
        {busy && <div className="busy">⚙ {busy}…</div>}
        {error && <div className="error" onClick={() => setError(null)}>{error} ✕</div>}
      </header>
      <div className="panes">
        <AssetRail
          assets={assets} selectedId={selected?.id ?? null} onSelect={select} onRun={run}
          meshyAvailable={meshy} tasks={tasks} onGenerate={generate}
          onDismissTask={(id) => setTasks((prev) => prev.filter((t) => t.taskId !== id))}
        />
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

export interface GenTask {
  taskId: string;
  kind: string;
  name: string;
  progress: number;
  status: 'PENDING' | 'IN_PROGRESS' | 'IMPORTING' | 'FAILED';
  error?: string;
}
