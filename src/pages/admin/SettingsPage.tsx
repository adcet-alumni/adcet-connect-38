import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { User, Bell, Moon, Shield, Mail, Edit, Loader2, Camera, X, Gauge, QrCode, Upload, Trash2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useAuth } from "@/contexts/AuthContext";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/utils";
import { storageUrl } from "@/lib/storage";
import { uploadFile } from "@/lib/upload";
import { toast } from "@/hooks/use-toast";
import { Skeleton } from "@/components/ui/skeleton";
import { requestPushPermission, usePreferences, type PreferenceKey } from "@/lib/preferences";
import ChangePasswordCard from "@/components/ChangePasswordCard";

/** Shape of `GET /admin/settings`. */
interface AdminSettings {
  settings: {
    feedPostsPerMonth: number;
    donationUpiId: string;
    donationPayeeName: string;
    donationQrKey: string;
    donationBankDetails: string;
    donationInstructions: string;
  };
  meta: Record<string, { label: string; description: string; default: unknown }>;
}

/**
 * The donation settings, and only those, as one form.
 *
 * These five values *are* the donations page: with no gateway, what an admin
 * types here is what a donor pays against. They save together because that is
 * how they are read — a QR without the UPI ID beside it, or an account number
 * belonging to a different payee, is worse than neither.
 */
type PaymentForm = {
  donationUpiId: string;
  donationPayeeName: string;
  donationQrKey: string;
  donationBankDetails: string;
  donationInstructions: string;
};

const EMPTY_PAYMENT: PaymentForm = {
  donationUpiId: "",
  donationPayeeName: "",
  donationQrKey: "",
  donationBankDetails: "",
  donationInstructions: "",
};

interface AdminProfile {
  bio?: string | null;
  phone?: string | null;
  city?: string | null;
  country?: string | null;
  currentRole?: string | null;
  currentCompany?: string | null;
  avatarKey?: string | null;
}

const WRITABLE: (keyof AdminProfile)[] = [
  "bio", "phone", "city", "country", "currentRole", "currentCompany", "avatarKey",
];

const pick = (p: AdminProfile): AdminProfile => {
  const out: AdminProfile = {};
  for (const key of WRITABLE) {
    // `Object.assign` is what avoids a cast here: `out[key] = p[key]` asks
    // TypeScript to prove the value type matches for *every* member of the
    // `keyof AdminProfile` union at once, which it can't, so the direct assignment
    // needs an `any` on both sides. This doesn't.
    if (p[key] !== undefined) Object.assign(out, { [key]: p[key] });
  }
  return out;
};

