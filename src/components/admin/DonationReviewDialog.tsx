/**
 * Everything one alumnus submitted about a payment, on one screen, so an admin
 * can check it against the bank statement without piecing it together from a
 * table row.
 *
 * The ledger and the queue are lists: they show enough to *find* a submission,
 * which is not enough to *decide* on one. What a decision needs is the exact
 * reference to search the statement for, the amount and date it should match,
 * who says they paid it and how to reach them if it doesn't — and the
 * screenshot, shown rather than downloaded, because an admin verifying twenty
 * gifts should not be opening twenty files.
 *
 * The proof image is fetched through a presigned URL: `donation-proof` is a
 * private scope (somebody's bank app, their name, sometimes their balance), so
 * there is no public URL to point an `<img>` at. The URL is requested when this
 * opens and dropped when it closes.
 */
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { CheckCircle, Copy, Check, Download, ExternalLink, Loader2, XCircle } from "lucide-react";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/utils";
import { toast } from "@/hooks/use-toast";
import {
  STATUS_BADGE, STATUS_LABELS, formatINR, paymentMethodLabel,
  type AdminDonation,
} from "@/lib/donations";

/**
 * `DonationLedgerEntry.entryType`, as the office reads it. Anything unmapped
 * falls through to the raw value rather than blanking the line — the ledger is
 * append-only, so an entry written by an older release still has to render.
 */
const ENTRY_LABELS: Record<string, string> = {
  SUBMITTED: "Submitted by the donor",
  VERIFIED: "Verified against the bank record",
  REJECTED: "Rejected",
  RECEIPT_SENT: "Receipt emailed",
  WITHDRAWN: "Withdrawn by the donor",
};

const dateTime = (v?: string | null) =>
  v ? new Date(v).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "—";
const day = (v?: string | null) =>
  v ? new Date(v).toLocaleDateString("en-IN", { dateStyle: "medium" }) : "—";

