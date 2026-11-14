import { StatusBadge, statusDef } from "../../components/Badge";

// The state of an agent's publication into Slack, GitHub or Linear. All
// three providers share one state machine (live | pending_setup |
// credentials_filled | awaiting_install | needs_reauth | unpublished). The
// label and tone for each state live in the product's status vocabulary
// (components/Badge.tsx STATUS); this file only picks the variant.

export type PublicationStatus =
  | "live"
  | "pending_setup"
  /** GitHub-only intermediate: encrypted credentials staged on the row,
   *  install URL not yet rendered. Slack's adapter skips it, but the type
   *  accepts it for symmetry. */
  | "credentials_filled"
  | "awaiting_install"
  | "needs_reauth"
  | "unpublished";

export function publicationStatusLabel(status: PublicationStatus): string {
  return statusDef(status).label;
}

interface StatusPillProps {
  status: PublicationStatus;
  /** Say it another way than the vocabulary does ("1 of 2 waiting for install"). */
  label?: string;
  /** `md` draws the tinted pill used in record headers; `sm` the dot + label for rows. */
  size?: "sm" | "md";
  className?: string;
}

export function StatusPill({ status, label, size = "sm", className }: StatusPillProps) {
  return <StatusBadge status={status} label={label} variant={size === "md" ? "soft" : "dot"} className={className} />;
}
