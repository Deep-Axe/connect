// The URL grammar. This is the only module that knows URL shapes: everything
// else asks it to parse a location into a destination or build one back.
//
// A parsed location is
//   { base, modal, commands, extensions, hash }
// where `base` is the page being shown:
//   { view, dongleId, drive, legacyRange, reason }
// and drive bounds are milliseconds relative to the route start, always
// whole seconds (the URL carries seconds). `modal` is the task dialog open
// over that page, or null:
//   { kind, dongleId, panel, clip: { filename, requestedAt } | null }
// A modal has a direct path (/:d/settings) and a contextual query form
// (?modal=settings&modalDevice=B) over another page; both decode to the
// same { base, modal }. `commands` are one-shot query arguments consumed by
// services (pair, r, stripe, auth); `extensions` are unknown query
// arguments preserved in order but never executed.

import { DEMO_DONGLE_ID } from '../api/demo';
import { config as AuthConfig } from '@commaai/my-comma-auth';

export const DONGLE_ID_RE = /^[0-9a-f]{16}$/;
export const LOG_ID_RE = /^[0-9a-f-]{20}$/;
const UINT_RE = /^\d+$/;

export const VIEWS = Object.freeze({
  ROOT: 'root',
  DASHBOARD: 'dashboard',
  DRIVE: 'drive',
  PRIME: 'prime',
  STREAM: 'stream',
  REFERRALS: 'referrals',
  LEGACY_RANGE: 'legacyRange',
  AUTH: 'auth',
  INVALID: 'invalid',
});

export const MODALS = Object.freeze({
  SETTINGS: 'settings',
  ADD_DEVICE: 'add-device',
  CLIPS: 'clips',
  PRIME_CANCEL: 'cancel',
  PRIME_CHANGE_PLAN: 'change-plan',
});

export const SETTINGS_PANELS = ['uploads'];

// pages each modal may open over; stream never takes an overlay
const MODAL_BASES = {
  [MODALS.SETTINGS]: [VIEWS.ROOT, VIEWS.DASHBOARD, VIEWS.DRIVE, VIEWS.PRIME, VIEWS.REFERRALS],
  [MODALS.ADD_DEVICE]: [VIEWS.ROOT, VIEWS.DASHBOARD, VIEWS.DRIVE, VIEWS.PRIME, VIEWS.REFERRALS],
  [MODALS.CLIPS]: [VIEWS.DASHBOARD, VIEWS.DRIVE],
  [MODALS.PRIME_CANCEL]: [VIEWS.PRIME],
  [MODALS.PRIME_CHANGE_PLAN]: [VIEWS.PRIME],
};

// modal query arguments, each a singleton
const MODAL_KEYS = ['modal', 'modalDevice', 'panel', 'clip', 'clipRequestedAt'];

// one-shot query arguments, each a singleton
const COMMAND_KEYS = ['pair', 'r', 'stripe_success', 'stripe_cancelled'];
// auth callback arguments, only meaningful on the auth path
const AUTH_KEYS = ['code', 'provider', 'state'];
// extension arguments that survive navigation to a different page
export const GLOBAL_EXTENSION_KEYS = ['ci'];

const emptyBase = (view) => ({ view, dongleId: null, drive: null, legacyRange: null, reason: null });

export const invalidBase = (reason) => ({ ...emptyBase(VIEWS.INVALID), reason });

export function rootBase() {
  return emptyBase(VIEWS.ROOT);
}

export function referralsBase() {
  return emptyBase(VIEWS.REFERRALS);
}

export function deviceBase(view, dongleId) {
  return { ...emptyBase(view), dongleId };
}

export function driveBase(dongleId, logId, start = null, end = null) {
  return { ...emptyBase(VIEWS.DRIVE), dongleId, drive: { logId, start, end } };
}

export function modalOf(kind, { dongleId = null, panel = null, clip = null } = {}) {
  return { kind, dongleId, panel, clip };
}

function secondsToMillis(start, end) {
  if (!UINT_RE.test(start) || !UINT_RE.test(end)) return null;
  const startMs = Number(start) * 1000;
  const endMs = Number(end) * 1000;
  if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || endMs <= startMs) return null;
  return { start: startMs, end: endMs };
}

