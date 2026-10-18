import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Bell, CheckCircle2, Clock3, RefreshCw, Search, ShieldOff } from 'lucide-react';

type NotificationChannel = 'pushover' | 'discord';
type NotificationState = 'pending' | 'sending' | 'retry' | 'accepted' | 'failed' | 'suppressed';
type NotificationStatus = {
  enabled: boolean;
  configured: boolean;
  state: 'disabled' | 'ready' | 'error';
  provider: 'internal_pushover_proxy' | 'internal_discord_proxy';
  channel?: NotificationChannel;
  eventTypes: string[];
  cooldownMinutes: number;
  counts: { pending: number; retry: number; accepted: number; failed: number; suppressed: number };
  lastAttemptAt: string | null;
  message?: string;
};
type NotificationRecord = {
  id: number; eventId: number; network: string; type: string;
  severity: string; mac: string | null; ip: string | null;
  state: NotificationState; attempts: number; reason: string | null;
  createdAt: string; lastAttemptAt: string | null;
  nextAttemptAt: string | null; acceptedAt: string | null;
};

const labels: Record<string, string> = {
  NEW_DEVICE: 'New device',
  DEVICE_ONLINE: 'Device online',
  DEVICE_OFFLINE: 'Device offline',
  IP_CHANGED: 'IP changed',
  MAC_CHANGED: 'MAC changed',
  IP_CONFLICT: 'IP conflict',
  CONFLICT_RESOLVED: 'Conflict resolved',
  DHCP_CHANGED: 'DHCP changed'
};
const stateLabels: Record<NotificationState, string> = {
  pending: 'Queued',
  sending: 'Sending',
  retry: 'Retrying',
  accepted: 'Accepted by proxy',
  failed: 'Failed',
  suppressed: 'Suppressed'
};
const reasons: Record<string, string> = {
  cooldown: 'Duplicate within cooldown',
  burst_limit: 'Too many alerts in one scan',
  temporarily_unavailable: 'Proxy temporarily unavailable',
  retry_exhausted: 'Maximum retry attempts reached',
  invalid_message: 'Proxy rejected the message (HTTP 422)',
  proxy_rejected: 'Proxy rejected the request',
  interrupted: 'Previous send interrupted'
};

function displayTime(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString();
}

type Filter = 'all' | NotificationState;

