import { afterEach, expect, it, vi } from 'vitest';
import { request, auth } from './api';
import { createRoutingServices } from './routing/services';
import { endSession } from './actions/session';

afterEach(() => vi.unstubAllGlobals());

it('old authenticated HTTP failure never invokes replacement-session callback', async () => {
  let complete;
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise((r) => (complete = r))),
  );
  const old = vi.fn(),
    current = vi.fn();
  request.configure('old-token', old);
  const pending = request.get('audit-probe');
  request.configure('new-token', current);
  complete(new Response('{}', { status: 401 }));
  await pending;
  expect(current).not.toHaveBeenCalled();
  expect(old).not.toHaveBeenCalled();
});

it('logout invalidates history provenance from the prior session', () => {
  const services = createRoutingServices();
  const parent = { pathname: '/aaaaaaaaaaaaaaaa', key: 'parent' };
  const child = {
    pathname: '/aaaaaaaaaaaaaaaa/prime',
    key: 'child',
    state: { parent: { key: 'parent', url: '/aaaaaaaaaaaaaaaa' } },
  };
  services.history.observe(parent, 'POP');
  services.history.observe(child, 'PUSH');
  expect(services.history.verifiedParentUrl(child)).toBe('/aaaaaaaaaaaaaaaa');
  endSession()(vi.fn(), () => ({ sessionEpoch: 0 }), services);
  expect(services.history.verifiedParentUrl(child)).toBeNull();
});

it('configure(null) removes credentials before the next request', async () => {
  const fetch = vi.fn(async () => new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  request.configure('private-token', vi.fn());
  request.configure(null);
  await request.get('clear-test');
  expect(fetch.mock.calls[0][1].headers.Authorization).toBeUndefined();
});

it('a superseded auth exchange cannot restore cleared credentials', async () => {
  let complete;
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise((r) => (complete = r))),
  );
  request.configure(null);
  const pending = auth.refreshAccessToken('old-code', 'h');
  request.configure(null);
  complete(new Response('{"access_token":"old-token"}', { status: 200 }));
  expect(await pending).toBeNull();
  expect(request.headers.Authorization).toBeUndefined();
});
