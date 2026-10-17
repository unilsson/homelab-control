import React, { useEffect, useMemo, useState } from 'react';
import {
  Activity, AlertTriangle, ArrowRight, Clock3, History, Laptop2,
  Network, RefreshCw, Search, Server, ShieldAlert, Wifi, WifiOff, X
} from 'lucide-react';

export type DetectiveView = 'overview' | 'events' | 'devices';

type Summary = {
  network: string;
  scans: number;
  lastScannedAt: string | null;
  totalDevices: number;
  online: number;
  offline: number;
  known: number;
  events: number;
};

type DeviceState = 'online' | 'offline' | 'known';

type Device = {
  network: string;
  mac: string;
  displayName: string | null;
  category: string | null;
  firstSeen: string;
  lastSeen: string;
  lastArpSeen: string | null;
  lastIp: string;
  hostname: string | null;
  vendor: string | null;
  description: string | null;
  state: DeviceState;
  missedScans: number;
};

type EventType =
  | 'NEW_DEVICE' | 'DEVICE_ONLINE' | 'DEVICE_OFFLINE' | 'IP_CHANGED'
  | 'MAC_CHANGED' | 'IP_CONFLICT' | 'CONFLICT_RESOLVED' | 'DHCP_CHANGED';
type Severity = 'info' | 'warning' | 'critical';

type NetworkEvent = {
  id: number;
  network: string;
  mac: string | null;
  ip: string | null;
  type: EventType;
  severity: Severity;
  previousValue: string | null;
  currentValue: string | null;
  createdAt: string;
};

type FilterState = 'all' | DeviceState;
type SeverityFilter = 'all' | Severity;
type EventTypeFilter = 'all' | EventType;

const emptySummary: Summary = {
  network: '—', scans: 0, lastScannedAt: null,
  totalDevices: 0, online: 0, offline: 0, known: 0, events: 0
};

const eventLabels: Record<EventType, string> = {
  NEW_DEVICE: 'New device',
  DEVICE_ONLINE: 'Device online',
  DEVICE_OFFLINE: 'Device offline',
  IP_CHANGED: 'IP address changed',
  MAC_CHANGED: 'MAC address changed',
  IP_CONFLICT: 'IP conflict detected',
  CONFLICT_RESOLVED: 'IP conflict resolved',
  DHCP_CHANGED: 'DHCP mapping changed'
};

const eventTypes = Object.entries(eventLabels) as Array<[EventType, string]>;

function formatDate(value: string | null): string {
  if (!value) return 'Never';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString();
}

function deviceLabel(device: Device): string {
  return device.displayName || device.hostname || device.mac;
}

function eventDetail(event: NetworkEvent): string {
  if (event.type === 'IP_CHANGED' || event.type === 'MAC_CHANGED') {
    return (event.previousValue || '—') + ' → ' + (event.currentValue || '—');
  }
  if (event.type === 'NEW_DEVICE') {
    return event.currentValue === 'dhcp' ? 'First recorded via DHCP' : 'First observed on the LAN';
  }
  if (event.type === 'DEVICE_OFFLINE') return 'Not observed by ARP in two successful scans';
  if (event.type === 'DEVICE_ONLINE') return 'ARP response detected';
  if (event.type === 'IP_CONFLICT') return 'Multiple MAC addresses detected for this IP';
  if (event.type === 'CONFLICT_RESOLVED') return 'Multiple MAC addresses are no longer detected';
  return 'Lease or reservation identity changed';
}

function SeverityIcon({ severity }: { severity: Severity }) {
  if (severity === 'critical') return <ShieldAlert size={17} aria-hidden="true" />;
  if (severity === 'warning') return <AlertTriangle size={17} aria-hidden="true" />;
  return <Activity size={17} aria-hidden="true" />;
}

