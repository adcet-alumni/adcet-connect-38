import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Suspense, lazy } from "react";
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
 */
const CompleteProfilePage = lazy(() => import("./pages/CompleteProfilePage"));
const AboutPage = lazy(() => import("./pages/AboutPage"));
const ContactPage = lazy(() => import("./pages/ContactPage"));
const NewsPage = lazy(() => import("./pages/NewsPage"));
const NewslettersPage = lazy(() => import("./pages/NewslettersPage"));
const EsteemedAlumniPage = lazy(() => import("./pages/EsteemedAlumniPage"));
const GalleryPage = lazy(() => import("./pages/GalleryPage"));
const AlumniMapPage = lazy(() => import("./pages/AlumniMapPage"));
const TestimonialsPage = lazy(() => import("./pages/TestimonialsPage"));
const SupportPage = lazy(() => import("./pages/SupportPage"));
const DashboardLayout = lazy(() => import("./components/DashboardLayout"));
const DashboardHome = lazy(() => import("./pages/DashboardHome"));
const FeedPage = lazy(() => import("./pages/FeedPage"));
const PostDetailPage = lazy(() => import("./pages/PostDetailPage"));
const EventsPage = lazy(() => import("./pages/EventsPage"));
const JobsPage = lazy(() => import("./pages/JobsPage"));
const JobDetailPage = lazy(() => import("./pages/JobDetailPage"));
const EventDetailPage = lazy(() => import("./pages/EventDetailPage"));
const MyJobPostsPage = lazy(() => import("./pages/MyJobPostsPage"));
const NotificationsPage = lazy(() => import("./pages/NotificationsPage"));
const NotificationPage = lazy(() => import("./pages/NotificationPage"));
const ProfilePage = lazy(() => import("./pages/ProfilePage"));
const AchievementsPage = lazy(() => import("./pages/AchievementsPage"));
const DonationsPage = lazy(() => import("./pages/DonationsPage"));
const GeoMapPage = lazy(() => import("./pages/GeoMapPage"));
const ChaptersPage = lazy(() => import("./pages/ChaptersPage"));
const CollaborationPage = lazy(() => import("./pages/CollaborationPage"));
const AnalyticsPage = lazy(() => import("./pages/AnalyticsPage"));
const AlumniDirectoryPage = lazy(() => import("./pages/AlumniDirectoryPage"));
const AchievementDetailPage = lazy(() => import("./pages/AchievementDetailPage"));
const PublicAchievementPage = lazy(() => import("./pages/PublicAchievementPage"));
const ResetPasswordPage = lazy(() => import("./pages/ResetPasswordPage"));
const OAuthCallbackPage = lazy(() => import("./pages/OAuthCallbackPage"));
const AdminLayout = lazy(() => import("./components/AdminLayout"));
const AdminDashboard = lazy(() => import("./pages/admin/AdminDashboard"));
const UserApprovalsPage = lazy(() => import("./pages/admin/UserApprovalsPage"));
const EventApprovalsPage = lazy(() => import("./pages/admin/EventApprovalsPage"));
const JobApprovalsPage = lazy(() => import("./pages/admin/JobApprovalsPage"));
const AchievementsAdminPage = lazy(() => import("./pages/admin/AchievementsAdminPage"));
const DonationsAdminPage = lazy(() => import("./pages/admin/DonationsAdminPage"));
const AdminAnalyticsPage = lazy(() => import("./pages/admin/AdminAnalyticsPage"));
const ReportsPage = lazy(() => import("./pages/admin/ReportsPage"));
const SettingsPage = lazy(() => import("./pages/admin/SettingsPage"));
const AdminGeoMapPage = lazy(() => import("./pages/admin/AdminGeoMapPage"));
const ChaptersAdminPage = lazy(() => import("./pages/admin/ChaptersAdminPage"));
const NewsroomPage = lazy(() => import("./pages/admin/NewsroomPage"));
const GalleryAdminPage = lazy(() => import("./pages/admin/GalleryAdminPage"));
const CollaborationAdminPage = lazy(() => import("./pages/admin/CollaborationAdminPage"));
const StaticContentPage = lazy(() => import("./pages/StaticContentPage"));
const AccountStatusPage = lazy(() => import("./pages/AccountStatusPage"));
const SupportInboxPage = lazy(() => import("./pages/admin/SupportInboxPage"));
const FeedModerationPage = lazy(() => import("./pages/admin/FeedModerationPage"));
const AdminUserDetailPage = lazy(() => import("./pages/admin/AdminUserDetailPage"));

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
        <BrowserRouter>
          <AuthProvider>
            {/*
              * One boundary around the whole table rather than per route: the
              * layouts are split too, so a dashboard navigation can suspend on
              * the layout as well as on the page inside it.
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
              <Route path="/auth/callback" element={<OAuthCallbackPage />} />

              {/* Onboarding for accounts without the mandatory profile —
                  chiefly SSO sign-ins. Sits inside ProtectedRoute (login
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
