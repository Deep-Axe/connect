import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ClipMenu from './ClipMenu';

const service = vi.hoisted(() => ({
  getClipState: vi.fn(),
  hasClipBlob: vi.fn(),
  getClipUrl: vi.fn(),
  releaseClip: vi.fn(),
  revokeClipUrl: vi.fn(),
}));
vi.mock('../../api/clips', () => ({ ClipChangedError: class extends Error {} }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('new preview URLs reload metadata and release old video', async () => {
  vi.stubGlobal(
    'URL',
    class extends URL {
      static revokeObjectURL = vi.fn();
    },
  );
  let clip = {
    filename: 'trip.mp4',
    requested_at: 100,
    status: 'ready',
    camera: 'fcamera.hevc',
    source_start_time: 0,
    source_end_time: 10,
    size: 3,
  };
  service.getClipState.mockImplementation(async () => ({ clips: [clip] }));
  service.hasClipBlob.mockResolvedValue(false);
  service.getClipUrl.mockImplementation(async (_device, _filename, version) => `blob:clip-${version}`);
  const props = {
    clipDevice: service,
    deviceOnline: true,
    dongleId: 'aaaaaaaaaaaaaaaa',
    inventoryOnly: true,
    open: true,
    onClose: vi.fn(),
    onClosePreview: vi.fn(),
  };
  const app = render(<ClipMenu {...props} preview={{ filename: clip.filename, requestedAt: '100' }} />);
  await waitFor(() => expect(document.querySelector('video')).toHaveAttribute('src', 'blob:clip-100'));
  clip = { ...clip, requested_at: 101 };
  let finishMetadata;
  service.getClipState.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishMetadata = resolve;
      }),
  );
  app.rerender(<ClipMenu {...props} preview={{ filename: clip.filename, requestedAt: '101' }} />);
  await waitFor(() => expect(document.querySelector('video')).not.toBeInTheDocument());
  await act(async () => {
    finishMetadata({ clips: [clip] });
  });
  await waitFor(() => expect(document.querySelector('video')).toHaveAttribute('src', 'blob:clip-101'));
  expect(service.getClipState).toHaveBeenCalledTimes(2);
});

it('a failed new version leaves its retry button accessible', async () => {
  vi.stubGlobal(
    'URL',
    class extends URL {
      static revokeObjectURL = vi.fn();
    },
  );
  const clip = {
    filename: 'retry.mp4',
    requested_at: 100,
    status: 'ready',
    camera: 'fcamera.hevc',
    source_start_time: 0,
    source_end_time: 10,
  };
  service.getClipState.mockImplementation(async () => ({ clips: [clip] }));
  service.hasClipBlob.mockResolvedValue(false);
  service.getClipUrl
    .mockResolvedValueOnce('blob:old-version')
    .mockRejectedValueOnce(new Error('Download failed'))
    .mockResolvedValueOnce('blob:new-version');
  const props = {
    clipDevice: service,
    deviceOnline: true,
    dongleId: 'aaaaaaaaaaaaaaaa',
    inventoryOnly: true,
    open: true,
    onClose: vi.fn(),
    onClosePreview: vi.fn(),
  };
  const app = render(<ClipMenu {...props} preview={{ filename: clip.filename, requestedAt: '100' }} />);
  await waitFor(() => expect(document.querySelector('video')).toHaveAttribute('src', 'blob:old-version'));
  clip.requested_at = 101;
  app.rerender(<ClipMenu {...props} preview={{ filename: clip.filename, requestedAt: '101' }} />);
  await screen.findByText('Download failed');
  const retry = await screen.findByRole('button', { name: 'Download clip' });
  fireEvent.click(retry);
  await waitFor(() => expect(document.querySelector('video')).toHaveAttribute('src', 'blob:new-version'));
});
