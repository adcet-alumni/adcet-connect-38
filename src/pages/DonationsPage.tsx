/**
 * Give to the college — pay, then declare.
 *
 * There is no payment gateway (the college would not carry the fee), so this
 * page is two halves in a fixed order: **where to pay**, which is the QR and
 * UPI ID the alumni office publishes, and **what you paid**, the form that
 * files the transaction reference for an admin to match against the bank
 * statement. The form cannot be submitted until the office has published
 * somewhere to pay — a reference is unanswerable otherwise, and the server
 * refuses the claim for the same reason.
 *
 * The page never says "thank you for your donation" on submit. Nothing here is
 * a gift until the office has verified it, and telling a donor otherwise is
 * exactly the misunderstanding the acknowledgement email exists to prevent.
 */
import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  Heart, Loader2, Download, CheckCircle2, QrCode, Copy, Check, Clock, XCircle,
  Upload, Smartphone, Info, Ban,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/utils";
import { toast } from "@/hooks/use-toast";
import { Skeleton } from "@/components/ui/skeleton";
import { storageUrl } from "@/lib/storage";
import { uploadFile, UPLOAD_MAX_BYTES } from "@/lib/upload";
import {
  DONATION_PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS,
  STATUS_LABELS,
  STATUS_TONE,
  formatINR,
  upiPayUrl,
  type Campaign,
  type DonationPaymentMethod,
  type MyDonation,
  type PaymentDetails,
} from "@/lib/donations";

const PRESETS = [1000, 5000, 10000, 50000];

/** Today, as the `type="date"` input wants it — and its own maximum. */
const todayISO = () => new Date().toISOString().slice(0, 10);

