import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

import { onLabelClick } from "./Field";

/**
 * One setting on a settings page or in a config card: what it is and what
 * it does on the left, its control on the right. Stack rows inside a
 * <SectionCard flush> — they draw their own dividers.
 *
 *   <SectionCard title="Networking" flush>
 *     <SettingRow label="Allow MCP servers" description="Agents may reach the MCP servers attached to them.">
 *       <Switch checked={allow} onCheckedChange={setAllow} />
 *     </SettingRow>
 *     <SettingRow label="Network access" description="Which hosts the sandbox can reach.">
 *       <Select …/>
 *     </SettingRow>
 *   </SectionCard>
 *
 * Use it for switches, selects and short inputs that apply on their own.
 * A group of text fields saved together is a form: use <Field>s instead.
 */
export function SettingRow({
  label,
  description,
  children,
  htmlFor,
  className,
}: {
  label: ReactNode;
  description?: ReactNode;
  /** The control. */
  children: ReactNode;
  /** id of the control, so clicking the label focuses/toggles it. */
  htmlFor?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-6 border-t border-border px-5 py-3.5 first:border-t-0",
        className,
      )}
    >
      <div className="min-w-0">
        <label htmlFor={htmlFor} onClick={onLabelClick} className="block text-small-size font-medium text-fg">
          {label}
        </label>
        {description && <p className="mt-0.5 max-w-[60ch] text-small text-fg-muted">{description}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}
