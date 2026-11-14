import { useEffect, useState } from "react";
import { ChevronsUpDownIcon, PlusIcon, CheckIcon } from "lucide-react";

import { useApi, getActiveTenantId, setActiveTenantId } from "../lib/api";
import { useApiQuery } from "../lib/useApiQuery";
import { Modal } from "./Modal";
import { Field } from "./Field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar } from "./Avatar";
import { Tip } from "./Tip";
import { failureSentence } from "../lib/failure-text";

// Slot beneath the logo in the sidebar. Opens a dropdown with all
// memberships + "Create workspace" button. Switching writes
// localStorage and reloads the page so every already-mounted query
// refetches under the new tenant.
//
// Built on shadcn DropdownMenu (Radix → Floating UI under the hood):
// the popover auto-flips between top/bottom and shifts on the cross
// axis when it would otherwise collide with the viewport, so nothing
// gets clipped no matter where the trigger sits in the sidebar (top,
// middle, or bottom). The earlier hand-rolled `bottom-full mb-1`
// version assumed "always upward, always fits" and broke whenever
// the sidebar shrank or the dropdown grew past the available space.

interface Tenant {
  id: string;
  name: string;
  role: string;
}

function displayName(t: Tenant): string {
  const trimmed = (t.name ?? "").trim();
  if (!trimmed || trimmed === "'s workspace" || trimmed.startsWith("'s ")) {
    // No usable name: fall back to the id, title-cased so it reads as one.
    return t.id ? t.id[0].toUpperCase() + t.id.slice(1) : "Workspace";
  }
  return trimmed;
}

/**
 * What a workspace's tile is lettered from. A one-word name gets ONE
 * letter ("Default" → "D"), the way workspace tiles are drawn everywhere:
 * its first two letters ("DE") read as an abbreviation of something else.
 * A name of several words keeps an initial from each of the first two
 * ("Lumen Analytics" → "LA"), which <Avatar> does by itself.
 */
export function workspaceMonogram(name: string): string {
  const words = name.replace(/[^\p{L}\p{N}\s]/gu, " ").trim().split(/\s+/).filter(Boolean);
  return words.length === 1 ? words[0][0] : name;
}

