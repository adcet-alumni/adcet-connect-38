import { useEffect, useRef, useState } from "react";
import { FileText, ImagePlus, Loader2, Plus, Upload, X } from "lucide-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { storageUrl } from "@/lib/storage";
import { uploadFile } from "@/lib/upload";
import { toast } from "@/hooks/use-toast";

/**
 * The one form that adds an achievement, in both places it can be added from.
 *
 * An alumnus submits their own (`/achievements`, lands PENDING). The alumni
 * office records somebody else's (`/achievements/admin`, lands APPROVED and
 * silent) and therefore answers one extra question first: whose is it? Either
 * a member of the portal — the entry then belongs to *their* account and shows
 * on their achievements — or a plain name for someone who never registered.
 *
 * Everything below the achiever block is identical for both, which is why this
 * is one component: the two forms could otherwise drift into asking for
 * different things about the same record.
 */

const EMPTY_FORM = { title: "", description: "", category: "", occurredOn: "", link: "" };
const ATTACHMENT_ACCEPT =
  "application/pdf,image/*,.doc,.docx,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** A directory row, as much of it as the picker needs. */
interface AlumniOption {
  userId: string;
  linkedinUrl?: string | null;
  department?: string | null;
  graduationYear?: number | null;
  user?: { firstName?: string; lastName?: string };
}

const nameOf = (a: AlumniOption) =>
  `${a.user?.firstName ?? ""} ${a.user?.lastName ?? ""}`.trim() || "Alumnus";

type Achiever =
  | { kind: "member"; picked: AlumniOption | null }
  | { kind: "guest"; name: string };

export interface AchievementFormDialogProps {
  /** Admin mode adds the achiever block and posts to the admin route. */
  admin?: boolean;
  onCreated: () => void;
}

