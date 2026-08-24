import { useState } from "react";
import { motion } from "framer-motion";
import { Trophy, ExternalLink, FileText, Linkedin } from "lucide-react";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { LoadingGrid } from "@/components/LoadingGrid";
import { EmptyState } from "@/components/EmptyState";
import AchievementCardMedia from "@/components/AchievementCardMedia";
import AchievementFormDialog from "@/components/AchievementFormDialog";
import { achieverInitials, achieverLinkedin, achieverOf } from "@/lib/achievements";
import { safeExternalUrl } from "@/lib/urls";

interface Achievement {
  id: string;
  title: string;
  description: string;
  category?: string | null;
  occurredOn?: string | null;
  imageKey?: string | null;
  attachmentKey?: string | null;
  link?: string | null;
  status: "PENDING" | "APPROVED" | "REJECTED";
  rejectionReason?: string | null;
  /** Set when the alumni office recorded this for someone off the portal. */
  achieverName?: string | null;
  /** Resolved by the API — null when the achiever has no link to show. */
  linkedinUrl?: string | null;
  user?: { firstName?: string; lastName?: string };
}

const STATUS_STYLES: Record<Achievement["status"], string> = {
  PENDING: "bg-amber-500/15 text-amber-600 border-0",
  APPROVED: "bg-accent/15 text-accent border-0",
  REJECTED: "bg-destructive/15 text-destructive border-0",
};

/**
 * One achievement card. `showStatus` is on for the author's own submissions,
 * where the moderation state (and any rejection reason) is the whole point —
 * before this, a submission vanished until an admin approved it.
 */
const AchievementCard = ({ a, showStatus }: { a: Achievement; showStatus?: boolean }) => (
  <div className="card-elevated overflow-hidden flex flex-col h-full hover:-translate-y-0.5 hover:shadow-lg transition-all">
    <Link to={`/dashboard/achievements/${a.id}`} className="block">
      <AchievementCardMedia item={a} />
    </Link>

    <div className="p-5 flex flex-col flex-1 gap-3">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0 text-xs font-semibold text-primary">
          {achieverInitials(a)}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground truncate flex items-center gap-1.5">
            <span className="truncate">{achieverOf(a, "Alumni")}</span>
            {/* Rendered only when the API sent a usable link. */}
            {achieverLinkedin(a) && (
              <a
                href={achieverLinkedin(a)}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                aria-label={`${achieverOf(a, "Alumni")} on LinkedIn`}
                title={`${achieverOf(a, "Alumni")} on LinkedIn`}
                className="shrink-0 rounded p-0.5 text-[#0A66C2] hover:bg-[#0A66C2]/10 transition-colors"
              >
                <Linkedin className="h-3.5 w-3.5" />
              </a>
            )}
          </p>
          {a.occurredOn && (
            <p className="text-xs text-muted-foreground">
              {new Date(a.occurredOn).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}
            </p>
          )}
        </div>
        {showStatus && (
          <Badge className={`text-[10px] capitalize shrink-0 ${STATUS_STYLES[a.status]}`}>
            {a.status.toLowerCase()}
          </Badge>
        )}
      </div>

      <Link to={`/dashboard/achievements/${a.id}`} className="block">
        <h3 className="font-semibold text-foreground text-sm hover:underline line-clamp-2">{a.title}</h3>
      </Link>
      {/* Fixed line count keeps every card in a row the same height. */}
      <p className="text-xs text-muted-foreground line-clamp-3">{a.description}</p>

      {showStatus && a.status === "REJECTED" && a.rejectionReason && (
        <p className="text-xs rounded-md bg-destructive/10 text-destructive px-2.5 py-2">
          <span className="font-medium">Not approved:</span> {a.rejectionReason}
        </p>
      )}
      {showStatus && a.status === "PENDING" && (
        <p className="text-xs text-muted-foreground italic">Waiting for admin review — only you can see this.</p>
      )}

      {/* Pinned to the bottom so links line up across the row. */}
      <div className="flex flex-wrap items-center gap-3 mt-auto pt-1">
        {a.link && (
          <a href={safeExternalUrl(a.link)} target="_blank" rel="noreferrer" className="text-xs text-primary hover:underline inline-flex items-center gap-1">
            <ExternalLink className="h-3 w-3" /> Link
          </a>
        )}
        {a.attachmentKey && (
          <a href={storageUrl(a.attachmentKey)} target="_blank" rel="noreferrer" className="text-xs text-primary hover:underline inline-flex items-center gap-1">
            <FileText className="h-3 w-3" /> Document
          </a>
        )}
      </div>
    </div>
  </div>
);

const TABS = ["All Achievements", "My Submissions"] as const;

const AchievementsPage = () => {
  const qc = useQueryClient();
  const [tab, setTab] = useState<(typeof TABS)[number]>("All Achievements");
  const mine = tab === "My Submissions";

  const list = useQuery({
    queryKey: ["achievements", mine ? "mine" : "approved"],
    queryFn: () =>
      api.get<{ items: Achievement[] }>(
        "/achievements",
        mine ? { mine: true, pageSize: 30 } : { status: "APPROVED", pageSize: 30 },
      ),
  });

  const items = list.data?.items ?? [];

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Achievements</h1>
          <p className="text-muted-foreground text-sm mt-1">Celebrating alumni accomplishments</p>
        </div>
        <AchievementFormDialog onCreated={() => qc.invalidateQueries({ queryKey: ["achievements"] })} />
      </div>

      <div className="flex gap-1 bg-muted p-1 rounded-lg w-fit">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm rounded-md transition-colors ${
              tab === t ? "bg-card text-foreground font-medium shadow-sm" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {list.isLoading && <LoadingGrid />}
      {!list.isLoading && items.length === 0 && (
        <EmptyState
          icon={Trophy}
          title={mine ? "You haven't submitted anything yet" : "No achievements yet"}
          description={mine ? "Add an achievement and track its approval here." : "Submit yours to be featured."}
        />
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 items-stretch">
        {items.map((a) => (
          <AchievementCard key={a.id} a={a} showStatus={mine} />
        ))}
      </div>
    </motion.div>
  );
};

export default AchievementsPage;