export default function NotificationsPage({ refreshKey }: { refreshKey: number }) {
  const [channel, setChannel] = useState<NotificationChannel>('pushover');
  const [status, setStatus] = useState<NotificationStatus | null>(null);
  const [history, setHistory] = useState<NotificationRecord[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState(false);
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);
  const [localRefresh, setLocalRefresh] = useState(0);
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');

  useEffect(() => {
    setStatus(null);
    setHistory([]);
    setBusy(true);
    setError(false);
    setRefreshedAt(null);
    let mounted = true;
    let controller: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      controller?.abort();
      const active = new AbortController();
      controller = active;
      try {
        const endpoint = channel === 'discord' ? '/api/notifications/discord' : '/api/notifications';
        const responses = await Promise.all([
          fetch(endpoint + '/status', { signal: active.signal }),
          fetch(endpoint + '/history?limit=100', { signal: active.signal })
        ]);
        if (!responses.every(response => response.ok)) throw new Error('Notifications API unavailable');
        const [nextStatus, nextHistory] = await Promise.all([
          responses[0].json() as Promise<NotificationStatus>,
          responses[1].json() as Promise<NotificationRecord[]>
        ]);
        if (!Array.isArray(nextHistory)) throw new Error('Invalid notification history');
        if (!mounted || active.signal.aborted) return;
        setStatus(nextStatus);
        setHistory(nextHistory);
        setError(false);
        setRefreshedAt(new Date().toISOString());
      } catch {
        if (mounted && !active.signal.aborted) setError(true);
      } finally {
        if (mounted && !active.signal.aborted) {
          setBusy(false);
          timer = setTimeout(() => { void load(); }, 30_000);
        }
      }
    };
    void load();
    return () => { mounted = false; controller?.abort(); if (timer) clearTimeout(timer); };
  }, [refreshKey, localRefresh, channel]);

  const shown = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return history.filter(entry => {
      if (filter !== 'all' && entry.state !== filter) return false;
      if (!needle) return true;
      return [
        labels[entry.type] || entry.type, entry.mac || '', entry.ip || '',
        stateLabels[entry.state], reasons[entry.reason || ''] || entry.reason || ''
      ].join(' ').toLowerCase().includes(needle);
    });
  }, [history, filter, search]);

  const counts = status?.counts || { pending: 0, retry: 0, accepted: 0, failed: 0, suppressed: 0 };

  return <div className="notifications-page">
    <div className="det-tabs notification-channel-tabs" aria-label="Notification delivery channel">
      {(['pushover', 'discord'] as const).map(item =>
        <button type="button" key={item} className={channel === item ? 'det-tab active' : 'det-tab'}
          aria-pressed={channel === item} onClick={() => { setChannel(item); setFilter('all'); setSearch(''); }}>
          {item === 'pushover' ? 'Pushover' : 'Discord'}
        </button>
      )}
    </div>
    <section className="panel">
      <div className="panel-title">
        <div><h2><Bell size={18} aria-hidden="true" /> Network notifications</h2>
          <p>Internal {channel === 'discord' ? 'Discord' : 'Pushover'} Proxy · read-only queue and attempt history</p>
        </div>
        <div className="lan-header-actions">
          <button type="button" className="instance-toggle" disabled={busy}
            onClick={() => { setBusy(true); setLocalRefresh(value => value + 1); }}>
            <RefreshCw size={15} aria-hidden="true" /> Refresh
          </button>
          <span className={'status ' + (status?.state === 'ready' ? 'good' : status?.state === 'error' ? 'bad' : 'neutral')}>
            {status?.state || 'Loading'}
          </span>
        </div>
      </div>

      {error && <div className="notice" role="alert"><AlertTriangle size={17} aria-hidden="true" />
        Could not refresh notification data. {refreshedAt ? 'Previously loaded data is shown.' : 'Check the backend.'}
      </div>}
      {busy && !status && <div className="empty" role="status">Loading notification status…</div>}
      {status?.state === 'disabled' && <div className="det-info" role="status">
        <ShieldOff size={19} aria-hidden="true" />
        <span>Automatic notifications are disabled. Set <code>{channel === 'discord' ? 'NETWORK_DISCORD_NOTIFICATIONS_ENABLED' : 'NETWORK_NOTIFICATIONS_ENABLED'}=true</code>
          in the server's local .env file to enable them. No notifications will be sent until then.</span>
      </div>}
      {status?.message && <div className="notice" role="alert"><AlertTriangle size={17} aria-hidden="true" /> {status.message}</div>}

      <div className="notification-metrics" aria-label="Notification queue totals">
        <div className="notification-metric"><strong>{counts.pending + counts.retry}</strong><span>Waiting / retrying</span></div>
        <div className="notification-metric"><strong>{counts.accepted}</strong><span>Accepted by proxy</span></div>
        <div className="notification-metric"><strong>{counts.failed}</strong><span>Failed</span></div>
        <div className="notification-metric"><strong>{counts.suppressed}</strong><span>Suppressed</span></div>
      </div>

      <div className="notification-config">
        <div><span>Enabled event types</span><strong>{status?.eventTypes.join(', ') || 'None'}</strong></div>
        <div><span>Duplicate cooldown</span><strong>{status?.cooldownMinutes ?? '—'} minutes</strong></div>
        <div><span>Last proxy attempt</span><strong>{displayTime(status?.lastAttemptAt || null)}</strong></div>
      </div>
      <p className="det-note">HTTP 200 means the internal proxy accepted the request;
        it does not guarantee {channel === 'discord' ? 'that Discord displayed the message' : 'delivery to a phone'}.
        Each channel has an independent SQLite queue with at most 3 requests in 10 minutes.
        Both channels are configured separately in the server's .env file.</p>
    </section>

    <section className="panel">
      <div className="panel-title">
        <div><h2><Clock3 size={18} aria-hidden="true" /> Notification history</h2>
          <p>Latest 100 queued, accepted, failed and suppressed {channel === 'discord' ? 'Discord' : 'Pushover'} alerts</p>
        </div>
        <span className="status neutral">{history.length} loaded</span>
      </div>
      <div className="det-toolbar">
        <label className="lan-search det-search"><Search size={16} aria-hidden="true" />
          <span className="sr-only">Search notification history</span>
          <input type="search" value={search} onChange={event => setSearch(event.target.value)}
            placeholder="Search event, IP, MAC or outcome…" />
        </label>
        <label className="det-select-label">Outcome
          <select value={filter} onChange={event => setFilter(event.target.value as Filter)}>
            <option value="all">All outcomes</option>
            {(['pending', 'sending', 'retry', 'accepted', 'failed', 'suppressed'] as const).map(value =>
              <option key={value} value={value}>{stateLabels[value]}</option>)}
          </select>
        </label>
      </div>
      <div className="det-count">Showing {shown.length} of {history.length} loaded entries</div>
      <div className="lan-table-scroll" role="region" aria-label="Notification attempt history" tabIndex={0}>
        <table className="lan-table notification-table">
          <thead><tr>
            <th scope="col">Event</th><th scope="col">Device / IP</th>
            <th scope="col">Outcome</th><th scope="col">Attempts</th>
            <th scope="col">Time / next attempt</th>
          </tr></thead>
          <tbody>
            {shown.map(entry => <tr key={entry.id}>
              <td><div className="notification-event-name">
                {entry.state === 'accepted'
                  ? <CheckCircle2 size={15} aria-hidden="true" />
                  : <Bell size={15} aria-hidden="true" />}
                <strong>{labels[entry.type] || entry.type}</strong>
              </div></td>
              <td><div className="notification-identity">
                <strong>{entry.ip || '—'}</strong><span>{entry.mac || '—'}</span>
              </div></td>
              <td><span className={'notification-state notification-state-' + entry.state}>
                {stateLabels[entry.state]}</span>
                {entry.reason && <small className="notification-reason">{reasons[entry.reason] || entry.reason}</small>}
              </td>
              <td>{entry.attempts}</td>
              <td><div className="notification-identity">
                <strong>{displayTime(entry.lastAttemptAt || entry.createdAt)}</strong>
                {entry.nextAttemptAt && <span>Next attempt: {displayTime(entry.nextAttemptAt)}</span>}
              </div></td>
            </tr>)}
            {shown.length === 0 && <tr><td colSpan={5} className="lan-no-results">
              {history.length === 0
                ? 'No notifications recorded yet. The initial LAN scan is a silent baseline.'
                : 'No notification attempts match the filters.'}
            </td></tr>}
          </tbody>
        </table>
      </div>
    </section>
    {refreshedAt && <p className="det-footer-note">Last refreshed {displayTime(refreshedAt)} · automatically every 30 seconds</p>}
  </div>;
}
