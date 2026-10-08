import React, { Component } from 'react';
import {
  Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, LinearProgress, Typography, withStyles,
} from '@material-ui/core';

import Colors from '../../colors';
import { ClipChangedError, clipDevice } from '../../api/clips';
import { CloseBold, Download as DownloadIcon, PlayArrow, Trash } from '../../icons';
import { shareOrDownload } from '../../utils/file';
import InfoTooltip from '../utils/InfoTooltip';

const MAX_CLIP_DURATION = 30 * 60;
const POLL_INTERVAL = 1000;
const ACTIVE_STATUSES = new Set(['queued', 'encoding']);

const CAMERAS = [
  ['fcamera.hevc', 'Road'],
  ['ecamera.hevc', 'Wide road'],
  ['dcamera.hevc', 'Driver'],
];

const BITRATES = [
  [5, 'Standard', '5 Mbps'],
  [8, 'High', '8 Mbps'],
  [12, 'Extreme', '12 Mbps'],
];

const SPEEDUPS = [1, 2, 4, 5, 10];

const clipVersion = (clip) => String(clip.requested_at);

const styles = () => ({
  paper: {
    display: 'flex',
    maxWidth: 'calc(100vw - 24px)',
    outline: 'none',
    overflow: 'hidden',
    width: 360,
  },
  menuList: {
    display: 'flex',
    flexDirection: 'column',
    maxHeight: 'calc(100vh - 96px)',
    minHeight: 0,
    width: '100%',
  },
  createPaper: {
    '@media (max-width: 600px)': {
      borderRadius: 0,
      bottom: '0 !important',
      height: '100vh',
      left: '0 !important',
      maxHeight: 'none',
      maxWidth: 'none',
      right: '0 !important',
      top: '0 !important',
      transform: 'none !important',
      width: '100vw',
    },
  },
  createMenuList: {
    '@media (max-width: 600px)': {
      height: '100vh',
      maxHeight: 'none',
    },
  },
  body: { outline: 'none', padding: 16, '&:focus': { outline: 'none' } },
  createHeader: {
    alignItems: 'center',
    display: 'flex',
    justifyContent: 'space-between',
  },
  mobileClose: {
    display: 'none',
    '@media (max-width: 600px)': {
      display: 'flex',
      margin: '-8px -8px -8px 0',
    },
  },
  header: { fontSize: 16, fontWeight: 500, marginBottom: 4 },
  supporting: { color: Colors.white60, fontSize: 12, lineHeight: 1.4 },
  range: {
    background: Colors.white05, borderRadius: 8, margin: '14px 0', padding: '10px 12px',
  },
  rangeValue: { fontSize: 15, fontWeight: 500 },
  field: { marginTop: 14 },
  label: { color: Colors.white60, display: 'block', fontSize: 11, marginBottom: 6 },
  segmentedControl: {
    display: 'flex',
    border: `1px solid ${Colors.white10}`,
    borderRadius: 8,
    overflow: 'hidden',
  },
  segmentedButton: {
    border: 'none',
    borderRadius: 0,
    borderRight: `1px solid ${Colors.white10}`,
    color: Colors.white,
    flex: '1 1 0',
    fontSize: 12,
    lineHeight: 1.2,
    minHeight: 44,
    minWidth: 0,
    padding: '5px 4px',
    textTransform: 'none',
    '&:last-child': { borderRight: 'none' },
    '&[aria-pressed="true"]': { background: 'rgba(255,255,255,.14)' },
    '&[aria-pressed="true"]:hover': { background: 'rgba(255,255,255,.14)' },
    '&[aria-pressed="true"]:focus': { background: 'rgba(255,255,255,.14)' },
  },
  qualityDetail: { color: Colors.white60, display: 'block', fontSize: 10, fontWeight: 400, marginTop: 2 },
  availabilityHint: { color: '#ffcc80', fontSize: 12, lineHeight: 1.4, marginTop: 7 },
  estimate: { alignItems: 'center', display: 'flex', justifyContent: 'space-between', marginTop: 8 },
  estimateValue: { fontSize: 12, fontWeight: 500 },
  input: {
    background: Colors.white05,
    border: `1px solid ${Colors.white10}`,
    borderRadius: 8,
    boxSizing: 'border-box',
    color: Colors.white,
    fontFamily: 'inherit',
    fontSize: 13,
    outline: 'none',
    padding: '9px 11px',
    width: '100%',
    '&::placeholder': { color: Colors.white40 },
  },
  error: { color: '#ff8a80', fontSize: 12, marginTop: 10 },
  create: {
    background: Colors.white, borderRadius: 16, color: Colors.grey900, marginTop: 16,
    minHeight: 32, textTransform: 'none', width: '100%',
    '&:hover': { background: '#eee' },
    '&:disabled': { background: Colors.white05, color: Colors.white60 },
  },
  clipsSection: {
    flex: '1 1 auto',
    minHeight: 0,
    overflowY: 'auto',
    padding: '13px 16px 16px',
  },
  sectionHeader: { alignItems: 'center', color: Colors.white60, display: 'flex', marginBottom: 8 },
  sectionTitle: { color: 'inherit', fontSize: 12, lineHeight: 1.4 },
  clip: {
    padding: '8px 0',
    '& + &': { borderTop: `1px solid ${Colors.white05}` },
    '&:last-child': { paddingBottom: 0 },
  },
  clipTop: { alignItems: 'center', display: 'flex', gap: 12, justifyContent: 'space-between' },
  clipDetails: { minWidth: 0 },
  clipTitle: { fontSize: 15, lineHeight: 1.35 },
  clipMeta: { color: Colors.white60, fontSize: 13, lineHeight: 1.4, marginTop: 2 },
  progress: { marginTop: 7 },
  transferProgress: { borderRadius: 3, height: 5, marginTop: 8 },
  transferLabel: { color: Colors.white60, fontSize: 12, marginTop: 8, textAlign: 'center' },
  clipAction: {
    color: Colors.white, flex: '0 0 auto', height: 32, padding: 7, width: 32,
    '&:disabled': { color: Colors.white40 },
  },
  actionIcon: { fontSize: 24 },
  clipActions: { alignItems: 'center', display: 'flex', flex: '0 0 auto', gap: 2, margin: '-4px -7px -4px 0' },
  playIcon: { fontSize: 27 },
  viewerPaper: { background: Colors.grey900, maxWidth: 800, width: 'calc(100vw - 32px)' },
  viewerTitle: { alignItems: 'flex-start', display: 'flex', justifyContent: 'space-between', padding: '16px 12px 12px 20px' },
  viewerDetails: { minWidth: 0, paddingTop: 1 },
  viewerHeader: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  viewerMeta: { color: Colors.white60, fontSize: 13, lineHeight: 1.4, marginTop: 3 },
  viewerActions: { alignItems: 'center', display: 'flex', flex: '0 0 auto', marginTop: -4 },
  viewerContent: { padding: '0 20px 20px' },
  viewerVideo: { background: Colors.grey950, display: 'block', maxHeight: '70vh', width: '100%' },
  deletePaper: { background: Colors.grey900, width: 360 },
  deleteTitle: { paddingBottom: 8 },
  deleteContent: { color: Colors.white60, fontSize: 14, lineHeight: 1.5 },
  deleteActions: { padding: '8px 16px 16px' },
  deleteButton: { color: '#ff8a80' },
  empty: { color: Colors.white60, fontSize: 13, lineHeight: 1.4, paddingTop: 5 },
});