function legacyMillis(start, end) {
  if (!UINT_RE.test(start) || !UINT_RE.test(end)) return null;
  const startMs = Number(start);
  const endMs = Number(end);
  if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || endMs <= startMs) return null;
  return { start: startMs, end: endMs };
}

function splitPath(pathname) {
  const raw = (pathname || '/').split('/').slice(1);
  if (raw.length > 1 && raw[raw.length - 1] === '') raw.pop(); // trailing slash, normalized by the builder
  if (raw.length === 1 && raw[0] === '') return [];
  if (raw.some((part) => part === '')) return null;
  try {
    return raw.map((part) => decodeURIComponent(part));
  } catch {
    return null;
  }
}

// direct modal paths: the page underneath plus the modal
function parseModalPath(parts) {
  const [first, second, third] = parts;
  const n = parts.length;
  if (n === 2 && first === 'devices' && second === 'add') {
    return { base: rootBase(), modal: modalOf(MODALS.ADD_DEVICE) };
  }
  if (!DONGLE_ID_RE.test(first)) return null;
  const dashboard = deviceBase(VIEWS.DASHBOARD, first);
  if (second === 'settings' && (n === 2 || (n === 3 && SETTINGS_PANELS.includes(third)))) {
    return { base: dashboard, modal: modalOf(MODALS.SETTINGS, { dongleId: first, panel: third ?? null }) };
  }
  if (n === 2 && second === 'clips') {
    return { base: dashboard, modal: modalOf(MODALS.CLIPS, { dongleId: first }) };
  }
  if (n === 3 && second === 'prime' && (third === MODALS.PRIME_CANCEL || third === MODALS.PRIME_CHANGE_PLAN)) {
    return { base: deviceBase(VIEWS.PRIME, first), modal: modalOf(third, { dongleId: first }) };
  }
  return null;
}

function parseBase(parts, pathname) {
  if (parts === null) return invalidBase('malformed-path');
  const [first, second, third, fourth] = parts;
  const n = parts.length;

  if (n === 0) return rootBase();
  const callbackPaths = [AuthConfig.AUTH_PATH, AuthConfig.APPLE_REDIRECT_PATH]
    .filter(Boolean)
    .map((path) => path.replace(/\/$/, ''));
  if (callbackPaths.includes(pathname.replace(/\/$/, ''))) return emptyBase(VIEWS.AUTH);
  if (n === 1 && first === 'referrals') return referralsBase();
  if (n === 1 && first === 'demo') return deviceBase(VIEWS.DASHBOARD, DEMO_DONGLE_ID);
  if (!DONGLE_ID_RE.test(first)) return invalidBase('unknown-path');

  if (n === 1) return deviceBase(VIEWS.DASHBOARD, first);
  if (n === 2 && second === 'prime') return deviceBase(VIEWS.PRIME, first);
  if (n === 2 && second === 'stream') return deviceBase(VIEWS.STREAM, first);
  if (LOG_ID_RE.test(second)) {
    if (n === 2) return driveBase(first, second);
    if (n === 4) {
      const range = secondsToMillis(third, fourth);
      return range ? driveBase(first, second, range.start, range.end) : invalidBase('invalid-range');
    }
    return invalidBase('unknown-path');
  }
  if (n === 3 && UINT_RE.test(second) && UINT_RE.test(third)) {
    const range = legacyMillis(second, third);
    if (range) return { ...deviceBase(VIEWS.LEGACY_RANGE, first), legacyRange: range };
    return invalidBase('invalid-range');
  }
  return invalidBase('unknown-path');
}

// an existing clip's filename is an opaque token: only reject what could
// escape a path or confuse the device
function validClipFilename(filename) {
  // eslint-disable-next-line no-control-regex
  return typeof filename === 'string' && filename.length > 0 && !/[/\\\u0000-\u001f\u007f]/.test(filename)
    && filename !== '.' && filename !== '..';
}

