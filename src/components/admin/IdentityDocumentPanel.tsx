/**
 * The proof of study an applicant uploaded at sign-up, shown to the admin
 * deciding whether to approve them.
 *
 * This is the only thing on a registration the office can actually check —
 * name, batch, department and company are all typed by the applicant. So it is
 * rendered *inline* rather than offered as a download: an admin working through
 * a queue of approvals should be reading marksheets, not opening files.
 *
 * `identity` is a private scope, so there is no public URL to point an `<img>`
 * at; the URL is presigned on open and dropped when the panel unmounts.
 */
import { useEffect, useState } from "react";
import { AlertCircle, ExternalLink, FileCheck2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";

interface Props {
  /** `Profile.identityDocumentKey`, or null for an account that predates sign-up asking. */
  documentKey?: string | null;
}

const IdentityDocumentPanel = ({ documentKey }: Props) => {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setUrl(null);
    setFailed(false);
    if (!documentKey) return;
    let live = true;
    api
      .post<{ url: string }>("/uploads/presign-download", { key: documentKey })
      .then(({ url }) => live && setUrl(url))
      .catch(() => live && setFailed(true));
    // The signed URL is short-lived and specific to this file; a stale one from
    // the previously viewed applicant must never render under a new name.
    return () => {
      live = false;
    };
  }, [documentKey]);

  const isPdf = /\.pdf($|\?)/i.test(documentKey ?? "");

  return (
    <div>
      <h2 className="font-semibold text-foreground mb-2 text-sm flex items-center gap-1.5">
        <FileCheck2 className="h-4 w-4 text-primary" /> Proof of study
      </h2>

      {!documentKey ? (
        /*
         * Not an error. Accounts created before sign-up asked for a document
         * have none, and saying so is more useful than an empty frame — it
         * tells the admin to verify this one some other way.
         */
        <div className="rounded-lg border border-dashed border-border p-4 flex items-start gap-2">
          <AlertCircle className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm text-foreground">No document on file</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              This account was created before sign-up collected one. Verify it another way before
              approving.
            </p>
          </div>
        </div>
      ) : failed ? (
        <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
          Couldn't load the document.
        </div>
      ) : !url ? (
        <div className="rounded-lg border border-border h-48 grid place-items-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : isPdf ? (
        <div className="rounded-lg border border-border p-4 text-center space-y-2">
          <p className="text-sm text-muted-foreground">The applicant uploaded a PDF.</p>
          <Button size="sm" variant="outline" onClick={() => window.open(url, "_blank")}>
            <ExternalLink className="h-3 w-3 mr-1.5" /> Open it
          </Button>
        </div>
      ) : (
        <a href={url} target="_blank" rel="noreferrer" title="Open full size">
          <img
            src={url}
            alt="Proof of study uploaded at sign-up"
            className="w-full rounded-lg border border-border bg-muted object-contain max-h-[26rem]"
            onError={() => setFailed(true)}
          />
        </a>
      )}
    </div>
  );
};

export default IdentityDocumentPanel;