const SettingsPage = () => {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<AdminProfile>({});
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [prefs, setPref] = usePreferences();

  const profile = useQuery({
    queryKey: ["profile", "me"],
    queryFn: () => api.get<AdminProfile>("/profiles/me"),
  });

  useEffect(() => {
    if (profile.data) setForm(pick(profile.data));
  }, [profile.data]);

  // Achievement notification recipients (director, principal, marketing, ...).
  const [recipients, setRecipients] = useState("");
  const recipientsSection = useQuery({
    queryKey: ["content", "section", "achievement_recipients"],
    queryFn: () =>
      api.get<{ key: string; title: string; body: string } | null>(
        "/content/sections/achievement_recipients",
      ),
  });
  useEffect(() => {
    if (recipientsSection.data) setRecipients(recipientsSection.data.body ?? "");
  }, [recipientsSection.data]);

  /**
   * Platform settings (`GET/PATCH /admin/settings`). `meta` carries each
   * setting's label, description and default, so this screen renders them
   * without duplicating copy that lives in the backend registry.
   */
  const [postLimit, setPostLimit] = useState("");
  const settings = useQuery({
    queryKey: ["admin", "settings"],
    queryFn: () => api.get<AdminSettings>("/admin/settings"),
  });
  useEffect(() => {
    if (settings.data) setPostLimit(String(settings.data.settings.feedPostsPerMonth));
  }, [settings.data]);

  /*
   * Donation payment details. Kept in their own form state and their own
   * mutation so saving the posting limit above cannot silently rewrite the
   * bank account, and vice versa.
   */
  const [payment, setPayment] = useState<PaymentForm>(EMPTY_PAYMENT);
  const [qrUploading, setQrUploading] = useState(false);
  const qrRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!settings.data) return;
    const s = settings.data.settings;
    setPayment({
      donationUpiId: s.donationUpiId ?? "",
      donationPayeeName: s.donationPayeeName ?? "",
      donationQrKey: s.donationQrKey ?? "",
      donationBankDetails: s.donationBankDetails ?? "",
      donationInstructions: s.donationInstructions ?? "",
    });
  }, [settings.data]);

  const savePayment = useMutation({
    mutationFn: (next: PaymentForm) => api.patch("/admin/settings", next),
    onSuccess: () => {
      toast({
        title: "Payment details saved",
        description: "Donors will see these on the donations page.",
      });
      qc.invalidateQueries({ queryKey: ["admin", "settings"] });
      // The donor-facing page reads the same values.
      qc.invalidateQueries({ queryKey: ["donations", "payment-details"] });
    },
    onError: (e: unknown) =>
      toast({ title: "Save failed", description: errorMessage(e), variant: "destructive" }),
  });

  /**
   * The QR is uploaded and saved in one step, rather than waiting for the Save
   * button: a key that exists in storage but not in settings is an orphaned
   * file, and an admin who uploads then navigates away would leave one behind.
   */
  const handleQrPick = async (file: File) => {
    if (!file.type.startsWith("image/")) {
      toast({ title: "Please select an image of the QR", variant: "destructive" });
      return;
    }
    setQrUploading(true);
    try {
      const key = await uploadFile(file, "donation-qr");
      const next = { ...payment, donationQrKey: key };
      setPayment(next);
      await savePayment.mutateAsync(next);
    } catch (e: unknown) {
      toast({ title: "Upload failed", description: errorMessage(e), variant: "destructive" });
    } finally {
      setQrUploading(false);
    }
  };

  const saveSettings = useMutation({
    mutationFn: () => api.patch("/admin/settings", { feedPostsPerMonth: Number(postLimit) }),
    onSuccess: () => {
      toast({
        title: "Settings saved",
        description: `Members may now publish ${postLimit} posts per month.`,
      });
      qc.invalidateQueries({ queryKey: ["admin", "settings"] });
      // Members' composers read this; refresh so the new figure shows up.
      qc.invalidateQueries({ queryKey: ["feed", "quota"] });
    },
    onError: (e: unknown) =>
      toast({ title: "Save failed", description: errorMessage(e), variant: "destructive" }),
  });

  const saveRecipients = useMutation({
    mutationFn: () =>
      api.put("/content/sections/achievement_recipients", {
        title: "Achievement Notification Recipients",
        body: recipients.trim() || " ",
      }),
    onSuccess: () => {
      toast({ title: "Recipients saved" });
      qc.invalidateQueries({ queryKey: ["content", "section", "achievement_recipients"] });
    },
    onError: (e: unknown) =>
      toast({ title: "Save failed", description: errorMessage(e), variant: "destructive" }),
  });

  const save = useMutation({
    mutationFn: () => api.patch("/profiles/me", pick(form)),
    onSuccess: () => {
      toast({ title: "Profile updated" });
      setEditing(false);
      qc.invalidateQueries({ queryKey: ["profile"] });
    },
    onError: (e: unknown) =>
      toast({ title: "Update failed", description: errorMessage(e), variant: "destructive" }),
  });

  const handleAvatarPick = async (file: File) => {
    if (!file.type.startsWith("image/")) {
      toast({ title: "Please select an image", variant: "destructive" });
      return;
    }
    setUploading(true);
    try {
      const key = await uploadFile(file, "avatar");
      await api.patch("/profiles/me", { avatarKey: key });
      toast({ title: "Photo updated" });
      qc.invalidateQueries({ queryKey: ["profile"] });
    } catch (e: unknown) {
      toast({ title: "Upload failed", description: errorMessage(e), variant: "destructive" });
    } finally {
      setUploading(false);
    }
  };

  const initials = `${user?.firstName?.[0] ?? ""}${user?.lastName?.[0] ?? ""}`.toUpperCase() || "AD";
  const avatarUrl = storageUrl(profile.data?.avatarKey);

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Settings</h1>
        <p className="text-muted-foreground text-sm mt-1">Manage your admin profile and preferences.</p>
      </div>

      <div className="card-elevated p-6 space-y-5">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
            <User className="h-4 w-4" /> Profile
          </h2>
          {!editing ? (
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setEditing(true)}>
              <Edit className="h-3 w-3" /> Edit
            </Button>
          ) : (
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setEditing(false);
                  setForm(pick(profile.data ?? {}));
                }}
              >
                <X className="h-3 w-3 mr-1" /> Cancel
              </Button>
              <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
                {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
              </Button>
            </div>
          )}
        </div>

        <div className="flex items-center gap-4">
          <div className="relative">
            <Avatar className="h-16 w-16">
              {avatarUrl && <AvatarImage src={avatarUrl} alt="Admin photo" />}
              <AvatarFallback className="bg-primary text-primary-foreground text-lg">{initials}</AvatarFallback>
            </Avatar>
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              className="absolute -bottom-1 -right-1 h-6 w-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center shadow-md hover:opacity-90 disabled:opacity-50"
              aria-label="Change photo"
            >
              {uploading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Camera className="h-3 w-3" />}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleAvatarPick(f);
                e.target.value = "";
              }}
            />
          </div>
          <div>
            <p className="text-sm font-medium text-foreground">
              {user?.firstName} {user?.lastName}
            </p>
            <p className="text-xs text-muted-foreground">{user?.email}</p>
          </div>
        </div>

        {profile.isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : !editing ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">First Name</p>
              <p className="text-sm text-foreground">{user?.firstName ?? "—"}</p>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Last Name</p>
              <p className="text-sm text-foreground">{user?.lastName ?? "—"}</p>
            </div>
            <div className="space-y-1 sm:col-span-2">
              <p className="text-xs text-muted-foreground">Email</p>
              <p className="text-sm text-foreground">{user?.email ?? "—"}</p>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Phone</p>
              <p className="text-sm text-foreground">{profile.data?.phone || "—"}</p>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Role</p>
              <p className="text-sm text-foreground">{profile.data?.currentRole || "—"}</p>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">City</p>
              <p className="text-sm text-foreground">{profile.data?.city || "—"}</p>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Country</p>
              <p className="text-sm text-foreground">{profile.data?.country || "—"}</p>
            </div>
            {profile.data?.bio && (
              <div className="space-y-1 sm:col-span-2">
                <p className="text-xs text-muted-foreground">Bio</p>
                <p className="text-sm text-foreground">{profile.data.bio}</p>
              </div>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>First Name</Label>
              <Input value={user?.firstName ?? ""} disabled />
            </div>
            <div className="space-y-1.5">
              <Label>Last Name</Label>
              <Input value={user?.lastName ?? ""} disabled />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label>Email</Label>
              <Input value={user?.email ?? ""} type="email" disabled />
            </div>
            <div className="space-y-1.5">
              <Label>Phone</Label>
              <Input
                value={form.phone ?? ""}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Role / Title</Label>
              <Input
                value={form.currentRole ?? ""}
                onChange={(e) => setForm({ ...form, currentRole: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label>City</Label>
              <Input
                value={form.city ?? ""}
                onChange={(e) => setForm({ ...form, city: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Country</Label>
              <Input
                value={form.country ?? ""}
                onChange={(e) => setForm({ ...form, country: e.target.value })}
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label>Bio</Label>
              <Textarea
                value={form.bio ?? ""}
                onChange={(e) => setForm({ ...form, bio: e.target.value })}
              />
            </div>
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          Name and email are managed by the alumni office. Contact support to change them.
        </p>
      </div>

      <div className="card-elevated p-6 space-y-5">
        <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
          <Shield className="h-4 w-4" /> Preferences
        </h2>
        <div className="space-y-4">
          {([
            { key: "emailNotifications", icon: Bell, label: "Email Notifications", desc: "Receive email alerts for new requests" },
            { key: "pushNotifications", icon: Bell, label: "Push Notifications", desc: "Get browser push notifications" },
            { key: "darkMode", icon: Moon, label: "Dark Mode", desc: "Toggle dark theme appearance" },
            { key: "weeklyDigest", icon: Mail, label: "Weekly Digest", desc: "Receive a weekly summary report" },
          ] as { key: PreferenceKey; icon: LucideIcon; label: string; desc: string }[]).map((pref) => (
            <div key={pref.key} className="flex items-center justify-between p-3 rounded-lg hover:bg-muted transition-colors">
              <div className="flex items-center gap-3">
                <pref.icon className="h-4 w-4 text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium text-foreground">{pref.label}</p>
                  <p className="text-xs text-muted-foreground">{pref.desc}</p>
                </div>
              </div>
              <Switch
                checked={prefs[pref.key]}
                onCheckedChange={async (checked) => {
                  if (pref.key === "pushNotifications" && checked) {
                    const granted = await requestPushPermission();
                    if (!granted) {
                      toast({
                        title: "Push permission denied",
                        description: "Enable notifications in your browser to receive alerts.",
                        variant: "destructive",
                      });
                      return;
                    }
                  }
                  setPref(pref.key, checked);
                  toast({ title: `${pref.label} ${checked ? "enabled" : "disabled"}` });
                }}
              />
            </div>
          ))}
        </div>
      </div>

      <div className="card-elevated p-6 space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
            <Gauge className="h-4 w-4" /> Feed Posting Limit
          </h2>
          <p className="text-xs text-muted-foreground mt-1">
            {settings.data?.meta.feedPostsPerMonth.description ??
              "How many posts each member may publish per calendar month."}
          </p>
        </div>
        {settings.isLoading ? (
          <Skeleton className="h-10 w-full max-w-xs" />
        ) : (
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="feedPostsPerMonth">Posts per member each month</Label>
              <Input
                id="feedPostsPerMonth"
                type="number"
                min={1}
                max={1000}
                className="w-40"
                value={postLimit}
                onChange={(e) => setPostLimit(e.target.value)}
              />
            </div>
            <Button
              size="sm"
              className="gap-1.5"
              onClick={() => saveSettings.mutate()}
              disabled={
                saveSettings.isPending ||
                !postLimit ||
                Number(postLimit) < 1 ||
                String(settings.data?.settings.feedPostsPerMonth) === postLimit
              }
            >
              {saveSettings.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save limit"}
            </Button>
            <span className="text-xs text-muted-foreground pb-2">
              Default {settings.data?.meta.feedPostsPerMonth.default ?? 10} · admins are not limited
            </span>
          </div>
        )}
      </div>

      {/* ── Where donations are paid ──────────────────────────────────── */}
      <div className="card-elevated p-6 space-y-5">
        <div>
          <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
            <QrCode className="h-4 w-4" /> Donation Payment Details
          </h2>
          <p className="text-xs text-muted-foreground mt-1">
            There is no payment gateway. Donors pay against what you publish here, then submit the
            transaction reference for you to verify against the bank statement.
          </p>
        </div>

        {settings.isLoading ? (
          <Skeleton className="h-56 w-full" />
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="donationUpiId">UPI ID</Label>
                <Input
                  id="donationUpiId"
                  placeholder="adcetalumni@sbi"
                  value={payment.donationUpiId}
                  onChange={(e) => setPayment({ ...payment, donationUpiId: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="donationPayeeName">Payee name</Label>
                <Input
                  id="donationPayeeName"
                  placeholder="ADCET Alumni Association"
                  value={payment.donationPayeeName}
                  onChange={(e) => setPayment({ ...payment, donationPayeeName: e.target.value })}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>Payment QR code</Label>
              <div className="flex flex-wrap items-start gap-4">
                {payment.donationQrKey ? (
                  <img
                    src={storageUrl(payment.donationQrKey)}
                    alt="Donation QR code"
                    className="w-32 h-32 rounded-lg border border-border bg-white object-contain p-1.5"
                  />
                ) : (
                  <div className="w-32 h-32 rounded-lg border border-dashed border-border grid place-items-center">
                    <QrCode className="h-6 w-6 text-muted-foreground" />
                  </div>
                )}
                <div className="space-y-2">
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="gap-1.5"
                      disabled={qrUploading}
                      onClick={() => qrRef.current?.click()}
                    >
                      {qrUploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                      {payment.donationQrKey ? "Replace QR" : "Upload QR"}
                    </Button>
                    {payment.donationQrKey && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="gap-1.5 text-muted-foreground"
                        disabled={savePayment.isPending}
                        onClick={() => {
                          const next = { ...payment, donationQrKey: "" };
                          setPayment(next);
                          savePayment.mutate(next);
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" /> Remove
                      </Button>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground max-w-xs">
                    A screenshot of the QR from your bank's app. Uploading saves it straight away.
                  </p>
                </div>
                <input
                  ref={qrRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void handleQrPick(f);
                    e.target.value = "";
                  }}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="donationBankDetails">Bank transfer details</Label>
              <Textarea
                id="donationBankDetails"
                rows={4}
                maxLength={2000}
                placeholder={"A/c name: …\nA/c no: …\nIFSC: …\nBranch: …"}
                value={payment.donationBankDetails}
                onChange={(e) => setPayment({ ...payment, donationBankDetails: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">
                For donors who prefer NEFT/IMPS. Shown exactly as typed, one detail per line.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="donationInstructions">Payment instructions</Label>
              <Textarea
                id="donationInstructions"
                rows={3}
                maxLength={4000}
                placeholder="Anything a donor should know before paying."
                value={payment.donationInstructions}
                onChange={(e) => setPayment({ ...payment, donationInstructions: e.target.value })}
              />
            </div>

            <div className="flex items-center gap-3">
              <Button
                size="sm"
                className="gap-1.5"
                disabled={savePayment.isPending}
                onClick={() => savePayment.mutate(payment)}
              >
                {savePayment.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save payment details"}
              </Button>
              {!payment.donationUpiId && !payment.donationQrKey && !payment.donationBankDetails && (
                <span className="text-xs text-amber-600">
                  Until one of these is filled in, the donations page tells members payment details
                  haven't been published yet.
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="card-elevated p-6 space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
            <Mail className="h-4 w-4" /> Achievement Notification Recipients
          </h2>
          <p className="text-xs text-muted-foreground mt-1">
            When an achievement is approved, an announcement email is sent to these
            addresses (e.g. director, principal, editing & marketing team) in addition
            to the alumnus who submitted it. Enter one email per line (commas also work).
          </p>
        </div>
        {recipientsSection.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <>
            <Textarea
              rows={5}
              value={recipients}
              onChange={(e) => setRecipients(e.target.value)}
              placeholder={"director@adcet.in\nprincipal@adcet.in\nmarketing@adcet.in"}
            />
            <Button
              size="sm"
              className="gap-1.5"
              onClick={() => saveRecipients.mutate()}
              disabled={saveRecipients.isPending}
            >
              {saveRecipients.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save recipients"}
            </Button>
          </>
        )}
      </div>

      <ChangePasswordCard />
    </motion.div>
  );
};

export default SettingsPage;