// Combine the path's modal (if any) with the modal query arguments and check
// the combination. Returns { modal } or { reason } when invalid.
function resolveModal(base, pathModal, args) {
  const present = Object.keys(args);
  if (!pathModal && present.length === 0) return { modal: null };
  if (pathModal && (args.modal != null || args.modalDevice != null || args.panel != null)) {
    return { reason: 'invalid-modal' };
  }

  let modal = pathModal;
  if (!modal) {
    if (args.modal == null) return { reason: 'invalid-modal' };
    modal = modalOf(args.modal, { dongleId: args.modalDevice ?? null, panel: args.panel ?? null });
  }
  if (args.clip != null || args.clipRequestedAt != null) {
    if (args.clip == null) return { reason: 'invalid-modal' };
    modal = { ...modal, clip: { filename: args.clip, requestedAt: args.clipRequestedAt ?? null } };
  }

  const { kind } = modal;
  if (!MODAL_BASES[kind] || !MODAL_BASES[kind].includes(base.view)) return { reason: 'invalid-modal' };
  const targetsDevice = kind === MODALS.SETTINGS || kind === MODALS.CLIPS;
  if (targetsDevice) {
    modal = { ...modal, dongleId: modal.dongleId ?? base.dongleId };
    if (!DONGLE_ID_RE.test(modal.dongleId || '')) return { reason: 'invalid-modal' };
  } else if (kind === MODALS.ADD_DEVICE) {
    if (modal.dongleId != null) return { reason: 'invalid-modal' };
  } else {
    // Prime subflows act on the Prime page's device
    if (modal.dongleId != null && modal.dongleId !== base.dongleId) return { reason: 'invalid-modal' };
    modal = { ...modal, dongleId: base.dongleId };
  }
  if (modal.panel != null && (kind !== MODALS.SETTINGS || !SETTINGS_PANELS.includes(modal.panel))) {
    return { reason: 'invalid-modal' };
  }
  if (modal.clip && (kind !== MODALS.CLIPS || !validClipFilename(modal.clip.filename)
    || modal.clip.requestedAt === '')) {
    return { reason: 'invalid-modal' };
  }
  return { modal };
}

export function parseLocation({ pathname = '/', search = '', hash = '' } = {}) {
  const parts = splitPath(pathname);
  const direct = parts && parseModalPath(parts);
  let base = direct ? direct.base : parseBase(parts, pathname);
  const commands = {};
  const modalArgs = {};
  const extensions = [];
  const seen = new Set();
  const commandKeys = base.view === VIEWS.AUTH ? [...COMMAND_KEYS, ...AUTH_KEYS] : COMMAND_KEYS;
  let duplicate = false;

  for (const [key, value] of new URLSearchParams(search)) {
    const known = commandKeys.includes(key) || (base.view !== VIEWS.AUTH && MODAL_KEYS.includes(key));
    if (!known) {
      extensions.push([key, value]);
      continue;
    }
    if (seen.has(key)) duplicate = true;
    seen.add(key);
    if (commandKeys.includes(key)) commands[key] = value;
    else modalArgs[key] = value;
  }

  let modal = null;
  if (duplicate) {
    base = invalidBase('duplicate-query-key');
  } else if (base.view !== VIEWS.INVALID && base.view !== VIEWS.AUTH) {
    const resolved = resolveModal(base, direct?.modal ?? null, modalArgs);
    if (resolved.reason) base = invalidBase(resolved.reason);
    else modal = resolved.modal;
  }

  // an invalid location runs nothing: its commands are dropped with it
  return {
    base,
    modal,
    commands: base.view === VIEWS.INVALID ? {} : commands,
    extensions,
    hash: hash === '#' ? '' : hash,
  };
}

function assertDongleId(dongleId) {
  if (!DONGLE_ID_RE.test(dongleId || '')) throw new Error(`invalid dongle id: ${dongleId}`);
}

