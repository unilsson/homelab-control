import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Network, Search, Server, RefreshCw } from 'lucide-react';

type LanStatus = 'used' | 'free' | 'leased' | 'reserved' | 'conflict';
type LanDevice = { mac: string; vendor: string };
type LanLease = {
  mac: string | null; hostname: string | null; description: string | null;
  manufacturer: string | null; type: string | null;
};
type LanAddress = {
  ip: string; status: LanStatus; hostname: string | null;
  devices: LanDevice[]; lease: LanLease | null;
};
type LanInventory = {
  network: string; state: 'online' | 'stale' | 'missing' | 'error';
  scannedAt: string | null;
  summary: {
    total: number; occupied: number; used: number; free: number;
    leased: number; reserved: number; conflicts: number;
  } | null;
  results: LanAddress[]; message?: string;
};
type Filter = 'all' | LanStatus;

const filters: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'used', label: 'Used' },
  { key: 'free', label: 'Free' },
  { key: 'leased', label: 'Leased' },
  { key: 'reserved', label: 'Reserved' },
  { key: 'conflict', label: 'Conflicts' }
];

const emptyInventory: LanInventory = {
  network: '192.168.1.0/24', state: 'missing', scannedAt: null,
  summary: null, results: []
};

function displayedMac(row: LanAddress): string {
  return row.devices.length
    ? row.devices.map(device => device.mac).join(', ')
    : (row.lease?.mac || '—');
}

function displayedVendor(row: LanAddress): string {
  return row.devices.map(device => device.vendor).filter(Boolean).join(', ')
    || row.lease?.manufacturer || '—';
}

export default function LanPage({ refreshKey }: { refreshKey: number }) {
  const [inventory, setInventory] = useState<LanInventory>(emptyInventory);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [pending, setPending] = useState(true);
  const [fetchError, setFetchError] = useState(false);

  useEffect(() => {
    let controller: AbortController | null = null;
    let mounted = true;
    const load = async () => {
      controller?.abort();
      const active = new AbortController();
      controller = active;
      try {
        const response = await fetch('/api/network/lan', { signal: active.signal });
        if (!response.ok) throw new Error('LAN API unavailable');
        const data = await response.json() as LanInventory;
        if (!mounted || active.signal.aborted) return;
        setInventory(data);
        setFetchError(false);
      } catch {
        if (mounted && !active.signal.aborted) setFetchError(true);
      } finally {
        if (mounted && !active.signal.aborted) setPending(false);
      }
    };
    void load();
    const timer = setInterval(() => { void load(); }, 30_000);
    return () => { mounted = false; controller?.abort(); clearInterval(timer); };
  }, [refreshKey]);

  const displayed = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return inventory.results.filter(row => {
      if (filter !== 'all' && row.status !== filter) return false;
      if (!needle) return true;
      const searchable = [
        row.ip, row.status, row.hostname ?? '',
        row.lease?.hostname ?? '', row.lease?.description ?? '',
        displayedMac(row), displayedVendor(row)
      ].join(' ').toLowerCase();
      return searchable.includes(needle);
    });
  }, [inventory.results, filter, search]);

  const summary = inventory.summary;
  const scannedAt = inventory.scannedAt
    ? new Date(inventory.scannedAt).toLocaleString()
    : 'Never';

  return <section className="panel lan-panel">
    <div className="panel-title">
      <div><h2><Network size={17} aria-hidden="true" /> LAN address inventory</h2>
        <p>{inventory.network} · read-only ARP / DNS / OPNsense DHCP snapshot</p>
      </div>
      <span className={'status ' + (inventory.state === 'online' ? 'good' : inventory.state === 'stale' ? 'caution' : 'neutral')}>{inventory.state}</span>
    </div>

    <p className="panel-copy muted lan-scan-time">
      <RefreshCw size={14} aria-hidden="true" /> Last scan: {scannedAt}. Page refreshes every 30 seconds.
    </p>
    {fetchError && <div className="notice"><AlertTriangle size={17} /> Could not refresh LAN data. The displayed data may be outdated.</div>}
    {inventory.message && <div className="notice"><AlertTriangle size={17} /><span>{inventory.message}</span></div>}
    {pending && !summary && <div className="empty">Loading LAN inventory…</div>}

    {summary && <>
      <div className="lan-summary">
        <div><strong>{summary.total}</strong><span>All addresses</span></div>
        <div><strong>{summary.occupied}</strong><span>Occupied</span></div>
        <div><strong>{summary.used}</strong><span>ARP used</span></div>
        <div><strong>{summary.free}</strong><span>Apparently free</span></div>
        <div><strong>{summary.leased}</strong><span>DHCP leased</span></div>
        <div><strong>{summary.reserved}</strong><span>Reserved</span></div>
        <div><strong>{summary.conflicts}</strong><span>Conflicts</span></div>
      </div>

      <div className="lan-toolbar">
        <div className="lan-filters" aria-label="Filter IP address status">
          {filters.map(item => <button
            type="button" key={item.key} className={filter === item.key ? 'lan-filter active' : 'lan-filter'}
            aria-pressed={filter === item.key} onClick={() => setFilter(item.key)}>
            {item.label}
          </button>)}
        </div>
        <label className="lan-search">
          <Search size={16} aria-hidden="true" />
          <span className="sr-only">Search LAN addresses</span>
          <input type="search" placeholder="Search IP, hostname, MAC, vendor…" value={search}
            onChange={event => setSearch(event.target.value)} />
        </label>
      </div>

      <div className="lan-row-count">Showing {displayed.length} of {inventory.results.length} IP addresses</div>
      <div className="lan-table-scroll" role="region" aria-label="Local network IP addresses" tabIndex={0}>
        <table className="lan-table">
          <thead><tr><th scope="col">IP address</th><th scope="col">Status</th>
            <th scope="col">Hostname</th><th scope="col">MAC address</th>
            <th scope="col">Vendor / description</th></tr></thead>
          <tbody>
            {displayed.map(row => <tr key={row.ip}>
              <td className="lan-ip"><Server size={13} aria-hidden="true" />{row.ip}</td>
              <td><span className={'lan-state lan-state-' + row.status}>{row.status}</span></td>
              <td>{row.hostname || row.lease?.hostname || '—'}</td>
              <td className="lan-mac">{displayedMac(row)}</td>
              <td>{row.lease?.description || displayedVendor(row)}</td>
            </tr>)}
            {displayed.length === 0 && <tr><td colSpan={5} className="lan-no-results">No matching IP addresses.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="lan-disclaimer">
        “Free” means no ARP response and no DHCP lease/reservation detected at scan time.
        It is not a guarantee that an IP address is safe to allocate.
      </p>
    </>}
  </section>;
}