function formatTime(time) {
  const totalSeconds = Math.max(0, Math.round(time));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours ? `${hours}:` : ''}${hours ? String(minutes).padStart(2, '0') : minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatDuration(duration) {
  const totalSeconds = Math.max(0, Math.round(duration));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours && `${hours}h`, minutes && `${minutes}m`, (seconds || (!hours && !minutes)) && `${seconds}s`].filter(Boolean).join(' ');
}

function formatSize(bytes) {
  if (!bytes) return '';
  return `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`;
}

function normalizeFilename(filename) {
  return filename.trim().replace(/\.mp4$/i, '');
}

function validFilename(filename) {
  const normalized = normalizeFilename(filename);
  return !filename.trim() || /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(normalized);
}

function defaultFilename(dongleId, route, camera, startTime, endTime, speedup) {
  const parts = [
    dongleId,
    deviceRouteName(route),
    Math.round(startTime),
    Math.round(endTime),
    camera.replace(/\.hevc$/i, ''),
  ];
  if (speedup > 1) parts.push(`${speedup}x`);
  return parts.join('_');
}

function deviceRouteName(route) {
  return route?.fullname?.split(/[|/]/).pop() || null;
}

function cameraCoversRange(cameraRanges, camera, startTime, endTime) {
  return Boolean(cameraRanges?.[camera]?.available_ranges?.some(([start, end]) => start <= startTime && end >= endTime));
}

