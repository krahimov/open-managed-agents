import { useMemo } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { createLowlight } from "lowlight";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import bash from "highlight.js/lib/languages/bash";
import json from "highlight.js/lib/languages/json";
import yaml from "highlight.js/lib/languages/yaml";
import python from "highlight.js/lib/languages/python";
import typescript from "highlight.js/lib/languages/typescript";
import javascript from "highlight.js/lib/languages/javascript";
import plaintext from "highlight.js/lib/languages/plaintext";
import { SessionLink } from "./SessionFiles";
import { resolveOutputLink } from "../lib/session-outputs";
import { isOwnOAuthUrl } from "../lib/markdown-urls";

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

const REMARK_PLUGINS = [remarkGfm];

/** Never a live link or image to our own OAuth routes: Markdown here is
 *  untrusted (agent output), and a click would start a sign-in flow. */
function dropOAuthUrls(url: string): string | null {
  return isOwnOAuthUrl(url, window.location.origin) ? null : defaultUrlTransform(url);
}

/** react-markdown blanks hrefs with unknown protocols; keep the ones that
 *  name a sandbox path so SessionLink can turn them into downloads. */
function keepSandboxUrls(url: string): string | null {
  return /^(sandbox|file):/i.test(url) ? url : dropOAuthUrls(url);
}

/**
 * Element renderers. Module-level on purpose: react-markdown keys React
 * elements by component identity, so components defined inside the render
 * function would unmount and rebuild the whole message DOM on every parent
 * re-render (each streamed chunk) — and detach a link mid-click.
 */
const BASE_COMPONENTS: Components = {
  pre: ({ children }) => (
    <pre className="bg-bg-surface border border-border rounded-md p-3 overflow-x-auto my-2 text-[13px]">
      {children}
    </pre>
  ),
  code: ({ className, children, ...props }) => {
    const isInline = !className;
    if (isInline) {
      return (
        <code className="bg-bg-surface px-1 py-0.5 rounded text-[0.85em] font-mono" {...props}>
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
  p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="list-disc pl-5 my-1">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal pl-5 my-1">{children}</ol>,
  li: ({ children }) => <li className="my-0.5">{children}</li>,
  h1: ({ children }) => <h1 className="font-display text-lg font-semibold mt-3 mb-1 text-fg">{children}</h1>,
  h2: ({ children }) => <h2 className="font-display text-base font-semibold mt-2 mb-1 text-fg">{children}</h2>,
  h3: ({ children }) => <h3 className="font-semibold mt-2 mb-1 text-fg">{children}</h3>,
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-border-strong pl-3 my-2 text-fg-muted">{children}</blockquote>
  ),
  table: ({ children }) => (
    <table className="border-collapse my-2 text-sm w-full">{children}</table>
  ),
  th: ({ children }) => (
    <th className="border border-border px-2 py-1 bg-bg-surface text-left text-fg">{children}</th>
  ),
  td: ({ children }) => (
    <td className="border border-border px-2 py-1 text-fg">{children}</td>
  ),
};

export function Markdown({
  children,
  sessionId,
}: {
  children: string;
  /** Session whose agent wrote this text. When set, links to the agent's
   *  output files download them instead of navigating the app. */
  sessionId?: string;
}) {
  const components = useMemo<Components>(() => {
    if (!sessionId) return BASE_COMPONENTS;
    return {
      ...BASE_COMPONENTS,
      a: ({ href, children }) => (
        <SessionLink sessionId={sessionId} href={href}>
          {children}
        </SessionLink>
      ),
      // An image whose src is a sandbox path can't load in the browser —
      // offer it as a download instead of a broken icon.
      img: ({ src, alt }) =>
        typeof src === "string" && resolveOutputLink(src, null) ? (
          <SessionLink sessionId={sessionId} href={src}>
            {alt || src.split("/").pop()}
          </SessionLink>
        ) : (
          <img src={src} alt={alt ?? ""} className="max-w-full rounded" />
        ),
    };
  }, [sessionId]);

  return (
    <ReactMarkdown
      remarkPlugins={REMARK_PLUGINS}
      urlTransform={sessionId ? keepSandboxUrls : dropOAuthUrls}
      components={components}
    >
      {children}
    </ReactMarkdown>
  );
}
