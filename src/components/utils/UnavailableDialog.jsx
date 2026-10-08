import { Button, Modal, Paper, Typography } from '@material-ui/core';

// A dialog URL that cannot be shown for this account or device.
const UnavailableDialog = ({ message, onClose }) => (
  <Modal open onClose={onClose}>
    <Paper className="absolute left-1/2 top-[40%] w-[400px] max-w-[90%] -translate-x-1/2 -translate-y-1/2 p-4">
      <Typography variant="title">Not available</Typography>
      <Typography className="mt-3">{message}</Typography>
      <div className="mt-4">
        <Button variant="contained" onClick={onClose}>
          Close
        </Button>
      </div>
    </Paper>
  </Modal>
);

export default UnavailableDialog;