class ClipMenu extends Component {
  constructor(props) {
    super(props);
    this.state = {
      clips: [], camera: 'fcamera.hevc', bitrate: 5, speedup: 1, filename: '',
      cameraRanges: null, loading: false, creating: false, error: null,
      autoDownloadFilename: null,
      downloadedClips: new Set(),
      viewingClip: null, previewingClip: null, previewUrl: null, previewProgress: 0, previewProblem: null,
      deletingClip: null, deleteDialogOpen: false, deleting: false,
    };
    this.poll = null;
    this.mounted = false;
    this.previewRequest = 0;
    this.metadataLoaded = false;
    this.loadedPreviewKey = null;
  }

  componentDidMount() {
    this.mounted = true;
    if (this.props.open) this.loadClips();
  }

  // The preview follows the URL (props.preview): opening and closing it is
  // navigation, and a shared link opens the same clip version.
  syncPreview() {
    const { preview } = this.props;
    const { clips, loading, viewingClip, previewingClip, previewProblem } = this.state;
    if (!preview) {
      this.loadedPreviewKey = null;
      if (viewingClip || previewingClip || previewProblem) this.closeViewer();
      return;
    }
    if (!this.props.deviceOnline) {
      if (!previewProblem) this.showPreviewProblem('Device offline');
      return;
    }
    if (loading || !this.metadataLoaded) return; // resolved against the device's clip list
    const key = `${preview.filename}/${preview.requestedAt}`;
    if (this.loadedPreviewKey === key) return;
    this.loadedPreviewKey = key;

    const named = clips.filter((clip) => clip.filename === preview.filename);
    if (preview.requestedAt == null) {
      // a filename-only link: resolve it to the one current version
      if (named.length === 1) {
        this.props.onResolvePreview(named[0]);
      } else {
        this.showPreviewProblem(named.length ? 'Several clips have this name; choose one from the list.' : 'This clip is no longer on the device.');
      }
      return;
    }
    const clip = named.find((candidate) => clipVersion(candidate) === preview.requestedAt);
    if (!clip) {
      this.showPreviewProblem(named.length ? 'This clip changed on the device since the link was made.' : 'This clip is no longer on the device.');
    } else if (clip.status !== 'ready') {
      // not final: look again on the next metadata poll
      this.loadedPreviewKey = null;
      this.showPreviewProblem('This clip is still being made.');
    } else {
      this.loadPreview(clip);
    }
  }

  // stop wanting the clip bytes this dialog asked for (cancels the download
  // when nobody else wants them)
  releaseDownload() {
    if (!this.download) return;
    const { dongleId, filename, requestedAt, onProgress, service } = this.download;
    service.releaseClip(dongleId, filename, requestedAt, onProgress);
    this.download = null;
  }

  clipService() {
    return this.props.clipDevice ?? clipDevice;
  }

  ownsClipTask(service, dongleId) {
    return this.mounted && service === this.clipService() && dongleId === this.props.dongleId
      && (service.isActive?.() ?? true);
  }

  revokePreviewUrl() {
    if (this.state.previewUrl) (this.previewService ?? this.clipService()).revokeClipUrl(this.state.previewUrl);
    this.previewService = null;
  }

  showPreviewProblem(previewProblem) {
    this.releaseDownload();
    this.previewRequest += 1;
    this.revokePreviewUrl();
    this.setState({ viewingClip: null, previewingClip: null, previewUrl: null, previewProgress: 0, previewProblem });
  }

