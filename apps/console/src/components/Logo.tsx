import { BRAND_NAME } from "@/lib/brand";

const SIZE_PX = {
  sm: 24,
  md: 28,
  lg: 32,
} as const;

interface LogoProps {
  size?: keyof typeof SIZE_PX;
  className?: string;
}

export function Logo({ size = "sm", className = "" }: LogoProps) {
  const px = SIZE_PX[size];
  const gid = `orrery-tile-${size}`;
  return (
    <svg
      width={px}
      height={px}
      viewBox="0 0 32 32"
      role="img"
      aria-label={BRAND_NAME}
      className={`shrink-0 ${className}`.trim()}
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Orrery app-icon tile: a graphite squircle (macOS app icon
          proportions) carrying the ring + hand in white, with the
          orbiting body as the one remaining touch of Orrery coral. */}
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" style={{ stopColor: "var(--logo-tile-top, #3a3a40)" }} />
          <stop offset="1" style={{ stopColor: "var(--logo-tile-bottom, #1c1c20)" }} />
        </linearGradient>
      </defs>
      <rect x="0.5" y="0.5" width="31" height="31" rx="8" fill={`url(#${gid})`} />
      <rect x="0.5" y="0.5" width="31" height="31" rx="8" fill="none" stroke="rgb(255 255 255 / 0.12)" />
      <g
        stroke="#ffffff"
        strokeWidth="2.25"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        transform="translate(16 16) scale(0.78) translate(-16 -16)"
      >
        <path d="M16 16l6-6" />
        <circle cx="16" cy="16" r="8.5" />
      </g>
      <circle cx="16" cy="16" r="1.8" fill="#ffffff" />
      <circle cx="20.7" cy="11.3" r="3" style={{ fill: "var(--logo-coral, #e5624f)" }} />
    </svg>
  );
}
