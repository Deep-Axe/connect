import { cleanup, render, waitFor } from '@testing-library/react';
import ClipMenu from './ClipMenu';

const service = vi.hoisted(() => ({
  getClipState: vi.fn(),
  hasClipBlob: vi.fn(),
  getClipUrl: vi.fn(),
  releaseClip: vi.fn(),
  revokeClipUrl: vi.fn(),
}));
vi.mock('../../api/clips', () => ({ clipDevice: service, ClipChangedError: class extends Error {} }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('a newer preview link checks current metadata before rejecting the version', async () => {
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
  app.rerender(<ClipMenu {...props} preview={{ filename: clip.filename, requestedAt: '101' }} />);
  await waitFor(() => expect(document.querySelector('video')).toHaveAttribute('src', 'blob:clip-101'));
  expect(service.getClipState).toHaveBeenCalledTimes(2);
});