  componentDidUpdate(prevProps, prevState) {
    if (prevProps.preview !== this.props.preview || prevState.clips !== this.state.clips
      || prevState.loading !== this.state.loading || prevProps.deviceOnline !== this.props.deviceOnline) {
      this.syncPreview();
    }
    const opened = this.props.open && !prevProps.open;
    const routeChanged = this.props.route?.fullname !== prevProps.route?.fullname;
    const deviceChanged = this.props.dongleId !== prevProps.dongleId;
    const serviceChanged = this.props.clipDevice !== prevProps.clipDevice;
    const reconnected = this.props.deviceOnline && !prevProps.deviceOnline;
    if (serviceChanged) {
      this.releaseDownload();
      this.revokePreviewUrl();
      this.loadedPreviewKey = null;
      this.metadataLoaded = false;
      this.previewRequest += 1;
      this.setState({ previewUrl: null, viewingClip: null, previewingClip: null });
    }
    if ((opened || routeChanged || deviceChanged || reconnected || serviceChanged) && this.props.open) this.loadClips();
    if (!this.props.deviceOnline && prevProps.deviceOnline) {
      this.stopPolling();
      this.setState({ loading: false });
    }
    if (!this.props.open && prevProps.open) {
      this.stopPolling();
      if (this.state.viewingClip) this.closeViewer();
    }
  }

  componentWillUnmount() {
    this.mounted = false;
    this.previewRequest += 1;
    this.releaseDownload();
    this.stopPolling();
    this.revokePreviewUrl();
  }

  stopPolling() {
    if (this.poll) clearTimeout(this.poll);
    this.poll = null;
  }

  async loadClips(showLoading = true) {
    const routeName = deviceRouteName(this.props.route);
    const { dongleId } = this.props;
    const service = this.clipService();
    this.metadataRequest = (this.metadataRequest ?? 0) + 1;
    const request = this.metadataRequest;
    const isCurrent = () => this.ownsClipTask(service, dongleId) && request === this.metadataRequest
      && routeName === deviceRouteName(this.props.route);
    if (!this.props.deviceOnline) {
      this.setState({ clips: [], cameraRanges: null, loading: false, error: null });
      return;
    }
    if (showLoading) this.setState({ loading: true, error: null });
    try {
      const state = await service.getClipState(dongleId, routeName ? { route: this.props.route.fullname } : {});
      if (!isCurrent()) return;
      const { clips } = state;
      const downloadedClips = new Set((await Promise.all(clips
        .filter(clip => clip.status === 'ready')
        .map(async clip => ([clip.filename, await service.hasClipBlob(dongleId, clip.filename, clip.requested_at)]))))
        .filter(([, downloaded]) => downloaded)
        .map(([filename]) => filename));
      if (!isCurrent()) return;
      const cameraRanges = routeName ? state.cameras || {} : null;
      this.metadataLoaded = true;
      this.setState({ clips, downloadedClips, cameraRanges, loading: false }, () => {
        if (!isCurrent()) return;
        const autoClip = clips.find(clip => clip.filename === this.state.autoDownloadFilename && clip.status === 'ready');
        if (this.props.open && autoClip) this.setState({ autoDownloadFilename: null }, () => this.openViewer(autoClip));
      });
      this.stopPolling();
      if (this.props.open && clips.some(clip => ACTIVE_STATUSES.has(clip.status))) {
        this.poll = setTimeout(() => { if (isCurrent()) this.loadClips(false); }, POLL_INTERVAL);
      }
    } catch (err) {
      if (isCurrent()) this.setState({ loading: false, error: err.message || 'Could not reach the device' });
    }
  }

  async createClip() {
    const { dongleId, route, zoom } = this.props;
    const { camera, bitrate, speedup, filename } = this.state;
    const service = this.clipService();
    const isCurrent = () => this.ownsClipTask(service, dongleId) && route?.fullname === this.props.route?.fullname;
    if (!route || !zoom || !this.props.deviceOnline || !validFilename(filename)) return;
    const generatedFilename = defaultFilename(dongleId, route, camera, zoom.start / 1000, zoom.end / 1000, speedup);
    const outputFilename = `${normalizeFilename(filename) || generatedFilename}.mp4`;
    this.setState({ creating: true, autoDownloadFilename: outputFilename, error: null });
    try {
      await service.createClip(dongleId, {
        route: route.fullname,
        source_start_time: zoom.start / 1000,
        source_end_time: zoom.end / 1000,
        clip: {
          camera,
          bitrate,
          speedup,
          filename: outputFilename,
        },
      });
      if (!isCurrent()) return;
      this.setState({ creating: false });
      await this.loadClips(false);
    } catch (err) {
      if (isCurrent()) this.setState({ creating: false, autoDownloadFilename: null, error: err.message || 'Could not create clip' });
    }
  }

