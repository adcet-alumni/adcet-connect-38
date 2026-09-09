import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Suspense, lazy } from "react";
import { registerRoute } from "./lib/routePreload";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import AuthPage from "./pages/AuthPage";
import LandingPage from "./pages/LandingPage";
import NotFound, { AdminNotFound, DashboardNotFound } from "./pages/NotFound";
import { shouldRetryQuery } from "./lib/api";
import { AuthProvider } from "./contexts/AuthContext";
import ProtectedRoute from "./components/ProtectedRoute";

// Admin
import AccountStatusGate from "./components/AccountStatusGate";
import { ThemeProvider } from "./contexts/ThemeContext";


/*
 * Every route below the landing page and the auth forms is code-split.
 *
 * All 68 routes used to be eager imports in this file, so a first-time visitor
 * landing on the public marketing page downloaded, parsed and executed the
 * entire admin panel, every Recharts chart, Leaflet and supercluster, jsPDF
 * and html2canvas, and all 27 Radix packages before the page became
 * interactive — 2.26 MB of JavaScript for a page that renders none of it.
 *
 * The landing page and AuthPage stay eager on purpose: they are the first
 * paint and the hop most visitors make next, and splitting them would only add
 * a round trip. NotFound stays because it has named exports, which React.lazy
 * cannot take, and it is a few lines.
 *
 * Each route goes through `route()` rather than `lazy()` directly, which files
 * the import thunk in `lib/routePreload.ts` under the path it serves. That is
 * what lets the layouts warm their pages on idle and the nav links warm one on
 * hover, so the split costs a round trip only when somebody navigates faster
 * than the browser can prefetch — see the module for why.
 */
const route = <T,>(path: string, load: () => Promise<{ default: T }>) =>
  lazy(registerRoute(path, load));
const CompleteProfilePage = route("/complete-profile", () => import("./pages/CompleteProfilePage"));
const AboutPage = route("/about", () => import("./pages/AboutPage"));
const ContactPage = route("/contact", () => import("./pages/ContactPage"));
const NewsPage = route("/news", () => import("./pages/NewsPage"));
const NewslettersPage = route("/newsletters", () => import("./pages/NewslettersPage"));
const EsteemedAlumniPage = route("/esteemed-alumni", () => import("./pages/EsteemedAlumniPage"));
const GalleryPage = route("/gallery", () => import("./pages/GalleryPage"));
const AlumniMapPage = route("/alumni-map", () => import("./pages/AlumniMapPage"));
const TestimonialsPage = route("/testimonials", () => import("./pages/TestimonialsPage"));
const SupportPage = route("/support", () => import("./pages/SupportPage"));
const DashboardLayout = route("/dashboard", () => import("./components/DashboardLayout"));
const DashboardHome = route("/dashboard/home", () => import("./pages/DashboardHome"));
const FeedPage = route("/dashboard/feed", () => import("./pages/FeedPage"));
const PostDetailPage = route("/dashboard/feed/", () => import("./pages/PostDetailPage"));
const EventsPage = route("/dashboard/events", () => import("./pages/EventsPage"));
const JobsPage = route("/dashboard/jobs", () => import("./pages/JobsPage"));
const JobDetailPage = route("/dashboard/jobs/", () => import("./pages/JobDetailPage"));
const EventDetailPage = route("/dashboard/events/", () => import("./pages/EventDetailPage"));
const MyJobPostsPage = route("/dashboard/jobs/mine", () => import("./pages/MyJobPostsPage"));
const NotificationsPage = route("/dashboard/notifications", () => import("./pages/NotificationsPage"));
const NotificationPage = route("/dashboard/notifications/", () => import("./pages/NotificationPage"));
const ProfilePage = route("/dashboard/profile", () => import("./pages/ProfilePage"));
const AchievementsPage = route("/dashboard/achievements", () => import("./pages/AchievementsPage"));
const DonationsPage = route("/dashboard/donations", () => import("./pages/DonationsPage"));
const GeoMapPage = route("/dashboard/geomap", () => import("./pages/GeoMapPage"));
const ChaptersPage = route("/dashboard/chapters", () => import("./pages/ChaptersPage"));
const CollaborationPage = route("/dashboard/collaboration", () => import("./pages/CollaborationPage"));
const AnalyticsPage = route("/dashboard/analytics", () => import("./pages/AnalyticsPage"));
const AlumniDirectoryPage = route("/dashboard/alumni", () => import("./pages/AlumniDirectoryPage"));
const AchievementDetailPage = route("/dashboard/achievements/", () => import("./pages/AchievementDetailPage"));
const PublicAchievementPage = route("/achievements/", () => import("./pages/PublicAchievementPage"));
const ResetPasswordPage = route("/reset-password", () => import("./pages/ResetPasswordPage"));
const AdminLayout = route("/admin", () => import("./components/AdminLayout"));
const AdminDashboard = route("/admin/home", () => import("./pages/admin/AdminDashboard"));
const UserApprovalsPage = route("/admin/approvals", () => import("./pages/admin/UserApprovalsPage"));
const EventApprovalsPage = route("/admin/events", () => import("./pages/admin/EventApprovalsPage"));
const JobApprovalsPage = route("/admin/jobs", () => import("./pages/admin/JobApprovalsPage"));
const AchievementsAdminPage = route("/admin/achievements", () => import("./pages/admin/AchievementsAdminPage"));
const DonationsAdminPage = route("/admin/donations", () => import("./pages/admin/DonationsAdminPage"));
const AdminAnalyticsPage = route("/admin/analytics", () => import("./pages/admin/AdminAnalyticsPage"));
const ReportsPage = route("/admin/reports", () => import("./pages/admin/ReportsPage"));
const SettingsPage = route("/admin/settings", () => import("./pages/admin/SettingsPage"));
const AdminGeoMapPage = route("/admin/geomap", () => import("./pages/admin/AdminGeoMapPage"));
const ChaptersAdminPage = route("/admin/chapters", () => import("./pages/admin/ChaptersAdminPage"));
const NewsroomPage = route("/admin/newsroom", () => import("./pages/admin/NewsroomPage"));
const GalleryAdminPage = route("/admin/gallery", () => import("./pages/admin/GalleryAdminPage"));
const CollaborationAdminPage = route("/admin/collaboration", () => import("./pages/admin/CollaborationAdminPage"));
const StaticContentPage = route("/dashboard/support", () => import("./pages/StaticContentPage"));
const AccountStatusPage = route("/dashboard/status", () => import("./pages/AccountStatusPage"));
const SupportInboxPage = route("/admin/support", () => import("./pages/admin/SupportInboxPage"));
const FeedModerationPage = route("/admin/feed", () => import("./pages/admin/FeedModerationPage"));
const AdminUserDetailPage = route("/admin/users/", () => import("./pages/admin/AdminUserDetailPage"));

