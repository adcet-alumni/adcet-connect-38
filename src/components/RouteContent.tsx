/**
 * The content pane of a layout: its own suspense boundary, plus the idle
 * prefetch for everything else in the section.
 *
 * Both halves exist for the same reason — the portal is split by route, so the
 * first visit to a page costs a network round trip for its chunk. Before this,
 * that round trip suspended the whole tree: React replaced the dashboard shell,
 * nav and sidebar included, with a blank fallback and then rebuilt it, which is
 * what read as the page reloading. Here the boundary sits *inside* the layout,
 * so the shell never moves and only this pane waits — and `preloadGroup` means
 * it usually has nothing to wait for, because the chunk was fetched during the
 * pause after the section first painted.
 */
import { Suspense, useEffect } from "react";
import { Outlet } from "react-router-dom";
import { preloadGroup } from "@/lib/routePreload";

/**
 * Held space, not a spinner.
 *
 * A chunk that arrives in 80 ms would make a spinner a flicker, and the pages
 * behind this draw their own skeletons once mounted. `min-h` keeps the shell
 * from collapsing while the pane is empty.
 */
const PaneFallback = () => (
  <div className="min-h-[60vh]" aria-busy="true" aria-live="polite" />
);

interface RouteContentProps {
  /** Route prefix whose chunks to warm — e.g. `/dashboard` or `/admin`. */
  preload: string;
}

const RouteContent = ({ preload }: RouteContentProps) => {
  useEffect(() => {
    // Somebody inside a layout is going to navigate inside it. Fetch those
    // pages while nothing else is happening; the cancel stops the walk if the
    // layout unmounts first (a sign-out, or an admin leaving for /dashboard).
    return preloadGroup(preload);
  }, [preload]);

  return (
    <Suspense fallback={<PaneFallback />}>
      <Outlet />
    </Suspense>
  );
};

export default RouteContent;
