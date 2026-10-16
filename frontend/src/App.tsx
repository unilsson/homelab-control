import { useEffect, useState } from 'react';
import { Activity, Boxes, LayoutDashboard, Radar, Settings2, Server, ShieldCheck, TriangleAlert, Clock3, RefreshCw, Cpu, Database, HardDrive, Layers3 } from 'lucide-react';

type System = {
  id: number; name: string; type: string; status: string; host: string | null;
  source?: string | null; external_id?: string | null; last_seen?: string | null;
};
type Event = { id: number; severity: string; message: string; created_at: string };
type ProxmoxNode = {
  name: string; status: string; cpu: number | null; maxcpu: number | null;
  mem: number | null; maxmem: number | null; uptime: number | null;
};
type ProxmoxGuest = {
  vmid: number; name: string; node: string; kind: 'qemu' | 'lxc';
  status: string; cpu: number | null; mem: number | null; maxmem: number | null; template: boolean;
};
type ProxmoxInventory = {
  configured: boolean; state: 'disabled' | 'online' | 'partial' | 'error'; checkedAt: string | null;
  nodes: ProxmoxNode[]; guests: ProxmoxGuest[]; error?: string;
};
type Page = 'Dashboard' | 'Systems' | 'Services' | 'Actions' | 'Events' | 'Discoveries' | 'Analysis' | 'Integrations';

const sections: { label: string; pages: Page[] }[] = [
  { label: 'OVERVIEW', pages: ['Dashboard'] },
  { label: 'COMMANDER', pages: ['Systems', 'Services', 'Actions'] },
  { label: 'DETECTIVE', pages: ['Events', 'Discoveries', 'Analysis'] },
  { label: 'SETTINGS', pages: ['Integrations'] }
];

const defaultInventory: ProxmoxInventory = { configured: false, state: 'disabled', checkedAt: null, nodes: [], guests: [] };

function iconFor(page: Page) {
  if (page === 'Dashboard') return <LayoutDashboard size={17} />;
  if (page === 'Systems') return <Server size={17} />;
  if (page === 'Events') return <Clock3 size={17} />;
  if (page === 'Integrations') return <Settings2 size={17} />;
  if (page === 'Discoveries' || page === 'Analysis') return <Radar size={17} />;
  return <Boxes size={17} />;
}

function statusClass(status: string): string {
  if (status === 'online' || status === 'healthy' || status === 'running') return 'status good';
  if (status === 'stopped' || status === 'disabled') return 'status neutral';
  return 'status bad';
}

function formatMemory(bytes: number | null): string {
  if (bytes === null) return '—';
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GiB';
}

function formatCPU(cpu: number | null): string {
  return cpu === null ? '—' : (cpu * 100).toFixed(1) + '%';
}

