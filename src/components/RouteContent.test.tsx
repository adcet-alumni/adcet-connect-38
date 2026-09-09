/**
 * The regression this guards is the one people actually reported: opening a
 * section for the first time made the whole portal look like it reloaded.
 *
 * The cause was boundary placement, not the code splitting. One `<Suspense>`
 * wrapped the entire route table, so a page whose chunk was still in flight
 * suspended the tree *above* the layout — React replaced the nav and sidebar
 * with a blank fallback and rebuilt them when the chunk landed. Moving the
 * boundary inside the layout is what keeps the shell painted, and that is what
 * this asserts: while a lazy page is pending, the shell is still on screen.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { Suspense, lazy } from "react";
import RouteContent from "./RouteContent";

/** A lazy page whose import this test resolves by hand. */
const deferredPage = (label: string) => {
  let resolve!: () => void;
  const gate = new Promise<void>((r) => {
    resolve = r;
  });
  const Page = lazy(async () => {
    await gate;
    return { default: () => <div>{label}</div> };
  });
  return { Page, resolve };
};

const Shell = ({ children }: { children: React.ReactNode }) => (
  <div>
    <nav>Sidebar and nav</nav>
    {children}
  </div>
);

describe("RouteContent", () => {
  it("keeps the layout shell on screen while a page chunk is still loading", async () => {
    const { Page, resolve } = deferredPage("Profile page");

    render(
      <MemoryRouter initialEntries={["/dashboard/profile"]}>
        {/* The app's outer boundary. If the shell were suspending into *this*
            one, the nav below would vanish — which is the bug. */}
        <Suspense fallback={<div>WHOLE APP BLANK</div>}>
          <Routes>
            <Route
              path="/dashboard"
              element={
                <Shell>
                  <RouteContent preload="/dashboard" />
                </Shell>
              }
            >
              <Route path="profile" element={<Page />} />
            </Route>
          </Routes>
        </Suspense>
      </MemoryRouter>,
    );

    // Chunk still in flight: the shell is painted and the app-level fallback
    // never appeared.
    expect(screen.getByText("Sidebar and nav")).toBeInTheDocument();
    expect(screen.queryByText("WHOLE APP BLANK")).not.toBeInTheDocument();
    expect(screen.queryByText("Profile page")).not.toBeInTheDocument();

    resolve();
    await waitFor(() => expect(screen.getByText("Profile page")).toBeInTheDocument());
    // ...and the shell was never torn down and rebuilt around it.
    expect(screen.getByText("Sidebar and nav")).toBeInTheDocument();
  });

  it("warms the section's other chunks once it has mounted", async () => {
    const preloadGroup = vi.fn(() => vi.fn());
    vi.doMock("@/lib/routePreload", () => ({ preloadGroup, preloadRoute: vi.fn(), registerRoute: (_: string, l: unknown) => l }));
    vi.resetModules();
    const { default: Fresh } = await import("./RouteContent");

    render(
      <MemoryRouter initialEntries={["/admin"]}>
        <Routes>
          <Route path="/admin" element={<Fresh preload="/admin" />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(preloadGroup).toHaveBeenCalledWith("/admin"));
    vi.doUnmock("@/lib/routePreload");
  });
});