/** One label/value line. `mono` for the fields an admin will compare character by character. */
const Row = ({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) => (
  <div className="flex items-baseline justify-between gap-4 py-1.5 border-b border-border/60 last:border-0">
    <span className="text-xs text-muted-foreground shrink-0">{label}</span>
    <span className={`text-sm text-foreground text-right ${mono ? "font-mono" : ""}`}>{value}</span>
  </div>
);

interface Props {
  donation: AdminDonation | null;
  onClose: () => void;
  onApprove: (id: string) => void;
  onReject: (donation: AdminDonation) => void;
  approving?: boolean;
}

const DonationReviewDialog = ({ donation, onClose, onApprove, onReject, approving }: Props) => {
  const [proofUrl, setProofUrl] = useState<string | null>(null);
  const [proofError, setProofError] = useState(false);
  const [copied, setCopied] = useState(false);

  const proofKey = donation?.proofKey ?? null;
  useEffect(() => {
    setProofUrl(null);
    setProofError(false);
    if (!proofKey) return;
    let live = true;
    api
      .post<{ url: string }>("/uploads/presign-download", { key: proofKey })
      .then(({ url }) => live && setProofUrl(url))
      .catch(() => live && setProofError(true));
    // The signed URL is short-lived and specific to this file; a stale one from
    // the previously reviewed donation must never render under a new donor.
    return () => {
      live = false;
    };
  }, [proofKey]);

  if (!donation) return null;

  const donorName =
    donation.donorName || `${donation.user.firstName} ${donation.user.lastName}`.trim() || "—";
  const donorEmail = donation.donorEmail || donation.user.email;
  const isPdf = /\.pdf($|\?)/i.test(proofKey ?? "");

  const copyReference = async () => {
    if (!donation.reference) return;
    try {
      await navigator.clipboard.writeText(donation.reference);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({ title: "Could not copy", description: donation.reference });
    }
  };

  const download = async (key: string) => {
    try {
      const { url } = await api.post<{ url: string }>("/uploads/presign-download", { key });
      window.open(url, "_blank");
    } catch (e) {
      toast({ title: "Download failed", description: errorMessage(e), variant: "destructive" });
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-3">
            <span>{formatINR(donation.amount)}</span>
            <Badge className={`text-[10px] ${STATUS_BADGE[donation.status]}`}>
              {STATUS_LABELS[donation.status]}
            </Badge>
          </DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* What to look for in the statement, first — it is why this is open. */}
          <div className="space-y-5">
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">
                Match against the bank record
              </h3>
              <div className="rounded-lg border border-border bg-muted/40 p-3 space-y-1">
                <p className="text-xs text-muted-foreground">Transaction reference</p>
                <div className="flex items-center gap-2">
                  <code className="text-base font-mono font-semibold text-foreground break-all">
                    {donation.reference ?? "— not provided —"}
                  </code>
                  {donation.reference && (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 shrink-0"
                      title="Copy reference"
                      onClick={copyReference}
                    >
                      {copied ? <Check className="h-3.5 w-3.5 text-accent" /> : <Copy className="h-3.5 w-3.5" />}
                    </Button>
                  )}
                </div>
              </div>
            </div>

            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">
                What was submitted
              </h3>
              <div>
                <Row label="Amount" value={<strong>{formatINR(donation.amount)}</strong>} />
                <Row label="Method" value={paymentMethodLabel(donation.paymentMethod)} />
                <Row label="Date paid" value={day(donation.paidAt)} />
                <Row label="Given for" value={donation.campaign?.title ?? "General fund"} />
                <Row label="Submitted" value={dateTime(donation.createdAt)} />
                <Row label="Show publicly" value={donation.isAnonymous ? "No — anonymous" : "Yes"} />
              </div>
              {donation.message && (
                <p className="mt-2 text-sm text-foreground/90 italic border-l-2 border-border pl-3">
                  “{donation.message}”
                </p>
              )}
            </div>

            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">
                Donor
              </h3>
              <div>
                <Row label="Name" value={donorName} />
                <Row
                  label="Email"
                  value={
                    donorEmail ? (
                      <a href={`mailto:${donorEmail}`} className="text-accent hover:underline">
                        {donorEmail}
                      </a>
                    ) : (
                      "—"
                    )
                  }
                />
                {donation.user.id && (
                  <Row
                    label="Profile"
                    value={
                      <a
                        href={`/admin/users/${donation.user.id}`}
                        className="text-accent hover:underline inline-flex items-center gap-1"
                      >
                        Open <ExternalLink className="h-3 w-3" />
                      </a>
                    }
                  />
                )}
              </div>
            </div>

            {(donation.status === "RECEIVED" || donation.status === "REJECTED") && (
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">
                  Decision
                </h3>
                <div>
                  {donation.receiptNo && <Row label="Receipt no." value={donation.receiptNo} mono />}
                  {donation.verifiedAt && <Row label="Verified" value={dateTime(donation.verifiedAt)} />}
                  {donation.verifiedBy && (
                    <Row
                      label="By"
                      value={`${donation.verifiedBy.firstName} ${donation.verifiedBy.lastName}`}
                    />
                  )}
                  {donation.rejectionReason && (
                    <Row label="Reason given" value={donation.rejectionReason} />
                  )}
                </div>
              </div>
            )}
          </div>

          {/* The donor's own evidence, shown rather than downloaded. */}
          <div className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Payment screenshot
            </h3>
            {!donation.proofKey ? (
              <div className="rounded-lg border border-dashed border-border p-6 text-center">
                <p className="text-sm text-muted-foreground">The donor didn't attach one.</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Verify from the reference and the bank statement.
                </p>
              </div>
            ) : proofError ? (
              <div className="rounded-lg border border-dashed border-border p-6 text-center space-y-2">
                <p className="text-sm text-muted-foreground">Couldn't load the file.</p>
                <Button size="sm" variant="outline" onClick={() => download(donation.proofKey!)}>
                  <Download className="h-3 w-3 mr-1.5" /> Download instead
                </Button>
              </div>
            ) : !proofUrl ? (
              <div className="rounded-lg border border-border h-64 grid place-items-center">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : isPdf ? (
              <div className="rounded-lg border border-border p-6 text-center space-y-2">
                <p className="text-sm text-muted-foreground">The donor attached a PDF.</p>
                <Button size="sm" variant="outline" onClick={() => window.open(proofUrl, "_blank")}>
                  <ExternalLink className="h-3 w-3 mr-1.5" /> Open it
                </Button>
              </div>
            ) : (
              <a href={proofUrl} target="_blank" rel="noreferrer" title="Open full size">
                <img
                  src={proofUrl}
                  alt="Payment screenshot submitted by the donor"
                  className="w-full rounded-lg border border-border bg-muted object-contain max-h-[28rem]"
                  onError={() => setProofError(true)}
                />
              </a>
            )}
            {donation.receiptKey && (
              <Button
                size="sm"
                variant="outline"
                className="w-full gap-1.5"
                onClick={() => download(donation.receiptKey!)}
              >
                <Download className="h-3 w-3" /> Download the issued receipt
              </Button>
            )}

            {/* The append-only trail behind this row. It is the only reader of
                `DonationLedgerEntry`, and what answers "who decided this, and
                when" when a donor writes in months later. */}
            {donation.ledgerEntries && donation.ledgerEntries.length > 0 && (
              <div className="pt-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                  History
                </h3>
                <ol className="space-y-2">
                  {donation.ledgerEntries.map((e) => (
                    <li key={e.id} className="text-xs border-l-2 border-border pl-3">
                      <p className="text-foreground">{ENTRY_LABELS[e.entryType] ?? e.entryType}</p>
                      <p className="text-muted-foreground">{dateTime(e.createdAt)}</p>
                      {e.note && <p className="text-muted-foreground/90 mt-0.5">{e.note}</p>}
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          {donation.status === "PLEDGED" ? (
            <>
              <Button variant="outline" onClick={onClose}>Close</Button>
              <Button variant="destructive" className="gap-1.5" onClick={() => onReject(donation)}>
                <XCircle className="h-4 w-4" /> Reject
              </Button>
              <Button className="gap-1.5" disabled={approving} onClick={() => onApprove(donation.id)}>
                {approving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle className="h-4 w-4" />}
                Verify &amp; send receipt
              </Button>
            </>
          ) : donation.status === "REJECTED" ? (
            <>
              <Button variant="outline" onClick={onClose}>Close</Button>
              <Button
                variant="outline"
                className="gap-1.5"
                disabled={approving}
                title="Undo the rejection and issue the receipt"
                onClick={() => onApprove(donation.id)}
              >
                <CheckCircle className="h-4 w-4" /> Verify anyway
              </Button>
            </>
          ) : (
            <Button variant="outline" onClick={onClose}>Close</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default DonationReviewDialog;
