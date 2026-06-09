const SIZE: Record<"sm" | "md" | "lg", { dot: string; gap: string }> = {
  sm: { dot: "size-1", gap: "gap-1" },
  md: { dot: "size-1.5", gap: "gap-1.5" },
  lg: { dot: "size-2", gap: "gap-2" },
};

interface BrandLoaderProps {
  size?: keyof typeof SIZE;
  /** Optional accessible label. Defaults to "Loading". */
  label?: string;
  className?: string;
}

export function BrandLoader({ size = "md", label = "Loading", className = "" }: BrandLoaderProps) {
  const s = SIZE[size];
  return (
    <span
      role="status"
      aria-label={label}
      className={`inline-flex items-center ${s.gap} text-brand select-none ${className}`.trim()}
    >
      <span className={`brand-loader-dot rounded-full bg-current ${s.dot}`} style={{ animationDelay: "0ms" }} />
      <span className={`brand-loader-dot rounded-full bg-current ${s.dot}`} style={{ animationDelay: "160ms" }} />
      <span className={`brand-loader-dot rounded-full bg-current ${s.dot}`} style={{ animationDelay: "320ms" }} />
    </span>
  );
}