  async downloadViewedClip() {
    const { previewUrl, viewingClip } = this.state;
    if (!previewUrl || !viewingClip) return;
    const start = formatTime(viewingClip.source_start_time).replaceAll(':', '-');
    const end = formatTime(viewingClip.source_end_time).replaceAll(':', '-');
    const defaultName = `comma-clip-${viewingClip.camera}-${start}-${end}`;
    const filename = `${(viewingClip.filename || defaultName).replace(/\.mp4$/i, '')}.mp4`;
    const mobile = /android|iphone|ipad|ipod/i.test(navigator.userAgent);
    await shareOrDownload({ url: previewUrl, filename, mimeType: 'video/mp4', share: mobile });
  }

  async removeClip(clip) {
    const service = this.clipService();
    const { dongleId } = this.props;
    if (!this.props.deviceOnline) return false;
    if (clip.filename === this.state.previewingClip) {
      this.previewRequest += 1;
      this.setState({ previewingClip: null, previewProgress: 0 });
    }
    try {
      await service.deleteClip(dongleId, { filename: clip.filename });
      if (!this.ownsClipTask(service, dongleId)) return false;
      if (clip.filename === this.state.autoDownloadFilename) this.setState({ autoDownloadFilename: null });
      await this.loadClips(false);
      return true;
    } catch (err) {
      if (this.ownsClipTask(service, dongleId)) this.setState({ error: err.message || 'Could not remove clip' });
      return false;
    }
  }

  async confirmDelete() {
    const { deletingClip } = this.state;
    if (!deletingClip || this.state.deleting) return;
    const service = this.clipService();
    const { dongleId } = this.props;
    this.setState({ deleting: true });
    const deleted = await this.removeClip(deletingClip);
    if (this.ownsClipTask(service, dongleId)) this.setState({ deleteDialogOpen: !deleted, deleting: false });
  }

  // a user asked to watch a clip: put its exact version in the URL, or, when
  // that is already the URL (a failed attempt), try again
  openViewer(clip) {
    if (!this.props.deviceOnline) return;
    const { preview } = this.props;
    if (preview?.filename === clip.filename && preview?.requestedAt === clipVersion(clip)) {
      this.loadPreview(clip);
      return;
    }
    this.props.onPreview(clip);
  }

  async loadPreview(clip) {
    if (!this.props.deviceOnline) {
      this.showPreviewProblem('Device offline');
      return;
    }
    this.revokePreviewUrl();
    this.previewRequest += 1;
    const request = this.previewRequest;
    const { dongleId } = this.props;
    const service = this.clipService();
    const version = clipVersion(clip);
    this.setState({ previewingClip: clip.filename, previewUrl: null, previewProgress: 0, previewProblem: null, error: null });
    const isCurrentVersion = async () => {
      if (!this.ownsClipTask(service, dongleId) || request !== this.previewRequest) return false;
      const { clips } = await service.getClipState(dongleId, {});
      if (!this.ownsClipTask(service, dongleId) || request !== this.previewRequest) return false;
      return clips.some((c) => c.filename === clip.filename && clipVersion(c) === version && c.status === 'ready');
    };
    this.releaseDownload();
    const onProgress = (loaded, total) => {
      if (this.ownsClipTask(service, dongleId) && request === this.previewRequest) this.setState({ previewProgress: loaded / total });
    };
    this.download = { dongleId, filename: clip.filename, requestedAt: clip.requested_at, onProgress, service };
    try {
      const previewUrl = await service.getClipUrl(dongleId, clip.filename, clip.requested_at, onProgress, isCurrentVersion);
      if (this.download?.onProgress === onProgress) this.download = null; // finished: nothing to release
      if (!this.ownsClipTask(service, dongleId) || request !== this.previewRequest || this.state.previewingClip !== clip.filename) {
        service.revokeClipUrl(previewUrl);
        return;
      }
      if (this.props.open) {
        this.previewService = service;
        this.setState(({ downloadedClips }) => ({
          viewingClip: clip,
          previewingClip: null,
          previewUrl,
          previewProgress: 0,
          downloadedClips: new Set(downloadedClips).add(clip.filename),
        }));
      } else {
        service.revokeClipUrl(previewUrl);
        this.setState({ previewingClip: null, previewProgress: 0 });
      }
    } catch (err) {
      if (this.ownsClipTask(service, dongleId) && request === this.previewRequest) {
        if (err instanceof ClipChangedError) {
          this.showPreviewProblem('This clip changed on the device since the link was made.');
        } else {
          // not retried automatically; clicking the clip again retries
          this.setState({ previewingClip: null, previewProgress: 0, error: err.message || 'Could not preview clip' });
        }
      }
    }
  }

