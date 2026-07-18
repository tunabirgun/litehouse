import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";

export interface ConfirmDeleteDialogProps {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  /** While true, both buttons are disabled and Escape/backdrop are inert, so a "Keep" click
   *  cannot race an in-flight delete. */
  busy?: boolean;
  busyLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

// Reusable confirmation for irreversible browser-local deletes. Rendered through a
// portal so a fixed backdrop escapes any transformed ancestor; the destructive
// action is carried by the confirm verb, not by colour alone.
export function ConfirmDeleteDialog({ open, title, body, confirmLabel, busy = false, busyLabel = "Deleting…", onConfirm, onCancel }: ConfirmDeleteDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const onCancelRef = useRef(onCancel);
  const busyRef = useRef(busy);
  const titleId = useId();
  const bodyId = useId();

  // Keep the latest onCancel/busy reachable from Escape without re-running the focus effect.
  useEffect(() => {
    onCancelRef.current = onCancel;
  }, [onCancel]);
  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  useEffect(() => {
    if (!open) return;
    // Remember the element that opened the dialog, then move focus to the safe button.
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusTimer = window.setTimeout(() => cancelRef.current?.focus(), 0);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (busyRef.current) return;
        onCancelRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      // Trap Tab within the dialog's focusable buttons.
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>("button:not(:disabled)")];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1) ?? first;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", onKeyDown);
      // Restore focus to whatever had it before the dialog opened.
      returnFocusRef.current?.focus();
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div
      className="dialog-backdrop lh-confirm-delete-backdrop"
      role="presentation"
      onClick={() => { if (!busy) onCancel(); }}
    >
      <div
        ref={dialogRef}
        className="lh-confirm-delete-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="dialog-header">
          <div><h2 id={titleId}>{title}</h2></div>
        </div>
        <div className="lh-confirm-delete-body">
          <p id={bodyId}>{body}</p>
        </div>
        <div className="lh-confirm-delete-actions">
          <button ref={cancelRef} className="button button-secondary" type="button" onClick={onCancel} disabled={busy}>Keep</button>
          <button className="button button-danger" type="button" onClick={onConfirm} disabled={busy}>{busy ? busyLabel : confirmLabel}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
