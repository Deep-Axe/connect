import { describe, expect, it } from 'vitest';

import {
  VIEWS, anonymizedPath, buildUrl, driveBase, isSafeReturnUrl, locationOfUrl, parseLocation,
} from './codec';
import { quantizeRange } from './navigate';

const D = '0000aaaa0000aaaa';
const LOG = '2026-08-06--12-00-00';
const HEX_LOG = '000000dd--455f14369d';

const parse = (url) => parseLocation(locationOfUrl(url));
const base = (url) => parse(url).base;

describe('parseLocation', () => {
  it.each([
    ['/', { view: VIEWS.ROOT, dongleId: null }],
    ['/referrals', { view: VIEWS.REFERRALS, dongleId: null }],
    [`/${D}`, { view: VIEWS.DASHBOARD, dongleId: D }],
    [`/${D}/prime`, { view: VIEWS.PRIME, dongleId: D }],
    [`/${D}/stream`, { view: VIEWS.STREAM, dongleId: D }],
    [`/${D}/${LOG}`, { view: VIEWS.DRIVE, dongleId: D, drive: { logId: LOG, start: null, end: null } }],
    [`/${D}/${HEX_LOG}`, { view: VIEWS.DRIVE, drive: { logId: HEX_LOG, start: null, end: null } }],
    [`/${D}/${LOG}/556/610`, { view: VIEWS.DRIVE, drive: { logId: LOG, start: 556000, end: 610000 } }],
    [`/${D}/${LOG}/0/20`, { view: VIEWS.DRIVE, drive: { logId: LOG, start: 0, end: 20000 } }],
    [`/${D}/1000/2000`, { view: VIEWS.LEGACY_RANGE, dongleId: D, legacyRange: { start: 1000, end: 2000 } }],
    ['/demo', { view: VIEWS.DASHBOARD, dongleId: 'deadbeefdeadbeef' }],
    ['/auth/?code=x&provider=g', { view: VIEWS.AUTH }],
  ])('%s', (url, expected) => {
    expect(base(url)).toMatchObject(expected);
  });

  it.each([
    [`/prefix${D}suffix`, 'unknown-path'],
    [`/not-a-device/${LOG}`, 'unknown-path'],
    [`/${D}/prime/extra`, 'unknown-path'],
    [`/${D}/${LOG}/10`, 'unknown-path'],
    [`/${D}/${LOG}/10/20/extra`, 'unknown-path'],
    [`/${D}/${LOG}/20/10`, 'invalid-range'],
    [`/${D}/${LOG}/10/10`, 'invalid-range'],
    [`/${D}/${LOG}/-1/10`, 'invalid-range'],
    [`/${D}/${LOG}/1.5/10`, 'invalid-range'],
    [`/${D}/${LOG}/0/9007199254740991`, 'invalid-range'], // safe seconds, unsafe milliseconds
    [`/${D}/1/Infinity`, 'unknown-path'],
    [`/${D}/abc/def`, 'unknown-path'],
    [`/${D}/2000/1000`, 'invalid-range'],
    ['/nonsense/abc/def', 'unknown-path'],
    [`/${D}//prime`, 'malformed-path'],
    [`/${D}/%E0%A4%A`, 'malformed-path'],
  ])('%s is invalid (%s)', (url, reason) => {
    expect(base(url)).toMatchObject({ view: VIEWS.INVALID, reason });
  });

  it('separates commands from extensions and keeps extension order', () => {
    const location = parse(`/${D}?ci=1&pair=tok&b=2&a=1&b=3#frag`);
    expect(location.commands).toEqual({ pair: 'tok' });
    expect(location.extensions).toEqual([['ci', '1'], ['b', '2'], ['a', '1'], ['b', '3']]);
    expect(location.hash).toBe('#frag');
  });

  it('rejects a duplicated command and keeps none of its commands', () => {
    expect(base(`/${D}?r=/a&r=/b`)).toMatchObject({ view: VIEWS.INVALID, reason: 'duplicate-query-key' });
    expect(parse(`/${D}?r=/a&r=/b&pair=x`).commands).toEqual({});
  });

  it('reads auth callback arguments only on the auth path', () => {
    expect(parse('/auth/?code=c&provider=p').commands).toEqual({ code: 'c', provider: 'p' });
    expect(parse(`/${D}?code=c`).extensions).toEqual([['code', 'c']]);
  });
});