/** `compact` is the rail form: the workspace's avatar alone, named by a tooltip, with the menu beside it. */
export function TenantSwitcher({ compact = false }: { compact?: boolean }) {
  const [active, setActive] = useState<string>("");
  const [createOpen, setCreateOpen] = useState(false);

  // TQ replaces the previous mount-once useEffect that hand-rolled a fetch
  // + setState. Dedup means a re-mount (sidebar collapse/expand) reuses the
  // cached membership list rather than re-hitting /v1/me/tenants. A 401 on
  // first paint (pre-auth) is silenced by useApi's auth-error list.
  const { data: tenantsRes } = useApiQuery<{ data: Tenant[] }>(
    "/v1/me/tenants",
  );
  const tenants = tenantsRes?.data ?? [];

  // Sync the active-tenant pin once the membership list lands. The
  // localStorage pin is the source of truth across page loads; on first
  // visit (or when the stored id is no longer a valid membership) we
  // fall back to whichever tenant the backend resolved (its own fallback
  // chain ends at user.tenantId).
  useEffect(() => {
    if (tenants.length === 0) return;
    const stored = getActiveTenantId();
    if (stored && tenants.some((t) => t.id === stored)) {
      setActive(stored);
    } else {
      setActive(tenants[0].id);
      setActiveTenantId(tenants[0].id);
    }
  }, [tenants]);

  const switchTo = (id: string) => {
    setActiveTenantId(id);
    // Full reload — cheaper than threading active-tenant context through
    // every page's query state. Acceptable cost: sub-second on modern HW.
    window.location.reload();
  };

  // Always render the row — even before `/v1/me/tenants` resolves —
  // so the sidebar layout doesn't change height between empty and
  // loaded states. Previously this returned null pre-fetch, which made
  // the SidebarFooter shorter on first paint and then grew by 44 px
  // when tenants landed, shifting the user-profile row below it
  // downward in a visible "jump together with the avatar" twitch.
  const current = tenants.find((t) => t.id === active);

  // `current` resolves on the second pass (after the useEffect picks
  // the active tenant from the loaded list). Until then the row holds
  // its 44 px footprint with a brand-tinted skeleton avatar so the
  // only visual change when data lands is the initial letter + name
  // appearing on top of the existing block.
  const ready = current != null;

  return (
    <>
      <DropdownMenu>
        {compact ? (
          <Tip label={ready ? displayName(current) : null} side="right">
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Switch workspace"
                disabled={!ready}
                className="flex size-9 shrink-0 items-center justify-center rounded-md transition-quick hover:bg-bg-hover disabled:cursor-default disabled:hover:bg-transparent aria-expanded:bg-bg-hover"
              >
                {ready ? (
                  <Avatar name={workspaceMonogram(displayName(current))} size="sm" squared />
                ) : (
                  <div className="size-6 shrink-0 rounded-[30%] bg-bg-pressed" aria-hidden="true" />
                )}
              </button>
            </DropdownMenuTrigger>
          </Tip>
        ) : (
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Switch workspace"
              disabled={!ready}
              className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-full pr-2 pl-1.5 text-left transition-quick hover:bg-bg-hover disabled:cursor-default disabled:hover:bg-transparent aria-expanded:bg-bg-hover"
            >
              {ready ? (
                <Avatar name={workspaceMonogram(displayName(current))} size="sm" squared />
              ) : (
                <div className="size-6 shrink-0 rounded-[30%] bg-bg-pressed" aria-hidden="true" />
              )}
              <span className="min-w-0 flex-1 truncate text-small-size font-medium text-fg">
                {ready ? displayName(current) : "\u00A0"}
              </span>
              {ready && <ChevronsUpDownIcon className="size-3.5 shrink-0 text-fg-faint" aria-hidden="true" />}
            </button>
          </DropdownMenuTrigger>
        )}
        {/* `side="bottom"` is the preferred placement; Radix auto-flips
            to top if the dropdown would overflow the viewport. `align`
            anchors the popover's left edge to the trigger; the menu
            width matches the trigger width (--radix-dropdown-menu-
            trigger-width). collisionPadding keeps a small breathing
            margin from viewport edges. */}
        <DropdownMenuContent
          side={compact ? "right" : "top"}
          align={compact ? "end" : "start"}
          sideOffset={compact ? 10 : 6}
          collisionPadding={8}
          className="max-h-80 w-64 overflow-y-auto"
        >
          <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
          {tenants.map((t) => (
            <DropdownMenuItem key={t.id} onSelect={() => switchTo(t.id)} className="gap-2.5 py-2">
              <Avatar name={workspaceMonogram(displayName(t))} size="sm" squared />
              <div className="min-w-0 flex-1 leading-tight">
                <div className="truncate text-small-size font-medium">{displayName(t)}</div>
                <div className="mt-0.5 truncate text-xs text-fg-subtle capitalize">{t.role}</div>
              </div>
              {t.id === active && <CheckIcon className="size-4 shrink-0 text-fg!" />}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setCreateOpen(true)}>
            <PlusIcon />
            Create workspace
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <CreateTenantModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(t) => {
          // Optimistic: append to list and switch immediately. The reload
          // ensures every page refetches with the new tenant header.
          setActiveTenantId(t.id);
          window.location.reload();
        }}
      />
    </>
  );
}

function CreateTenantModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (t: Tenant) => void;
}) {
  const { api } = useApi();
  const [name, setName] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setWorking(true);
    setError("");
    try {
      const res = await api<Tenant>("/v1/tenants", {
        method: "POST",
        body: JSON.stringify({ name: trimmed }),
      });
      onCreated(res);
    } catch (err) {
      setError(failureSentence(err));
      setWorking(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Create workspace"
      subtitle="An isolated home for agents, sessions, vaults and integrations. You will be its owner."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={working}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!name.trim()} loading={working} loadingLabel="Creating…">
            Create workspace
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name" error={error || undefined}>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="e.g. Acme Production"
            autoFocus
            disabled={working}
            autoComplete="off"
          />
        </Field>
      </div>
    </Modal>
  );
}