function EventList({
  events, devices, onSelectDevice, emptyMessage
}: {
  events: NetworkEvent[];
  devices: Device[];
  onSelectDevice: (mac: string) => void;
  emptyMessage: string;
}) {
  const names = useMemo(() => new Map(devices.map(device => [device.mac, deviceLabel(device)])), [devices]);

  if (events.length === 0) return <div className="empty">{emptyMessage}</div>;

  return <ol className="det-events">
    {events.map(event => {
      const name = event.mac ? names.get(event.mac) : null;
      const canOpen = Boolean(event.mac && name);
      return <li key={event.id} className="det-event">
        <span className={'det-event-icon det-severity-' + event.severity}>
          <SeverityIcon severity={event.severity} />
        </span>
        <div className="det-event-content">
          <div className="det-event-line">
            <strong>{eventLabels[event.type] || event.type}</strong>
            <span className={'det-severity-text det-severity-' + event.severity}>{event.severity}</span>
          </div>
          <p>{eventDetail(event)}</p>
          <div className="det-event-meta">
            {event.mac && (canOpen
              ? <button type="button" className="det-link"
                  onClick={() => onSelectDevice(event.mac as string)}
                  title="View device history">{name} <ArrowRight size={12} aria-hidden="true" /></button>
              : <span className="det-mono">{event.mac}</span>)}
            {event.ip && <span className="det-mono">{event.ip}</span>}
            <time dateTime={event.createdAt}>{formatDate(event.createdAt)}</time>
          </div>
        </div>
      </li>;
    })}
  </ol>;
}

type Props = {
  view: DetectiveView;
  refreshKey: number;
  onNavigate: (view: DetectiveView) => void;
  onOpenLan: () => void;
};

