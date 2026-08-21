/**
 * The 404 route has to do two things the old stub did not: keep a signed-in
 * member inside the portal shell when they mistype a `/dashboard/*` URL, and
 * tell them *which* path failed. The last test pins the React Router behaviour
 * the whole design rests on — a `*` nested inside a layout beats the top-level
 * `*`, so the layout's nav survives a bad child path.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";

const mockAuth = { user: null as { id: string } | null, isAdmin: false };
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => mockAuth }));

const NotFound = (await import("./NotFound")).default;
const { DashboardNotFound, AdminNotFound } = await import("./NotFound");

beforeEach(() => {
  mockAuth.user = null;
  mockAuth.isAdmin = false;
});

const renderAt = (ui: React.ReactElement, path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="*" element={ui} />
      </Routes>
    </MemoryRouter>,
  );

describe("the public 404", () => {
  it("names the path that failed, so a mistyped link is obvious", () => {
    renderAt(<NotFound />, "/esteemed-alumnii");

    expect(screen.getByText("404")).toBeInTheDocument();
    expect(screen.getByText("/esteemed-alumnii")).toBeInTheDocument();
  });

  it("sends an anonymous visitor to the homepage, and offers the sign-in CTAs", () => {
    renderAt(<NotFound />, "/nope");

    expect(screen.getByRole("link", { name: /go to homepage/i })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: /sign in/i })).toBeInTheDocument();
  });

  it("sends a signed-in member back to the portal, not out to the landing page", () => {
    mockAuth.user = { id: "u1" };
    renderAt(<NotFound />, "/nope");

    expect(screen.getByRole("link", { name: /back to dashboard/i })).toHaveAttribute("href", "/dashboard");
    // A member who is already signed in is not asked to sign in again.
    expect(screen.queryByRole("link", { name: /sign in/i })).not.toBeInTheDocument();
  });

  it("sends an admin to the admin console", () => {
    mockAuth.user = { id: "u1" };
    mockAuth.isAdmin = true;
    renderAt(<NotFound />, "/nope");

    expect(screen.getByRole("link", { name: /back to dashboard/i })).toHaveAttribute("href", "/admin");
  });

  it("offers no 'Go back' when the 404 is the first page in the session", () => {
    // A bookmark, a stale link in an email, or a hard reload: history.state.idx
    // is 0, so there is nothing behind this page to return to.
    renderAt(<NotFound />, "/nope");

    expect(screen.queryByRole("button", { name: /go back/i })).not.toBeInTheDocument();
  });
});

describe("the in-portal 404", () => {
  it("brings no chrome of its own — the layout supplies it", () => {
    renderAt(<DashboardNotFound />, "/dashboard/evnets");

    expect(screen.queryByRole("banner")).not.toBeInTheDocument();
    expect(screen.getByText("/dashboard/evnets")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /back to dashboard/i })).toHaveAttribute("href", "/dashboard");
  });

  it("keeps an admin inside the admin console", () => {
    renderAt(<AdminNotFound />, "/admin/reprots");

    expect(screen.getByRole("link", { name: /back to admin home/i })).toHaveAttribute("href", "/admin");
  });

  it("wins over the top-level catch-all, so the shell stays on screen", () => {
    // Mirrors the nesting in App.tsx: an unknown /dashboard/* child must render
    // inside the layout, never fall through to the bare public 404.
    render(
      <MemoryRouter initialEntries={["/dashboard/evnets"]}>
        <Routes>
          <Route
            path="/dashboard"
            element={<div><nav>Portal sidebar</nav><Outlet /></div>}
          >
            <Route path="feed" element={<div>Feed</div>} />
            <Route path="*" element={<DashboardNotFound />} />
          </Route>
          <Route path="*" element={<div>Public 404</div>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText("Portal sidebar")).toBeInTheDocument();
    expect(screen.getByText("404")).toBeInTheDocument();
    expect(screen.queryByText("Public 404")).not.toBeInTheDocument();
  });
});
