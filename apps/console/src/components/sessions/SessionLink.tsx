import type { MouseEvent, ReactNode } from "react";
import { toast } from "sonner";
import { DownloadIcon } from "lucide-react";

import {
  downloadSessionOutput,
  refreshSessionOutputs,
  resolveOutputLink,
  sessionOutputUrl,
  useSessionOutputs,
} from "@/lib/session-outputs";

/**
 * A link in an agent's message, inside a session.
 *
 * Agents name the files they wrote as `sandbox:/mnt/session/outputs/x.md`,
 * `/mnt/session/outputs/x.md` or a bare `x.md`. None of these is a page the
 * browser can open (a bare name would send the console to a route that does
 * not exist), so such a link downloads the file through the session's
 * outputs instead, with the same sign-in the rest of the console sends. A
 * name that is not (yet) among the outputs is looked up again on click,
 * since the reply can arrive before the turn's files are listed. A path the
 * outputs cannot serve (elsewhere in the sandbox) says so instead of going
 * anywhere. Every other link opens in a new tab.
 */

const LINK = "rounded-sm py-1 text-plum underline decoration-plum/40 underline-offset-3 transition-quick hover:decoration-plum";

export function SessionLink({ sessionId, href, children }: { sessionId: string; href?: string; children?: ReactNode }) {
  const { outputs } = useSessionOutputs(sessionId);
  const target = resolveOutputLink(href, outputs);

  // A link whose address was dropped (a sign-in route) is just its words.
  if (!href) return <span>{children}</span>;
  if (!target) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={LINK}>
        {children}
      </a>
    );
  }

  const onClick = async (e: MouseEvent<HTMLAnchorElement>) => {
    // Always: a sandbox path must never reach the router.
    e.preventDefault();
    if (target.kind === "output") {
      void downloadSessionOutput(sessionId, target.filename);
      return;
    }
    if (target.kind === "relative") {
      const fresh = await refreshSessionOutputs(sessionId);
      if (fresh.some((o) => o.filename === target.path)) void downloadSessionOutput(sessionId, target.path);
      else toast.error(`“${target.path}” is not among this session's files.`);
      return;
    }
    toast.info(`“${target.path}” is in the agent's sandbox, where it cannot be downloaded. Ask the agent to save it in its outputs folder.`);
  };

  if (target.kind === "unavailable") {
    return (
      <a
        href="#"
        onClick={onClick}
        data-output-link="unavailable"
        title="This file is in the agent's sandbox"
        className="cursor-help rounded-sm py-1 text-fg-muted underline decoration-fg-faint decoration-dotted underline-offset-3"
      >
        {children}
      </a>
    );
  }

  const name = target.kind === "output" ? target.filename : target.path;
  return (
    <a
      // A real address for a known file, so "Copy link" means something; the
      // click itself is taken over (sign-in headers, always a download).
      href={target.kind === "output" ? sessionOutputUrl(sessionId, target.filename) : "#"}
      onClick={onClick}
      data-output-link={target.kind}
      title={`Download ${name}`}
      className={LINK}
    >
      {children}
      <DownloadIcon className="ml-0.5 inline size-3.5 align-[-2px]" aria-hidden="true" />
    </a>
  );
}
