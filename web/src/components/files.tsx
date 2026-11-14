"use client";

// file_viewer_screen.dart + the avatar widget. Files are fetched through the
// audited API into memory and shown from an object URL that is revoked when
// the viewer closes. Nothing is written to the browser cache.

import { useEffect, useId, useRef, useState } from "react";
import { type FileClass, type OpenedFile, acceptAttr, fetchFile, fileError, saveBlob, sizeLabel } from "@/lib/files";
import { initials } from "@/lib/people";
import { Banner, Button, Sheet, Spinner, cx } from "./ui";

const msg = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

/** A labelled file input with client-side checks. */
export function FilePicker({
  label,
  cls,
  file,
  onChange,
  error,
  hint,
}: {
  label: string;
  cls: FileClass;
  file: File | null;
  onChange: (f: File | null, problem: string | null) => void;
  error?: string | null;
  hint?: string;
}) {
  const id = useId();
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div>
      <span className="mb-1.5 block text-body-md font-medium text-text-secondary">{label}</span>
      <div className={cx("flex items-center gap-3 rounded-input border bg-surface px-4 py-3", error ? "border-error" : "border-border")}>
        <span className="min-w-0 flex-1 truncate text-body-md">{file ? `${file.name} · ${sizeLabel(file.size)}` : "No file chosen"}</span>
        <label htmlFor={id} className="inline-flex min-h-10 cursor-pointer items-center rounded-button border border-border px-3 font-semibold text-primary">
          {file ? "Change" : "Choose file"}
        </label>
        {file && (
          <Button
            variant="text"
            type="button"
            onClick={() => {
              if (ref.current) ref.current.value = "";
              onChange(null, null);
            }}
          >
            Remove
          </Button>
        )}
        <input
          ref={ref}
          id={id}
          type="file"
          aria-label={label}
          accept={acceptAttr(cls)}
          className="sr-only"
          onChange={(e) => {
            const f = e.target.files?.[0] ?? null;
            onChange(f, f ? fileError(f, cls) : null);
          }}
        />
      </div>
      {error ? <p className="mt-1 text-body-sm text-error">{error}</p> : hint ? <p className="mt-1 text-body-sm text-text-secondary">{hint}</p> : null}
    </div>
  );
}

/** Opens a stored file in a sheet (PDF in a sandboxed frame, images inline). */
export function FileViewer({ versionId, title, path, onClose }: { versionId: string; title: string; path?: string; onClose: () => void }) {
  const [file, setFile] = useState<OpenedFile | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    let made: string | null = null;
    fetchFile(versionId, "view", path)
      .then((f) => {
        if (!live) return;
        made = URL.createObjectURL(f.blob);
        setFile(f);
        setUrl(made);
      })
      .catch((e) => live && setError(msg(e, "Could not open the file.")));
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [versionId, path]);
  return (
    <Sheet title={title} onClose={onClose}>
      {error ? (
        <Banner>{error}</Banner>
      ) : !file || !url ? (
        <div role="status" className="grid place-items-center py-16 text-primary">
          <Spinner size={32} />
          <span className="sr-only">Opening</span>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {file.mime.startsWith("image/") ? (
            // eslint-disable-next-line @next/next/no-img-element -- blob URL from memory
            <img src={url} alt={title} className="max-h-[60dvh] w-full rounded-input object-contain" />
          ) : (
            <iframe title={title} src={url} sandbox="" className="h-[60dvh] w-full rounded-input border border-border" />
          )}
          <Button variant="outlined" onClick={() => saveBlob(file)}>
            Download
          </Button>
        </div>
      )}
    </Sheet>
  );
}

const avatarCache = new Map<string, string>();

/** Round avatar: initials until the photo (if any) has loaded. */
export function Avatar({ name, versionId, size = 48 }: { name: string; versionId?: string | null; size?: number }) {
  const [url, setUrl] = useState<string | null>(versionId ? (avatarCache.get(versionId) ?? null) : null);
  useEffect(() => {
    if (!versionId || avatarCache.has(versionId)) return;
    let live = true;
    fetchFile(versionId, "view")
      .then((f) => {
        const u = URL.createObjectURL(f.blob);
        avatarCache.set(versionId, u);
        if (live) setUrl(u);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [versionId]);
  const shown = versionId ? (url ?? avatarCache.get(versionId) ?? null) : null;
  return (
    <span
      className="inline-grid shrink-0 place-items-center overflow-hidden rounded-full bg-people-card font-semibold text-primary"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.36) }}
      aria-hidden={shown ? undefined : true}
    >
      {shown ? (
        // eslint-disable-next-line @next/next/no-img-element -- blob URL from memory
        <img src={shown} alt={`${name}'s photo`} className="size-full object-cover" />
      ) : (
        initials(name)
      )}
    </span>
  );
}
