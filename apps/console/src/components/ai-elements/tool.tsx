"use client";

import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import {
  CheckCircleIcon,
  ChevronDownIcon,
  CircleIcon,
  ClockIcon,
  WrenchIcon,
  XCircleIcon,
} from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { isValidElement } from "react";

import { CodeBlock } from "./code-block";

export type ToolProps = ComponentProps<typeof Collapsible>;

export const Tool = ({ className, ...props }: ToolProps) => (
  <Collapsible
    // Xcode build-log style disclosure row: compact, a quiet grouped
    // surface, expands in place.
    className={cn("group not-prose mb-1 w-full max-w-2xl rounded-[10px] bg-bg-surface shadow-[var(--shadow-sm)] data-[state=open]:shadow-[var(--shadow-md)] transition-shadow duration-[var(--dur-base)]", className)}
    {...props}
  />
);

export type ToolPart = ToolUIPart | DynamicToolUIPart;

export type ToolHeaderProps = {
  title?: string;
  className?: string;
  /** Overrides the badge text for the given state (e.g. "Waiting for
   *  client result" on the approval-requested visual). */
  statusLabel?: string;
} & (
  | { type: ToolUIPart["type"]; state: ToolUIPart["state"]; toolName?: never }
  | {
      type: DynamicToolUIPart["type"];
      state: DynamicToolUIPart["state"];
      toolName: string;
    }
);

const statusLabels: Record<ToolPart["state"], string> = {
  "approval-requested": "Awaiting Approval",
  "approval-responded": "Responded",
  "input-available": "Running",
  "input-streaming": "Pending",
  "output-available": "Completed",
  "output-denied": "Denied",
  "output-error": "Error",
};

const statusIcons: Record<ToolPart["state"], ReactNode> = {
  "approval-requested": <ClockIcon className="size-3 text-warning" />,
  "approval-responded": <CheckCircleIcon className="size-3 text-brand" />,
  "input-available": <ClockIcon className="size-3 text-info animate-pulse" />,
  "input-streaming": <CircleIcon className="size-3" />,
  "output-available": <CheckCircleIcon className="size-3 text-success" />,
  "output-denied": <XCircleIcon className="size-3 text-warning" />,
  "output-error": <XCircleIcon className="size-3 text-danger" />,
};

export const getStatusBadge = (status: ToolPart["state"], label?: string) => (
  <Badge className="gap-1 rounded-full text-[11px] py-0 h-[18px] px-1.5 font-medium text-fg-muted" variant="secondary">
    {statusIcons[status]}
    {label ?? statusLabels[status]}
  </Badge>
);

export const ToolHeader = ({
  className,
  title,
  type,
  state,
  toolName,
  statusLabel,
  ...props
}: ToolHeaderProps) => {
  const derivedName =
    type === "dynamic-tool" ? toolName : type.split("-").slice(1).join("-");

  return (
    <CollapsibleTrigger
      className={cn(
        "flex w-full items-center justify-between gap-3 px-3 h-9 rounded-[10px] outline-none hover:bg-bg-hover focus-visible:ring-[3px] focus-visible:ring-system-accent/45",
        className
      )}
      {...props}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span className="inline-flex size-5 items-center justify-center rounded-[5px] bg-bg-inset text-fg-muted shadow-[inset_0_0_0_0.5px_var(--border)] shrink-0">
          <WrenchIcon className="size-3" />
        </span>
        <span className="font-mono font-medium text-[12px] text-fg truncate">{title ?? derivedName}</span>
        {getStatusBadge(state, statusLabel)}
      </div>
      <ChevronDownIcon className="size-3.5 text-fg-subtle -rotate-90 transition-transform duration-[var(--dur-base)] group-data-[state=open]:rotate-0 shrink-0" />
    </CollapsibleTrigger>
  );
};

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export const ToolContent = ({ className, ...props }: ToolContentProps) => (
  <CollapsibleContent
    className={cn(
      "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 space-y-2 px-3 pb-3 text-popover-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
      className
    )}
    {...props}
  />
);

export type ToolInputProps = ComponentProps<"div"> & {
  input: ToolPart["input"];
};

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => {
  // Single-key "command" input (bash, exec, etc.) renders as an inline
  // shell-style line — `pwd` instead of a 4-line JSON block. The wrapped
  // chrome (PARAMETERS label + bordered code box) was overkill for the
  // common case where the input is one short string.
  if (
    input
    && typeof input === "object"
    && !Array.isArray(input)
    && Object.keys(input).length === 1
  ) {
    const k = Object.keys(input)[0];
    const v = (input as Record<string, unknown>)[k];
    if (typeof v === "string" && v.length < 200 && !v.includes("\n")) {
      return (
        <div className={cn("font-mono text-[12.5px] text-fg", className)} {...props}>
          <span className="text-fg-subtle select-none">{k}: </span>
          <span>{v}</span>
        </div>
      );
    }
  }
  return (
    <div className={cn("overflow-hidden", className)} {...props}>
      <div className="rounded-[8px] bg-bg-inset">
        <CodeBlock code={JSON.stringify(input, null, 2)} language="json" />
      </div>
    </div>
  );
};

export type ToolOutputProps = ComponentProps<"div"> & {
  output: ToolPart["output"];
  errorText: ToolPart["errorText"];
};

export const ToolOutput = ({
  className,
  output,
  errorText,
  ...props
}: ToolOutputProps) => {
  if (!(output || errorText)) {
    return null;
  }

  // String output that isn't structured JSON → inline mono preview, no
  // syntax-highlighter chrome. CodeBlock with language="json" was making
  // every shell stdout look like a syntax-error.
  if (typeof output === "string" && !errorText) {
    const looksLikeJson = output.trimStart().startsWith("{") || output.trimStart().startsWith("[");
    if (!looksLikeJson) {
      return (
        <div
          className={cn(
            "rounded-[8px] bg-bg-inset px-3 py-2 text-[12px] font-mono text-fg whitespace-pre-wrap break-words max-h-64 overflow-y-auto",
            className,
          )}
          {...props}
        >
          {output}
        </div>
      );
    }
  }

  let Output = <div>{output as ReactNode}</div>;

  if (typeof output === "object" && !isValidElement(output)) {
    Output = (
      <CodeBlock code={JSON.stringify(output, null, 2)} language="json" />
    );
  } else if (typeof output === "string") {
    Output = <CodeBlock code={output} language="json" />;
  }

  return (
    <div className={cn("space-y-1", className)} {...props}>
      <div
        className={cn(
          "overflow-x-auto rounded-[8px] text-xs [&_table]:w-full",
          errorText
            ? "bg-danger-subtle text-danger px-3 py-2"
            : "bg-bg-inset text-foreground"
        )}
      >
        {errorText && <div>{errorText}</div>}
        {Output}
      </div>
    </div>
  );
};
