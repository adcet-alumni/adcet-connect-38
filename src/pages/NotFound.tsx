import { Link, useLocation, useNavigate } from "react-router-dom";
import { ArrowLeft, Compass, Home, LayoutDashboard, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/AuthContext";

/**
 * The 404 page — three surfaces, one block of copy.
 *
 * A single top-level `path="*"` is not enough in practice: it only catches URLs
 * that match *nothing*, so a mistyped `/dashboard/evnets` or `/admin/reprots`
 * used to drop the member onto a bare full-screen page with no nav — the portal
 * appeared to vanish rather than to report a bad link. So the same content is
 * mounted three times (see `App.tsx`):
 *
 *  - `*` at the top level → {@link NotFound}, the public full-page version with
 *    its own slim header, matching `PublicAchievementPage`.
 *  - `*` inside `DashboardLayout` → {@link DashboardNotFound}, a plain content
 *    block; the topbar, sidebar and theme come from the layout.
 *  - `*` inside `AdminLayout` → {@link AdminNotFound}, likewise.
 *
 * "Not found" here always means *no such route*. A route that exists but whose
 * record does not (a deleted event, someone else's notification) is the
 * detail page's own business — those render an `EmptyState` on a 404 from the
 * API, so the reader keeps the page they were on and its Back link.
 */

/** The shared 404 content: heading, the path that failed, and a way out. */
export const NotFoundBlock = ({
  homeTo = "/",
  homeLabel = "Go to homepage",
  illustration,
}: {
  homeTo?: string;
  homeLabel?: string;
  /** Overrides the plain icon badge — the public page passes the alumni crest. */
  illustration?: React.ReactNode;
}) => {
  const { pathname } = useLocation();
  const navigate = useNavigate();

  /**
   * `history.state.idx` is React Router's own position in its stack: 0 means
   * the 404 is the first entry (a bookmark, a stale link from an email, a
   * reload), and there is nothing behind it to go back to.
   */
  const canGoBack = ((window.history.state as { idx?: number } | null)?.idx ?? 0) > 0;

  return (
    <div className="flex flex-col items-center text-center py-16 sm:py-24 px-6">
      {illustration ?? (
        <div className="w-16 h-16 rounded-2xl bg-muted flex items-center justify-center mb-6">
          <Compass className="h-7 w-7 text-muted-foreground" />
        </div>
      )}

      <p className="text-5xl sm:text-6xl font-bold tracking-tight text-foreground">404</p>
      <h1 className="mt-3 text-lg sm:text-xl font-semibold text-foreground">
        We couldn't find that page
      </h1>
      <p className="mt-2 max-w-md text-sm text-muted-foreground">
        The link may be broken, or the page may have been moved or renamed.
      </p>

      {/* The failed path, so a mistyped or truncated link is obvious at a
          glance — and so a bug report can quote it. `break-all` keeps a long
          URL from widening the page on mobile. */}
      <code className="mt-4 max-w-full break-all rounded-md bg-muted px-3 py-1.5 text-xs text-muted-foreground">
        {pathname}
      </code>

      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
        {canGoBack && (
          <Button variant="outline" className="gap-2" onClick={() => navigate(-1)}>
            <ArrowLeft className="h-4 w-4" /> Go back
          </Button>
        )}
        <Button asChild className="gap-2">
          <Link to={homeTo}>
            {homeTo === "/" ? <Home className="h-4 w-4" /> : <LayoutDashboard className="h-4 w-4" />}
            {homeLabel}
          </Link>
        </Button>
      </div>
    </div>
  );
};

/** Route-level 404 inside `DashboardLayout` — the shell stays, only the content is 404. */
export const DashboardNotFound = () => (
  <NotFoundBlock homeTo="/dashboard" homeLabel="Back to dashboard" />
);

/** Route-level 404 inside `AdminLayout`. */
export const AdminNotFound = () => (
  <NotFoundBlock homeTo="/admin" homeLabel="Back to admin home" />
);

/**
 * The public 404: everything that matched no route at all. Signed-in readers
 * are offered their own home (dashboard or admin console) rather than the
 * marketing landing page, because a bad link inside the portal should not walk
 * them out of it.
 */
const NotFound = () => {
  const { user, isAdmin } = useAuth();
  const home = !user ? "/" : isAdmin ? "/admin" : "/dashboard";
  const homeLabel = home === "/" ? "Go to homepage" : "Back to dashboard";

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
      <header className="sticky top-0 z-50 h-14 border-b border-border bg-card/95 backdrop-blur flex items-center px-6 gap-3">
        <Link to="/" className="flex items-center gap-2">
          <img src="/logo.jpeg" alt="ADCET" className="w-8 h-8 rounded-lg object-cover" />
          <span className="font-bold text-sm hidden sm:block">ADCET Alumni Portal</span>
        </Link>
        {!user && (
          <div className="ml-auto flex items-center gap-2">
            <Button variant="ghost" size="sm" asChild><Link to="/login">Sign In</Link></Button>
            <Button size="sm" asChild><Link to="/register">Join Network</Link></Button>
          </div>
        )}
      </header>

      <main className="flex-1 flex items-center justify-center">
        <div className="w-full">
          <NotFoundBlock
            homeTo={home}
            homeLabel={homeLabel}
            illustration={
              <img
                src="/404_logo.svg"
                alt=""
                aria-hidden="true"
                className="w-32 h-32 sm:w-40 sm:h-40 mb-4 select-none"
              />
            }
          />

          {/* Somewhere to go next, so the page is not a dead end. */}
          <div className="max-w-md mx-auto -mt-8 pb-16 px-6">
            <div className="rounded-xl bg-muted/40 p-5 text-center">
              <p className="text-xs font-medium text-muted-foreground mb-3 flex items-center justify-center gap-1.5">
                <Search className="h-3.5 w-3.5" /> Looking for something?
              </p>
              <div className="flex flex-wrap justify-center gap-2">
                <Button variant="outline" size="sm" asChild><Link to="/news">News</Link></Button>
                <Button variant="outline" size="sm" asChild><Link to="/gallery">Gallery</Link></Button>
                <Button variant="outline" size="sm" asChild><Link to="/alumni-map">Alumni Map</Link></Button>
                <Button variant="outline" size="sm" asChild><Link to="/contact">Contact</Link></Button>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
};

export default NotFound;
