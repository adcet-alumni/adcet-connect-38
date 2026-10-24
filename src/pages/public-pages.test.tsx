import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "@/contexts/ThemeContext";
import LandingPage from "./LandingPage";
import AboutPage from "./AboutPage";
import ContactPage from "./ContactPage";
import NewsPage from "./NewsPage";
import GalleryPage from "./GalleryPage";
import EsteemedAlumniPage from "./EsteemedAlumniPage";
import { TOTAL_ALUMNI } from "@/lib/alumni-count";
import { CONTACT } from "@/lib/site";
import { ESTEEMED_CATEGORIES } from "@/lib/esteemed";

// Board members and esteemed alumni are now API-backed so `api.get` returns
// empty arrays — the pages render their loading/empty states without crashing.
vi.mock("@/lib/api", () => ({
  api: { get: vi.fn().mockResolvedValue({ items: [] }), patch: vi.fn().mockResolvedValue({}) },
  tokenStore: { get: () => null, set: vi.fn(), clear: vi.fn() },
}));

const renderPage = (ui: React.ReactElement) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <ThemeProvider>
      <QueryClientProvider client={client}>
        <MemoryRouter>{ui}</MemoryRouter>
      </QueryClientProvider>
    </ThemeProvider>,
  );
};

describe("public pages", () => {
  it("renders the landing page with the alumni figures", () => {
    renderPage(<LandingPage />);
    expect(screen.getByRole("heading", { name: "ADCET Alumni Portal" })).toBeInTheDocument();
    // Matched loosely so copy tweaks like "11,256+" don't break the smoke test.
    expect(screen.getByText(/11,256/)).toBeInTheDocument();
    expect(screen.getByText(/^26\+?$/)).toBeInTheDocument();
  });

  it("renders the about page with the board section heading and alumni total", () => {
    renderPage(<AboutPage />);
    // Board section heading is always rendered regardless of whether members have loaded.
    expect(screen.getByRole("heading", { name: "Alumni Association Board" })).toBeInTheDocument();
    // The footer total is derived from the rows, not hardcoded.
    expect(TOTAL_ALUMNI).toBe(11256);
    expect(screen.getAllByText("11,256").length).toBeGreaterThan(0);
  });

  it("shows the alumni office contact details and not the director's mail", () => {
    renderPage(<ContactPage />);
    expect(screen.getAllByText("alumni@adcet.in").length).toBeGreaterThan(0);
    // Derived from CONTACT rather than hardcoded — the office adds and drops
    // numbers, and that shouldn't fail a test about *which* address is shown.
    expect(CONTACT.phones.length).toBeGreaterThan(0);
    for (const phone of CONTACT.phones) {
      expect(screen.getAllByRole("link", { name: phone }).length).toBeGreaterThan(0);
    }
    // The director's address belongs in the footer only, not in page content.
    expect(screen.queryByText(/General Enquiry/i)).not.toBeInTheDocument();
    expect(screen.getAllByText("director@adcet.in")).toHaveLength(1);
  });

  it("renders the news and gallery pages", () => {
    renderPage(<NewsPage />);
    expect(screen.getByRole("heading", { name: "Latest Updates" })).toBeInTheDocument();

    renderPage(<GalleryPage />);
    expect(screen.getAllByRole("heading", { name: "Gallery" }).length).toBeGreaterThan(0);
  });

  it("renders the esteemed alumni page with category section headings", async () => {
    renderPage(<EsteemedAlumniPage />);
    // Category section headings are rendered structurally — even while the API
    // is loading each section shows a spinner, and once resolved the
    // empty-state placeholder appears (api mock returns no alumni).
    for (const cat of ESTEEMED_CATEGORIES) {
      await waitFor(() =>
        expect(screen.getByRole("heading", { name: cat.title })).toBeInTheDocument(),
      );
    }
    expect(screen.queryByRole("heading", { name: /all esteemed alumni/i })).not.toBeInTheDocument();
  });
});
