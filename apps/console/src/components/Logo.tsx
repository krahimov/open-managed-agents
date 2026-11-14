import { useId } from "react";

import { BRAND_NAME } from "@/lib/brand";

const SIZE_PX = {
  sm: 24,
  md: 28,
  lg: 36,
  xl: 48,
} as const;

interface LogoProps {
  size?: keyof typeof SIZE_PX;
  /**
   * `tile` (default): the mark in cream on an ink squircle, with the orbiting
   * body lit by the wash gradient. `bare`: just the mark in currentColor, for
   * tight inline spots.
   */
  variant?: "tile" | "bare";
  className?: string;
}

/**
 * The Orrery mark: a ring, a hand from the hub, and a body on the ring.
 * Geometry is public/logo.svg's 64-grid halved. Muse presents it as an ink
 * tile; the body carries the peach → rose → lilac wash, the brand's one
 * signature colour moment in the chrome.
 */
export function Logo({ size = "sm", variant = "tile", className = "" }: LogoProps) {
  const px = SIZE_PX[size];
  const gid = useId();
  const tile = variant === "tile";
  return (
    <svg
      width={px}
      height={px}
      viewBox="0 0 32 32"
      role="img"
      aria-label={BRAND_NAME}
      className={`shrink-0 ${tile ? "" : "text-fg"} ${className}`.trim()}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#f6b98a" />
          <stop offset="0.55" stopColor="#f08fa6" />
          <stop offset="1" stopColor="#b9a0f5" />
        </linearGradient>
      </defs>
      {tile && <rect width="32" height="32" rx="9.5" fill="var(--ink)" />}
      <g
        transform={tile ? "translate(16 16) scale(0.72) translate(-16 -16)" : undefined}
        style={{ color: tile ? "var(--on-ink)" : undefined }}
      >
        <g stroke="currentColor" strokeWidth="2.75" strokeLinecap="round" strokeLinejoin="round" fill="none">
          <path d="M16 16l6-6" />
          <circle cx="16" cy="16" r="8.5" />
        </g>
        <circle cx="16" cy="16" r="2.25" fill="currentColor" />
        <circle cx="22" cy="10" r="4" fill={`url(#${gid})`} stroke={tile ? "var(--ink)" : "var(--bg)"} strokeWidth="1.5" />
      </g>
    </svg>
  );
}