describe('buildUrl', () => {
  it.each([
    '/',
    '/referrals',
    `/${D}`,
    `/${D}/prime`,
    `/${D}/stream`,
    `/${D}/${LOG}`,
    `/${D}/${LOG}/0/20`,
    `/${D}/${LOG}/556/610`,
    `/${D}/1000/2000`,
    `/${D}/${LOG}/10/20?pair=tok&ci=1#frag`,
  ])('round-trips %s', (url) => {
    expect(buildUrl(parse(url))).toBe(url);
    expect(parse(buildUrl(parse(url)))).toEqual(parse(url));
  });

  it.each([
    [`/${D}/`, `/${D}`],
    [`/${D}/${LOG}/010/020`, `/${D}/${LOG}/10/20`],
    ['/demo', '/deadbeefdeadbeef'],
  ])('canonicalizes %s to %s', (url, canonical) => {
    expect(buildUrl(parse(url))).toBe(canonical);
  });

  it('has no canonical form for auth or invalid locations', () => {
    expect(buildUrl(parse('/auth/?code=x'))).toBeNull();
    expect(buildUrl(parse('/nonsense'))).toBeNull();
  });

  it('refuses invalid destinations', () => {
    expect(() => buildUrl({ base: driveBase('bad', LOG), commands: {}, extensions: [] })).toThrow('invalid dongle id');
    expect(() => buildUrl({ base: driveBase(D, LOG, 1500, 3000), commands: {}, extensions: [] })).toThrow('invalid drive range');
    expect(() => buildUrl({ base: driveBase(D, LOG, 3000, 1000), commands: {}, extensions: [] })).toThrow('invalid drive range');
  });
});

describe('quantizeRange', () => {
  it.each([
    [[1234, 5678], { start: 1000, end: 6000 }],
    [[0, 20000], { start: 0, end: 20000 }],
    [[1200, 1800], { start: 1000, end: 2000 }],
    [[999, 1000], { start: 0, end: 1000 }],
  ])('rounds %j outward to whole seconds', (args, expected) => {
    expect(quantizeRange(...args)).toEqual(expected);
  });

  it.each([[[5, 5]], [[10, 5]], [[-1, 5]], [[0, NaN]], [[0, Infinity]]])('rejects %j', (args) => {
    expect(quantizeRange(...args)).toBeNull();
  });
});

describe('return targets and analytics', () => {
  it.each([
    [`/${D}/${LOG}?x=1#h`, true],
    ['/', true],
    ['//evil.example.com/x', false],
    ['/\\evil.example.com', false],
    ['https://evil.example.com', false],
    ['javascript:alert(1)', false],
    [null, false],
  ])('isSafeReturnUrl(%s)', (url, expected) => {
    expect(isSafeReturnUrl(url)).toBe(expected);
  });

  it.each([
    [`/${D}`, '/<dongleId>'],
    [`/${D}/${LOG}`, '/<dongleId>/<logId>'],
    [`/${D}/${LOG}/10/20`, '/<dongleId>/<logId>/<zoomStart>/<zoomEnd>'],
    [`/${D}/1000/2000`, '/<dongleId>/<zoomStart>/<zoomEnd>'],
    ['/', ''],
  ])('anonymizes %s', (url, expected) => {
    expect(anonymizedPath(parse(url))).toBe(expected);
  });
});