export default function AchievementFormDialog({ admin, onCreated }: AchievementFormDialogProps) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [achiever, setAchiever] = useState<Achiever>({ kind: "member", picked: null });
  const [linkedin, setLinkedin] = useState("");
  const [imageKey, setImageKey] = useState<string | null>(null);
  const [attachmentKey, setAttachmentKey] = useState<string | null>(null);
  const [attachmentName, setAttachmentName] = useState("");
  const [imgUploading, setImgUploading] = useState(false);
  const [docUploading, setDocUploading] = useState(false);
  const imgRef = useRef<HTMLInputElement>(null);
  const docRef = useRef<HTMLInputElement>(null);

  const reset = () => {
    setForm(EMPTY_FORM);
    setAchiever({ kind: "member", picked: null });
    setLinkedin("");
    setImageKey(null);
    setAttachmentKey(null);
    setAttachmentName("");
  };

  const create = useMutation({
    mutationFn: () => {
      const common = {
        title: form.title,
        description: form.description,
        category: form.category || undefined,
        occurredOn: form.occurredOn ? new Date(form.occurredOn).toISOString() : undefined,
        link: form.link || undefined,
        imageKey: imageKey || undefined,
        attachmentKey: attachmentKey || undefined,
      };
      if (!admin) return api.post("/achievements", common);
      return api.post("/achievements/admin", {
        ...common,
        ...(achiever.kind === "member"
          ? { userId: achiever.picked?.userId }
          : { achieverName: achiever.name.trim() }),
        // Blank means "use their profile link", which then stays in step with
        // whatever they later change it to.
        achieverLinkedinUrl: linkedin.trim() || undefined,
      });
    },
    onSuccess: () => {
      toast(
        admin
          ? { title: "Achievement added", description: "It is live now." }
          : { title: "Submitted", description: "Pending admin approval." },
      );
      setOpen(false);
      onCreated();
      reset();
    },
    onError: (e: Error) =>
      toast({ title: "Failed", description: e?.message, variant: "destructive" }),
  });

  const handleImage = async (file: File) => {
    if (!file.type.startsWith("image/")) {
      toast({ title: "Please select an image", variant: "destructive" });
      return;
    }
    setImgUploading(true);
    try {
      setImageKey(await uploadFile(file, "achievement"));
    } catch (e) {
      toast({ title: "Image upload failed", description: (e as Error)?.message, variant: "destructive" });
    } finally {
      setImgUploading(false);
    }
  };

  const handleDoc = async (file: File) => {
    setDocUploading(true);
    try {
      setAttachmentKey(await uploadFile(file, "achievement"));
      setAttachmentName(file.name);
    } catch (e) {
      toast({ title: "Upload failed", description: (e as Error)?.message, variant: "destructive" });
    } finally {
      setDocUploading(false);
    }
  };

  /** An admin has to have said whose achievement this is before submitting. */
  const achieverMissing =
    admin &&
    (achiever.kind === "member" ? !achiever.picked : achiever.name.trim().length < 2);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" className="gap-1.5">
          <Plus className="h-3.5 w-3.5" /> {admin ? "Add achievement" : "Add"}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{admin ? "Add an achievement" : "Add Achievement"}</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
          className="space-y-3"
        >
          {admin && (
            <AchieverPicker
              value={achiever}
              onChange={(next) => {
                setAchiever(next);
                // Pre-fill from the member's profile, so the usual case is no
                // typing at all. Cleared when they switch to a plain name.
                setLinkedin(next.kind === "member" ? next.picked?.linkedinUrl ?? "" : "");
              }}
              linkedin={linkedin}
              onLinkedinChange={setLinkedin}
            />
          )}

          <div className="space-y-1.5">
            <Label>Title</Label>
            <Input
              required
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Description</Label>
            <Textarea
              required
              rows={4}
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Category</Label>
              <Input
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value })}
                placeholder="Academic, Sports..."
              />
            </div>
            <div className="space-y-1.5">
              <Label>Date</Label>
              <Input
                type="date"
                value={form.occurredOn}
                onChange={(e) => setForm({ ...form, occurredOn: e.target.value })}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>
              Link <span className="text-muted-foreground font-normal">(optional)</span>
            </Label>
            <Input
              type="url"
              value={form.link}
              onChange={(e) => setForm({ ...form, link: e.target.value })}
              placeholder="https://..."
            />
          </div>

          {/* Cover image */}
          <div className="space-y-1.5">
            <Label>
              Cover image{" "}
              <span className="text-muted-foreground font-normal">
                (optional — shown on cards &amp; home slider)
              </span>
            </Label>
            <input
              ref={imgRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleImage(f);
                e.target.value = "";
              }}
            />
            {imageKey ? (
              <div className="flex items-center gap-2">
                <img
                  src={storageUrl(imageKey)}
                  alt="cover"
                  className="h-14 w-20 object-cover rounded-md border border-border"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="gap-1.5 text-destructive"
                  onClick={() => setImageKey(null)}
                >
                  <X className="h-3.5 w-3.5" /> Remove
                </Button>
              </div>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1.5"
                disabled={imgUploading}
                onClick={() => imgRef.current?.click()}
              >
                {imgUploading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ImagePlus className="h-3.5 w-3.5" />
                )}{" "}
                Upload image
              </Button>
            )}
          </div>

          {/* Certificate / document */}
          <div className="space-y-1.5">
            <Label>
              Certificate / document{" "}
              <span className="text-muted-foreground font-normal">
                (optional — PDF, DOC or image)
              </span>
            </Label>
            <input
              ref={docRef}
              type="file"
              accept={ATTACHMENT_ACCEPT}
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleDoc(f);
                e.target.value = "";
              }}
            />
            {attachmentKey ? (
              <div className="flex items-center gap-2 text-sm">
                <FileText className="h-4 w-4 text-primary flex-shrink-0" />
                <span className="truncate flex-1 text-muted-foreground">
                  {attachmentName || "Attached"}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="gap-1.5 text-destructive"
                  onClick={() => {
                    setAttachmentKey(null);
                    setAttachmentName("");
                  }}
                >
                  <X className="h-3.5 w-3.5" /> Remove
                </Button>
              </div>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1.5"
                disabled={docUploading}
                onClick={() => docRef.current?.click()}
              >
                {docUploading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Upload className="h-3.5 w-3.5" />
                )}{" "}
                Upload document
              </Button>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={create.isPending || imgUploading || docUploading || achieverMissing}
            >
              {create.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : admin ? "Add" : "Submit"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Whose achievement is this?
 *
 * Searching the directory is the first option because filing under a real
 * account is the better outcome: the entry reaches that member's own
 * achievements, and their LinkedIn comes from their profile and stays current.
 * The plain-name option exists so a guest speaker or an alumnus who never
 * registered can still be recorded rather than left out.
 */
const AchieverPicker = ({
  value,
  onChange,
  linkedin,
  onLinkedinChange,
}: {
  value: Achiever;
  onChange: (next: Achiever) => void;
  linkedin: string;
  onLinkedinChange: (next: string) => void;
}) => {
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const picked = value.kind === "member" ? value.picked : null;

  const results = useQuery({
    queryKey: ["alumni", "achiever-picker", debounced],
    // Only once they have typed something: the point is to find one person,
    // not to page through the directory inside a dialog.
    enabled: value.kind === "member" && debounced.length >= 2 && !picked,
    queryFn: () =>
      api
        .get<{ items: AlumniOption[] }>("/alumni", { q: debounced, sort: "name", pageSize: 8 })
        .then((r) => r.items),
  });

  return (
    <div className="rounded-lg border border-border p-3 space-y-3">
      <div className="space-y-1.5">
        <Label>Whose achievement is this?</Label>
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            variant={value.kind === "member" ? "default" : "outline"}
            onClick={() => onChange({ kind: "member", picked: null })}
          >
            An alumnus on the portal
          </Button>
          <Button
            type="button"
            size="sm"
            variant={value.kind === "guest" ? "default" : "outline"}
            onClick={() => onChange({ kind: "guest", name: "" })}
          >
            Someone else
          </Button>
        </div>
      </div>

      {value.kind === "member" ? (
        picked ? (
          <div className="flex items-center gap-2 text-sm">
            <span className="flex-1 truncate">
              <span className="font-medium text-foreground">{nameOf(picked)}</span>
              {picked.graduationYear ? (
                <span className="text-muted-foreground"> · {picked.graduationYear}</span>
              ) : null}
              {picked.department ? (
                <span className="text-muted-foreground"> · {picked.department}</span>
              ) : null}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="gap-1.5"
              onClick={() => {
                setSearch("");
                onChange({ kind: "member", picked: null });
              }}
            >
              <X className="h-3.5 w-3.5" /> Change
            </Button>
          </div>
        ) : (
          <div className="space-y-1.5">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search alumni by name or company"
              aria-label="Search alumni"
            />
            {results.isFetching && (
              <p className="text-xs text-muted-foreground">Searching…</p>
            )}
            {results.data?.length === 0 && debounced.length >= 2 && (
              <p className="text-xs text-muted-foreground">
                Nobody matched. Use “Someone else” to record the name yourself.
              </p>
            )}
            {!!results.data?.length && (
              <ul className="max-h-40 overflow-y-auto rounded-md border border-border divide-y divide-border">
                {results.data.map((a) => (
                  <li key={a.userId}>
                    <button
                      type="button"
                      className="w-full text-left px-3 py-2 text-sm hover:bg-muted transition-colors"
                      onClick={() => onChange({ kind: "member", picked: a })}
                    >
                      <span className="font-medium text-foreground">{nameOf(a)}</span>
                      {a.graduationYear ? (
                        <span className="text-muted-foreground"> · {a.graduationYear}</span>
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )
      ) : (
        <div className="space-y-1.5">
          <Label htmlFor="achiever-name">Name</Label>
          <Input
            id="achiever-name"
            value={value.name}
            onChange={(e) => onChange({ kind: "guest", name: e.target.value })}
            placeholder="e.g. Dr. S. R. Kulkarni"
          />
        </div>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="achiever-linkedin">
          LinkedIn <span className="text-muted-foreground font-normal">(optional)</span>
        </Label>
        <Input
          id="achiever-linkedin"
          type="url"
          value={linkedin}
          onChange={(e) => onLinkedinChange(e.target.value)}
          placeholder="https://linkedin.com/in/…"
        />
        <p className="text-xs text-muted-foreground">
          {value.kind === "member"
            ? "Pre-filled from their profile. Leave it blank to keep following their profile — and if they have hidden their LinkedIn, no link is shown either way."
            : "Shown as an icon next to their name in the portal. Leave blank if you don't have one."}
        </p>
      </div>
    </div>
  );
};
