import ModalManager from '@material-ui/core/Modal/ModalManager';

// MUI 1's portal mount node is the container, not the dialog root. Its default
// manager therefore hides the active dialog and cannot restore a parent dialog.
// The public manager hook lets it track each clip dialog's actual DOM root.
class ClipModalManager extends ModalManager {
  constructor() {
    super();
    this.entries = new WeakMap();
  }

  entry(modal) {
    if (!this.entries.has(modal)) {
      this.entries.set(modal, {
        get mountNode() {
          return modal.modalRef;
        },
      });
    }
    return this.entries.get(modal);
  }

  add(modal, container) {
    return super.add(this.entry(modal), container);
  }

  remove(modal) {
    return super.remove(this.entry(modal));
  }

  isTopModal(modal) {
    return super.isTopModal(this.entry(modal));
  }
}

export default new ClipModalManager();
