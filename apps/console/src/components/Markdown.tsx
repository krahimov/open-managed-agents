import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { createLowlight } from "lowlight";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { createContext, isValidElement, useContext, useMemo, type ReactNode } from "react";
import bash from "highlight.js/lib/languages/bash";
import json from "highlight.js/lib/languages/json";
import yaml from "highlight.js/lib/languages/yaml";
import python from "highlight.js/lib/languages/python";
import typescript from "highlight.js/lib/languages/typescript";
import javascript from "highlight.js/lib/languages/javascript";
import plaintext from "highlight.js/lib/languages/plaintext";

import { isOwnOAuthUrl } from "@/lib/markdown-urls";
import { resolveOutputLink } from "@/lib/session-outputs";

import { CopyButton } from "./IdChip";
import { SessionLink } from "./sessions/SessionLink";

/**
 * Hand-rolled syntax highlighting registry. Replaces rehype-highlight,
 * which pulls all 36+ languages from lowlight's `common` set (>500 KB
 * gzipped). The console only renders bash/json/yaml/python/ts/js in
 * chat output — registering only those keeps the bundle lean.
 *
 * To add a language: import from `highlight.js/lib/languages/<name>`
 * and add it (plus any aliases) to the createLowlight() call.
 */
const lowlight = createLowlight({
  bash,
  sh: bash,
  shell: bash,
  zsh: bash,
  json,
  yaml,
  yml: yaml,
  python,
  py: python,
  typescript,
  ts: typescript,
  javascript,
  js: javascript,
  jsx: javascript,
  tsx: typescript,
  plaintext,
  text: plaintext,
});

const jsxRuntime = { Fragment, jsx, jsxs } as Parameters<typeof toJsxRuntime>[1];

/** The plain text inside a rendered node, for copying a code block. */
function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children);
  return "";
}

const PRE = "overflow-x-auto rounded-lg bg-bg-inset p-4 font-mono text-small leading-relaxed";

/** The session whose agent wrote the Markdown below, for <OutputLinks>. */
const OutputLinksSession = createContext<string | undefined>(undefined);

/**
 * Inside a session's conversation: links in the agent's words that name a
 * file in its sandbox (`sandbox:/mnt/session/outputs/report.md`, a bare
 * `report.md`) download that file instead of navigating, and an image whose
 * source is a sandbox path is offered as a download instead of a broken
 * picture. The page wraps its conversation in this once; every <Markdown>
 * inside reads it, so the components that draw messages need no prop.
 */
export function OutputLinks({ sessionId, children }: { sessionId: string | undefined; children: ReactNode }) {
  return <OutputLinksSession.Provider value={sessionId || undefined}>{children}</OutputLinksSession.Provider>;
}

/** Never a live link or image to the console's own sign-in routes: Markdown
 *  here is untrusted (an agent wrote it), and a click would start a sign-in. */
function dropOAuthUrls(url: string): string | null {
  return isOwnOAuthUrl(url, window.location.origin) ? null : defaultUrlTransform(url);
}

/** react-markdown blanks links with unknown schemes; keep `sandbox:` and
 *  `file:` ones inside a session, so they can become downloads. */
function keepSandboxUrls(url: string): string | null {
  return /^(sandbox|file):/i.test(url) ? url : dropOAuthUrls(url);
}

const LINK = "rounded-sm py-1 text-plum underline decoration-plum/40 underline-offset-3 transition-quick hover:decoration-plum";

/**
 * Element renderers. Module-level on purpose: react-markdown keys elements
 * by component identity, so components made inside the render would rebuild
 * the whole message on every parent render (each streamed chunk), and
 * detach a link in the middle of a click.
 */
