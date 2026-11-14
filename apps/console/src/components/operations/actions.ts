import { useCallback, useState } from "react";

import { useApi } from "@/lib/api";
import { failureSentence } from "@/lib/failure-text";

/**
 * What a person can do from the Operations page: decide an approval, retry
 * or discard failed work, stop a session, pause or stop a mission. Every
 * action is a POST to an existing operations endpoint, one at a time, and
 * the report is re-read before the control is released, so a decided item
 * leaves the queue instead of flickering back.
 */
export interface ConfirmRequest {
  title: string;
  body: string;
  confirmLabel: string;
  /** Runs when the person confirms. */
  run: () => Promise<unknown>;
}

export interface OperationActions {
  /** The role allows approving, retrying and stopping. */
  canOperate: boolean;
  /** Permissions have loaded: do not flash "no access" before then. */
  accessKnown: boolean;
  /** Nothing can be acted on right now: no access, stale data, or another action in flight. */
  locked: boolean;
  /** `${action}:${scope}` of the action in flight. */
  busy: string | null;
  /** The last action that failed, kept beside the item it belongs to. */
  failure: { scope: string; message: string } | null;
  dismissFailure: () => void;
  /** POST `path`; resolves true when it went through. Never throws. */
  run: (action: string, scope: string, path: string, body?: unknown) => Promise<boolean>;
  /** Ask before an action that interrupts or repeats work. */
  confirm: (request: ConfirmRequest) => void;
}

export function useOperationActions({
  canOperate,
  accessKnown,
  stale,
  refresh,
}: {
  canOperate: boolean;
  accessKnown: boolean;
  /** The report on screen is older than the last failed read. */
  stale: boolean;
  /** Re-read the operations report. */
  refresh: () => Promise<unknown>;
}): OperationActions & { pending: ConfirmRequest | null; closeConfirm: () => void } {
  const { api } = useApi();
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<OperationActions["failure"]>(null);
  const [pending, setPending] = useState<ConfirmRequest | null>(null);

  const run = useCallback(
    async (action: string, scope: string, path: string, body?: unknown) => {
      setBusy(`${action}:${scope}`);
      setFailure(null);
      try {
        await api(path, {
          method: "POST",
          body: body === undefined ? undefined : JSON.stringify(body),
          silentErrors: true,
        });
        await refresh().catch(() => undefined);
        return true;
      } catch (err) {
        setFailure({ scope, message: err instanceof Error ? failureSentence(err) : "The action was not completed." });
        // The item may have changed under us (decided elsewhere, already retried): show what is true now.
        void refresh().catch(() => undefined);
        return false;
      } finally {
        setBusy(null);
      }
    },
    [api, refresh],
  );

  return {
    canOperate,
    accessKnown,
    locked: !canOperate || stale || busy !== null,
    busy,
    failure,
    dismissFailure: () => setFailure(null),
    run,
    confirm: setPending,
    pending,
    closeConfirm: () => setPending(null),
  };
}