export default function App() {
  const [page, setPage] = useState<Page>('Dashboard');
  const [online, setOnline] = useState(false);
  const [systems, setSystems] = useState<System[]>([]);
  const [events, setEvents] = useState<Event[]>([]);
  const [proxmox, setProxmox] = useState<ProxmoxInventory>(defaultInventory);
  const [loading, setLoading] = useState(true);
  const [apiError, setApiError] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const [healthResponse, systemsResponse, eventsResponse, proxmoxResponse] = await Promise.all([
          fetch('/api/health', { signal: controller.signal }),
          fetch('/api/systems', { signal: controller.signal }),
          fetch('/api/events', { signal: controller.signal }),
          fetch('/api/integrations/proxmox', { signal: controller.signal })
        ]);
        if (![healthResponse, systemsResponse, eventsResponse, proxmoxResponse].every(r => r.ok)) throw new Error('API unavailable');
        const [health, newSystems, newEvents, newProxmox] = await Promise.all([
          healthResponse.json() as Promise<{ status: string }>,
          systemsResponse.json() as Promise<System[]>,
          eventsResponse.json() as Promise<Event[]>,
          proxmoxResponse.json() as Promise<ProxmoxInventory>
        ]);
        if (controller.signal.aborted) return;
        setOnline(health.status === 'ok');
        setSystems(newSystems);
        setEvents(newEvents);
        setProxmox(newProxmox);
        setApiError(false);
      } catch {
        if (!controller.signal.aborted) { setOnline(false); setApiError(true); }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void load();
    const interval = setInterval(() => { void load(); }, 30_000);
    return () => { controller.abort(); clearInterval(interval); };
  }, [refreshKey]);

  const healthy = systems.filter(s => s.status === 'healthy' || s.status === 'online').length;
  const alerts = events.filter(e => e.severity === 'warning' || e.severity === 'critical').length;
  const guestsRunning = proxmox.guests.filter(g => g.status === 'running').length;

  const systemRows = <div className="system-table">
    {systems.length === 0 ? <div className="empty">No systems discovered yet. Configure Proxmox to populate this list.</div> :
      systems.map(s => <div className="system-row" key={s.id}>
        <div className="system-identity"><Server size={18}/><div><strong>{s.name}</strong><span>{s.type} · {s.host || '—'}</span></div></div>
        <span className={statusClass(s.status)}>{s.status}</span>
      </div>)}
  </div>;

  const proxmoxPanel = <section className="panel">
    <div className="panel-title"><div><h2>Proxmox infrastructure</h2><p>Live node and guest inventory · read-only</p></div>
      <span className={statusClass(proxmox.state === 'partial' ? 'unknown' : proxmox.state)}>{proxmox.state}</span></div>
    {proxmox.state === 'disabled' ? <div className="empty">Proxmox is not configured. Add PROXMOX_URL and a read-only API token to your local .env file.</div> :
      proxmox.state === 'error' ? <div className="notice"><TriangleAlert size={17}/><span>{proxmox.error || 'Proxmox is unavailable.'}</span></div> : <>
        {proxmox.error && <div className="notice"><TriangleAlert size={17}/><span>{proxmox.error}</span></div>}
        <div className="mini-stats"><span><Server size={15}/> {proxmox.nodes.length} nodes</span><span><Cpu size={15}/> {proxmox.guests.filter(g => g.kind === 'qemu').length} VMs</span><span><Layers3 size={15}/> {proxmox.guests.filter(g => g.kind === 'lxc').length} LXC</span><span><Activity size={15}/> {guestsRunning} running</span></div>
        {proxmox.nodes.map(node => <div key={node.name} className="node-block">
          <div className="node-header"><strong>{node.name}</strong><span className={statusClass(node.status)}>{node.status}</span></div>
          <div className="node-details"><span>CPU {formatCPU(node.cpu)}</span><span>RAM {formatMemory(node.mem)} / {formatMemory(node.maxmem)}</span></div>
          {proxmox.guests.filter(g => g.node === node.name).map(guest => <div className="guest-row" key={guest.kind + ':' + guest.vmid}>
            <div className="guest-name"><span className="vmid">{guest.vmid}</span><strong>{guest.name}</strong><span className="guest-kind">{guest.kind.toUpperCase()}{guest.template ? ' · template' : ''}</span></div>
            <div className="guest-metrics"><span>{formatCPU(guest.cpu)}</span><span>{formatMemory(guest.mem)}</span><span className={statusClass(guest.status)}>{guest.status}</span></div>
          </div>)}
        </div>)}
      </>}
  </section>;

  return <div className="layout">
    <aside className="sidebar">
      <div className="brand"><span className="brand-icon"><Activity size={23}/></span><span>HOMELAB<br/><strong>CONTROL</strong></span></div>
      <nav>{sections.map(group => <div key={group.label} className="nav-group"><div className="nav-label">{group.label}</div>{group.pages.map(item =>
        <button type="button" key={item} onClick={() => setPage(item)} className={page === item ? 'nav-item active' : 'nav-item'}>{iconFor(item)}<span>{item}</span></button>
      )}</div>)}</nav>
      <div className="sidebar-bottom">SPRINT 2 <span>v0.2.0</span></div>
    </aside>
    <main className="main">
      <header className="topbar"><span>Infrastructure / <strong>{page}</strong></span><div className="header-actions"><button className="refresh" type="button" onClick={() => { setLoading(true); setRefreshKey(k => k + 1); }} aria-label="Refresh data" title="Refresh data"><RefreshCw size={16}/></button><span className={online ? 'connection online' : 'connection offline'}><span className="dot"/>{online ? 'API ONLINE' : 'API OFFLINE'}</span></div></header>
      <div className="content"><div className="eyebrow">HOMELAB CONTROL / {page.toUpperCase()}</div><h1>{page}</h1><p className="subhead">{page === 'Dashboard' ? 'Your infrastructure, all in one place.' : 'Infrastructure control and observability.'}</p>
      {apiError && <div className="notice"><TriangleAlert size={17}/> Unable to reach Homelab Control API. Data may be stale.</div>}
      {page === 'Dashboard' ? <>
        <div className="cards">
          <div className="card"><div className="card-heading"><Server size={18}/> DISCOVERED SYSTEMS</div><div className="metric">{systems.length}</div><div className="card-foot">Systems under management</div></div>
          <div className="card"><div className="card-heading"><ShieldCheck size={18}/> ONLINE</div><div className="metric green">{healthy}</div><div className="card-foot">Currently reporting online</div></div>
          <div className="card"><div className="card-heading"><TriangleAlert size={18}/> RECENT ALERTS</div><div className="metric amber">{alerts}</div><div className="card-foot">Warning or critical events</div></div>
        </div>
        {proxmoxPanel}
        <section className="panel"><div className="panel-title"><h2>Registered systems</h2><button className="text-action" onClick={() => setPage('Systems')} type="button">View all →</button></div>{systemRows}</section>
        <section className="panel"><h2>Recent events</h2>{events.length === 0 ? <div className="empty">No events recorded yet.</div> : events.slice(0, 5).map(e => <div className="row" key={e.id}><strong>{e.message}</strong><span>{e.severity} · {e.created_at}</span></div>)}</section>
      </> : page === 'Systems' ? <><section className="panel"><h2>Discovered systems</h2>{systemRows}</section>{proxmoxPanel}</> :
      page === 'Integrations' ? <section className="panel"><div className="panel-title"><h2>Proxmox VE</h2><span className={statusClass(proxmox.state === 'partial' ? 'unknown' : proxmox.state)}>{proxmox.state}</span></div>
        <p className="panel-copy">Read-only discovery of nodes, virtual machines and LXC containers. Configure PROXMOX_URL, PROXMOX_TOKEN_ID and PROXMOX_TOKEN_SECRET in your local .env file and restart the backend.</p>
        {proxmox.error && <div className="notice">{proxmox.error}</div>}
        <p className="panel-copy muted">Last checked: {proxmox.checkedAt ? new Date(proxmox.checkedAt).toLocaleString() : 'never'} · Credentials are never sent to the browser.</p>
        <div className="mini-stats"><span><Database size={15}/> {proxmox.nodes.length} nodes</span><span><HardDrive size={15}/> {proxmox.guests.length} guests</span></div>
      </section> :
      page === 'Events' ? <section className="panel"><h2>Events</h2>{events.length ? events.map(e => <div className="row" key={e.id}><strong>{e.message}</strong><span>{e.severity} · {e.created_at}</span></div>) : <div className="empty">No events recorded yet.</div>}</section> :
      page === 'Discoveries' ? <section className="panel"><h2>Discovered infrastructure</h2>{systemRows}</section> :
      <section className="panel"><h2>{page}</h2><div className="empty">This module will be enabled in a later sprint.</div></section>}
      <footer>HOMELAB CONTROL · PROXMOX DISCOVERY · {loading ? 'REFRESHING…' : '2026'}</footer></div>
    </main>
  </div>;
}
