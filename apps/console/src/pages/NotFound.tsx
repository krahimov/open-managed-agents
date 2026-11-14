import { Link, useLocation } from "react-router";
import { CompassIcon, HouseIcon, SearchIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

import { EmptyState } from "../components/EmptyState";
import { Kbd } from "../components/Kbd";
import { allNavItems, type NavItem } from "../components/navigation";
import { Page } from "../components/Page";
import { MOD_KEY, openCommandPalette } from "../lib/shell-events";
import { inlineLink } from "@/lib/links";

/**
 * The page for an address that matches no route. It is the same block a
 * missing record draws (a session or agent that no longer exists): what
 * happened, why it usually happens, and a way out. Here the ways out are
 * Home and the command palette, plus the destination the address most
 * looks like when there is one ("/session" → Sessions).
 *
 * It renders inside the shell, so the sidebar and every shortcut still
 * work, and the tab is titled "Page not found · Orrery".
 */

/** Edit distance, capped: a typo or a plural, not a different word. */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const keep = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = keep;
    }
  }
  return row[b.length];
}

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The destination an unknown address most looks like, if any is close. */
function nearestDestination(pathname: string): NavItem | undefined {
  const typed = squash(pathname.split("/").filter(Boolean)[0] ?? "");
  if (typed.length < 3) return undefined;
  let best: { item: NavItem; score: number } | undefined;
  for (const item of allNavItems()) {
    if (item.to === "/") continue;
    const names = [squash(item.to.split("/").pop() ?? ""), squash(item.label)];
    for (const name of names) {
      if (!name) continue;
      const score = name.startsWith(typed) || typed.startsWith(name) ? 0 : distance(typed, name);
      if (score <= 2 && (!best || score < best.score)) best = { item, score };
    }
  }
  return best?.item;
}

export function NotFound() {
  const { pathname } = useLocation();
  const near = nearestDestination(pathname);

  return (
    // Wide, like a list's empty state: the card spans the frame, so the
    // message sits in the middle of the panel at every window width.
    <Page width="wide">
      <div className="pt-5">
        <EmptyState
          size="lg"
          heading="h1"
          icon={<CompassIcon />}
          title="This page does not exist"
          body={
            <>
              <p>
                Nothing lives at{" "}
                <code className="rounded-sm bg-bg-soft px-1 py-0.5 font-mono text-small-size break-all text-fg">{pathname}</code>
                . The link may be out of date, or the address may have a typo.
              </p>
              {near && (
                <p className="mt-2">
                  Were you looking for{" "}
                  <Link to={near.to} className={inlineLink}>
                    {near.label}
                  </Link>
                  ?
                </p>
              )}
            </>
          }
          action={
            <>
              <Button asChild>
                <Link to="/">
                  <HouseIcon data-icon="inline-start" />
                  Go home
                </Link>
              </Button>
              <Button variant="outline" onClick={() => openCommandPalette()}>
                <SearchIcon data-icon="inline-start" />
                Search
                <Kbd keys={[MOD_KEY, "K"]} className="ml-1" />
              </Button>
            </>
          }
        />
      </div>
    </Page>
  );
}
