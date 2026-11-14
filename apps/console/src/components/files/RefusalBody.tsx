import { Fragment } from "react";
import { ArrowUpRightIcon } from "lucide-react";

import { inlineLink } from "@/lib/links";
import { cn } from "@/lib/utils";

import type { Segment } from "./refusal";

/** The words of a refused-file notice; a link (to the docs) opens beside the page, so the draft stays. */
export function RefusalBody({ body }: { body: Segment[] }) {
  return (
    <>
      {body.map((s, i) =>
        typeof s === "string" ? (
          <Fragment key={i}>{s}</Fragment>
        ) : "link" in s ? (
          <a key={i} href={s.href} target="_blank" rel="noopener noreferrer" className={cn(inlineLink, "whitespace-nowrap")}>
            {s.link}
            <ArrowUpRightIcon className="ml-0.5 inline size-3 align-[-1px]" aria-hidden="true" />
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        ) : (
          <code key={i} className="font-mono text-xs whitespace-nowrap text-fg">
            {s.code}
          </code>
        ),
      )}
    </>
  );
}