const DonationsPage = () => {
  const qc = useQueryClient();
  const [preset, setPreset] = useState<number | "other">(1000);
  // "" = the general alumni fund, which stays a valid choice.
  const [campaignId, setCampaignId] = useState("");
  const [custom, setCustom] = useState("");
  const [message, setMessage] = useState("");
  const [anonymous, setAnonymous] = useState(false);
  const [reference, setReference] = useState("");
  const [method, setMethod] = useState<DonationPaymentMethod>("UPI");
  const [paidOn, setPaidOn] = useState(todayISO);
  const [proofKey, setProofKey] = useState<string | null>(null);
  const [proofName, setProofName] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [copied, setCopied] = useState(false);

  const amount = preset === "other" ? Number(custom) || 0 : preset;

  const payment = useQuery({
    queryKey: ["donations", "payment-details"],
    queryFn: () => api.get<PaymentDetails>("/donations/payment-details"),
  });

  // Only campaigns currently open to donations are offered.
  const campaigns = useQuery({
    queryKey: ["donations", "campaigns", "active"],
    queryFn: () =>
      api.get<{ items: Campaign[] }>("/donations/campaigns", { active: true, pageSize: 50 }),
  });
  const openCampaigns = (campaigns.data?.items ?? []).filter((c) => {
    const now = Date.now();
    return (
      new Date(c.startsAt).getTime() <= now &&
      (!c.endsAt || new Date(c.endsAt).getTime() >= now)
    );
  });
  const selected = openCampaigns.find((c) => c.id === campaignId);

  const myDonations = useQuery({
    queryKey: ["donations", "me"],
    queryFn: () => api.get<MyDonation[] | { items?: MyDonation[] }>("/donations/me"),
  });
  const recent: MyDonation[] = Array.isArray(myDonations.data)
    ? myDonations.data
    : myDonations.data?.items ?? [];

  const qrUrl = storageUrl(payment.data?.qrKey || undefined);
  const upiLink = useMemo(
    () => (payment.data ? upiPayUrl(payment.data, amount) : null),
    [payment.data, amount],
  );

  const submit = useMutation({
    mutationFn: () =>
      api.post<MyDonation>("/donations", {
        amount,
        campaignId: campaignId || undefined,
        reference: reference.trim(),
        paymentMethod: method,
        paidAt: new Date(`${paidOn}T00:00:00`).toISOString(),
        proofKey: proofKey ?? undefined,
        message: message || undefined,
        isAnonymous: anonymous,
      }),
    onSuccess: () => {
      toast({
        title: "Submitted for verification",
        description: "You'll get your receipt by email once the office confirms it.",
      });
      qc.invalidateQueries({ queryKey: ["donations"] });
      setMessage("");
      setReference("");
      setProofKey(null);
      setProofName(null);
    },
    onError: (e: unknown) =>
      toast({ title: "Could not submit", description: errorMessage(e), variant: "destructive" }),
  });

  const withdraw = useMutation({
    mutationFn: (id: string) => api.post(`/donations/${id}/withdraw`),
    onSuccess: () => {
      toast({ title: "Submission withdrawn" });
      qc.invalidateQueries({ queryKey: ["donations"] });
    },
    onError: (e: unknown) =>
      toast({ title: "Could not withdraw", description: errorMessage(e), variant: "destructive" }),
  });

  const handleProofPick = async (file: File) => {
    if (file.size > UPLOAD_MAX_BYTES["donation-proof"]) {
      toast({
        title: "That file is too large",
        description: `Screenshots must be under ${UPLOAD_MAX_BYTES["donation-proof"] / (1024 * 1024)} MB.`,
        variant: "destructive",
      });
      return;
    }
    setUploading(true);
    try {
      const key = await uploadFile(file, "donation-proof");
      setProofKey(key);
      setProofName(file.name);
    } catch (e: unknown) {
      toast({ title: "Upload failed", description: errorMessage(e), variant: "destructive" });
    } finally {
      setUploading(false);
    }
  };

  const copyUpi = async () => {
    const upi = payment.data?.upiId;
    if (!upi) return;
    try {
      await navigator.clipboard.writeText(upi);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({ title: "Could not copy", description: upi });
    }
  };

  const downloadReceipt = async (key: string) => {
    try {
      const { url } = await api.post<{ url: string }>("/uploads/presign-download", { key });
      window.open(url, "_blank");
    } catch (e) {
      toast({ title: "Download failed", description: errorMessage(e), variant: "destructive" });
    }
  };

  const canSubmit =
    !!payment.data?.configured && amount >= 1 && reference.trim().length >= 4 && !!paidOn;

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Donations</h1>
        <p className="text-muted-foreground text-sm mt-1">Give back to the ADCET community</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          {/* ── Step 1: where to pay ─────────────────────────────────── */}
          <div className="card-elevated p-6 space-y-5">
            <div className="flex items-start gap-3">
              <span className="w-7 h-7 rounded-full bg-accent/15 text-accent grid place-items-center text-sm font-bold shrink-0">
                1
              </span>
              <div>
                <h2 className="text-lg font-semibold text-foreground">Pay</h2>
                <p className="text-sm text-muted-foreground mt-0.5">
                  Scan the QR, or transfer to the account below.
                </p>
              </div>
            </div>

            {payment.isLoading ? (
              <Skeleton className="h-56 w-full" />
            ) : !payment.data?.configured ? (
              <div className="rounded-lg border border-dashed border-border p-6 text-center space-y-2">
                <QrCode className="h-8 w-8 mx-auto text-muted-foreground" />
                <p className="text-sm font-medium text-foreground">
                  Payment details haven't been published yet
                </p>
                <p className="text-xs text-muted-foreground">Please check back shortly.</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-[auto,1fr] gap-5 items-start">
                {qrUrl ? (
                  <img
                    src={qrUrl}
                    alt="UPI payment QR code"
                    className="w-44 h-44 rounded-xl border border-border bg-white object-contain p-2"
                  />
                ) : (
                  <div className="w-44 h-44 rounded-xl border border-dashed border-border grid place-items-center text-center p-3">
                    <span className="text-xs text-muted-foreground">No QR — use the details alongside</span>
                  </div>
                )}

                <div className="space-y-3 min-w-0">
                  {payment.data.payeeName && (
                    <div>
                      <p className="text-xs text-muted-foreground">Paying to</p>
                      <p className="text-sm font-semibold text-foreground">{payment.data.payeeName}</p>
                    </div>
                  )}
                  {payment.data.upiId && (
                    <div>
                      <p className="text-xs text-muted-foreground">UPI ID</p>
                      <div className="flex items-center gap-2">
                        <code className="text-sm font-mono text-foreground break-all">
                          {payment.data.upiId}
                        </code>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7 shrink-0"
                          title="Copy UPI ID"
                          onClick={copyUpi}
                        >
                          {copied ? <Check className="h-3.5 w-3.5 text-accent" /> : <Copy className="h-3.5 w-3.5" />}
                        </Button>
                      </div>
                    </div>
                  )}
                  {payment.data.bankDetails && (
                    <div>
                      <p className="text-xs text-muted-foreground">Bank account</p>
                      <p className="text-sm text-foreground whitespace-pre-line">
                        {payment.data.bankDetails}
                      </p>
                    </div>
                  )}
                  {upiLink && (
                    <Button asChild variant="outline" size="sm" className="gap-1.5 sm:hidden">
                      {/* Phones only: on a desktop a upi:// link has nothing to open. */}
                      <a href={upiLink}>
                        <Smartphone className="h-3.5 w-3.5" /> Open in a UPI app
                      </a>
                    </Button>
                  )}
                </div>
              </div>
            )}

            {payment.data?.instructions && (
              <div className="rounded-lg bg-muted/50 p-3 flex items-start gap-2 text-xs text-muted-foreground">
                <Info className="h-4 w-4 mt-0.5 text-accent flex-shrink-0" />
                <span className="whitespace-pre-line">{payment.data.instructions}</span>
              </div>
            )}
          </div>

          {/* ── Step 2: tell us what you paid ────────────────────────── */}
          <div className="card-elevated p-6 space-y-6">
            <div className="flex items-start gap-3">
              <span className="w-7 h-7 rounded-full bg-accent/15 text-accent grid place-items-center text-sm font-bold shrink-0">
                2
              </span>
              <div>
                <h2 className="text-lg font-semibold text-foreground">Tell us what you paid</h2>
                <p className="text-sm text-muted-foreground mt-0.5">
                  The office verifies it against the bank record, then emails your receipt.
                </p>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="campaign">Support</Label>
              <Select value={campaignId || "general"} onValueChange={(v) => setCampaignId(v === "general" ? "" : v)}>
                <SelectTrigger id="campaign">
                  <SelectValue placeholder="Choose a cause" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="general">Wherever it's needed most (general fund)</SelectItem>
                  {openCampaigns.map((c) => (
                    <SelectItem key={c.id} value={c.id}>{c.title}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selected ? (
                <div className="rounded-lg border border-border bg-muted/40 p-3 space-y-2">
                  <p className="text-xs text-muted-foreground">{selected.description}</p>
                  <div className="space-y-1">
                    <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                      <div
                        className="h-full rounded-full bg-accent transition-all"
                        style={{
                          width: `${Math.min(100, Math.round(((selected.raisedAmount ?? 0) / selected.goalAmount) * 100))}%`,
                        }}
                      />
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      {formatINR(selected.raisedAmount ?? 0)} raised of{" "}
                      {formatINR(selected.goalAmount)} goal
                    </p>
                  </div>
                </div>
              ) : null}
            </div>

            <div className="space-y-3">
              <Label>Amount paid (₹)</Label>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {PRESETS.map((a) => (
                  <button
                    key={a}
                    type="button"
                    onClick={() => setPreset(a)}
                    className={`px-4 py-3 rounded-xl border text-sm font-semibold transition-all ${
                      preset === a
                        ? "border-accent bg-accent/10 text-accent ring-1 ring-accent"
                        : "border-border text-foreground hover:border-accent/50"
                    }`}
                  >
                    {formatINR(a)}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setPreset("other")}
                  className={`px-4 py-3 rounded-xl border text-sm font-semibold transition-all ${
                    preset === "other"
                      ? "border-accent bg-accent/10 text-accent ring-1 ring-accent"
                      : "border-border text-foreground hover:border-accent/50"
                  }`}
                >
                  Other
                </button>
              </div>
              {preset === "other" && (
                <Input
                  type="number"
                  min={1}
                  autoFocus
                  placeholder="Amount"
                  value={custom}
                  onChange={(e) => setCustom(e.target.value)}
                  className="max-w-xs"
                />
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="method">How you paid</Label>
                <Select value={method} onValueChange={(v) => setMethod(v as DonationPaymentMethod)}>
                  <SelectTrigger id="method">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DONATION_PAYMENT_METHODS.map((m) => (
                      <SelectItem key={m} value={m}>{PAYMENT_METHOD_LABELS[m]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="paidOn">Date paid</Label>
                <Input
                  id="paidOn"
                  type="date"
                  max={todayISO()}
                  value={paidOn}
                  onChange={(e) => setPaidOn(e.target.value)}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="reference">Transaction reference / UTR *</Label>
              <Input
                id="reference"
                value={reference}
                maxLength={80}
                placeholder="e.g. 402318795412"
                onChange={(e) => setReference(e.target.value)}
                className="font-mono"
              />
              <p className="text-xs text-muted-foreground">
                The UTR / transaction ID from your payment app — copy it exactly.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label>Payment screenshot (optional)</Label>
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  disabled={uploading}
                  onClick={() => document.getElementById("proof-input")?.click()}
                >
                  {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                  {proofKey ? "Replace file" : "Attach screenshot"}
                </Button>
                {proofName && <span className="text-xs text-muted-foreground truncate">{proofName}</span>}
                <input
                  id="proof-input"
                  type="file"
                  accept="image/*,application/pdf"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void handleProofPick(f);
                    e.target.value = "";
                  }}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Speeds up verification. Only you and the office can see it.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="donation-message">Message (optional)</Label>
              <Textarea
                id="donation-message"
                value={message}
                maxLength={1000}
                rows={2}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="A note with your gift"
              />
            </div>

            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={anonymous} onChange={(e) => setAnonymous(e.target.checked)} />
              Show my donation as anonymous
            </label>

            <Button
              onClick={() => submit.mutate()}
              disabled={!canSubmit || submit.isPending || uploading}
              className="w-full sm:w-auto px-8"
            >
              {submit.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <>
                  <Heart className="mr-2 h-4 w-4" /> Submit {formatINR(amount)}
                </>
              )}
            </Button>
          </div>
        </div>

        <div className="card-elevated p-6 h-fit">
          <h2 className="text-lg font-semibold text-foreground mb-4">My Donations</h2>
          <div className="space-y-3">
            {myDonations.isLoading &&
              Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-14 w-full" />)}
            {!myDonations.isLoading && recent.length === 0 && (
              <p className="text-sm text-muted-foreground">No donations yet.</p>
            )}
            {recent.slice(0, 6).map((d) => (
              <div key={d.id} className="p-3 rounded-lg bg-muted/50 space-y-2">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-full bg-accent/10 flex items-center justify-center flex-shrink-0">
                    {d.status === "RECEIVED" ? (
                      <CheckCircle2 className="h-4 w-4 text-accent" />
                    ) : d.status === "REJECTED" ? (
                      <XCircle className="h-4 w-4 text-destructive" />
                    ) : d.status === "CANCELLED" ? (
                      <Ban className="h-4 w-4 text-muted-foreground" />
                    ) : (
                      <Clock className="h-4 w-4 text-amber-600" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground">{formatINR(d.amount)}</p>
                    <p className="text-xs text-foreground/80 truncate">
                      {d.campaign?.title ?? "General fund"}
                    </p>
                    <p className="text-xs text-muted-foreground truncate">
                      {new Date(d.paidAt ?? d.createdAt).toLocaleDateString("en-IN")} ·{" "}
                      <span className={STATUS_TONE[d.status]}>{STATUS_LABELS[d.status]}</span>
                    </p>
                  </div>
                  {d.receiptKey && (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8 flex-shrink-0"
                      title="Download receipt"
                      onClick={() => downloadReceipt(d.receiptKey!)}
                    >
                      <Download className="h-4 w-4" />
                    </Button>
                  )}
                </div>
                {d.status === "REJECTED" && d.rejectionReason && (
                  <p className="text-xs text-destructive/90 pl-12">{d.rejectionReason}</p>
                )}
                {d.status === "PLEDGED" && (
                  <div className="pl-12">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-xs text-muted-foreground"
                      disabled={withdraw.isPending}
                      onClick={() => withdraw.mutate(d.id)}
                    >
                      Withdraw
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </motion.div>
  );
};

export default DonationsPage;