/** Shown while a route's chunk is in flight. Deliberately quiet — a spinner
 *  that appears for 80 ms reads as a flicker, so this is just held space. */
const RouteFallback = () => (
  <div className="min-h-screen bg-background" aria-busy="true" aria-live="polite" />
);

const queryClient = new QueryClient({
  // A definitive 4xx is not retried, so a detail page can say "not found"
  // immediately instead of spinning through three doomed attempts first.
  defaultOptions: { queries: { retry: shouldRetryQuery } },
});

const App = () => (
  <ThemeProvider>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Sonner />
        {/*
          * `v7_startTransition` is what stops a navigation from blanking the
          * screen. Without it, a route whose chunk is still in flight suspends
          * the tree and React swaps the *whole* app — dashboard shell included
          * — for the fallback below, which reads as the page reloading. Routing
          * inside a transition instead keeps the current screen painted until
          * the new one is ready, so a slow chunk costs a pause, not a flash.
          */}
        <BrowserRouter future={{ v7_startTransition: true }}>
          <AuthProvider>
            {/*
              * The outer boundary covers entering a section — the layout chunk
              * itself. Navigation *within* a layout is caught by that layout's
              * own boundary around its `<Outlet />`, so the nav and sidebar
              * stay on screen and only the content pane waits.
              */}
            <Suspense fallback={<RouteFallback />}>
            <Routes>
              <Route path="/" element={<LandingPage />} />
              {/* One page, two entry points. AuthPage reads the path to decide
                  which panel to show, so "Sign In" and "Join Network" land on
                  the right form and the choice survives a bookmark or a
                  browser Back. */}
              <Route path="/login" element={<AuthPage />} />
              <Route path="/register" element={<AuthPage />} />
              <Route path="/about" element={<AboutPage />} />
              <Route path="/contact" element={<ContactPage />} />
              <Route path="/news" element={<NewsPage />} />
              <Route path="/newsletters" element={<NewslettersPage />} />
              <Route path="/esteemed-alumni" element={<EsteemedAlumniPage />} />
              <Route path="/gallery" element={<GalleryPage />} />
              <Route path="/alumni-map" element={<AlumniMapPage />} />
              {/* Reached only from the landing-page carousel — deliberately not in the nav. */}
              <Route path="/testimonials" element={<TestimonialsPage />} />
              <Route path="/support" element={<SupportPage />} />
              {/* The shareable link, for readers with no session. Members open
                  /dashboard/achievements/:id instead, which keeps the portal
                  shell — see PublicAchievementPage. */}
              <Route path="/achievements/:id" element={<PublicAchievementPage />} />
              <Route path="/reset-password" element={<ResetPasswordPage />} />

              {/* Onboarding for accounts without the mandatory profile — the
                  ones that predate sign-up collecting it, and any the office
                  imported. Sits inside ProtectedRoute (login
                  required) but outside DashboardLayout, so there is no nav to
                  escape into until the form is done. */}
              <Route element={<ProtectedRoute />}>
                <Route path="/complete-profile" element={<CompleteProfilePage />} />
              </Route>

              {/* Any logged-in user (any role) can access /dashboard. */}
              <Route element={<ProtectedRoute />}>
                <Route path="/dashboard" element={<DashboardLayout />}>
                  <Route element={<AccountStatusGate />}>
                    <Route index element={<DashboardHome />} />
                    <Route path="feed" element={<FeedPage />} />
                    <Route path="feed/:id" element={<PostDetailPage />} />
                    <Route path="events" element={<EventsPage />} />
                    <Route path="events/:id" element={<EventDetailPage />} />
                    <Route path="jobs" element={<JobsPage />} />
                    <Route path="jobs/:id" element={<JobDetailPage />} />
                    <Route path="jobs/mine" element={<MyJobPostsPage />} />
                    <Route path="notifications" element={<NotificationsPage />} />
                    <Route path="notifications/:id" element={<NotificationPage />} />
                    <Route path="profile" element={<ProfilePage />} />
                    <Route path="achievements" element={<AchievementsPage />} />
                    <Route path="achievements/:id" element={<AchievementDetailPage />} />
                    <Route path="donations" element={<DonationsPage />} />
                    <Route path="geomap" element={<GeoMapPage />} />
                    {/* Read-only: alumni browse chapters and rosters, nothing more. */}
                    <Route path="chapters" element={<ChaptersPage />} />
                    <Route path="analytics" element={<AnalyticsPage />} />
                    <Route path="alumni" element={<AlumniDirectoryPage />} />
                    {/* Alumni Collaboration — one page per kind, all driven by
                        COLLABORATION_KINDS in src/lib/collaboration.ts. */}
                    <Route path="collaboration/placement" element={<CollaborationPage type="PLACEMENT" />} />
                    <Route path="collaboration/workshop" element={<CollaborationPage type="WORKSHOP" />} />
                    <Route path="collaboration/other" element={<CollaborationPage type="OTHER" />} />
                    <Route path="support" element={<StaticContentPage contentKey="support" />} />
                    <Route path="news" element={<StaticContentPage contentKey="news" />} />
                    <Route path="status" element={<AccountStatusPage />} />
                  </Route>
                  {/* A mistyped /dashboard/* URL keeps the portal shell —
                      sidebar, topbar and theme — instead of dropping the
                      member onto the bare public 404. Deliberately outside
                      AccountStatusGate: a bad link is a bad link whatever the
                      account status, and it discloses nothing. */}
                  <Route path="*" element={<DashboardNotFound />} />
                </Route>
              </Route>

              {/* Admin-only area. */}
              <Route element={<ProtectedRoute roles={["ADMIN"]} />}>
                <Route path="/admin" element={<AdminLayout />}>
                  <Route index element={<AdminDashboard />} />
                  <Route path="approvals" element={<UserApprovalsPage />} />
                  <Route path="users/:id" element={<AdminUserDetailPage />} />
                  <Route path="events" element={<EventApprovalsPage />} />
                  <Route path="jobs" element={<JobApprovalsPage />} />
                  <Route path="achievements" element={<AchievementsAdminPage />} />
                  <Route path="feed" element={<FeedModerationPage />} />
                  <Route path="donations" element={<DonationsAdminPage />} />
                  <Route path="chapters" element={<ChaptersAdminPage />} />
                  <Route path="analytics" element={<AdminAnalyticsPage />} />
                  <Route path="geomap" element={<AdminGeoMapPage />} />
                  <Route path="reports" element={<ReportsPage />} />
                  <Route path="newsroom" element={<NewsroomPage />} />
                  <Route path="gallery" element={<GalleryAdminPage />} />
                  <Route path="collaboration/placement" element={<CollaborationAdminPage type="PLACEMENT" />} />
                  <Route path="collaboration/workshop" element={<CollaborationAdminPage type="WORKSHOP" />} />
                  <Route path="collaboration/other" element={<CollaborationAdminPage type="OTHER" />} />
                  <Route path="support" element={<SupportInboxPage />} />
                  <Route path="settings" element={<SettingsPage />} />
                  {/* Same for the admin console. */}
                  <Route path="*" element={<AdminNotFound />} />
                </Route>
              </Route>

              <Route path="*" element={<NotFound />} />
            </Routes>
            </Suspense>
          </AuthProvider>
        </BrowserRouter>
      </TooltipProvider>
    </QueryClientProvider>
  </ThemeProvider>
);

export default App;
