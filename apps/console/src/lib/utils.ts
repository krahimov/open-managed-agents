import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * tailwind-merge has to be told about Muse's custom utilities, or it
 * guesses wrong: by default it reads `text-h2` as a text COLOUR and drops
 * it when a real colour (`text-fg`) follows in the same `cn()` call.
 *
 *   - `text-*` type roles are font sizes (index.css @theme --text-*).
 *   - `shadow-[var(--shadow-*)]` is a box-shadow, so `shadow-none` and a
 *     different elevation override it.
 *   - `transition-quick` / `transition-base` are transition-property sets.
 *
 * Add a name here whenever you add a `--text-*` role to index.css.
 */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ["display", "hero", "stat", "h1", "h2", "h3", "prose", "body", "small", "small-size", "caption", "caption-size", "micro", "micro-size", "body-size"],
    },
    classGroups: {
      shadow: [{ shadow: [(value: string) => value.startsWith("[var(--shadow-")] }],
      transition: [{ transition: ["quick", "base"] }],
    },
  },
});

/**
 * Class merger used everywhere. clsx normalizes a mixed argument list
 * (strings, conditionals, arrays, objects); twMerge resolves conflicting
 * Tailwind utilities so the *last* one wins
 * (e.g., `cn("p-2", "p-4")` → `"p-4"`).
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
