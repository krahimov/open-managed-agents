import type { ReactNode } from "react";

import { Page } from "../Page";
import { PageHeader } from "../PageHeader";
import { ErrorState } from "../QueryProblem";

/**
 * A list page whose read failed. Keeps the page's title and subtitle so
 * the person still knows where they are, and replaces the table with an
 * error block that says what could not be loaded and offers a retry.
 * (`DataTable` has no error state of its own: with no rows it would show
 * the first-run empty state, which is the wrong message.)
 *
 *   if (error && items.length === 0)
 *     return <ResourceListError title="Vaults" subtitle="…" what="Vaults" error={error} retry={refresh} />;
 */
export function ResourceListError({
  title,
  subtitle,
  what,
  error,
  retry,
}: {
  title: string;
  subtitle?: ReactNode;
  /** Plural noun for the message: "Environments could not be loaded". */
  what: string;
  error: unknown;
  retry?: () => unknown;
}) {
  return (
    <Page width="wide" header={<PageHeader title={title} subtitle={subtitle} width="wide" />}>
      <ErrorState title={`${what} could not be loaded`} error={error} retry={retry} />
    </Page>
  );
}
