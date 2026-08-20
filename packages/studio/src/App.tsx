import { useCallback, useEffect, useRef, useState } from 'react';
import { api, cloud, detectBackend, getBackend, restoreLocal, type AssetDetail, type AssetSummary, type CloudUser } from './api';
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
  const [cloudAuth, setCloudAuth] = useState<{ available: boolean; user: CloudUser | null }>({ available: false, user: null });
  const [providers, setProviders] = useState<{ github: boolean; google: boolean }>({ github: false, google: false });
  const [history, setHistory] = useState<Array<{ task_id: string; kind: string; created_at: number }>>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const refreshCloud = useCallback(() => cloud.me().then(setCloudAuth).catch(() => {}), []);
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get('purchase') === 'success') {
      setNotice('✓ Payment received — your credits are being added.');
    } else if (params.get('purchase') === 'cancelled') {
      setNotice('Checkout cancelled — no charge was made.');
    }
    if (params.has('purchase')) window.history.replaceState(null, '', location.pathname);

    detectBackend().then(async (detected) => {
      setMode(detected);
      if (detected === 'remote') {
        api.meshyAvailable().then((m) => setMeshy(m.available)).catch(() => {});
      } else {
        // Hosted studio: generation is available when the edge API is up
        // (sign-in gates the actual spend).
        await restoreLocal();
        const auth = await cloud.me();
        setCloudAuth(auth);
        setMeshy(auth.available);
        if (auth.available) {
          cloud.providers().then(setProviders).catch(() => {});
          if (auth.user) cloud.history().then((h) => setHistory(h.tasks)).catch(() => {});
        }
      }
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
          const localMode = getBackend() === 'local';
          const st = localMode
            ? await cloud.genTask(task.taskId)
            : await api.meshyTask(task.kind, task.taskId);
          if (st.status === 'SUCCEEDED') {
            setTasks((prev) => prev.map((t) => t.taskId === task.taskId ? { ...t, status: 'IMPORTING', progress: 100 } : t));
            const asset = localMode
              ? await api.upload(`meshy-${task.taskId.slice(0, 8)}.glb`, await cloud.genFileBytes(task.taskId), 'mobile-hero')
              : await api.meshyImport(task.kind, task.taskId);
            setTasks((prev) => prev.filter((t) => t.taskId !== task.taskId));
            await refresh(asset.id);
            if (localMode) void refreshCloud();
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
      if (getBackend() === 'local') {
        if (!cloudAuth.user) {
          location.href = cloud.loginUrl('github');
          return;
        }
        const { taskId, kind } = await cloud.genImage(bytes, mime, pbr);
        setTasks((prev) => [...prev, { taskId, kind, name, progress: 0, status: 'PENDING' }]);
        void refreshCloud();
      } else {
        const { taskId, kind } = await api.meshyImage(bytes, mime, pbr);
        setTasks((prev) => [...prev, { taskId, kind, name, progress: 0, status: 'PENDING' }]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [cloudAuth.user, refreshCloud]);

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

  const reimport = useCallback(async (taskId: string) => {
    await run(`re-importing ${taskId.slice(0, 8)}`, async () => {
      const bytes = await cloud.genFileBytes(taskId);
      return api.upload(`meshy-${taskId.slice(0, 8)}.glb`, bytes, 'mobile-hero');
    });
  }, [run]);

  const parent = selected?.parentId ? assets.find((a) => a.id === selected.parentId) : null;

  return (
    <div className="studio">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">⬢</span> GLBForge <span className="brand-sub">Studio</span>
        </div>
        {mode === 'local' && (
          <div className="mode-badge" title="Analyze, forge, optimize and STL all run in your browser — those assets never leave your device. Only Meshy generation (sign-in) touches a server.">
            ⚡ in-browser · private
          </div>
        )}
        {mode === 'local' && cloudAuth.available && (
          cloudAuth.user ? (
            <div className="account">
              <span className="acct-login">{cloudAuth.user.login}</span>
              <span className="acct-credits">{cloudAuth.user.credits} credits</span>
              <button className="acct-btn" onClick={() => void cloud.checkout('starter').catch((e) => setError(String(e.message ?? e)))}>buy</button>
              <button className="acct-btn" onClick={() => void cloud.logout().then(refreshCloud)}>out</button>
            </div>
          ) : (
            <span className="signin-row">
              {providers.github && <a className="acct-signin" href={cloud.loginUrl('github')}>Sign in with GitHub</a>}
              {providers.google && <a className="acct-signin" href={cloud.loginUrl('google')}>Sign in with Google</a>}
            </span>
          )
        )}
        {notice && <div className="notice" onClick={() => setNotice(null)}>{notice} ✕</div>}
        {busy && <div className="busy">⚙ {busy}…</div>}
        {error && <div className="error" onClick={() => setError(null)}>{error} ✕</div>}
      </header>
      <div className="panes">
        <AssetRail
          assets={assets} selectedId={selected?.id ?? null} onSelect={select} onRun={run}
          meshyAvailable={meshy} tasks={tasks} onGenerate={generate}
          onDismissTask={(id) => setTasks((prev) => prev.filter((t) => t.taskId !== id))}
          history={history.filter((h) => !assets.some((a) => a.name.includes(h.task_id.slice(0, 8))))}
          onReimport={reimport}
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
