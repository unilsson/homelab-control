import { useEffect, useState } from 'react';
import { Activity, Boxes, LayoutDashboard, Radar, Settings2, Server, ShieldCheck, TriangleAlert, Clock3, RefreshCw, Cpu, Database, HardDrive, Layers3, ChevronDown, ChevronUp, Network } from 'lucide-react';
import LanPage from './LanPage.js';

type System = {
  id: number; name: string; type: string; status: string; host: string | null;
  source?: string | null; external_id?: string | null; last_seen?: string | null;
};
type Event = { id: number; severity: string; message: string; created_at: string };
type ProxmoxNode = {
  instanceId: string; instanceName: string;
  name: string; status: string; cpu: number | null; maxcpu: number | null;
  mem: number | null; maxmem: number | null; uptime: number | null;
};
type ProxmoxGuest = {
  instanceId: string; instanceName: string;
  vmid: number; name: string; node: string; kind: 'qemu' | 'lxc';
  status: string; cpu: number | null; mem: number | null; maxmem: number | null; template: boolean;
};
type ProxmoxInstance = {
  id: string; name: string; state: 'online' | 'partial' | 'error'; checkedAt: string;
  nodes: ProxmoxNode[]; guests: ProxmoxGuest[]; error?: string;
};
type ProxmoxInventory = {
  configured: boolean; state: 'disabled' | 'online' | 'partial' | 'error'; checkedAt: string | null;
  instances: ProxmoxInstance[]; nodes: ProxmoxNode[]; guests: ProxmoxGuest[]; error?: string;
};
type SecretProviderStatus = {
  provider: 'infisical'; configured: boolean;
  state: 'disabled' | 'idle' | 'online' | 'degraded' | 'error';
  lastCheckedAt: string | null; message?: string;
};
type Page = 'Dashboard' | 'Systems' | 'Services' | 'Actions' | 'Proxmox' | 'LAN' | 'Events' | 'Discoveries' | 'Analysis' | 'Integrations';

const sections: { label: string; pages: Page[] }[] = [
  { label: 'OVERVIEW', pages: ['Dashboard'] },
  { label: 'COMMANDER', pages: ['Systems', 'Services', 'Actions'] },
  { label: 'VIRTUALIZATION', pages: ['Proxmox'] },
  { label: 'NETWORK', pages: ['LAN'] },
  { label: 'DETECTIVE', pages: ['Events', 'Discoveries', 'Analysis'] },
  { label: 'SETTINGS', pages: ['Integrations'] }
];

const defaultInventory: ProxmoxInventory = { configured: false, state: 'disabled', checkedAt: null, instances: [], nodes: [], guests: [] };

function iconFor(page: Page) {
  if (page === 'Dashboard') return <LayoutDashboard size={17} />;
  if (page === 'Systems') return <Server size={17} />;
  if (page === 'Proxmox') return <Layers3 size={17} />;
  if (page === 'LAN') return <Network size={17} />;
  if (page === 'Events') return <Clock3 size={17} />;
  if (page === 'Integrations') return <Settings2 size={17} />;
  if (page === 'Discoveries' || page === 'Analysis') return <Radar size={17} />;
  return <Boxes size={17} />;
}