  closeViewer() {
    this.releaseDownload();
    this.previewRequest += 1;
    this.revokePreviewUrl();
    this.setState({ viewingClip: null, previewingClip: null, previewUrl: null, previewProgress: 0, previewProblem: null });
  }

  renderViewer() {
    const { classes, preview, onClosePreview } = this.props;
    const { previewUrl, viewingClip, previewProblem } = this.state;
    if (previewProblem) {
      return (
        <Dialog open={Boolean(preview)} onClose={onClosePreview} classes={{ paper: classes.deletePaper }}>
          <DialogTitle className={classes.deleteTitle}>Clip unavailable</DialogTitle>
          <DialogContent>
            <Typography className={classes.deleteContent}>{previewProblem}</Typography>
          </DialogContent>
          <DialogActions className={classes.deleteActions}>
            <Button onClick={onClosePreview}>Close</Button>
          </DialogActions>
        </Dialog>
      );
    }
    const title = viewingClip?.filename?.replace(/\.mp4$/i, '') || 'Clip';
    const camera = CAMERAS.find(([value]) => value === viewingClip?.camera)?.[1] || viewingClip?.camera;
    const duration = viewingClip
      ? formatDuration((viewingClip.source_end_time - viewingClip.source_start_time) / (viewingClip.speedup || 1))
      : '';
    return (
      <Dialog open={Boolean(preview && viewingClip)} onClose={onClosePreview} classes={{ paper: classes.viewerPaper }} maxWidth="md">
        <DialogTitle disableTypography className={classes.viewerTitle}>
          <div className={classes.viewerDetails}>
            <Typography className={`${classes.header} ${classes.viewerHeader}`}>{title}</Typography>
            <Typography className={classes.viewerMeta}>
              {[camera, duration, formatSize(viewingClip?.size)].filter(Boolean).join(' · ')}
            </Typography>
          </div>
          <div className={classes.viewerActions}>
            <IconButton aria-label="Download clip" title="Download clip" onClick={() => this.downloadViewedClip()}>
              <DownloadIcon className={classes.actionIcon} />
            </IconButton>
            <IconButton aria-label="Close video" title="Close" onClick={onClosePreview}>
              <CloseBold className={classes.actionIcon} />
            </IconButton>
          </div>
        </DialogTitle>
        <DialogContent className={classes.viewerContent}>
          {previewUrl && <video className={classes.viewerVideo} src={previewUrl} controls autoPlay playsInline />}
        </DialogContent>
      </Dialog>
    );
  }

  renderDeleteConfirmation() {
    const { classes } = this.props;
    const { deleteDialogOpen, deleting, deletingClip } = this.state;
    const title = deletingClip?.filename?.replace(/\.mp4$/i, '') || 'this clip';
    return (
      <Dialog
        open={deleteDialogOpen}
        onClose={() => !deleting && this.setState({ deleteDialogOpen: false })}
        classes={{ paper: classes.deletePaper }}
        TransitionProps={{ onExited: () => this.setState({ deletingClip: null }) }}
      >
        <DialogTitle className={classes.deleteTitle}>Delete clip?</DialogTitle>
        <DialogContent>
          <Typography className={classes.deleteContent}>
            {`${title} will be permanently deleted from your comma device.`}
          </Typography>
        </DialogContent>
        <DialogActions className={classes.deleteActions}>
          <Button disabled={deleting} onClick={() => this.setState({ deleteDialogOpen: false })}>Cancel</Button>
          <Button className={classes.deleteButton} disabled={deleting} onClick={() => this.confirmDelete()}>
            {deleting ? <CircularProgress size={18} /> : 'Delete'}
          </Button>
        </DialogActions>
      </Dialog>
    );
  }

