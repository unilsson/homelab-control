import { useEffect, useState } from 'react';
import { Activity, Boxes, LayoutDashboard, Radar, Settings2, Server, ShieldCheck, TriangleAlert, Clock3 } from 'lucide-react';

type System = { id: number; name: string; type: string; status: string; host: string | null };
type Event = { id: number; severity: string; message: string; created_at: string };
type Page = 'Dashboard' | 'Systems' | 'Services' | 'Actions' | 'Events' | 'Discoveries' | 'Analysis' | 'Integrations';

const sections: { label: string; pages: Page[] }[] = [
  { label: 'OVERVIEW', pages: ['Dashboard'] },
  { label: 'COMMANDER', pages: ['Systems', 'Services', 'Actions'] },
  { label: 'DETECTIVE', pages: ['Events', 'Discoveries', 'Analysis'] },
  { label: 'SETTINGS', pages: ['Integrations'] },
];

function iconFor(page: Page) {
  if (page === 'Dashboard') return <LayoutDashboard size={17} />;
  if (page === 'Systems') return <Server size={17} />;
  if (page === 'Events') return <Clock3 size={17} />;
  if (page === 'Integrations') return <Settings2 size={17} />;
  if (page === 'Discoveries' || page === 'Analysis') return <Radar size={17} />;
  return <Boxes size={17} />;
}

export default function App() {
  const [page, setPage] = useState<Page>('Dashboard');
  const [online, setOnline] = useState(false);
  const [systems, setSystems] = useState<System[]>([]);
  const [events, setEvents] = useState<Event[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const [healthResponse, systemsResponse, eventsResponse] = await Promise.all([
          fetch('/api/health', { signal: controller.signal }),
          fetch('/api/systems', { signal: controller.signal }),
          fetch('/api/events', { signal: controller.signal }),
        ]);
        if (!healthResponse.ok || !systemsResponse.ok || !eventsResponse.ok) throw new Error('API unavailable');
        const health: {status: string} = await healthResponse.json();
        setOnline(health.status === 'ok');
        setSystems(await systemsResponse.json());
        setEvents(await eventsResponse.json());
      } catch {
        if (!controller.signal.aborted) setOnline(false);
      }
    };
    void load();
    const interval = setInterval(() => void load(), 30000);
    return () => { controller.abort(); clearInterval(interval); };
  }, []);

  const healthy = systems.filter(s => s.status === 'healthy' || s.status === 'online').length;
  const alerts = events.filter(e => e.severity === 'warning' || e.severity === 'critical').length;
  return <div className="layout">
    <aside className="sidebar">
      <div className="brand"><span className="brand-icon"><Activity size={23}/></span><span>HOMELAB<br/><strong>CONTROL</strong></span></div>
      <nav>{sections.map(group => <div key={group.label} className="nav-group"><div className="nav-label">{group.label}</div>{group.pages.map(item =>
        <button type="button" key={item} onClick={() => setPage(item)} className={page === item ? 'nav-item active' : 'nav-item'}>{iconFor(item)}<span>{item}</span></button>
      )}</div>)}</nav>
      <div className="sidebar-bottom">SPRINT 1 <span>v0.1.0</span></div>
    </aside>
    <main className="main">
      <header className="topbar"><span>Infrastructure / <strong>{page}</strong></span><span className={online ? 'connection online' : 'connection offline'}><span className="dot"/>{online ? 'API ONLINE' : 'API OFFLINE'}</span></header>
      <div className="content"><div className="eyebrow">HOMELAB CONTROL / {page.toUpperCase()}</div><h1>{page}</h1><p className="subhead">{page === 'Dashboard' ? 'Your infrastructure, all in one place.' : 'Infrastructure control and observability.'}</p>
      {page === 'Dashboard' ? <>
        <div className="cards">
          <div className="card"><div className="card-heading"><Server size={18}/> REGISTERED SYSTEMS</div><div className="metric">{systems.length}</div><div className="card-foot">Systems under management</div></div>
          <div className="card"><div className="card-heading"><ShieldCheck size={18}/> HEALTHY</div><div className="metric green">{healthy}</div><div className="card-foot">Reporting healthy status</div></div>
          <div className="card"><div className="card-heading"><TriangleAlert size={18}/> RECENT ALERTS</div><div className="metric amber">{alerts}</div><div className="card-foot">Warning or critical events</div></div>
        </div>
        <section className="panel"><h2>Registered systems</h2>{systems.length === 0 ? <div className="empty">No systems registered yet. Integrations are coming in a future sprint.</div> : systems.map(s => <div className="row" key={s.id}><strong>{s.name}</strong><span>{s.type} · {s.status}</span></div>)}</section>
        <section className="panel"><h2>Recent events</h2>{events.length === 0 ? <div className="empty">No events recorded yet.</div> : events.map(e => <div className="row" key={e.id}><strong>{e.message}</strong><span>{e.severity} · {e.created_at}</span></div>)}</section>
      </> : <section className="panel"><h2>{page}</h2>{page === 'Systems' ? systems.length ? systems.map(s => <div className="row" key={s.id}><strong>{s.name}</strong><span>{s.host || s.type} · {s.status}</span></div>) : <div className="empty">No systems registered yet.</div> : page === 'Events' ? events.length ? events.map(e => <div className="row" key={e.id}><strong>{e.message}</strong><span>{e.severity} · {e.created_at}</span></div>) : <div className="empty">No events recorded yet.</div> : <div className="empty">This module will be enabled in a later sprint.</div>}</section>}
      <footer>HOMELAB CONTROL · FOUNDATION BUILD · 2026</footer></div>
    </main>
  </div>;
}
