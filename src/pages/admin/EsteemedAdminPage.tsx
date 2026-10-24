import { useRef, useState } from "react";
import { motion } from "framer-motion";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Loader2,
  Pencil,
  Plus,
  Star,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { toast } from "@/hooks/use-toast";
import { EmptyState } from "@/components/EmptyState";
import { uploadFile } from "@/lib/upload";
import {
  ESTEEMED_CATEGORIES,
  esteemedAlumniQuery,
  esteemedAlumnusPhotoUrl,
  categoryIdOf,
  createEsteemedAlumnus,
  updateEsteemedAlumnus,
  deleteEsteemedAlumnus,
  reorderEsteemedAlumni,
  type EsteemedAlumnus,
  type EsteemedCategoryDb,
} from "@/lib/esteemed";

const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

const failed = (e: unknown) =>
  toast({
    title: "Something went wrong",
    description: e instanceof Error ? e.message : undefined,
    variant: "destructive",
  });

const emptyForm = () => ({
  name: "",
  batch: new Date().getFullYear().toString(),
  position: "",
  category: "leadership" as EsteemedCategoryDb,
});

const CATEGORY_LABELS: Record<EsteemedCategoryDb, string> = {
  leadership: "Leaders in Industry & Academia",
  entrepreneurs: "Entrepreneurs & Innovators",
  civil_services: "Civil Services & Public Administration",
};

/* ----------------------------- Form dialog ----------------------------- */

