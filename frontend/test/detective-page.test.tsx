import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { test } from 'node:test';
import DetectivePage, { type DetectiveView } from '../src/DetectivePage.js';

function render(view: DetectiveView): string {
  return renderToStaticMarkup(createElement(DetectivePage, {
    view, refreshKey: 0, onNavigate: () => {}, onOpenLan: () => {}
  }));
}

test('Detective overview renders a safe initial loading state and summary labels', () => {
  const html = render('overview');
  assert.match(html, /Loading Network Detective/);
  assert.match(html, /Known devices/);
  assert.match(html, /Online \(ARP\)/);
  assert.match(html, /DHCP only/);
  assert.match(html, /Recorded changes/);
  assert.match(html, /Recent network events/);
  assert.match(html, /Recently observed devices/);
  assert.match(html, /aria-pressed="true"[^>]*>Overview/);
});

test('Event timeline has accessible search and severity/type filters', () => {
  const html = render('events');
  assert.match(html, /Event timeline/);
  assert.match(html, /Search network events/);
  assert.match(html, /All severities/);
  assert.match(html, /All event types/);
  assert.match(html, /IP conflict detected/);
  assert.match(html, /maximum 100 loaded/);
  assert.match(html, /aria-pressed="true"[^>]*>Events/);
});

test('Device registry and history inspector are available as read-only views', () => {
  const html = render('devices');
  assert.match(html, /Device registry/);
  assert.match(html, /Search devices/);
  assert.match(html, /Filter devices by status/);
  assert.match(html, /DHCP only/);
  assert.match(html, /Selected device details/);
  assert.match(html, /Select.*Details.*device registry/);
  assert.match(html, /aria-pressed="true"[^>]*>Devices/);
});
