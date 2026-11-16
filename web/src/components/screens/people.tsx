"use client";

// profile_screen.dart (work details, private details change request, photo)
// and people_screen.dart (directory).

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ApiError, newOperationId, rpc } from "@/lib/api";
import { dayLabel, todayIn } from "@/lib/attendance";
import { uploadFile } from "@/lib/files";
import { type DirectoryRow, type Paged, type PrivateKey, type Profile, type OrgStructure, PRIVATE_FIELDS, privateErrors, privatePatch } from "@/lib/people";
import { roleLabel } from "@/lib/roles";
import { stateOf } from "@/lib/requests";
import { useSession } from "@/lib/session";
import { useRpc } from "@/lib/use-rpc";
import { Avatar, FilePicker } from "../files";
import { Banner, Button, EmptyState, ErrorState, KeyValue, LoadingState, PageTitle, SectionCard, Sheet, StatusChip, TextField, cx } from "../ui";

const msg = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

function weekdays(mask: number): string {
  const names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const on = names.filter((_, i) => mask & (1 << i));
  return on.length === 7 ? "Every day" : on.join(", ") || "—";
}
const hhmm = (t: string | null | undefined) => (t ? t.slice(0, 5) : "—");

/* ───────────────────────── Profile ───────────────────────── */

export function ProfileScreen({ now = new Date() }: { now?: Date }) {
  const { context } = useSession();
  const today = todayIn(context?.org.timezone ?? "Asia/Kolkata", now);
  const q = useRpc<Profile>("get_my_profile", {});
  const [editing, setEditing] = useState(false);
  const [photo, setPhoto] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  if (q.error) return <><PageTitle title="My profile" back="/explore" /><ErrorState message={msg(q.error, "Could not load your profile.")} onRetry={() => q.mutate()} /></>;
  if (!q.data) return <><PageTitle title="My profile" back="/explore" /><LoadingState /></>;
  const p = q.data;
  const pending = p.profile_request && ["submitted", "under_review", "returned", "draft"].includes(p.profile_request.state) ? p.profile_request : null;

  return (
    <>
      <PageTitle title="My profile" back="/explore" />
      <div className="mx-auto flex max-w-xl md:max-w-3xl lg:max-w-5xl flex-col gap-4 p-page">
        {notice && <Banner tone="success">{notice}</Banner>}
        <SectionCard>
          <div className="flex items-center gap-4">
            <Avatar name={p.name} versionId={p.avatar_file_version_id} size={72} />
            <div className="min-w-0 flex-1">
              <p className="text-title-lg font-semibold">{p.name}</p>
              <p className="text-body-md text-text-secondary">
                {p.code} · {p.designation ?? roleLabel(p.role)}
              </p>
              <div className="mt-1 flex flex-wrap gap-1.5">
                <StatusChip label={roleLabel(p.role)} tone="info" />
                {p.position_label === "manager" && <StatusChip label="Manager" tone="neutral" />}
              </div>
            </div>
          </div>
          <Button variant="text" className="mt-2" onClick={() => setPhoto(true)}>
            {p.avatar_file_version_id ? "Change photo" : "Add photo"}
          </Button>
        </SectionCard>

        <SectionCard>
          <h2 className="mb-2 text-title-sm font-semibold">Work</h2>
          <KeyValue k="Team" v={p.team?.name ?? "—"} />
          <KeyValue k="Department" v={p.department?.name ?? "—"} />
          <KeyValue k="Office" v={p.office?.name ?? "—"} />
          <KeyValue k="Manager" v={p.manager?.name ?? "—"} />
          <KeyValue k="Joined" v={p.join_date ? dayLabel(p.join_date) : "—"} />
          <KeyValue k="Work email" v={p.business_email ?? "—"} />
          <KeyValue k="Work phone" v={p.business_phone ?? "—"} />
          {p.shift && (
            <>
              <KeyValue k="Shift" v={`${p.shift.name} · ${hhmm(p.shift.start_local)}–${hhmm(p.shift.end_local)}`} />
              <KeyValue k="Working days" v={weekdays(p.shift.weekly_mask)} />
            </>
          )}
          <p className="mt-2 text-body-sm text-text-secondary">HR keeps these up to date. Ask HR if something is wrong.</p>
        </SectionCard>

        <SectionCard>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-title-sm font-semibold">Personal</h2>
            {!editing && (
              <Button variant="text" onClick={() => setEditing(true)}>
                {pending ? "Edit request" : "Request a change"}
              </Button>
            )}
          </div>
          {pending && (
            <div className="mb-3">
              <Banner tone="info">
                Change request: {stateOf(pending.state).label.toLowerCase()}.{" "}
                <Link href={`/requests/${pending.id}`} className="font-semibold underline">
                  View
                </Link>
              </Banner>
            </div>
          )}
          {editing ? (
            <PrivateForm
              profile={p}
              today={today}
              onCancel={() => setEditing(false)}
              onSaved={async () => {
                setEditing(false);
                setNotice("Change request sent to HR.");
                await q.mutate();
              }}
            />
          ) : (
            PRIVATE_FIELDS.map((f) => {
              const v = p.private?.[f.key];
              return <KeyValue key={f.key} k={f.label} v={v ? (f.key === "date_of_birth" ? dayLabel(String(v)) : String(v)) : "—"} />;
            })
          )}
        </SectionCard>
      </div>
      {photo && (
        <PhotoSheet
          employeeId={p.id}
          onClose={() => setPhoto(false)}
          onSaved={async () => {
            setPhoto(false);
            setNotice("Photo updated.");
            await q.mutate();
          }}
        />
      )}
    </>
  );
}