function statusClass(status: string): string {
  if (status === 'online' || status === 'healthy' || status === 'running') return 'status good';
  if (status === 'stopped' || status === 'disabled' || status === 'unknown' || status === 'idle') return 'status neutral';
  if (status === 'partial' || status === 'degraded') return 'status caution';
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
  const [infisical, setInfisical] = useState<SecretProviderStatus>({ provider: 'infisical', configured: false, state: 'disabled', lastCheckedAt: null });
  const [loading, setLoading] = useState(true);
  const [apiError, setApiError] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [expandedInstances, setExpandedInstances] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const [healthResponse, systemsResponse, eventsResponse, proxmoxResponse, infisicalResponse] = await Promise.all([
          fetch('/api/health', { signal: controller.signal }),
          fetch('/api/systems', { signal: controller.signal }),
          fetch('/api/events', { signal: controller.signal }),
          fetch('/api/integrations/proxmox', { signal: controller.signal }),
          fetch('/api/integrations/infisical', { signal: controller.signal })
        ]);
        if (![healthResponse, systemsResponse, eventsResponse, proxmoxResponse, infisicalResponse].every(r => r.ok)) throw new Error('API unavailable');
        const [health, newSystems, newEvents, newProxmox, newInfisical] = await Promise.all([
          healthResponse.json() as Promise<{ status: string }>,
          systemsResponse.json() as Promise<System[]>,
          eventsResponse.json() as Promise<Event[]>,
          proxmoxResponse.json() as Promise<ProxmoxInventory>,
          infisicalResponse.json() as Promise<SecretProviderStatus>
        ]);
        if (controller.signal.aborted) return;
        setOnline(health.status === 'ok');
        setSystems(newSystems);
        setEvents(newEvents);
        setProxmox(newProxmox);
        setInfisical(newInfisical);
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
    <div className="panel-title">
      <div><h2>Proxmox infrastructure</h2><p>Multiple servers · read-only discovery</p></div>
      <span className={statusClass(proxmox.state)}>{proxmox.state}</span>
    </div>
    {proxmox.state === 'disabled'
      ? <div className="empty">No Proxmox servers configured yet. Create a local config/proxmox-instances.json and set PROXMOX_INSTANCES_FILE in .env.</div>
      : <>
        {proxmox.error && <div className="notice"><TriangleAlert size={17}/><span>{proxmox.error}</span></div>}
        <div className="mini-stats">
          <span><Server size={15}/> {proxmox.instances.length} connections</span>
          <span><Database size={15}/> {proxmox.nodes.length} nodes</span>
          <span><Cpu size={15}/> {proxmox.guests.filter(g => g.kind === 'qemu').length} VMs</span>
          <span><Layers3 size={15}/> {proxmox.guests.filter(g => g.kind === 'lxc').length} LXC</span>
          <span><Activity size={15}/> {guestsRunning} running</span>
        </div>
        {proxmox.instances.map(instance => {
          const expanded = Boolean(expandedInstances[instance.id]);
          const vmCount = instance.guests.filter(g => g.kind === 'qemu').length;
          const lxcCount = instance.guests.filter(g => g.kind === 'lxc').length;
          const runningCount = instance.guests.filter(g => g.status === 'running').length;
          const detailsId = 'proxmox-details-' + instance.id;
          return <div className="proxmox-instance" key={instance.id}>
            <div className="instance-overview">
              <div className="instance-main">
                <div className="instance-heading">
                  <Server size={18} aria-hidden="true" />
                  <strong>{instance.name}</strong>
                  <span className={statusClass(instance.state)}>{instance.state}</span>
                </div>
                <div className="instance-summary">
                  <span>{instance.nodes.length} nodes</span>
                  <span>{vmCount} VMs</span>
                  <span>{lxcCount} LXC</span>
                  <span>{runningCount} running</span>
                </div>
              </div>
              <button
                type="button"
                className="instance-toggle"
                onClick={() => setExpandedInstances(previous => ({ ...previous, [instance.id]: !previous[instance.id] }))}
                aria-expanded={expanded}
                aria-controls={detailsId}
              >
                {expanded ? 'Hide workloads' : 'Show workloads'}
                {expanded ? <ChevronUp size={16} aria-hidden="true" /> : <ChevronDown size={16} aria-hidden="true" />}
              </button>
            </div>
            {instance.error && <div className="notice"><TriangleAlert size={17}/><span>{instance.error}</span></div>}
            <div className="instance-details" id={detailsId} hidden={!expanded}>
              {instance.nodes.length === 0
                ? <div className="empty">No nodes available from this Proxmox server.</div>
                : instance.nodes.map(node => <div key={instance.id + ':' + node.name} className="node-block">
                  <div className="node-header"><strong>{node.name}</strong><span className={statusClass(node.status)}>{node.status}</span></div>
                  <div className="node-details"><span>CPU {formatCPU(node.cpu)}</span><span>RAM {formatMemory(node.mem)} / {formatMemory(node.maxmem)}</span></div>
                  {instance.guests.filter(g => g.node === node.name).map(guest => <div className="guest-row" key={instance.id + ':' + guest.kind + ':' + guest.vmid}>
                    <div className="guest-name"><span className="vmid">{guest.vmid}</span><strong>{guest.name}</strong><span className="guest-kind">{guest.kind.toUpperCase()}{guest.template ? ' · template' : ''}</span></div>
                    <div className="guest-metrics"><span>{formatCPU(guest.cpu)}</span><span>{formatMemory(guest.mem)}</span><span className={statusClass(guest.status)}>{guest.status}</span></div>
                  </div>)}
                </div>)}
            </div>
          </div>;
        })}
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
      <div className="content"><div className="eyebrow">HOMELAB CONTROL / {page.toUpperCase()}</div><h1>{page}</h1><p className="subhead">{page === 'Dashboard' ? 'Your infrastructure, all in one place.' : page === 'Proxmox' ? 'Your Proxmox servers and virtual workloads.' : page === 'LAN' ? 'All local IPv4 addresses, used and apparently free.' : 'Infrastructure control and observability.'}</p>
      {apiError && <div className="notice"><TriangleAlert size={17}/> Unable to reach Homelab Control API. Data may be stale.</div>}
      {page === 'Dashboard' ? <>
        <div className="cards">
          <div className="card"><div className="card-heading"><Server size={18}/> DISCOVERED SYSTEMS</div><div className="metric">{systems.length}</div><div className="card-foot">Systems under management</div></div>
          <div className="card"><div className="card-heading"><ShieldCheck size={18}/> ONLINE</div><div className="metric green">{healthy}</div><div className="card-foot">Currently reporting online</div></div>
          <div className="card"><div className="card-heading"><TriangleAlert size={18}/> RECENT ALERTS</div><div className="metric amber">{alerts}</div><div className="card-foot">Warning or critical events</div></div>
        </div>
        <section className="panel">
          <div className="panel-title">
            <div><h2>Virtualization</h2><p>Proxmox infrastructure at a glance</p></div>
            <button className="text-action" onClick={() => setPage('Proxmox')} type="button">Open Proxmox →</button>
          </div>
          <div className="virtualization-overview">
            <span className={statusClass(proxmox.state)}>{proxmox.state}</span>
            <span>{proxmox.instances.length} servers</span>
            <span>{proxmox.guests.filter(g => g.kind === 'qemu').length} VMs</span>
            <span>{proxmox.guests.filter(g => g.kind === 'lxc').length} LXC</span>
          </div>
          {proxmox.error && <div className="notice"><TriangleAlert size={17}/><span>{proxmox.error}</span></div>}
        </section>
        <section className="panel"><div className="panel-title"><h2>Registered systems</h2><button className="text-action" onClick={() => setPage('Systems')} type="button">View all →</button></div><p className="panel-copy muted">{systems.length} systems registered. Open Systems to see the full list.</p></section>
        <section className="panel"><h2>Recent events</h2>{events.length === 0 ? <div className="empty">No events recorded yet.</div> : events.slice(0, 5).map(e => <div className="row" key={e.id}><strong>{e.message}</strong><span>{e.severity} · {e.created_at}</span></div>)}</section>
      </> : page === 'Systems' ? <section className="panel"><h2>Discovered systems</h2>{systemRows}</section> :
      page === 'Proxmox' ? proxmoxPanel :
      page === 'LAN' ? <LanPage refreshKey={refreshKey} /> :
      page === 'Integrations' ? <> <section className="panel">
        <div className="panel-title"><h2>Proxmox VE connections</h2><span className={statusClass(proxmox.state)}>{proxmox.state}</span></div>
        <p className="panel-copy">Manage multiple independent Proxmox installations through your local <code>config/proxmox-instances.json</code> file. Each server has its own read-only API token and optional CA certificate.</p>
        <p className="panel-copy muted">Last checked: {proxmox.checkedAt ? new Date(proxmox.checkedAt).toLocaleString() : 'never'} · Credentials are never sent to the browser.</p>
        {proxmox.error && <div className="notice">{proxmox.error}</div>}
        {proxmox.instances.length === 0 && <div className="empty">No connections configured.</div>}
        {proxmox.instances.map(instance => <div key={instance.id} className="integration-row">
          <div><strong>{instance.name}</strong><span>{instance.id} · {instance.nodes.length} nodes · {instance.guests.length} guests</span>
            {instance.error && <span className="integration-error">{instance.error}</span>}</div>
          <span className={statusClass(instance.state)}>{instance.state}</span>
        </div>)}
        <div className="mini-stats"><span><Database size={15}/> {proxmox.nodes.length} nodes</span><span><HardDrive size={15}/> {proxmox.guests.length} guests</span></div>
      </section>
      <section className="panel">
        <div className="panel-title">
          <div><h2>Infisical secrets</h2><p>Self-hosted Machine Identity · Universal Auth</p></div>
          <span className={statusClass(infisical.state)}>{infisical.state}</span>
        </div>
        <p className="panel-copy">Proxmox API tokens are retrieved by secret reference and kept in backend memory. Credentials are never returned to the browser or stored in SQLite.</p>
        <p className="panel-copy muted">Last checked: {infisical.lastCheckedAt ? new Date(infisical.lastCheckedAt).toLocaleString() : 'never'}</p>
        {infisical.message && <div className="notice"><TriangleAlert size={17}/>{infisical.message}</div>}
        {!infisical.configured && <div className="empty">Infisical is not configured. Set Machine Identity credentials in your local deployment environment.</div>}
      </section> </> :
      page === 'Events' ? <section className="panel"><h2>Events</h2>{events.length ? events.map(e => <div className="row" key={e.id}><strong>{e.message}</strong><span>{e.severity} · {e.created_at}</span></div>) : <div className="empty">No events recorded yet.</div>}</section> :
      page === 'Discoveries' ? <section className="panel"><h2>Discovered infrastructure</h2>{systemRows}</section> :
      <section className="panel"><h2>{page}</h2><div className="empty">This module will be enabled in a later sprint.</div></section>}
      <footer>HOMELAB CONTROL · PROXMOX DISCOVERY · {loading ? 'REFRESHING…' : '2026'}</footer></div>
    </main>
  </div>;
}
