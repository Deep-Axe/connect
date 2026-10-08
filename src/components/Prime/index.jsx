import { useEffect, useRef } from 'react';
import { connect } from 'react-redux';

import { Typography } from '@material-ui/core';
import PrimeManage from './PrimeManage';
import PrimeCheckout from './PrimeCheckout';
import UnavailableDialog from '../utils/UnavailableDialog';
import { MODALS } from '../../routing/codec';
import { closeModal } from '../../routing/navigate';
import { selectNavLocation } from '../../routing/selectors';
import { selectDevice } from '../../selectors';

const CloseOnMount = ({ onMount }) => {
  useEffect(() => { onMount(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
};

const Prime = (props) => {
  // the Stripe redirect's result, consumed from the URL by the navigation effects
  const { device, dispatch, modal, profile, stripeResult } = props;
  // the device last seen with a subscription on this page
  const subscribedDevice = useRef(null);
  // only Prime's own dialogs depend on the subscription; any other dialog
  // over this page belongs to ModalHost
  const primeDialog = modal === MODALS.PRIME_CANCEL || modal === MODALS.PRIME_CHANGE_PLAN;
  const stripeCancelled = stripeResult?.cancelled ?? null;
  const stripeSuccess = stripeResult?.success ?? null;

  if (!profile) {
    return null;
  }

  if (!device.is_owner && !profile.superuser) {
    return (<Typography>No access</Typography>);
  }
  if (device.prime || stripeSuccess) {
    subscribedDevice.current = device.dongle_id;
    return (<PrimeManage stripeSuccess={ stripeSuccess } />);
  }
  return (
    <>
      <PrimeCheckout stripeCancelled={ stripeCancelled } />
      {/* cancel / change-plan links need an existing subscription; once one
          ends while its dialog is open, the dialog just closes */}
      {primeDialog && (subscribedDevice.current === device.dongle_id
        ? <CloseOnMount onMount={() => dispatch(closeModal())} />
        : <UnavailableDialog message="This device has no comma prime subscription." onClose={() => dispatch(closeModal())} />)}
    </>
  );
};

const stateToProps = (state) => ({
  subscription: state.subscription,
  device: selectDevice(state),
  profile: state.profile,
  stripeResult: state.primeStripeResult,
  modal: selectNavLocation(state)?.modal?.kind ?? null,
});

export default connect(stateToProps)(Prime);
