import { useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Confirmation for an action that cannot be undone (delete, revoke) or
 * that changes what others see (archive, disable). Replaces
 * `window.confirm`.
 *
 *   const [target, setTarget] = useState<Agent | null>(null);
 *   <ConfirmDialog
 *     open={!!target}
 *     onClose={() => setTarget(null)}
 *     title={`Delete ${target?.name}?`}
 *     body="Its sessions stay in history, but the agent and its versions are removed. This cannot be undone."
 *     confirmLabel="Delete agent"
 *     destructive
 *     onConfirm={async () => { await api(…); refresh(); }}
 *   />
 *
 * Copy: the title is the question, naming the thing. The body says what
 * happens and whether it can be undone. The confirm button repeats the
 * verb ("Delete agent"), never "OK" or "Yes". Cancel is always the quiet
 * button on the left; focus starts on Cancel for destructive actions.
 */
export function ConfirmDialog({
  open,
  onClose,
  title,
  body,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  /** May be async: the confirm button shows a loader until it settles.
   *  The dialog closes on success and stays open if it throws. */
  onConfirm: () => void | Promise<void>;
}) {
  const [working, setWorking] = useState(false);
  const confirm = async () => {
    setWorking(true);
    try {
      await onConfirm();
      onClose();
    } catch {
      // The API client already raised a toast; keep the dialog open.
    } finally {
      setWorking(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(next) => !next && !working && onClose()}>
      <DialogContent showCloseButton={false} className="sm:max-w-[420px]">
        <DialogHeader className="pr-0">
          <DialogTitle>{title}</DialogTitle>
          {body && <DialogDescription>{body}</DialogDescription>}
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={working} autoFocus={destructive}>
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? "destructive" : "default"}
            onClick={() => void confirm()}
            loading={working}
            className={destructive ? "border-transparent bg-danger text-white hover:bg-danger/90 dark:text-[oklch(0.2_0.03_20)]" : undefined}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
