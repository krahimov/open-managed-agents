import { useEffect, useState } from "react";

const visibleNow = () => typeof document === "undefined" || document.visibilityState !== "hidden";

/**
 * Whether this tab is in front (`document.visibilityState`). Live views use
 * it to let go of what they hold while nobody can see them: a desktop
 * viewer disconnects, a picture stops being retaken.
 */
export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(visibleNow);
  useEffect(() => {
    const onChange = () => setVisible(visibleNow());
    onChange();
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return visible;
}