const BASE: Components = {
  a: ({ children, href }) =>
    // A link whose address was dropped (a sign-in route) is just its words.
    href ? (
      // `py-1` grows the target without moving a line (see lib/links.ts).
      <a href={href} target="_blank" rel="noopener noreferrer" className={LINK}>
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  pre: ({ children }) => <pre className={`my-3 ${PRE}`}>{children}</pre>,
  hr: () => <hr className="my-5 border-border" />,
  code: ({ className, children, ...props }) => {
    const isInline = !className;
    if (isInline) {
      return (
        <code className="rounded-sm bg-bg-soft px-1 py-0.5 font-mono text-[0.86em]" {...props}>
          {children}
        </code>
      );
    }
    // Block code with a language hint — apply syntax highlighting if
    // the language is in our registered set, otherwise render plain.
    const langMatch = /language-([\w-]+)/.exec(className || "");
    const lang = langMatch?.[1];
    const codeText = typeof children === "string"
      ? children
      : Array.isArray(children) ? children.join("") : String(children ?? "");
    if (lang && lowlight.registered(lang)) {
      const tree = lowlight.highlight(lang, codeText.replace(/\n$/, ""));
      return (
        <code className={`${className} font-mono hljs`} {...props}>
          {toJsxRuntime(tree, jsxRuntime)}
        </code>
      );
    }
    return (
      <code className={`${className} font-mono`} {...props}>
        {children}
      </code>
    );
  },
  p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
  // GFM task lists ("- [x] done") arrive as a ul.contains-task-list of
  // li.task-list-item with a disabled checkbox inside. Draw them as a
  // checklist: no bullet, a Muse checkbox hung in the margin.
  ul: ({ children, className }) =>
    className?.includes("contains-task-list") ? (
      <ul className="my-3 space-y-1.5">{children}</ul>
    ) : (
      <ul className="my-3 list-disc space-y-1 pl-5 marker:text-fg-faint">{children}</ul>
    ),
  ol: ({ children }) => <ol className="my-3 list-decimal space-y-1 pl-5 marker:text-fg-subtle">{children}</ol>,
  li: ({ children, className }) =>
    className?.includes("task-list-item") ? (
      <li className="relative list-none pl-[1.625rem]">{children}</li>
    ) : (
      <li className="pl-0.5">{children}</li>
    ),
  input: ({ type, checked }) =>
    type === "checkbox" ? (
      <span
        className={`absolute top-[0.32em] left-0 flex size-4 items-center justify-center rounded-[5px] border ${
          checked ? "border-ink bg-ink text-on-ink" : "border-border-strong bg-bg-surface dark:bg-bg-soft"
        }`}
      >
        {checked && (
          <svg viewBox="0 0 12 12" className="size-3" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M2.5 6.4 5 8.8l4.5-5.4" />
          </svg>
        )}
        <span className="sr-only">{checked ? "Done: " : "To do: "}</span>
      </span>
    ) : null,
  h1: ({ children }) => <h1 className="mt-5 mb-2 text-h2 text-fg first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-5 mb-2 text-[1rem] font-semibold tracking-[-0.01em] text-fg first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-4 mb-1.5 text-h3 text-fg first:mt-0">{children}</h3>,
  blockquote: ({ children }) => (
    <blockquote className="my-3 border-l-2 border-border-strong pl-4 text-fg-muted">{children}</blockquote>
  ),
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto rounded-lg border border-border"><table className="w-full border-collapse text-small-size [&_tbody>tr:first-child>td]:border-t-0">{children}</table></div>
  ),
  th: ({ children }) => (
    // A table written with a blank header row gets no header strip.
    <th className="border-b border-border bg-bg-inset px-3 py-2 text-left text-xs font-medium text-fg-muted empty:hidden">{children}</th>
  ),
  td: ({ children }) => (
    <td className="border-t border-border px-3 py-2 text-fg">{children}</td>
  ),
};

/** `copyCode`: a "Copy code" button in the corner of every code block. */
const WITH_COPY: Components = {
  ...BASE,
  pre: ({ children }) => (
    <div className="group/code relative my-3">
      <pre className={PRE}>{children}</pre>
      <span className="absolute top-1.5 right-1.5 opacity-0 transition-quick group-hover/code:opacity-100 focus-within:opacity-100">
        <CopyButton
          value={textOf(children).replace(/\n$/, "")}
          label="Copy code"
          className="border border-border bg-bg-raised shadow-[var(--shadow-xs)] hover:bg-bg-raised"
        />
      </span>
    </div>
  ),
};

const REMARK_PLUGINS = [remarkGfm];

/**
 * `copyCode` puts a "Copy code" button in the corner of every code block.
 * It shows on hover and whenever it holds keyboard focus.
 *
 * `sessionId` (or an enclosing <OutputLinks>) turns links to the agent's
 * files into downloads; without one, links open in a new tab. Links and
 * images to the console's own sign-in routes are never live.
 */
export function Markdown({ children, copyCode = false, sessionId: own }: { children: string; copyCode?: boolean; sessionId?: string }) {
  const fromPage = useContext(OutputLinksSession);
  const sessionId = own ?? fromPage;
  const base = copyCode ? WITH_COPY : BASE;
  const components = useMemo<Components>(() => {
    if (!sessionId) return base;
    return {
      ...base,
      a: ({ href, children }) => (
        <SessionLink sessionId={sessionId} href={href}>
          {children}
        </SessionLink>
      ),
      // A picture whose source is a sandbox path cannot load in the browser.
      img: ({ src, alt }) =>
        typeof src === "string" && resolveOutputLink(src, null) ? (
          <SessionLink sessionId={sessionId} href={src}>
            {alt || src.split("/").pop()}
          </SessionLink>
        ) : (
          <img src={typeof src === "string" ? src : undefined} alt={alt ?? ""} className="max-w-full rounded-lg" />
        ),
    };
  }, [base, sessionId]);
  return (
    <ReactMarkdown remarkPlugins={REMARK_PLUGINS} urlTransform={sessionId ? keepSandboxUrls : dropOAuthUrls} components={components}>
      {children}
    </ReactMarkdown>
  );
}
