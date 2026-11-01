import ReactMarkdown from "react-markdown";
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

export function Markdown({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        pre: ({ children }) => (
          <pre className="bg-bg-inset rounded-xl px-4 py-3.5 overflow-x-auto my-3 text-[12.5px] leading-relaxed">
            {children}
          </pre>
        ),
        code: ({ className, children, ...props }) => {
          const isInline = !className;
          if (isInline) {
            return (
              <code className="bg-fill px-1.5 py-0.5 rounded-md text-[0.86em] font-mono" {...props}>
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
        ul: ({ children }) => <ul className="list-disc pl-5 my-2 marker:text-fg-subtle">{children}</ul>,
        ol: ({ children }) => <ol className="list-decimal pl-5 my-2 marker:text-fg-subtle">{children}</ol>,
        li: ({ children }) => <li className="my-0.5">{children}</li>,
        h1: ({ children }) => <h1 className="font-display text-[22px] leading-7 font-bold tracking-[-0.022em] mt-5 mb-2 text-fg">{children}</h1>,
        h2: ({ children }) => <h2 className="font-display text-[18px] leading-6 font-bold tracking-[-0.018em] mt-4 mb-1.5 text-fg">{children}</h2>,
        h3: ({ children }) => <h3 className="font-semibold mt-3 mb-1 text-fg">{children}</h3>,
        blockquote: ({ children }) => (
          <blockquote className="border-l-2 border-border-strong pl-3 my-2 text-fg-muted">{children}</blockquote>
        ),
        table: ({ children }) => (
          <table className="border-collapse my-2 text-sm w-full">{children}</table>
        ),
        th: ({ children }) => (
          <th className="border-b border-border-strong px-3 py-2 text-left text-fg font-semibold">{children}</th>
        ),
        td: ({ children }) => (
          <td className="border-b border-border px-3 py-2 text-fg">{children}</td>
        ),
      }}
    >
      {children}
    </ReactMarkdown>
  );
}
