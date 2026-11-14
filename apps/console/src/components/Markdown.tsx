import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { createLowlight } from "lowlight";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { isValidElement, type ReactNode } from "react";
import bash from "highlight.js/lib/languages/bash";
import json from "highlight.js/lib/languages/json";
import yaml from "highlight.js/lib/languages/yaml";
import python from "highlight.js/lib/languages/python";
import typescript from "highlight.js/lib/languages/typescript";
import javascript from "highlight.js/lib/languages/javascript";
import plaintext from "highlight.js/lib/languages/plaintext";

import { CopyButton } from "./IdChip";

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

/**
 * `copyCode` puts a "Copy code" button in the corner of every code block.
 * It shows on hover and whenever it holds keyboard focus.
 */
export function Markdown({ children, copyCode = false }: { children: string; copyCode?: boolean }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ children, href }) => (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            // `py-1` grows the target without moving a line (see lib/links.ts).
            className="rounded-sm py-1 text-plum underline decoration-plum/40 underline-offset-3 transition-quick hover:decoration-plum"
          >
            {children}
          </a>
        ),
        hr: () => <hr className="my-5 border-border" />,
        pre: ({ children }) =>
          copyCode ? (
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
          ) : (
            <pre className={`my-3 ${PRE}`}>{children}</pre>
          ),
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
      }}
    >
      {children}
    </ReactMarkdown>
  );
}