  renderClip(clip) {
    const { classes } = this.props;
    const camera = CAMERAS.find(([value]) => value === clip.camera)?.[1] || clip.camera;
    const currentRoute = clip.route === deviceRouteName(this.props.route);
    const knownRoute = this.props.routes?.find(route => deviceRouteName(route) === clip.route);
    const routeLabel = currentRoute
      ? 'This route'
      : (knownRoute?.start_time_utc_millis
        ? new Date(knownRoute.start_time_utc_millis).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
        : clip.route);
    const title = clip.filename?.replace(/\.mp4$/i, '') || 'Clip';
    const previewing = this.state.previewingClip === clip.filename;
    const downloaded = this.state.downloadedClips.has(clip.filename);
    return (
      <div key={clip.filename} className={classes.clip}>
        <div className={classes.clipTop}>
          <div className={classes.clipDetails}>
            <Typography className={classes.clipTitle}>{title}</Typography>
            <Typography className={classes.clipMeta}>{routeLabel}</Typography>
            <Typography className={classes.clipMeta}>
              {`${camera} · ${formatDuration((clip.source_end_time - clip.source_start_time) / (clip.speedup || 1))}${clip.size ? ` · ${formatSize(clip.size)}` : ''}`}
            </Typography>
          </div>
          <div className={classes.clipActions}>
            {clip.status === 'ready' && (
              <IconButton
                aria-label={downloaded ? 'Play clip' : 'Download clip'}
                className={classes.clipAction}
                disabled={!this.props.deviceOnline || previewing}
                title={this.props.deviceOnline ? (previewing ? 'Downloading' : (downloaded ? 'Play clip' : 'Download clip')) : 'Device offline'}
                onClick={() => this.openViewer(clip)}
              >
                {downloaded
                  ? <PlayArrow className={classes.playIcon} />
                  : <DownloadIcon className={classes.actionIcon} />}
              </IconButton>
            )}
            {clip.status === 'encoding' && <Typography className={classes.clipMeta}>Encoding</Typography>}
            {clip.status === 'queued' && <Typography className={classes.clipMeta}>Queued</Typography>}
            <IconButton
              aria-label={ACTIVE_STATUSES.has(clip.status) ? 'Cancel clip' : 'Delete clip'}
              className={classes.clipAction}
              disabled={!this.props.deviceOnline}
              title={this.props.deviceOnline ? (ACTIVE_STATUSES.has(clip.status) ? 'Cancel clip' : 'Delete clip') : 'Device offline'}
              onClick={() => (ACTIVE_STATUSES.has(clip.status)
                ? this.removeClip(clip)
                : this.setState({ deletingClip: clip, deleteDialogOpen: true }))}
            >
              {ACTIVE_STATUSES.has(clip.status)
                ? <CloseBold className={classes.actionIcon} />
                : <Trash className={classes.actionIcon} />}
            </IconButton>
          </div>
        </div>
        {clip.status === 'encoding' && <LinearProgress className={classes.progress} />}
        {previewing && (
          <React.Fragment>
            <LinearProgress className={classes.transferProgress} variant="determinate" value={this.state.previewProgress * 100} />
            <Typography className={classes.transferLabel}>Downloading · {Math.round(this.state.previewProgress * 100)}%</Typography>
          </React.Fragment>
        )}
      </div>
    );
  }