const AlumnusFormDialog = ({
  alumnus,
  open,
  onOpenChange,
  onSaved,
}: {
  alumnus: EsteemedAlumnus | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) => {
  const [form, setForm] = useState(emptyForm());
  const [initialisedFor, setInitialisedFor] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [pendingPhotoKey, setPendingPhotoKey] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const key = alumnus?.id ?? "new";
  if (open && initialisedFor !== key) {
    setInitialisedFor(key);
    setForm(
      alumnus
        ? {
            name: alumnus.name,
            batch: alumnus.batch.toString(),
            position: alumnus.position,
            category: alumnus.category,
          }
        : emptyForm(),
    );
    setPendingPhotoKey(null);
    setPreviewUrl(alumnus ? (esteemedAlumnusPhotoUrl(alumnus) ?? null) : null);
  }
  if (!open && initialisedFor !== null) {
    setInitialisedFor(null);
    setPendingPhotoKey(null);
    setPreviewUrl(null);
  }

  const onPickPhoto = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    if (file.size > MAX_PHOTO_BYTES) {
      return toast({ title: "Photo too large", description: "Maximum size is 10 MB.", variant: "destructive" });
    }
    setUploading(true);
    try {
      const k = await uploadFile(file, "esteemed-alumni");
      setPendingPhotoKey(k);
      setPreviewUrl(URL.createObjectURL(file));
    } catch (e) {
      failed(e);
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const save = useMutation({
    mutationFn: () => {
      const batchNum = parseInt(form.batch, 10);
      if (isNaN(batchNum)) throw new Error("Batch year must be a valid number.");
      if (!pendingPhotoKey && !alumnus?.photoKey) throw new Error("A portrait photo is required.");

      const payload = {
        name: form.name.trim(),
        batch: batchNum,
        position: form.position.trim(),
        category: form.category,
        ...(pendingPhotoKey ? { photoKey: pendingPhotoKey } : {}),
      };
      return alumnus
        ? updateEsteemedAlumnus(alumnus.id, payload)
        : createEsteemedAlumnus({ ...payload, photoKey: pendingPhotoKey! });
    },
    onSuccess: () => {
      toast({ title: alumnus ? "Alumnus updated" : "Alumnus added" });
      onOpenChange(false);
      onSaved();
    },
    onError: failed,
  });

  const isCreating = !alumnus;
  const valid =
    form.name.trim().length > 0 &&
    form.position.trim().length > 0 &&
    form.batch.trim().length > 0 &&
    (!isCreating || !!pendingPhotoKey);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{alumnus ? "Edit esteemed alumnus" : "Add esteemed alumnus"}</DialogTitle>
          <DialogDescription>
            A portrait photo is required. Upload it first, then fill in the details.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Photo preview */}
          <div className="flex items-center gap-4">
            <div className="h-24 w-18 rounded-lg overflow-hidden border border-border bg-muted flex items-center justify-center shrink-0 aspect-[3/4]" style={{ width: "4.5rem" }}>
              {previewUrl ? (
                <img src={previewUrl} alt="Preview" className="h-full w-full object-cover object-top" />
              ) : (
                <Upload className="h-5 w-5 text-muted-foreground/50" />
              )}
            </div>
            <div className="space-y-1.5">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => fileInput.current?.click()}
                disabled={uploading}
              >
                {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                {uploading ? "Uploading…" : previewUrl ? "Replace photo" : "Upload photo"}
              </Button>
              {previewUrl && !uploading && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="gap-1.5 text-muted-foreground"
                  onClick={() => { setPendingPhotoKey(null); setPreviewUrl(null); }}
                >
                  <X className="h-3.5 w-3.5" /> Remove
                </Button>
              )}
              <p className="text-[11px] text-muted-foreground">JPG / PNG · max 10 MB · 3:4 portrait recommended</p>
            </div>
            <input ref={fileInput} type="file" accept="image/*" className="hidden" onChange={(e) => onPickPhoto(e.target.files)} />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ea-name">Full name</Label>
            <Input id="ea-name" placeholder="Vikas Gaikwad" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="ea-batch">Batch (graduating year)</Label>
              <Input id="ea-batch" type="number" min={1960} max={2099} placeholder="2005" value={form.batch} onChange={(e) => setForm({ ...form, batch: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ea-category">Category</Label>
              <Select value={form.category} onValueChange={(v) => setForm({ ...form, category: v as EsteemedCategoryDb })}>
                <SelectTrigger id="ea-category">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(["leadership", "entrepreneurs", "civil_services"] as EsteemedCategoryDb[]).map((c) => (
                    <SelectItem key={c} value={c}>{CATEGORY_LABELS[c]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ea-position">Current position / designation</Label>
            <Input
              id="ea-position"
              placeholder="Director, Product Management, Mastercard"
              value={form.position}
              onChange={(e) => setForm({ ...form, position: e.target.value })}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={!valid || save.isPending || uploading}>
            {save.isPending && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}
            {alumnus ? "Save changes" : "Add alumnus"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/* ----------------------------- Alumnus card ----------------------------- */

const AlumnusCard = ({
  alumnus,
  index,
  onEdit,
  onDelete,
  onMoveUp,
  onMoveDown,
  isFirst,
  isLast,
}: {
  alumnus: EsteemedAlumnus;
  index: number;
  onEdit: () => void;
  onDelete: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  isFirst: boolean;
  isLast: boolean;
}) => (
  <div className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 hover:bg-muted/30 transition-colors">
    <div className="flex flex-col gap-0.5 shrink-0">
      <button type="button" onClick={onMoveUp} disabled={isFirst} className="h-5 w-5 rounded text-muted-foreground hover:text-foreground disabled:opacity-20 disabled:cursor-not-allowed flex items-center justify-center" aria-label="Move up">▲</button>
      <button type="button" onClick={onMoveDown} disabled={isLast} className="h-5 w-5 rounded text-muted-foreground hover:text-foreground disabled:opacity-20 disabled:cursor-not-allowed flex items-center justify-center" aria-label="Move down">▼</button>
    </div>

    <span className="w-7 text-sm text-muted-foreground tabular-nums text-center shrink-0">{index + 1}</span>

    <div className="h-14 w-10 rounded-md overflow-hidden border border-border bg-muted shrink-0">
      <img src={esteemedAlumnusPhotoUrl(alumnus)} alt={alumnus.name} loading="lazy" className="h-full w-full object-cover object-top" />
    </div>

    <div className="flex-1 min-w-0">
      <p className="font-medium text-sm text-foreground truncate">{alumnus.name}</p>
      <p className="text-xs text-muted-foreground truncate">{alumnus.position}</p>
      <p className="text-xs text-primary font-medium mt-0.5">Batch of {alumnus.batch}</p>
    </div>

    <Badge variant="secondary" className="shrink-0 text-xs">
      {CATEGORY_LABELS[alumnus.category]}
    </Badge>

    <div className="flex gap-1 shrink-0">
      <Button size="sm" variant="ghost" onClick={onEdit} aria-label="Edit"><Pencil className="h-3.5 w-3.5" /></Button>
      <Button size="sm" variant="ghost" onClick={onDelete} className="text-destructive hover:text-destructive" aria-label="Delete"><Trash2 className="h-3.5 w-3.5" /></Button>
    </div>
  </div>
);

/* ----------------------------- Main page ----------------------------- */

const EsteemedAdminPage = () => {
  const qc = useQueryClient();
  const { data: alumni = [], isLoading } = useQuery(esteemedAlumniQuery());
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<EsteemedAlumnus | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState<EsteemedCategoryDb | "all">("all");

  const invalidate = () => qc.invalidateQueries({ queryKey: ["esteemed"] });

  const openNew = () => { setEditing(null); setDialogOpen(true); };
  const openEdit = (a: EsteemedAlumnus) => { setEditing(a); setDialogOpen(true); };

  const doDelete = useMutation({
    mutationFn: () => deleteEsteemedAlumnus(deletingId!),
    onSuccess: () => { toast({ title: "Alumnus removed" }); setDeletingId(null); invalidate(); },
    onError: failed,
  });

  const doReorder = useMutation({
    mutationFn: (items: { id: string; sortOrder: number }[]) => reorderEsteemedAlumni(items),
    onSuccess: () => invalidate(),
    onError: failed,
  });

  const displayed = activeCategory === "all" ? alumni : alumni.filter((a) => a.category === activeCategory);

  const move = (fromIndex: number, toIndex: number) => {
    if (toIndex < 0 || toIndex >= displayed.length) return;
    const reordered = [...displayed];
    const [moved] = reordered.splice(fromIndex, 1);
    reordered.splice(toIndex, 0, moved);
    // Re-assign sortOrder across the whole displayed set so positions make sense
    const allReordered = alumni.filter((a) => !displayed.find((d) => d.id === a.id));
    const combined = [...reordered, ...allReordered].map((a, i) => ({ id: a.id, sortOrder: i }));
    doReorder.mutate(combined);
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <Star className="h-5 w-5" /> Esteemed Alumni
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Manage the esteemed alumni roster and their display order per category. Photos are stored in S3.
          </p>
        </div>
        <Button onClick={openNew} className="gap-1.5">
          <Plus className="h-4 w-4" /> Add alumnus
        </Button>
      </div>

      {/* Category filter tabs */}
      <div className="flex flex-wrap gap-2">
        {([{ id: "all" as const, label: `All (${alumni.length})` }, ...ESTEEMED_CATEGORIES.map((c) => ({ id: c.dbValue, label: `${c.title} (${alumni.filter((a) => a.category === c.dbValue).length})` }))] as { id: EsteemedCategoryDb | "all"; label: string }[]).map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveCategory(tab.id)}
            className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${activeCategory === tab.id ? "bg-primary text-primary-foreground border-primary" : "border-border text-muted-foreground hover:border-primary/50 hover:text-foreground"}`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {isLoading && (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      )}

      {!isLoading && alumni.length === 0 && (
        <EmptyState
          icon={Star}
          title="No esteemed alumni yet"
          description="Add the first alumnus to get started."
        />
      )}

      {!isLoading && alumni.length > 0 && displayed.length === 0 && (
        <EmptyState
          icon={Star}
          title="No alumni in this category"
          description="Switch category or add a new alumnus."
        />
      )}

      <div className="space-y-2">
        {displayed.map((a, i) => (
          <AlumnusCard
            key={a.id}
            alumnus={a}
            index={i}
            isFirst={i === 0}
            isLast={i === displayed.length - 1}
            onEdit={() => openEdit(a)}
            onDelete={() => setDeletingId(a.id)}
            onMoveUp={() => move(i, i - 1)}
            onMoveDown={() => move(i, i + 1)}
          />
        ))}
      </div>

      <AlumnusFormDialog
        alumnus={editing}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSaved={invalidate}
      />

      <AlertDialog open={!!deletingId} onOpenChange={(o) => !o && setDeletingId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this alumnus?</AlertDialogTitle>
            <AlertDialogDescription>
              This will delete the record and remove their portrait from storage. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => doDelete.mutate()}
            >
              {doDelete.isPending && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}
              Remove alumnus
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </motion.div>
  );
};

export default EsteemedAdminPage;