function buildPath(base) {
  switch (base.view) {
    case VIEWS.ROOT:
      return '/';
    case VIEWS.REFERRALS:
      return '/referrals';
    case VIEWS.DASHBOARD:
      assertDongleId(base.dongleId);
      return `/${base.dongleId}`;
    case VIEWS.PRIME:
    case VIEWS.STREAM:
      assertDongleId(base.dongleId);
      return `/${base.dongleId}/${base.view}`;
    case VIEWS.DRIVE: {
      assertDongleId(base.dongleId);
      const { logId, start, end } = base.drive;
      if (!LOG_ID_RE.test(logId || '')) throw new Error(`invalid log id: ${logId}`);
      if (start == null && end == null) return `/${base.dongleId}/${logId}`;
      // the pure builder only accepts canonical, second-aligned bounds; navigate() rounds
      const range =
        start % 1000 === 0 && end % 1000 === 0 ? secondsToMillis(String(start / 1000), String(end / 1000)) : null;
      if (!range) throw new Error(`invalid drive range: ${start}-${end}`);
      return `/${base.dongleId}/${logId}/${start / 1000}/${end / 1000}`;
    }
    case VIEWS.LEGACY_RANGE: {
      assertDongleId(base.dongleId);
      const range = legacyMillis(String(base.legacyRange?.start), String(base.legacyRange?.end));
      if (!range) throw new Error('invalid legacy range');
      return `/${base.dongleId}/${range.start}/${range.end}`;
    }
    default:
      return null;
  }
}

// The direct path for a modal over its natural page, or null when the
// modal is shown over some other page (contextual form).
function directModalPath(base, modal) {
  switch (modal.kind) {
    case MODALS.SETTINGS:
      return base.view === VIEWS.DASHBOARD && base.dongleId === modal.dongleId
        ? `/${modal.dongleId}/settings${modal.panel ? `/${modal.panel}` : ''}` : null;
    case MODALS.ADD_DEVICE:
      return base.view === VIEWS.ROOT ? '/devices/add' : null;
    case MODALS.CLIPS:
      return base.view === VIEWS.DASHBOARD && base.dongleId === modal.dongleId ? `/${modal.dongleId}/clips` : null;
    default:
      return `/${base.dongleId}/prime/${modal.kind}`;
  }
}

function appendModalArgs(params, base, modal, direct) {
  if (!direct) {
    params.append('modal', modal.kind);
    const targetsDevice = modal.kind === MODALS.SETTINGS || modal.kind === MODALS.CLIPS;
    if (targetsDevice && modal.dongleId !== base.dongleId) params.append('modalDevice', modal.dongleId);
    if (modal.panel) params.append('panel', modal.panel);
  }
  if (modal.clip) {
    params.append('clip', modal.clip.filename);
    if (modal.clip.requestedAt != null) params.append('clipRequestedAt', modal.clip.requestedAt);
  }
}

// Returns the canonical URL for a location, or null when it has none
// (auth callbacks and invalid locations are never rewritten).
export function buildUrl(location) {
  let path = buildPath(location.base);
  if (path === null) return null;
  const { modal } = location;
  let direct = null;
  if (modal) {
    const { reason } = resolveModal(location.base, null, {
      modal: modal.kind, modalDevice: modal.dongleId ?? undefined, panel: modal.panel ?? undefined,
      clip: modal.clip?.filename, clipRequestedAt: modal.clip?.requestedAt ?? undefined,
    });
    if (reason) throw new Error(`invalid modal: ${modal.kind}`);
    direct = directModalPath(location.base, modal);
    if (direct) path = direct;
  }
  const params = new URLSearchParams();
  for (const key of COMMAND_KEYS) {
    if (location.commands?.[key] != null) params.append(key, location.commands[key]);
  }
  if (modal) appendModalArgs(params, location.base, modal, Boolean(direct));
  for (const [key, value] of location.extensions || []) params.append(key, value);
  const search = params.toString();
  return `${path}${search ? `?${search}` : ''}${location.hash || ''}`;
}

export function urlOfRouterLocation({ pathname = '/', search = '', hash = '' } = {}) {
  return `${pathname}${search === '?' ? '' : search}${hash === '#' ? '' : hash}`;
}

export function locationOfUrl(url) {
  const parsed = new URL(url, 'http://connect.invalid');
  return { pathname: parsed.pathname, search: parsed.search, hash: parsed.hash };
}

// A new location for `base` carrying only the arguments that survive
// navigation to a different page.
export function locationFor(base, from = null) {
  return {
    base,
    modal: null,
    commands: {},
    extensions: (from?.extensions || []).filter(([key]) => GLOBAL_EXTENSION_KEYS.includes(key)),
    hash: '',
  };
}

