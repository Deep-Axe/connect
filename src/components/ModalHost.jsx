// Renders the task dialog named by the URL over whatever page is showing.
// Lives in the explorer shell, so a dialog does not depend on the drawer or
// any page being mounted, and the page underneath keeps its state.
//
// Prime's cancel and plan-change dialogs are rendered by the Prime page
// itself: they act on its loaded subscription.
import { connect } from 'react-redux';

import { MODALS, VIEWS, modalOf } from '../routing/codec';
import { closeModal, openModal } from '../routing/navigate';
import { selectNavLocation } from '../routing/selectors';
import { deviceIsOnline } from '../utils';

import DeviceSettingsModal from './Dashboard/DeviceSettingsModal';
import { ConnectedAddDeviceDialog } from './Dashboard/AddDevice';
import ClipMenu from './DriveView/ClipMenu';
import Unavailable from './utils/UnavailableDialog';

// The modal's device, once it can be known: null while the device list is
// still loading, false when this account cannot see it.
function targetDevice(state, dongleId) {
  if (state.device?.dongle_id === dongleId) return state.device;
  if (state.devices === null) return null;
  return state.devices.find((d) => d.dongle_id === dongleId) || false;
}

const ModalHost = ({ dispatch, location, device, canManage, route, zoom, routes }) => {
  const modal = location?.modal;
  if (!modal) return null;
  const close = () => dispatch(closeModal());

  switch (modal.kind) {
    case MODALS.SETTINGS:
      if (device === null) return null;
      if (!device || !canManage) {
        return <Unavailable message="You don't have access to this device's settings." onClose={close} />;
      }
      return (
        <DeviceSettingsModal
          key={modal.dongleId}
          isOpen
          dongleId={modal.dongleId}
          onClose={close}
          uploadsOpen={modal.panel === 'uploads'}
          onOpenUploads={() => dispatch(openModal({ ...modal, panel: 'uploads' }))}
          onCloseUploads={close}
        />
      );

    case MODALS.ADD_DEVICE:
      return <ConnectedAddDeviceDialog onClose={close} />;

    case MODALS.CLIPS: {
      if (device === null) return null;
      if (!device) return <Unavailable message="This device's clips aren't available to you." onClose={close} />;
      // the clip creation form needs a drive of the same device underneath
      const createFrom = location.base.view === VIEWS.DRIVE && location.base.dongleId === modal.dongleId;
      return (
        <ClipMenu
          key={modal.dongleId}
          open
          dongleId={modal.dongleId}
          onClose={close}
          route={createFrom ? route : null}
          zoom={createFrom ? zoom : null}
          routes={routes}
          inventoryOnly={!createFrom}
          deviceOnline={deviceIsOnline(device)}
          preview={modal.clip}
          onPreview={(clip) =>
            dispatch(
              openModal(
                modalOf(MODALS.CLIPS, {
                  dongleId: modal.dongleId,
                  clip: { filename: clip.filename, requestedAt: String(clip.requested_at) },
                }),
              ),
            )
          }
          onResolvePreview={(clip) =>
            dispatch(
              openModal(
                modalOf(MODALS.CLIPS, {
                  dongleId: modal.dongleId,
                  clip: { filename: clip.filename, requestedAt: String(clip.requested_at) },
                }),
                { replace: true },
              ),
            )
          }
          onClosePreview={close}
        />
      );
    }

    default:
      return null; // Prime subflows: rendered by the Prime page
  }
};

const stateToProps = (state) => {
  const location = selectNavLocation(state);
  const modal = location?.modal;
  const device = modal?.dongleId ? targetDevice(state, modal.dongleId) : null;
  return {
    location,
    device,
    canManage: Boolean(device && (device.is_owner || state.profile?.superuser)),
    route: state.currentRoute,
    zoom: state.zoom,
    routes: state.routes,
  };
};

export default connect(stateToProps)(ModalHost);
