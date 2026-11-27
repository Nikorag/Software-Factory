import { useEffect, useState } from "react";

/** Tracks a CSS media query. Without matchMedia (tests, very old browsers) it reports `false`, i.e. the desktop layout. */
export function useMediaQuery(query: string): boolean {
  const get = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches;
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(query);
    const on = () => setMatches(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return matches;
}

/** Below Tailwind's `md` breakpoint (768px). */
export const useIsMobile = () => useMediaQuery("(max-width: 767px)");
