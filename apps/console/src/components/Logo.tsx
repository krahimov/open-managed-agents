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
      <rect
        x="5"
        y="5"
        width="22"
        height="22"
        rx="6"
        fill="currentColor"
        opacity="0.12"
      />
      <path
        d="M10 21.5 15.2 10.5 18.7 18.2 22 12.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="10" cy="21.5" r="2" fill="currentColor" />
      <circle cx="15.2" cy="10.5" r="2" fill="currentColor" />
      <circle cx="18.7" cy="18.2" r="2" fill="currentColor" />
      <circle cx="22" cy="12.2" r="2" fill="currentColor" />
    </svg>
  );
}
