import { useRef, useState } from "react";
import { motion } from "framer-motion";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  GripVertical,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  Upload,
  Users,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { toast } from "@/hooks/use-toast";
import { EmptyState } from "@/components/EmptyState";
import { uploadFile } from "@/lib/upload";
import {
  boardMembersQuery,
  boardMemberPhotoUrl,
  createBoardMember,
  updateBoardMember,
  deleteBoardMember,
  reorderBoardMembers,
  initialsOf,
  type BoardMember,
} from "@/lib/board";

const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

const failed = (e: unknown) =>
  toast({
    title: "Something went wrong",
    description: e instanceof Error ? e.message : undefined,
    variant: "destructive",
  });

const emptyForm = () => ({ name: "", authority: "", designation: "" });

/* ----------------------------- Form dialog ----------------------------- */

const MemberFormDialog = ({
  member,
  open,
  onOpenChange,
  onSaved,
}: {
  member: BoardMember | null;
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

  const key = member?.id ?? "new";
  if (open && initialisedFor !== key) {
    setInitialisedFor(key);
    setForm(
      member
        ? { name: member.name, authority: member.authority, designation: member.designation }
        : emptyForm(),
    );
    setPendingPhotoKey(null);
    setPreviewUrl(member ? (boardMemberPhotoUrl(member) ?? null) : null);
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
      const key = await uploadFile(file, "board-member");
      setPendingPhotoKey(key);
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
      const payload = {
        name: form.name.trim(),
        authority: form.authority.trim(),
        designation: form.designation.trim(),
        ...(pendingPhotoKey ? { photoKey: pendingPhotoKey } : {}),
      };
      return member ? updateBoardMember(member.id, payload) : createBoardMember(payload);
    },
    onSuccess: () => {
      toast({ title: member ? "Member updated" : "Member added" });
      onOpenChange(false);
      onSaved();
    },
    onError: failed,
  });

  const valid = form.name.trim().length > 0 && form.authority.trim().length > 0 && form.designation.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{member ? "Edit board member" : "Add board member"}</DialogTitle>
          <DialogDescription>
            Fill in the member's details. Upload a portrait photo via the button below.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Photo preview */}
          <div className="flex items-center gap-4">
            <div className="h-20 w-16 rounded-lg overflow-hidden border border-border bg-muted flex items-center justify-center shrink-0">
              {previewUrl ? (
                <img src={previewUrl} alt="Preview" className="h-full w-full object-cover object-top" />
              ) : (
                <span className="text-xl font-semibold text-muted-foreground">
                  {form.name ? initialsOf(form.name) : "?"}
                </span>
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
                  <X className="h-3.5 w-3.5" /> Remove photo
                </Button>
              )}
              <p className="text-[11px] text-muted-foreground">JPG / PNG · max 10 MB</p>
            </div>
            <input ref={fileInput} type="file" accept="image/*" className="hidden" onChange={(e) => onPickPhoto(e.target.files)} />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="bm-name">Full name</Label>
            <Input id="bm-name" placeholder="Dr. A. B. Patil" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bm-authority">Authority / Role</Label>
            <Input id="bm-authority" placeholder="Secretary" value={form.authority} onChange={(e) => setForm({ ...form, authority: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bm-designation">Designation</Label>
            <Input id="bm-designation" placeholder="Dean, Alumni Relations" value={form.designation} onChange={(e) => setForm({ ...form, designation: e.target.value })} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={!valid || save.isPending || uploading}>
            {save.isPending && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}
            {member ? "Save changes" : "Add member"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/* ----------------------------- Member row ----------------------------- */

const MemberRow = ({
  member,
  index,
  onEdit,
  onDelete,
  onMoveUp,
  onMoveDown,
  isFirst,
  isLast,
}: {
  member: BoardMember;
  index: number;
  onEdit: () => void;
  onDelete: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  isFirst: boolean;
  isLast: boolean;
}) => {
  const photoUrl = boardMemberPhotoUrl(member);
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 hover:bg-muted/30 transition-colors">
      {/* Drag handle / position arrows */}
      <div className="flex flex-col gap-0.5 shrink-0">
        <button
          type="button"
          onClick={onMoveUp}
          disabled={isFirst}
          className="h-5 w-5 rounded text-muted-foreground hover:text-foreground disabled:opacity-20 disabled:cursor-not-allowed flex items-center justify-center"
          aria-label="Move up"
        >
          ▲
        </button>
        <button
          type="button"
          onClick={onMoveDown}
          disabled={isLast}
          className="h-5 w-5 rounded text-muted-foreground hover:text-foreground disabled:opacity-20 disabled:cursor-not-allowed flex items-center justify-center"
          aria-label="Move down"
        >
          ▼
        </button>
      </div>

      <span className="w-7 text-sm text-muted-foreground tabular-nums text-center shrink-0">{index + 1}</span>

      <div className="h-12 w-10 rounded-md overflow-hidden border border-border bg-muted shrink-0">
        {photoUrl ? (
          <img src={photoUrl} alt={member.name} loading="lazy" className="h-full w-full object-cover object-top" />
        ) : (
          <div className="h-full w-full flex items-center justify-center text-xs font-semibold text-primary bg-primary/10">
            {initialsOf(member.name)}
          </div>
        )}
      </div>

      <div className="flex-1 min-w-0">
        <p className="font-medium text-sm text-foreground truncate">{member.name}</p>
        <p className="text-xs text-muted-foreground truncate">{member.designation}</p>
      </div>

      <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-primary/10 text-primary whitespace-nowrap shrink-0">
        {member.authority}
      </span>

      <div className="flex gap-1 shrink-0">
        <Button size="sm" variant="ghost" onClick={onEdit} aria-label="Edit">
          <Pencil className="h-3.5 w-3.5" />
        </Button>
        <Button size="sm" variant="ghost" onClick={onDelete} className="text-destructive hover:text-destructive" aria-label="Delete">
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
};

/* ----------------------------- Main page ----------------------------- */

const BoardAdminPage = () => {
  const qc = useQueryClient();
  const { data: members = [], isLoading } = useQuery(boardMembersQuery());
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<BoardMember | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["board", "members"] });

  const openNew = () => { setEditing(null); setDialogOpen(true); };
  const openEdit = (m: BoardMember) => { setEditing(m); setDialogOpen(true); };

  const doDelete = useMutation({
    mutationFn: () => deleteBoardMember(deletingId!),
    onSuccess: () => { toast({ title: "Member removed" }); setDeletingId(null); invalidate(); },
    onError: failed,
  });

  const doReorder = useMutation({
    mutationFn: (items: { id: string; sortOrder: number }[]) => reorderBoardMembers(items),
    onSuccess: () => invalidate(),
    onError: failed,
  });

  const move = (fromIndex: number, toIndex: number) => {
    if (toIndex < 0 || toIndex >= members.length) return;
    const reordered = [...members];
    const [moved] = reordered.splice(fromIndex, 1);
    reordered.splice(toIndex, 0, moved);
    doReorder.mutate(reordered.map((m, i) => ({ id: m.id, sortOrder: i })));
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <Users className="h-5 w-5" /> Alumni Association Board
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Manage board members and their display order. Photos are stored in S3.
          </p>
        </div>
        <Button onClick={openNew} className="gap-1.5">
          <Plus className="h-4 w-4" /> Add member
        </Button>
      </div>

      {isLoading && (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      )}

      {!isLoading && members.length === 0 && (
        <EmptyState
          icon={Users}
          title="No board members yet"
          description="Add the first member to get started."
        />
      )}

      <div className="space-y-2">
        {members.map((m, i) => (
          <MemberRow
            key={m.id}
            member={m}
            index={i}
            isFirst={i === 0}
            isLast={i === members.length - 1}
            onEdit={() => openEdit(m)}
            onDelete={() => setDeletingId(m.id)}
            onMoveUp={() => move(i, i - 1)}
            onMoveDown={() => move(i, i + 1)}
          />
        ))}
      </div>

      <MemberFormDialog
        member={editing}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSaved={invalidate}
      />

      <AlertDialog open={!!deletingId} onOpenChange={(o) => !o && setDeletingId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this board member?</AlertDialogTitle>
            <AlertDialogDescription>
              This will delete the member record and remove their portrait from storage. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => doDelete.mutate()}
            >
              {doDelete.isPending && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}
              Remove member
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </motion.div>
  );
};

export default BoardAdminPage;