// The same thing on screen: device page or drive (any range), ignoring
// the selection, modal and query.
export function sameResource(a, b) {
  if (!a || !b) return false;
  return a.view === b.view && a.dongleId === b.dongleId && a.drive?.logId === b.drive?.logId;
}

// `base` reached from `from` keeping everything that belongs to the same
// resource (unknown arguments in order, hash) when only the selection
// changes, or only the global arguments when it is a different page.
export function locationForEdit(base, from) {
  if (from && sameResource(from.base, base)) {
    return { base, modal: null, commands: {}, extensions: from.extensions, hash: from.hash };
  }
  return locationFor(base, from);
}

export function withoutCommands(location, keys) {
  const commands = { ...location.commands };
  keys.forEach((key) => delete commands[key]);
  return { ...location, commands };
}

export function sameModal(a, b) {
  const x = a?.modal ?? null;
  const y = b?.modal ?? null;
  if (!x || !y) return x === y;
  return x.kind === y.kind && x.dongleId === y.dongleId && x.panel === y.panel
    && x.clip?.filename === y.clip?.filename && x.clip?.requestedAt === y.clip?.requestedAt;
}

// Whether `modal` may open over `base` (e.g. never over stream).
export function modalAllowedOn(base, modal) {
  return !resolveModal(base, null, {
    modal: modal.kind, modalDevice: modal.dongleId ?? undefined, panel: modal.panel ?? undefined,
    clip: modal.clip?.filename, clipRequestedAt: modal.clip?.requestedAt ?? undefined,
  }).reason;
}

// The page a modal's direct link opens over: settings and clips over their
// device's dashboard, add-device over the root, Prime subflows over Prime.
export function directBaseFor(modal) {
  switch (modal.kind) {
    case MODALS.SETTINGS:
    case MODALS.CLIPS:
      return deviceBase(VIEWS.DASHBOARD, modal.dongleId);
    case MODALS.ADD_DEVICE:
      return rootBase();
    default:
      return deviceBase(VIEWS.PRIME, modal.dongleId);
  }
}

// The modal one level up: settings → (uploads closes to settings), clip
// preview → clip list, otherwise the page underneath.
export function parentModal(modal) {
  if (!modal) return null;
  if (modal.panel) return { ...modal, panel: null };
  if (modal.clip) return { ...modal, clip: null };
  return null;
}

// Same page, ignoring the modal, commands, extensions and hash.
export function sameBase(a, b) {
  if (!a || !b) return false;
  const x = a.base;
  const y = b.base;
  return (
    x.view === y.view
    && x.dongleId === y.dongleId
    && x.drive?.logId === y.drive?.logId
    && x.drive?.start === y.drive?.start
    && x.drive?.end === y.drive?.end
    && x.legacyRange?.start === y.legacyRange?.start
    && x.legacyRange?.end === y.legacyRange?.end
  );
}

// An internal path that is safe to redirect to after login.
export function isSafeReturnUrl(url) {
  if (typeof url !== 'string' || !url.startsWith('/') || url.startsWith('//') || url.startsWith('/\\')) return false;
  try {
    return new URL(url, 'http://connect.invalid').origin === 'http://connect.invalid';
  } catch {
    return false;
  }
}

// Analytics page location with identifiers replaced by placeholders.
export function anonymizedPath(location) {
  const { base } = location;
  switch (base.view) {
    case VIEWS.ROOT:
      return '';
    case VIEWS.DASHBOARD:
      return '/<dongleId>';
    case VIEWS.PRIME:
    case VIEWS.STREAM:
      return `/<dongleId>/${base.view}`;
    case VIEWS.DRIVE:
      return base.drive.start == null ? '/<dongleId>/<logId>' : '/<dongleId>/<logId>/<zoomStart>/<zoomEnd>';
    case VIEWS.LEGACY_RANGE:
      return '/<dongleId>/<zoomStart>/<zoomEnd>';
    case VIEWS.REFERRALS:
      return '/referrals';
    case VIEWS.AUTH:
      return '/auth';
    default:
      return '/<invalid>';
  }
}

export function anonymizedModal(location) {
  const { modal } = location;
  if (!modal) return null;
  return [modal.kind, modal.panel, modal.clip ? 'preview' : null].filter(Boolean).join('/');
}
