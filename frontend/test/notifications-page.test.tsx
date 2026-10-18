import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { test } from 'node:test';
import NotificationsPage from '../src/NotificationsPage.js';

test('notifications page shows disabled-safe, read-only status and history regions', () => {
  const html = renderToStaticMarkup(
    createElement(NotificationsPage, { refreshKey: 0 })
  );
  assert.match(html, /Network notifications/);
  assert.match(html, /Internal Pushover Proxy/);
  assert.match(html, /aria-pressed="true"[^>]*>Pushover/);
  assert.match(html, /aria-pressed="false"[^>]*>Discord/);
  assert.match(html, /Notification delivery channel/);
  assert.match(html, /Loading notification status/);
  assert.match(html, /Waiting \/ retrying/);
  assert.match(html, /Accepted by proxy/);
  assert.match(html, /Suppressed/);
  assert.match(html, /Notification history/);
  assert.match(html, /Search notification history/);
  assert.match(html, /All outcomes/);
  assert.match(html, /does not guarantee delivery to a phone/);
});