  render() {
    const { classes, deviceOnline, inventoryOnly, onClose, open, route, zoom } = this.props;
    const { bitrate, camera, cameraRanges, clips, creating, error, filename, loading, speedup } = this.state;
    const startTime = zoom ? zoom.start / 1000 : 0;
    const endTime = zoom ? zoom.end / 1000 : 0;
    const duration = endTime - startTime;
    const outputDuration = duration / speedup;
    const estimatedSize = outputDuration * bitrate * 125000;
    const invalidDuration = duration <= 0 || duration > MAX_CLIP_DURATION;
    const invalidFilename = !validFilename(filename);
    const cameraUnavailable = !inventoryOnly && cameraRanges !== null && !cameraCoversRange(cameraRanges, camera, startTime, endTime);
    const cameraAvailable = cameraRanges === null || CAMERAS.some(([value]) => cameraCoversRange(cameraRanges, value, startTime, endTime));
    const deviceBusy = clips.some(clip => ACTIVE_STATUSES.has(clip.status));

    return (
      <>
        <Dialog
          open={open}
          onClose={onClose}
          aria-label="Clips"
          classes={{ paper: `${classes.paper} ${!inventoryOnly ? classes.createPaper : ''}` }}
        >
          <div className={`${classes.menuList} ${!inventoryOnly ? classes.createMenuList : ''}`}>
          {!inventoryOnly && <div className={classes.body}>
          <div className={classes.createHeader}>
            <Typography className={classes.header}>Create a clip</Typography>
            <IconButton aria-label="Close clip menu" className={classes.mobileClose} onClick={onClose}><CloseBold /></IconButton>
          </div>
          <div className={classes.range}>
            <Typography className={classes.supporting}>Selected timeline range</Typography>
            <Typography className={classes.rangeValue}>{zoom ? `${formatTime(startTime)}–${formatTime(endTime)} · ${formatDuration(duration)}` : '—'}</Typography>
          </div>
          <div className={classes.field}>
            <Typography className={classes.label}>CAMERA</Typography>
            <div className={classes.segmentedControl}>
              {CAMERAS.map(([value, label]) => (
                <Button
                  key={value}
                  aria-pressed={camera === value}
                  className={classes.segmentedButton}
                  disabled={cameraRanges !== null && !cameraCoversRange(cameraRanges, value, startTime, endTime)}
                  onClick={() => this.setState({ camera: value })}
                >
                  {label}
                </Button>
              ))}
            </div>
            {!cameraAvailable && (
              <Typography className={classes.availabilityHint}>
                No camera footage covers this entire range. Choose a smaller range.
              </Typography>
            )}
          </div>
          <div className={classes.field}>
            <Typography className={classes.label}>QUALITY</Typography>
            <div className={classes.segmentedControl}>
              {BITRATES.map(([value, label, detail]) => (
                <Button key={value} aria-pressed={bitrate === value} className={classes.segmentedButton} onClick={() => this.setState({ bitrate: value })}>
                  <span>{label}<span className={classes.qualityDetail}>{detail}</span></span>
                </Button>
              ))}
            </div>
          </div>
          <div className={classes.field}>
            <Typography className={classes.label}>SPEED</Typography>
            <div className={classes.segmentedControl}>
              {SPEEDUPS.map(value => (
                <Button key={value} aria-pressed={speedup === value} className={classes.segmentedButton} onClick={() => this.setState({ speedup: value })}>{`${value}×`}</Button>
              ))}
            </div>
            <div className={classes.estimate}>
              <Typography className={classes.supporting}>{`Output: ${formatDuration(outputDuration)}`}</Typography>
              <Typography className={classes.estimateValue}>{`About ${formatSize(estimatedSize)}`}</Typography>
            </div>
          </div>
          <div className={classes.field}>
            <Typography className={classes.label}>FILENAME</Typography>
            <input
              className={classes.input}
              value={filename}
              maxLength={80}
              placeholder={defaultFilename(this.props.dongleId, route, camera, startTime, endTime, speedup)}
              onChange={event => this.setState({ filename: event.target.value })}
            />
            {invalidFilename && <Typography className={classes.error}>Use letters, numbers, periods, underscores, and hyphens only.</Typography>}
          </div>
          {duration > MAX_CLIP_DURATION && <Typography className={classes.error}>Choose a range of 30 minutes or less.</Typography>}
          <Button className={classes.create} disabled={!deviceOnline || loading || creating || deviceBusy || invalidDuration || invalidFilename || cameraUnavailable || !route} onClick={() => this.createClip()}>
            {creating ? <CircularProgress size={18} /> : (!deviceOnline ? 'Device offline' : (deviceBusy ? 'Clip in progress' : 'Create clip'))}
          </Button>
          </div>}
          {!inventoryOnly && <hr />}
          <div className={classes.clipsSection}>
            <div className={classes.sectionHeader}>
              <Typography className={classes.sectionTitle}>CLIPS ON THIS DEVICE</Typography>
              <InfoTooltip title="Clips are stored on your device and may be cleared to make room for more recent driving footage." />
            </div>
            {error && <Typography className={classes.error}>{error}</Typography>}
            {loading && <div className={classes.empty}><CircularProgress size={18} /></div>}
            {!loading && clips.length === 0 && <Typography className={classes.empty}>{deviceOnline ? 'No clips yet' : 'Device offline'}</Typography>}
            {!loading && clips.map(clip => this.renderClip(clip))}
          </div>
          </div>
        </Dialog>
        {this.renderViewer()}
        {this.renderDeleteConfirmation()}
      </>
    );
  }
}

export default withStyles(styles)(ClipMenu);
