/**
 * The alumni office's donation ledger — and the desk where gifts are verified.
 *
 * Every row below is a donor's *claim* that they paid: there is no gateway, so
 * the admin's job is to find the reference in the college's bank statement and
 * then approve or reject. That decision is the only thing that turns a claim
 * into money, which is why the pending queue sits above the ledger rather than
 * being a filter within it — an unverified submission nobody looks at is a
 * donor waiting indefinitely for a receipt.
 */
import { motion } from "framer-motion";
import {
  Heart, TrendingUp, IndianRupee, Download, CheckCircle, XCircle, Clock, Loader2,
  FileSearch, ChevronLeft, ChevronRight,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/EmptyState";
import { toast } from "@/hooks/use-toast";
import { useEffect, useState } from "react";
import {
  STATUS_BADGE, STATUS_LABELS, formatINR, paymentMethodLabel,
  type AdminDonation, type DonationStats,
} from "@/lib/donations";
import DonationReviewDialog from "@/components/admin/DonationReviewDialog";

/** A campaign, as the ledger's filter dropdown draws it. */
interface CampaignItem {
  id: string;
  title: string;
  isActive: boolean;
}

interface Paginated<T> {
  items: T[];
  pagination: { total: number; page: number; pageSize: number; totalPages: number };
}

/**
 * Rows per ledger page. The office reconciles a statement a screen at a time,
 * so this is sized to be readable rather than to minimise round trips.
 */
const PAGE_SIZE = 25;

const donorOf = (d: AdminDonation) =>
  d.donorName || `${d.user.firstName} ${d.user.lastName}`.trim() || "—";

const DonationsAdminPage = () => {
  const qc = useQueryClient();
  const [status, setStatus] = useState("all");
  const [campaignId, setCampaignId] = useState("all");
  const [page, setPage] = useState(1);
  /** The submission an admin has open to check against the bank record. */
  const [reviewing, setReviewing] = useState<AdminDonation | null>(null);
  /** The row an admin is rejecting, and the reason they are typing. */
  const [rejecting, setRejecting] = useState<AdminDonation | null>(null);
  const [reason, setReason] = useState("");

  const filters = {
    status: status === "all" ? undefined : status,
    campaignId: campaignId === "all" ? undefined : campaignId,
  };

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ["admin", "donations", "ledger", status, campaignId, page],
    queryFn: () =>
      api.get<Paginated<AdminDonation>>("/donations", { ...filters, page, pageSize: PAGE_SIZE }),
    // Without this the table empties to skeletons on every page change, which
    // makes paging through a statement feel like a reload.
    placeholderData: (previous) => previous,
  });

  /**
   * The totals above the table.
   *
   * Their own request, because the table is paginated: adding up the rows on
   * screen would make "Total Received" mean "received on page 3". The server
   * computes them over the whole filtered set, so the cards and the table
   * always agree about what is being looked at.
   */
  const stats = useQuery({
    queryKey: ["admin", "donations", "stats", status, campaignId],
    queryFn: () => api.get<DonationStats>("/donations/stats", filters),
  });

  /**
   * The verification queue, fetched separately from the filtered ledger below.
   * Reusing the ledger's rows would make the queue disappear the moment an
   * admin filtered to RECEIVED — the one view where they are most likely to be
   * reconciling, and least likely to notice submissions piling up.
   */
  const pending = useQuery({
    queryKey: ["admin", "donations", "pending"],
    queryFn: () =>
      api.get<Paginated<AdminDonation>>("/donations", { pageSize: PAGE_SIZE, status: "PLEDGED" }),
  });

  // Every campaign, including archived ones — old donations still point at them.
  const campaigns = useQuery({
    queryKey: ["admin", "donations", "campaigns"],
    queryFn: () => api.get<Paginated<CampaignItem>>("/donations/campaigns", { pageSize: 100 }),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["admin", "donations"] });
    qc.invalidateQueries({ queryKey: ["analytics", "overview"] });
  };

  const approve = useMutation({
    mutationFn: (id: string) => api.post(`/donations/${id}/approve`, {}),
    onSuccess: () => {
      toast({
        title: "Donation verified",
        description: "A receipt has been generated and emailed to the donor.",
      });
      refresh();
    },
    onError: (e: unknown) =>
      toast({ title: "Could not verify", description: errorMessage(e), variant: "destructive" }),
  });

  const reject = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      api.post(`/donations/${id}/reject`, { reason }),
    onSuccess: () => {
      toast({
        title: "Donation rejected",
        description: "The donor has been emailed the reason. The record is archived for 30 days.",
      });
      setRejecting(null);
      setReason("");
      refresh();
    },
    onError: (e: unknown) =>
      toast({ title: "Could not reject", description: errorMessage(e), variant: "destructive" }),
  });

  const items = data?.items ?? [];
  const queue = pending.data?.items ?? [];
  const ledger = data?.pagination;

  /*
   * A verify or reject refetches both lists, so an open review sheet would
   * otherwise keep rendering the submission as it was *before* the decision —
   * still offering Verify on a gift already receipted. Re-point it at the fresh
   * row whenever the decision fields move; keep the copy it has when the row is
   * no longer in either list, so the sheet doesn't blank out under the admin.
   *
   * Keyed on the query results rather than the derived arrays, and updated
   * functionally, so it doesn't re-run on every render.
   */
  useEffect(() => {
    setReviewing((current) => {
      if (!current) return current;
      const rows = [...(pending.data?.items ?? []), ...(data?.items ?? [])];
      const fresh = rows.find((d) => d.id === current.id);
      if (!fresh) return current;
      const changed =
        fresh.status !== current.status ||
        fresh.receiptNo !== current.receiptNo ||
        fresh.rejectionReason !== current.rejectionReason;
      return changed ? fresh : current;
    });
  }, [data, pending.data]);
  const summary = stats.data;
  const byCampaign = summary?.byCampaign ?? [];

  const summaryCards = [
    { label: "Total Received", value: formatINR(summary?.totalReceived ?? 0), icon: IndianRupee, bg: "bg-accent/10", text: "text-accent" },
    { label: "This Month", value: formatINR(summary?.thisMonthReceived ?? 0), icon: TrendingUp, bg: "bg-primary/10", text: "text-primary" },
    { label: "Awaiting Verification", value: String(summary?.pendingCount ?? 0), icon: Clock, bg: "bg-amber-500/10", text: "text-amber-600" },
    { label: "Unique Donors", value: String(summary?.donorCount ?? 0), icon: Heart, bg: "bg-rose-500/10", text: "text-rose-600" },
  ];

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Donations</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Match each submission against the college's bank statement, then verify or reject it.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {summaryCards.map((s) => (
          <div key={s.label} className="stat-card hover:-translate-y-0.5">
            <div className={`w-10 h-10 rounded-xl ${s.bg} flex items-center justify-center mb-3`}>
              <s.icon className={`h-5 w-5 ${s.text}`} />
            </div>
            {stats.isLoading ? <Skeleton className="h-7 w-24" /> : (
              <p className="text-2xl font-bold text-foreground">{s.value}</p>
            )}
            <p className="text-sm text-muted-foreground">{s.label}</p>
          </div>
        ))}
      </div>

      {/* ── The verification queue ─────────────────────────────────────── */}
      <div className="card-elevated overflow-hidden">
        <div className="p-5 border-b border-border">
          <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
            <Clock className="h-4 w-4 text-amber-600" /> Awaiting verification
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Cross-check the reference and amount against the bank record. Verifying emails the
            donor a receipt; rejecting emails them your reason and archives the record for 30 days.
          </p>
        </div>
        {pending.isLoading ? (
          <div className="p-5 space-y-2">
            {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
          </div>
        ) : queue.length === 0 ? (
          <EmptyState
            icon={CheckCircle}
            title="Nothing waiting"
            description="Every submitted donation has been decided on."
          />
        ) : (
          <div className="divide-y divide-border">
            {queue.map((d) => (
              <div key={d.id} className="p-5 flex flex-col lg:flex-row lg:items-center gap-4">
                <div className="flex-1 min-w-0 space-y-1">
                  <p className="font-semibold text-foreground">
                    {formatINR(d.amount)}
                    <span className="ml-2 font-normal text-sm text-muted-foreground">
                      from {donorOf(d)}
                      {d.isAnonymous && <span className="text-[10px] ml-1">(anon)</span>}
                    </span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {d.donorEmail} · {d.campaign?.title ?? "General fund"}
                  </p>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs pt-1">
                    <span className="text-muted-foreground">
                      Ref{" "}
                      <code className="font-mono text-foreground">{d.reference ?? "—"}</code>
                    </span>
                    <span className="text-muted-foreground">{paymentMethodLabel(d.paymentMethod)}</span>
                    <span className="text-muted-foreground">
                      Paid {d.paidAt ? new Date(d.paidAt).toLocaleDateString("en-IN") : "—"}
                    </span>
                    <span className="text-muted-foreground">
                      Submitted {new Date(d.createdAt).toLocaleDateString("en-IN")}
                    </span>
                    {d.proofKey && (
                      <span className="text-accent inline-flex items-center gap-1">
                        <Download className="h-3 w-3" /> screenshot attached
                      </span>
                    )}
                  </div>
                  {d.message && (
                    <p className="text-xs text-foreground/80 italic pt-1">“{d.message}”</p>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  {/* The full submission — everything the donor filled in, with
                      their screenshot shown rather than downloaded. Deciding
                      from the strip alone is deciding on a summary. */}
                  <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={() => setReviewing(d)}>
                    <FileSearch className="h-3 w-3" /> Review
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    className="h-8 gap-1"
                    onClick={() => { setRejecting(d); setReason(""); }}
                  >
                    <XCircle className="h-3 w-3" /> Reject
                  </Button>
                  <Button
                    size="sm"
                    className="h-8 gap-1"
                    disabled={approve.isPending}
                    onClick={() => approve.mutate(d.id)}
                  >
                    {approve.isPending ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <CheckCircle className="h-3 w-3" />
                    )}
                    Verify & receipt
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {!stats.isLoading && byCampaign.length > 0 && (
        <div className="card-elevated p-5 space-y-3">
          <div>
            <h2 className="text-lg font-semibold text-foreground">What donors gave for</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Received totals across every donation matching the filters below.
            </p>
          </div>
          <div className="space-y-2">
            {byCampaign.map((c) => (
              <div key={c.campaignId ?? "general"} className="flex items-center justify-between gap-3 text-sm">
                <span className={c.campaignId === null ? "text-muted-foreground italic" : "text-foreground"}>
                  {c.title}
                </span>
                <span className="flex items-center gap-3 shrink-0">
                  <span className="text-xs text-muted-foreground">
                    {c.count} donation{c.count === 1 ? "" : "s"}
                  </span>
                  <span className="font-semibold text-foreground tabular-nums">
                    {formatINR(c.received)}
                  </span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card-elevated overflow-hidden">
        <div className="p-5 border-b border-border flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-foreground">Donation Ledger</h2>
          <div className="flex flex-col sm:flex-row gap-2">
          <Select value={campaignId} onValueChange={(v) => { setCampaignId(v); setPage(1); }}>
            <SelectTrigger className="w-full sm:w-56">
              <SelectValue placeholder="Campaign" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Campaigns</SelectItem>
              {(campaigns.data?.items ?? []).map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.title}{c.isActive ? "" : " (archived)"}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={status} onValueChange={(v) => { setStatus(v); setPage(1); }}>
            <SelectTrigger className="w-full sm:w-52">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              <SelectItem value="PLEDGED">Awaiting verification</SelectItem>
              <SelectItem value="RECEIVED">Verified</SelectItem>
              <SelectItem value="REJECTED">Not verified</SelectItem>
              <SelectItem value="CANCELLED">Withdrawn</SelectItem>
            </SelectContent>
          </Select>
          </div>
        </div>
        {isLoading ? (
          <div className="p-5 space-y-2">
            {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
          </div>
        ) : items.length === 0 ? (
          <EmptyState icon={Heart} title="No donations yet" description="Donations will appear here." />
        ) : (
          <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Donor</TableHead>
                <TableHead>Given for</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead>Reference</TableHead>
                <TableHead>Receipt No.</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Date</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((d) => {
                const donorEmail = d.donorEmail || d.user.email;
                return (
                  <TableRow key={d.id} className="hover:bg-muted/50 align-top">
                    <TableCell className="font-medium text-foreground">
                      <div>
                        <p className="flex items-center gap-1.5">
                          {donorOf(d)}
                          {d.isAnonymous && (
                            <span className="text-[10px] text-muted-foreground font-normal">(anon)</span>
                          )}
                        </p>
                        {donorEmail && <p className="text-xs text-muted-foreground">{donorEmail}</p>}
                      </div>
                    </TableCell>
                    <TableCell>
                      {d.campaign ? (
                        <span className="text-sm text-foreground">{d.campaign.title}</span>
                      ) : (
                        <span className="text-sm text-muted-foreground italic">General fund</span>
                      )}
                    </TableCell>
                    <TableCell className="font-semibold text-foreground">{formatINR(d.amount)}</TableCell>
                    {/* The transaction id alone — it is what an admin matches
                        against the statement. How it was paid is in Review. */}
                    <TableCell className="text-xs font-mono text-muted-foreground">
                      <span className="block max-w-[150px] truncate" title={d.reference ?? undefined}>
                        {d.reference ?? "—"}
                      </span>
                    </TableCell>
                    <TableCell className="text-xs font-mono text-muted-foreground">
                      {d.receiptNo ?? "—"}
                    </TableCell>
                    <TableCell>
                      <div className="space-y-1">
                        <Badge className={`text-[10px] ${STATUS_BADGE[d.status]}`}>
                          {STATUS_LABELS[d.status]}
                        </Badge>
                        {d.status === "REJECTED" && d.rejectionReason && (
                          <p className="text-[11px] text-muted-foreground max-w-[180px]">
                            {d.rejectionReason}
                          </p>
                        )}
                        {d.status === "RECEIVED" && d.verifiedBy && (
                          <p className="text-[11px] text-muted-foreground">
                            by {d.verifiedBy.firstName} {d.verifiedBy.lastName}
                          </p>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm whitespace-nowrap">
                      {new Date(d.paidAt ?? d.createdAt).toLocaleDateString("en-IN")}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        {/* Every row opens, whatever its status: a gift already
                            decided still has to be answerable when the donor
                            writes in about it. */}
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 gap-1"
                          onClick={() => setReviewing(d)}
                        >
                          <FileSearch className="h-3 w-3" /> Review
                        </Button>
                        {d.status === "PLEDGED" && (
                          <Button
                            size="sm"
                            className="h-8 gap-1"
                            disabled={approve.isPending}
                            onClick={() => approve.mutate(d.id)}
                          >
                            <CheckCircle className="h-3 w-3" /> Verify
                          </Button>
                        )}
                        {d.status === "RECEIVED" && (
                          <span className="inline-flex items-center gap-1 text-xs text-accent">
                            <CheckCircle className="h-3.5 w-3.5" /> Verified
                          </span>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          </div>
        )}

        {/* The ledger is the one list here that grows without bound, so it is
            paged. The totals above are their own query and stay whole-set. */}
        {ledger && ledger.total > 0 && (
          <div className="p-4 border-t border-border flex flex-col sm:flex-row items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              Showing {(ledger.page - 1) * ledger.pageSize + 1}–
              {Math.min(ledger.page * ledger.pageSize, ledger.total)} of {ledger.total} donation
              {ledger.total === 1 ? "" : "s"}
            </p>
            {ledger.totalPages > 1 && (
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={ledger.page <= 1 || isFetching}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  <ChevronLeft className="h-4 w-4 mr-1" /> Previous
                </Button>
                <span className="text-sm text-muted-foreground px-1 tabular-nums">
                  Page {ledger.page} of {ledger.totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={ledger.page >= ledger.totalPages || isFetching}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next <ChevronRight className="h-4 w-4 ml-1" />
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      <DonationReviewDialog
        donation={reviewing}
        approving={approve.isPending}
        onClose={() => setReviewing(null)}
        onApprove={(id) => approve.mutate(id)}
        onReject={(d) => { setRejecting(d as AdminDonation); setReason(""); }}
      />

      <Dialog open={!!rejecting} onOpenChange={(o) => !o && setRejecting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject this donation?</DialogTitle>
            <DialogDescription>
              {rejecting && (
                <>
                  {formatINR(rejecting.amount)} from {donorOf(rejecting)}, reference{" "}
                  <code className="font-mono">{rejecting.reference ?? "—"}</code>. Your reason is
                  emailed to the donor, and the record is archived and then removed after 30 days.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground" htmlFor="reject-reason">
              Reason *
            </label>
            <Textarea
              id="reject-reason"
              rows={3}
              maxLength={1000}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. No credit with this reference appears in the statement for that date."
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejecting(null)}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={reason.trim().length < 5 || reject.isPending}
              onClick={() => rejecting && reject.mutate({ id: rejecting.id, reason: reason.trim() })}
            >
              {reject.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Reject donation"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </motion.div>
  );
};

export default DonationsAdminPage;
