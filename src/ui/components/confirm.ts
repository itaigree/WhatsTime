import { h, uid } from '../dom';

export interface ConfirmOptions {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
}

/**
 * In-page replacement for window.confirm(), which embedded views (and some
 * installed-app modes) block. Resolves true only when the user confirms;
 * Cancel, Escape and closing the dialog resolve false.
 */
export function confirmDialog({ title, body, confirmLabel, danger = false }: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const titleId = uid('confirm-title');
    const bodyId = uid('confirm-body');
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    let settled = false;

    const finish = (result: boolean): void => {
      if (settled) return;
      settled = true;
      dialog.close();
      dialog.remove();
      returnFocus?.focus();
      resolve(result);
    };

    const cancelButton = h('button', { type: 'button', class: 'btn btn-secondary', onClick: () => finish(false) }, 'Cancel');
    const confirmButton = h(
      'button',
      { type: 'button', class: danger ? 'btn btn-danger-solid' : 'btn btn-primary', onClick: () => finish(true) },
      confirmLabel,
    );
    const dialog = h(
      'dialog',
      { class: 'dialog', 'aria-labelledby': titleId, 'aria-describedby': bodyId },
      // The padded inner box means a click whose target is the <dialog> itself landed on the backdrop.
      h(
        'div',
        { class: 'dialog-inner' },
        h('h2', { class: 'dialog-title', id: titleId }, title),
        h('p', { class: 'dialog-body', id: bodyId }, body),
        h('div', { class: 'dialog-actions' }, cancelButton, confirmButton),
      ),
    );
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      finish(false);
    });
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) finish(false);
    });

    document.body.append(dialog);
    dialog.showModal();
    cancelButton.focus();
  });
}