export default function DetectivePage({ view, refreshKey, onNavigate, onOpenLan }: Props) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [events, setEvents] = useState<NetworkEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(false);
  const [lastLoaded, setLastLoaded] = useState<string | null>(null);
  const [localRefresh, setLocalRefresh] = useState(0);

  const [selectedMac, setSelectedMac] = useState<string | null>(null);
  const [selectedEvents, setSelectedEvents] = useState<NetworkEvent[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState(false);

  const [deviceSearch, setDeviceSearch] = useState('');
  const [deviceState, setDeviceState] = useState<FilterState>('all');
  const [eventSearch, setEventSearch] = useState('');
  const [eventSeverity, setEventSeverity] = useState<SeverityFilter>('all');
  const [eventType, setEventType] = useState<EventTypeFilter>('all');

  useEffect(() => {
    let mounted = true;
    let current: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      const controller = new AbortController();
      current = controller;
      try {
        const responses = await Promise.all([
          fetch('/api/network/detective/summary', { signal: controller.signal }),
          fetch('/api/network/devices?limit=500', { signal: controller.signal }),
          fetch('/api/network/events?limit=100', { signal: controller.signal })
        ]);
        if (!responses.every(response => response.ok)) throw new Error('Detective API unavailable');
        const [nextSummary, nextDevices, nextEvents] = await Promise.all([
          responses[0].json() as Promise<Summary>,
          responses[1].json() as Promise<Device[]>,
          responses[2].json() as Promise<NetworkEvent[]>
        ]);
        if (!Array.isArray(nextDevices) || !Array.isArray(nextEvents)) throw new Error('Invalid Detective response');
        if (!mounted || controller.signal.aborted) return;
        setSummary(nextSummary);
        setDevices(nextDevices);
        setEvents(nextEvents);
        setFetchError(false);
        setLastLoaded(new Date().toISOString());
      } catch {
        if (mounted && !controller.signal.aborted) setFetchError(true);
      } finally {
        if (mounted && !controller.signal.aborted) {
          setLoading(false);
          timer = setTimeout(() => { void load(); }, 30_000);
        }
      }
    };
    void load();
    return () => {
      mounted = false;
      current?.abort();
      if (timer) clearTimeout(timer);
    };
  }, [refreshKey, localRefresh]);

  useEffect(() => {
    if (!selectedMac) {
      setSelectedEvents([]);
      setDetailError(false);
      setDetailLoading(false);
      return;
    }
    const controller = new AbortController();
    setDetailLoading(true);
    setDetailError(false);
    setSelectedEvents([]);
    const load = async () => {
      try {
        const response = await fetch(
          '/api/network/devices/' + encodeURIComponent(selectedMac) + '/events?limit=100',
          { signal: controller.signal }
        );
        if (!response.ok) throw new Error('Device history unavailable');
        const data = await response.json() as NetworkEvent[];
        if (!Array.isArray(data)) throw new Error('Invalid device history');
        if (!controller.signal.aborted) setSelectedEvents(data);
      } catch {
        if (!controller.signal.aborted) setDetailError(true);
      } finally {
        if (!controller.signal.aborted) setDetailLoading(false);
      }
    };
    void load();
    return () => controller.abort();
  }, [selectedMac, refreshKey, localRefresh, lastLoaded]);

  const selectedDevice = selectedMac ? devices.find(device => device.mac === selectedMac) : null;

  const filteredDevices = useMemo(() => {
    const query = deviceSearch.trim().toLowerCase();
    return devices.filter(device => {
      if (deviceState !== 'all' && device.state !== deviceState) return false;
      return !query || [
        deviceLabel(device), device.hostname || '', device.mac, device.lastIp,
        device.vendor || '', device.description || '', device.category || ''
      ].join(' ').toLowerCase().includes(query);
    });
  }, [devices, deviceSearch, deviceState]);

  const filteredEvents = useMemo(() => {
    const query = eventSearch.trim().toLowerCase();
    return events.filter(event => {
      if (eventSeverity !== 'all' && event.severity !== eventSeverity) return false;
      if (eventType !== 'all' && event.type !== eventType) return false;
      return !query || [
        eventLabels[event.type] || event.type, event.mac || '', event.ip || '',
        event.previousValue || '', event.currentValue || '',
        devices.find(device => device.mac === event.mac)?.hostname || ''
      ].join(' ').toLowerCase().includes(query);
    });
  }, [devices, eventSearch, eventSeverity, eventType, events]);

  function selectDevice(mac: string): void {
    setSelectedMac(mac);
    onNavigate('devices');
  }

  const state = summary || emptySummary;
  const hasBaseline = state.scans > 0;
  const lastEvents = events.slice(0, 8);
  const recentDevices = [...devices]
    .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))
    .slice(0, 8);

  return <div className="det-page">
    <div className="det-heading">
      <div className="det-intro">
        <span className="det-overline"><Network size={15} aria-hidden="true" /> {state.network}</span>
        <p>Read-only device history and changes recorded by successful LAN scans.</p>
        <span className="det-meta-line">Last scan: {formatDate(state.lastScannedAt)} · {state.scans} successful scans · refresh every 30 s</span>
      </div>
      <div className="det-header-actions">
        <button type="button" className="instance-toggle" onClick={onOpenLan}>LAN inventory <ArrowRight size={14} aria-hidden="true" /></button>
        <button type="button" className="instance-toggle" disabled={loading}
          onClick={() => { setLoading(true); setLocalRefresh(value => value + 1); }}
          aria-label="Refresh Network Detective" title="Refresh Network Detective">
          <RefreshCw size={15} aria-hidden="true" /> Refresh
        </button>
      </div>
    </div>
    {fetchError && <div className="notice" role="alert"><AlertTriangle size={17} aria-hidden="true" />
      Could not refresh Network Detective data. {lastLoaded ? 'Previously loaded data is shown.' : 'Check the backend connection.'}
    </div>}
    {loading && !summary && <div className="empty" role="status">Loading Network Detective…</div>}
    {!loading && !fetchError && !hasBaseline &&
      <div className="det-info" role="status">
        <Clock3 size={18} aria-hidden="true" />
        <span>No successful scan has been recorded yet. Open LAN and run <strong>Scan now</strong> to create the initial baseline; the first scan intentionally generates no events.</span>
      </div>}

    <div className="det-tabs" aria-label="Network Detective sections">
      {([
        ['overview', 'Overview'], ['events', 'Events'], ['devices', 'Devices']
      ] as const).map(([key, label]) =>
        <button key={key} type="button" aria-pressed={view === key}
          className={view === key ? 'det-tab active' : 'det-tab'}
          onClick={() => onNavigate(key)}>{label}</button>
      )}
    </div>

    {view === 'overview' && <>
      <div className="det-metrics" aria-label="Network Detective summary">
        <div className="det-metric"><Server size={19} aria-hidden="true" /><strong>{state.totalDevices}</strong><span>Known devices</span></div>
        <div className="det-metric"><Wifi size={19} aria-hidden="true" /><strong>{state.online}</strong><span>Online (ARP)</span></div>
        <div className="det-metric"><WifiOff size={19} aria-hidden="true" /><strong>{state.offline}</strong><span>Offline</span></div>
        <div className="det-metric"><Laptop2 size={19} aria-hidden="true" /><strong>{state.known}</strong><span>DHCP only</span></div>
        <div className="det-metric"><History size={19} aria-hidden="true" /><strong>{state.events}</strong><span>Recorded changes</span></div>
      </div>
      <p className="det-explainer">Online requires an ARP response. Offline is confirmed after two consecutive successful scans without ARP. DHCP-only devices are listed as known, not online.</p>
      <div className="det-overview-grid">
        <section className="panel det-overview-section">
          <div className="panel-title"><div><h2>Recent network events</h2><p>Latest detected changes</p></div>
            <button type="button" className="text-action" onClick={() => onNavigate('events')}>All recent events →</button>
          </div>
          <EventList events={lastEvents} devices={devices} onSelectDevice={selectDevice}
            emptyMessage={hasBaseline ? 'No changes recorded yet. Events appear after subsequent successful scans detect differences.' : 'Run an initial LAN scan to start detecting changes.'} />
        </section>
        <section className="panel det-overview-section">
          <div className="panel-title"><div><h2>Recently observed devices</h2><p>Most recently recorded</p></div>
            <button type="button" className="text-action" onClick={() => onNavigate('devices')}>View devices →</button>
          </div>
          {recentDevices.length === 0
            ? <div className="empty">No devices recorded yet.</div>
            : <div className="det-recent-devices">{recentDevices.map(device =>
              <button key={device.mac} type="button" className="det-recent-device" onClick={() => selectDevice(device.mac)}>
                <span className="det-device-symbol"><Laptop2 size={17} aria-hidden="true" /></span>
                <span className="det-recent-identity"><strong>{deviceLabel(device)}</strong><small>{device.lastIp} · {device.mac}</small></span>
                <span className={'lan-state det-device-state det-state-' + device.state}>{device.state}</span>
              </button>
            )}</div>}
        </section>
      </div>
    </>}

    {view === 'events' && <section className="panel det-list-panel">
      <div className="panel-title"><div><h2>Event timeline</h2>
        <p>Latest 100 events from SQLite · {state.events} recorded in total</p></div>
      </div>
      <div className="det-toolbar">
        <label className="lan-search det-search"><Search size={16} aria-hidden="true" />
          <span className="sr-only">Search network events</span>
          <input type="search" placeholder="Search event, IP or MAC…" value={eventSearch}
            onChange={event => setEventSearch(event.target.value)} />
        </label>
        <label className="det-select-label">Severity
          <select value={eventSeverity} onChange={event => setEventSeverity(event.target.value as SeverityFilter)}>
            <option value="all">All severities</option>
            <option value="info">Info</option>
            <option value="warning">Warning</option>
            <option value="critical">Critical</option>
          </select>
        </label>
        <label className="det-select-label">Type
          <select value={eventType} onChange={event => setEventType(event.target.value as EventTypeFilter)}>
            <option value="all">All event types</option>
            {eventTypes.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select>
        </label>
      </div>
      <div className="det-count">Showing {filteredEvents.length} of {events.length} most recent events (maximum 100 loaded)</div>
      <EventList events={filteredEvents} devices={devices} onSelectDevice={selectDevice}
        emptyMessage={events.length === 0 ? 'No network changes detected yet. The initial scan is a silent baseline.' : 'No events match the selected filters.'} />
    </section>}

    {view === 'devices' && <>
      <section className="panel det-list-panel">
        <div className="panel-title">
          <div><h2>Device registry</h2><p>MAC identities observed across successful LAN scans</p></div>
          <span className="status neutral">{state.totalDevices} registered</span>
        </div>
        <div className="det-toolbar">
          <label className="lan-search det-search"><Search size={16} aria-hidden="true" />
            <span className="sr-only">Search devices</span>
            <input type="search" placeholder="Search name, MAC, IP or vendor…" value={deviceSearch}
              onChange={event => setDeviceSearch(event.target.value)} />
          </label>
          <div className="lan-filters" aria-label="Filter devices by status">
            {(['all', 'online', 'offline', 'known'] as const).map(key =>
              <button key={key} type="button" aria-pressed={deviceState === key}
                className={deviceState === key ? 'lan-filter active' : 'lan-filter'}
                onClick={() => setDeviceState(key)}>
                {key === 'all' ? 'All' : key === 'known' ? 'DHCP only' : key}
              </button>)}
          </div>
        </div>
        <div className="det-count">Showing {filteredDevices.length} of {devices.length} loaded devices (maximum 500)</div>
        <div className="lan-table-scroll" role="region" aria-label="Discovered network devices" tabIndex={0}>
          <table className="lan-table det-devices-table">
            <thead><tr><th scope="col">Device</th><th scope="col">IP address</th>
              <th scope="col">Status</th><th scope="col">MAC address</th>
              <th scope="col">Last observed</th><th scope="col">History</th></tr></thead>
            <tbody>
              {filteredDevices.map(device => <tr key={device.mac}
                className={selectedMac === device.mac ? 'det-row-selected' : undefined}>
                <td><div className="det-device-cell"><Laptop2 size={16} aria-hidden="true" />
                  <span><strong>{deviceLabel(device)}</strong>
                    <small>{device.vendor || device.description || 'Unknown vendor'}</small>
                  </span></div></td>
                <td className="det-mono">{device.lastIp}</td>
                <td><span className={'lan-state det-device-state det-state-' + device.state}>{device.state}</span></td>
                <td className="det-mono">{device.mac}</td>
                <td><time dateTime={device.lastSeen}>{formatDate(device.lastSeen)}</time></td>
                <td><button className="det-link" type="button" aria-label={'View history for ' + deviceLabel(device)}
                  onClick={() => setSelectedMac(device.mac)}>Details <ArrowRight size={13} aria-hidden="true" /></button></td>
              </tr>)}
              {filteredDevices.length === 0 && <tr><td colSpan={6} className="lan-no-results">
                {devices.length === 0 ? 'No devices recorded yet. Run a LAN scan.' : 'No devices match the filters.'}
              </td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      <section className="panel det-details-panel" aria-label="Selected device details">
        <div className="panel-title">
          <div><h2>Device history</h2><p>Identity, first/last observation and changes</p></div>
          {selectedMac && <button type="button" className="det-clear" aria-label="Close device details"
            onClick={() => setSelectedMac(null)}><X size={17} aria-hidden="true" /> Close</button>}
        </div>
        {!selectedMac && <div className="empty">Select <strong>Details</strong> in the device registry to inspect its history.</div>}
        {selectedMac && !selectedDevice && <div className="empty">This device is not in the loaded registry. Try refreshing.</div>}
        {selectedDevice && <>
          <div className="det-details-heading">
            <div><strong>{deviceLabel(selectedDevice)}</strong><span className="det-mono">{selectedDevice.mac}</span></div>
            <span className={'lan-state det-device-state det-state-' + selectedDevice.state}>{selectedDevice.state}</span>
          </div>
          <dl className="det-device-facts">
            <div><dt>Last IP address</dt><dd>{selectedDevice.lastIp}</dd></div>
            <div><dt>Hostname</dt><dd>{selectedDevice.hostname || '—'}</dd></div>
            <div><dt>Vendor</dt><dd>{selectedDevice.vendor || '—'}</dd></div>
            <div><dt>Description</dt><dd>{selectedDevice.description || '—'}</dd></div>
            <div><dt>First seen</dt><dd>{formatDate(selectedDevice.firstSeen)}</dd></div>
            <div><dt>Last recorded</dt><dd>{formatDate(selectedDevice.lastSeen)}</dd></div>
            <div><dt>Last ARP response</dt><dd>{formatDate(selectedDevice.lastArpSeen)}</dd></div>
            <div><dt>Missed ARP scans</dt><dd>{selectedDevice.missedScans}</dd></div>
          </dl>
          <h3 className="det-subtitle"><History size={17} aria-hidden="true" /> Changes for this device</h3>
          {detailLoading && <div className="empty" role="status">Loading device history…</div>}
          {detailError && <div className="notice" role="alert"><AlertTriangle size={17} aria-hidden="true" /> Could not load device history. Try refreshing.</div>}
          {!detailLoading && !detailError && <EventList events={selectedEvents} devices={devices}
            onSelectDevice={selectDevice} emptyMessage="No changes recorded for this device yet." />}
          <p className="det-note">History contains the latest 100 matching events. IP-wide conflicts without a MAC association appear in the overall Events timeline.</p>
        </>}
      </section>
    </>}
    {lastLoaded && <p className="det-footer-note">Dashboard data last refreshed {formatDate(lastLoaded)}. Changes are retained in SQLite on this installation.</p>}
  </div>;
}