function PrivateForm({ profile, today, onCancel, onSaved }: { profile: Profile; today: string; onCancel: () => void; onSaved: () => Promise<void> }) {
  const init = Object.fromEntries(PRIVATE_FIELDS.map((f) => [f.key, String(profile.private?.[f.key] ?? "")])) as Record<PrivateKey, string>;
  const [v, setV] = useState(init);
  const [errors, setErrors] = useState<Partial<Record<PrivateKey, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const op = useRef<string | null>(null);
  const pending = profile.profile_request;
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const errs = privateErrors(v, today);
    setErrors(errs);
    setError(null);
    if (Object.keys(errs).length) return;
    const patch = privatePatch(profile.private, v);
    if (!Object.keys(patch).length) {
      setError("Nothing changed.");
      return;
    }
    setBusy(true);
    op.current ??= newOperationId();
    try {
      await rpc("save_profile_details_request", {
        p_request_id: pending?.id ?? null,
        p_patch: patch,
        p_expected_private_version: profile.private?.version ?? null,
        p_expected_request_version: pending?.version ?? null,
        p_operation_key: op.current,
      });
      op.current = null;
      await onSaved();
    } catch (x) {
      if (!(x instanceof ApiError && x.isNetwork)) op.current = null;
      if (x instanceof ApiError) setErrors(x.fieldErrors as Partial<Record<PrivateKey, string>>);
      setError(x instanceof ApiError && x.code === "STALE_VERSION" ? "Your details changed since you opened this. Reload and try again." : msg(x, "Could not send the request."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form noValidate onSubmit={save} className="flex flex-col gap-3">
      {error && <Banner>{error}</Banner>}
      {PRIVATE_FIELDS.map((f) => (
        <TextField
          key={f.key}
          label={f.label}
          type={f.type}
          value={v[f.key]}
          max={f.key === "date_of_birth" ? today : undefined}
          onChange={(e) => setV({ ...v, [f.key]: e.target.value })}
          error={errors[f.key]}
        />
      ))}
      <p className="text-body-sm text-text-secondary">HR approves changes before they show here. Leave a field empty to remove it.</p>
      <div className="flex gap-2">
        <Button type="submit" busy={busy} className="flex-1">
          Send to HR
        </Button>
        <Button type="button" variant="outlined" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function PhotoSheet({ employeeId, onClose, onSaved }: { employeeId: string; onClose: () => void; onSaved: () => Promise<void> }) {
  const [file, setFile] = useState<File | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const last = useRef<string | null>(null);
  useEffect(() => () => {
    if (last.current) URL.revokeObjectURL(last.current);
  }, []);
  const save = async () => {
    if (!file) return setProblem("Choose a photo.");
    if (problem) return;
    setBusy(true);
    setError(null);
    try {
      const id = await uploadFile(file, { cls: "avatar", ownerEmployeeId: employeeId });
      await rpc("publish_document", { p_file_version_id: id });
      await onSaved();
    } catch (x) {
      setError(msg(x, "Could not save the photo."));
      setBusy(false);
    }
  };
  return (
    <Sheet title="Profile photo" onClose={onClose}>
      <div className="flex flex-col gap-4">
        {error && <Banner>{error}</Banner>}
        {preview && file && !problem && (
          // eslint-disable-next-line @next/next/no-img-element -- local preview
          <img src={preview} alt="New photo preview" className="mx-auto size-40 rounded-full object-cover" />
        )}
        <FilePicker
          label="Photo"
          cls="avatar"
          file={file}
          error={problem}
          hint="JPG, PNG or WebP, up to 5 MB. A square photo looks best."
          onChange={(f, p) => {
            setFile(f);
            setProblem(p);
            if (last.current) URL.revokeObjectURL(last.current);
            last.current = f && !p ? URL.createObjectURL(f) : null;
            setPreview(last.current);
          }}
        />
        <Button busy={busy} disabled={!file || !!problem} onClick={save}>
          Save photo
        </Button>
      </div>
    </Sheet>
  );
}

/* ───────────────────────── Directory ───────────────────────── */

const PAGE = 25;

export function Directory() {
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [team, setTeam] = useState("");
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => {
      setQ(search.trim());
      setOffset(0);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);
  const structure = useRpc<OrgStructure>("list_org_structure", {});
  const list = useRpc<Paged<DirectoryRow>>("list_directory", { p_search: q || null, p_team_id: team || null, p_limit: PAGE, p_offset: offset });
  const total = list.data?.total ?? 0;
  return (
    <>
      <PageTitle title="People" back="/explore" />
      <div className="mx-auto flex max-w-xl md:max-w-3xl lg:max-w-5xl flex-col gap-3 p-page">
        <TextField label="Search" type="search" placeholder="Name, ID or designation" value={search} onChange={(e) => setSearch(e.target.value)} />
        <div>
          <label htmlFor="team-filter" className="mb-1.5 block text-body-md font-medium text-text-secondary">
            Team
          </label>
          <select
            id="team-filter"
            value={team}
            onChange={(e) => {
              setTeam(e.target.value);
              setOffset(0);
            }}
            className="min-h-12 w-full rounded-input border border-border bg-surface px-4"
          >
            <option value="">All teams</option>
            {(structure.data?.teams ?? []).filter((t) => t.active).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
        {list.error ? (
          <ErrorState message={msg(list.error, "Could not load people.")} onRetry={() => list.mutate()} />
        ) : !list.data ? (
          <LoadingState />
        ) : list.data.rows.length === 0 ? (
          <EmptyState art="groups" title={q ? `Nobody matches “${q}”` : "Nobody here yet"} />
        ) : (
          <>
            <p className="text-body-sm text-text-secondary" aria-live="polite">
              {total} {total === 1 ? "person" : "people"}
            </p>
            <ul className="flex flex-col gap-2">
              {list.data.rows.map((r) => (
                <li key={r.id} className="flex items-center gap-3 rounded-card border border-border bg-surface p-card">
                  <Avatar name={r.name} versionId={r.avatar_file_version_id} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold">{r.name}</p>
                    <p className="truncate text-body-md text-text-secondary">
                      {[r.designation, r.team?.name].filter(Boolean).join(" · ") || r.code}
                    </p>
                    <div className="mt-1 flex flex-wrap gap-x-4 text-body-md">
                      {r.business_email && (
                        <a href={`mailto:${r.business_email}`} className="font-semibold text-primary">
                          Email
                        </a>
                      )}
                      {r.business_phone && (
                        <a href={`tel:${r.business_phone.replace(/\s/g, "")}`} className="font-semibold text-primary">
                          Call
                        </a>
                      )}
                    </div>
                  </div>
                  {r.role !== "employee" && <StatusChip label={roleLabel(r.role)} tone="info" />}
                </li>
              ))}
            </ul>
            <div className={cx("flex items-center justify-between", total <= PAGE && "hidden")}>
              <Button variant="outlined" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
                Previous
              </Button>
              <span className="text-body-sm text-text-secondary">
                {offset + 1}–{Math.min(offset + PAGE, total)} of {total}
              </span>
              <Button variant="outlined" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>
                Next
              </Button>
            </div>
          </>
        )}
      </div>
    </>
  );
}
