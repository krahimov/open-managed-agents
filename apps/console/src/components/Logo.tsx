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
  return (
    <svg
      width={px}
      height={px}
      viewBox="0 0 32 32"
      role="img"
      aria-label={BRAND_NAME}
      className={`shrink-0 text-brand ${className}`.trim()}
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Orrery mark: ring + hand from the hub, coral body on the ring.
          Geometry is public/logo.svg's 64-grid halved; ink follows
          currentColor so the sidebar/theme tints it, the orbiting body
          keeps the brand coral. */}
      <g
        stroke="currentColor"
        strokeWidth="2.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      >
        <path d="M16 16l6-6" />
        <circle cx="16" cy="16" r="8.5" />
      </g>
      <circle cx="16" cy="16" r="2.25" fill="currentColor" />
      <circle cx="22" cy="10" r="3.5" fill="#d9564a" />
    </svg>
  );
}