describe('modals', () => {
  const B = '1111bbbb1111bbbb';
  const modal = (url) => parse(url).modal;

  it.each([
    [`/${D}/settings`, { view: VIEWS.DASHBOARD, dongleId: D }, { kind: 'settings', dongleId: D, panel: null }],
    [`/${D}/settings/uploads`, { view: VIEWS.DASHBOARD }, { kind: 'settings', dongleId: D, panel: 'uploads' }],
    [`/${D}/${LOG}/10/20?modal=settings&modalDevice=${B}`, { view: VIEWS.DRIVE, drive: { start: 10000 } }, { kind: 'settings', dongleId: B }],
    [`/${D}/${LOG}?modal=settings&panel=uploads`, { view: VIEWS.DRIVE }, { kind: 'settings', dongleId: D, panel: 'uploads' }],
    [`/referrals?modal=settings&modalDevice=${B}`, { view: VIEWS.REFERRALS }, { kind: 'settings', dongleId: B }],
    ['/devices/add', { view: VIEWS.ROOT }, { kind: 'add-device', dongleId: null }],
    [`/${D}/${LOG}?modal=add-device`, { view: VIEWS.DRIVE }, { kind: 'add-device' }],
    [`/${D}/clips`, { view: VIEWS.DASHBOARD }, { kind: 'clips', dongleId: D, clip: null }],
    [`/${D}/clips?clip=a.mp4&clipRequestedAt=1700000000`, { view: VIEWS.DASHBOARD },
      { kind: 'clips', clip: { filename: 'a.mp4', requestedAt: '1700000000' } }],
    [`/${D}/clips?clip=a.mp4`, { view: VIEWS.DASHBOARD }, { kind: 'clips', clip: { filename: 'a.mp4', requestedAt: null } }],
    [`/${D}/${LOG}?modal=clips&modalDevice=${B}`, { view: VIEWS.DRIVE }, { kind: 'clips', dongleId: B }],
    [`/${D}/prime/cancel`, { view: VIEWS.PRIME }, { kind: 'cancel', dongleId: D }],
    [`/${D}/prime/change-plan`, { view: VIEWS.PRIME }, { kind: 'change-plan', dongleId: D }],
  ])('%s', (url, expectedBase, expectedModal) => {
    expect(base(url)).toMatchObject(expectedBase);
    expect(modal(url)).toMatchObject(expectedModal);
  });

  it.each([
    `/${D}/settings`,
    `/${D}/settings/uploads`,
    `/${D}/${LOG}/10/20?modal=settings&modalDevice=${B}`,
    `/${D}/${LOG}?modal=settings&panel=uploads`,
    `/referrals?modal=settings&modalDevice=${B}`,
    '/devices/add',
    `/${D}?modal=add-device&ci=1#x`,
    `/${D}/clips?clip=a+b.mp4&clipRequestedAt=1700000000.25`,
    `/${D}/${LOG}?modal=clips&modalDevice=${B}&clip=a.mp4&clipRequestedAt=5`,
    `/${D}/prime/cancel`,
    `/${D}/prime/change-plan`,
  ])('round-trips %s', (url) => {
    expect(buildUrl(parse(url))).toBe(url);
  });

  it.each([
    [`/${D}?modal=settings`, `/${D}/settings`],
    [`/${D}?modal=settings&modalDevice=${D}&panel=uploads`, `/${D}/settings/uploads`],
    [`/${D}?modal=clips`, `/${D}/clips`],
    ['/?modal=add-device', '/devices/add'],
    [`/${D}/prime?modal=cancel`, `/${D}/prime/cancel`],
  ])('canonicalizes %s to its direct path %s', (url, canonical) => {
    expect(buildUrl(parse(url))).toBe(canonical);
  });

  it.each([
    [`/${D}/stream?modal=settings`, 'stream takes no overlay'],
    [`/${D}/${LOG}?modal=cancel`, 'Prime subflows only on Prime'],
    [`/${D}/prime/cancel?modal=settings`, 'two modals'],
    [`/${D}?modal=unknown`, 'unknown modal'],
    [`/${D}?panel=uploads`, 'panel without a modal'],
    [`/${D}?modal=clips&panel=uploads`, 'panel on the wrong modal'],
    [`/${D}?modal=settings&panel=nope`, 'unknown panel'],
    [`/${D}?modal=settings&modalDevice=nope`, 'invalid target device'],
    ['/referrals?modal=settings', 'settings with no device to target'],
    ['/referrals?modal=clips', 'clips over a page without drives'],
    [`/${D}?modal=add-device&modalDevice=${B}`, 'add-device has no target device'],
    [`/${D}/clips?clipRequestedAt=5`, 'version without a clip'],
    [`/${D}/clips?clip=../x`, 'path separator in a clip name'],
    [`/${D}/clips?clip=..`, 'dot-only clip name'],
    [`/${D}/clips?clip=a%0Ab`, 'control character in a clip name'],
    [`/${D}/clips?clip=a&clipRequestedAt=`, 'empty version'],
    [`/${D}?modal=settings&modal=clips`, 'duplicate modal key'],
    [`/${D}/settings/other`, 'unknown settings panel path'],
  ])('%s is invalid (%s)', (url) => {
    expect(base(url).view).toBe(VIEWS.INVALID);
    expect(modal(url)).toBeNull();
  });

  it('treats %20 and + as the same clip name', () => {
    expect(parse(`/${D}/clips?clip=a%20b.mp4`)).toEqual(parse(`/${D}/clips?clip=a+b.mp4`));
  });

  it('keeps an existing clip filename exactly as given', () => {
    expect(modal(`/${D}/clips?clip=My%20Clip.MP4`).clip.filename).toBe('My Clip.MP4');
  });
});
