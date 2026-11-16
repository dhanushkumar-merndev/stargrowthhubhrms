"use client";

// Tasks (given by HR, Admins and team leaders) and daily work reports.
// Visibility and permissions are enforced by the database; the screens only
// hide what the caller cannot use.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { rpc } from "@/lib/api";
import { todayIn } from "@/lib/attendance";
import { useSession } from "@/lib/session";
import {
  PRIORITY,
  STATUS,
  TIER_LABEL,
  type Priority,
  type Task,
  type TaskForm,
  type TeamWorkRow,
  type WorkAccess,
  type WorkForm,
  type WorkLog,
  addDays,
  dueLabel,
  minutesLabel,
  nextStatuses,
  parseDuration,
  taskErrors,
  workErrors,
} from "@/lib/tasks";
import { useRpc } from "@/lib/use-rpc";
import { Select, useAction } from "../forms";
import { Banner, Button, EmptyState, ErrorState, LoadingState, PageTitle, PillTabs, SectionCard, Sheet, StatusChip, TextArea, TextField, cx } from "../ui";

const msg = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

function useToday(now?: Date) {
  const { context } = useSession();
  return todayIn(context?.org.timezone ?? "Asia/Kolkata", now ?? new Date());
}

const dayNice = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

/* ───────────────────────────── Task list ───────────────────────────── */

type TaskScope = "mine" | "given" | "team";
type TaskFilter = "open" | "done" | "all";

export function TasksHome({ initialScope = "mine", now }: { initialScope?: TaskScope; now?: Date }) {
  const today = useToday(now);
  const access = useRpc<WorkAccess>("get_work_access");
  const [scope, setScope] = useState<TaskScope>(initialScope);
  const [filter, setFilter] = useState<TaskFilter>("open");
  const tasks = useRpc<Task[]>("list_tasks", { p_scope: scope, p_status: filter });
  const a = access.data;
  const tabs = [
    { id: "mine" as const, label: "My tasks" },
    ...(a?.can_assign_others ? [{ id: "given" as const, label: "Given by me" }] : []),
    ...(a?.can_view_team ? [{ id: "team" as const, label: "Team" }] : []),
  ];
  return (
    <>
      <PageTitle
        title="Tasks"
        back="/action"
        action={
          <Link href="/tasks/new" className="inline-flex min-h-10 items-center rounded-button bg-primary px-4 font-semibold text-white">
            New task
          </Link>
        }
      />
      <div className="mx-auto flex max-w-5xl flex-col gap-3 p-page">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <PillTabs label="Whose tasks" tabs={tabs} value={scope} onChange={setScope} />
          <PillTabs
            label="Status"
            tabs={[
              { id: "open", label: "Open" },
              { id: "done", label: "Done" },
              { id: "all", label: "All" },
            ]}
            value={filter}
            onChange={setFilter}
          />
        </div>
        {tasks.error ? (
          <ErrorState message={msg(tasks.error, "Could not load tasks.")} onRetry={() => void tasks.mutate()} />
        ) : !tasks.data ? (
          <LoadingState />
        ) : tasks.data.length === 0 ? (
          <EmptyState art="task_alt" title={filter === "open" ? "Nothing to do" : "No tasks here"} body={scope === "mine" ? "Tasks given to you appear here." : undefined} />
        ) : (
          <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" aria-label="Tasks">
            {tasks.data.map((t) => (
              <li key={t.id}>
                <TaskCard task={t} today={today} showWho={scope !== "mine"} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

function TaskCard({ task: t, today, showWho }: { task: Task; today: string; showWho: boolean }) {
  const due = dueLabel(t, today);
  return (
    <Link href={`/tasks/${t.id}`} className="block h-full rounded-card border border-border bg-surface p-4 hover:border-primary">
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 flex-1 text-title-sm font-semibold">{t.title}</p>
        <StatusChip label={STATUS[t.status].label} tone={STATUS[t.status].tone} />
      </div>
      {t.description && <p className="mt-1 line-clamp-2 text-body-md text-text-secondary">{t.description}</p>}
      <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-body-sm text-text-secondary">
        {t.priority === "high" && <span className="font-semibold text-error">High priority</span>}
        {due && <span className={cx(t.overdue && "font-semibold text-error")}>{due}</span>}
        {showWho ? <span>For {t.assigned_to.name}</span> : t.assigned_by.id !== t.assigned_to.id && <span>From {t.assigned_by.name}</span>}
        {t.logged_minutes > 0 && <span>{minutesLabel(t.logged_minutes)} logged</span>}
      </p>
    </Link>
  );
}

/* ───────────────────────────── New task ───────────────────────────── */

export function TaskNew({ now, initialAssignee = "" }: { now?: Date; initialAssignee?: string }) {
  const today = useToday(now);
  const router = useRouter();
  const people = useRpc<{ id: string; code: string; name: string; is_me: boolean }[]>("list_task_assignees");
  const [f, setF] = useState<TaskForm>({ assigned_to: initialAssignee, title: "", description: "", due_date: "", priority: "normal" });
  const [errors, setErrors] = useState<Partial<Record<keyof TaskForm, string>>>({});
  const a = useAction();
  if (people.error) return <><PageTitle title="New task" back="/tasks" /><ErrorState message={msg(people.error, "Could not load people.")} onRetry={() => void people.mutate()} /></>;
  if (!people.data) return <><PageTitle title="New task" back="/tasks" /><LoadingState /></>;
  const assignee = f.assigned_to || (people.data.length === 1 ? people.data[0].id : "");
  const form = { ...f, assigned_to: assignee };
  const set = <K extends keyof TaskForm>(k: K, v: TaskForm[K]) => setF({ ...form, [k]: v });
  const fieldErr = (k: keyof TaskForm) => errors[k] ?? a.fields[k];
  return (
    <>
      <PageTitle title="New task" back="/tasks" />
      <form
        noValidate
        className="mx-auto flex max-w-2xl flex-col gap-3 p-page"
        onSubmit={(e) => {
          e.preventDefault();
          const errs = taskErrors(form, today);
          setErrors(errs);
          if (Object.keys(errs).length) return;
          void a.run(async () => {
            const t = await rpc<Task>("create_task", {
              p_assigned_to: form.assigned_to,
              p_title: form.title.trim(),
              p_description: form.description.trim() || null,
              p_due_date: form.due_date || null,
              p_priority: form.priority,
            });
            router.push(`/tasks/${t.id}`);
          }, "Could not create the task.");
        }}
      >
        {a.error && <Banner>{a.error}</Banner>}
        <Select
          label="Who does it"
          value={form.assigned_to}
          onChange={(v) => set("assigned_to", v)}
          options={people.data.map((p) => ({ value: p.id, label: p.is_me ? `Me (${p.name})` : `${p.name} (${p.code})` }))}
          placeholder="Choose a person"
          error={fieldErr("assigned_to")}
        />
        <TextField label="Task" value={form.title} maxLength={200} onChange={(e) => set("title", e.target.value)} error={fieldErr("title")} />
        <TextArea label="Details (optional)" value={form.description} maxLength={4000} rows={5} onChange={(v) => set("description", v)} error={fieldErr("description")} hint="What needs doing, and what “done” looks like." />
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField label="Due date (optional)" type="date" min={today} value={form.due_date} onChange={(e) => set("due_date", e.target.value)} error={fieldErr("due_date")} />
          <Select
            label="Priority"
            value={form.priority}
            onChange={(v) => set("priority", v as Priority)}
            options={[
              { value: "high", label: "High" },
              { value: "normal", label: "Normal" },
              { value: "low", label: "Low" },
            ]}
          />
        </div>
        <Button type="submit" busy={a.busy}>
          Give task
        </Button>
      </form>
    </>
  );
}

/* ───────────────────────────── Task detail ───────────────────────────── */

export function TaskDetail({ id, now }: { id: string; now?: Date }) {
  const today = useToday(now);
  const q = useRpc<Task>("get_task", { p_task_id: id });
  const a = useAction();
  const [edit, setEdit] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  if (q.error) return <><PageTitle title="Task" back="/tasks" /><ErrorState message={msg(q.error, "Could not load the task.")} onRetry={() => void q.mutate()} /></>;
  if (!q.data) return <><PageTitle title="Task" back="/tasks" /><LoadingState /></>;
  const t = q.data;
  const patch = (p: Record<string, unknown>, done: string) =>
    a.run(async () => {
      await rpc("update_task", { p_task_id: t.id, p_patch: p, p_expected_version: t.version });
      setNotice(done);
      await q.mutate();
    }, "Could not update the task.");
  const due = dueLabel(t, today);
  return (
    <>
      <PageTitle title="Task" back="/tasks" />
      <div className="mx-auto grid max-w-5xl gap-4 p-page lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex flex-col gap-3">
          {notice && <Banner tone="success">{notice}</Banner>}
          {a.error && <Banner>{a.error}</Banner>}
          <SectionCard>
            <div className="flex items-start justify-between gap-2">
              <h2 className="min-w-0 flex-1 text-title-md font-semibold">{t.title}</h2>
              <StatusChip label={STATUS[t.status].label} tone={STATUS[t.status].tone} />
            </div>
            {t.description ? <p className="mt-2 whitespace-pre-wrap text-body-md">{t.description}</p> : <p className="mt-2 text-body-md text-text-secondary">No details.</p>}
            {t.is_mine && nextStatuses(t.status).length > 0 && (
              <div className="mt-4 flex flex-wrap gap-2">
                {nextStatuses(t.status).map((s, i) => (
                  <Button key={s.to} variant={i === 0 ? "filled" : "outlined"} busy={a.busy} onClick={() => patch({ status: s.to }, `Marked as ${STATUS[s.to].label.toLowerCase()}.`)}>
                    {s.label}
                  </Button>
                ))}
                {t.status !== "done" && (
                  <Link href={`/work?task=${t.id}`} className="inline-flex min-h-12 items-center rounded-button px-4 font-semibold text-primary">
                    Log work on this
                  </Link>
                )}
              </div>
            )}
          </SectionCard>
          <SectionCard>
            <h3 className="text-title-sm font-semibold">Work logged</h3>
            {(t.logs ?? []).length === 0 ? (
              <p className="mt-1 text-body-md text-text-secondary">Nothing logged against this task yet.</p>
            ) : (
              <ul className="mt-2 divide-y divide-border">
                {(t.logs ?? []).map((w) => (
                  <li key={w.id} className="py-2">
                    <p className="font-semibold">
                      {w.title} <span className="font-normal text-text-secondary">· {dayNice(w.work_date)}{w.minutes ? ` · ${minutesLabel(w.minutes)}` : ""}</span>
                    </p>
                    <p className="whitespace-pre-wrap text-body-md text-text-secondary">{w.details}</p>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        </div>
        <aside className="flex flex-col gap-3">
          <SectionCard>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-body-md">
              <dt className="text-text-secondary">For</dt>
              <dd>{t.assigned_to.name}</dd>
              <dt className="text-text-secondary">From</dt>
              <dd>{t.assigned_by.name}</dd>
              <dt className="text-text-secondary">Priority</dt>
              <dd>{PRIORITY[t.priority].label}</dd>
              <dt className="text-text-secondary">Due</dt>
              <dd className={cx(t.overdue && "font-semibold text-error")}>{due || "No date"}</dd>
              <dt className="text-text-secondary">Logged</dt>
              <dd>{minutesLabel(t.logged_minutes) || "—"}</dd>
            </dl>
          </SectionCard>
          {t.can_manage && t.status !== "cancelled" && (
            <div className="flex flex-col gap-2">
              <Button variant="outlined" onClick={() => setEdit(true)}>
                Edit task
              </Button>
              <Button variant="text" onClick={() => setConfirmCancel(true)}>
                Cancel task
              </Button>
            </div>
          )}
        </aside>
      </div>
      {edit && <TaskEdit task={t} today={today} onClose={() => setEdit(false)} onSaved={async () => { setEdit(false); setNotice("Task updated."); await q.mutate(); }} />}
      {confirmCancel && (
        <Sheet title="Cancel this task?" onClose={() => setConfirmCancel(false)}>
          <p className="text-body-md">{t.assigned_to.name} will be told they no longer need to do it.</p>
          <div className="mt-4 flex flex-col gap-2">
            <Button variant="danger" busy={a.busy} onClick={async () => { setConfirmCancel(false); await patch({ status: "cancelled" }, "Task cancelled."); }}>
              Cancel task
            </Button>
            <Button variant="outlined" onClick={() => setConfirmCancel(false)}>
              Keep it
            </Button>
          </div>
        </Sheet>
      )}
    </>
  );
}

function TaskEdit({ task: t, today, onClose, onSaved }: { task: Task; today: string; onClose: () => void; onSaved: () => Promise<void> }) {
  const [f, setF] = useState<TaskForm>({ assigned_to: t.assigned_to.id, title: t.title, description: t.description ?? "", due_date: t.due_date ?? "", priority: t.priority });
  const [errors, setErrors] = useState<Partial<Record<keyof TaskForm, string>>>({});
  const a = useAction();
  return (
    <Sheet title="Edit task" onClose={onClose}>
      <form
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          // An unchanged past due date is allowed to stay.
          const errs = taskErrors({ ...f, due_date: f.due_date === (t.due_date ?? "") ? "" : f.due_date }, today);
          setErrors(errs);
          if (Object.keys(errs).length) return;
          void a.run(async () => {
            await rpc("update_task", {
              p_task_id: t.id,
              p_patch: { title: f.title.trim(), description: f.description.trim() || null, due_date: f.due_date || null, priority: f.priority },
              p_expected_version: t.version,
            });
            await onSaved();
          }, "Could not save.");
        }}
      >
        {a.error && <Banner>{a.error}</Banner>}
        <TextField label="Task" value={f.title} maxLength={200} onChange={(e) => setF({ ...f, title: e.target.value })} error={errors.title ?? a.fields.title} />
        <TextArea label="Details (optional)" value={f.description} maxLength={4000} rows={4} onChange={(v) => setF({ ...f, description: v })} error={errors.description ?? a.fields.description} />
        <TextField label="Due date (optional)" type="date" value={f.due_date} onChange={(e) => setF({ ...f, due_date: e.target.value })} error={errors.due_date ?? a.fields.due_date} />
        <Select
          label="Priority"
          value={f.priority}
          onChange={(v) => setF({ ...f, priority: v as Priority })}
          options={[
            { value: "high", label: "High" },
            { value: "normal", label: "Normal" },
            { value: "low", label: "Low" },
          ]}
        />
        <Button type="submit" busy={a.busy}>
          Save
        </Button>
      </form>
    </Sheet>
  );
}

/* ───────────────────────────── Daily work report ───────────────────────────── */

type WorkTab = "mine" | "team";

export function WorkHome({ now, initialTab = "mine", taskId = "" }: { now?: Date; initialTab?: WorkTab; taskId?: string }) {
  const today = useToday(now);
  const access = useRpc<WorkAccess>("get_work_access");
  const [tab, setTab] = useState<WorkTab>(initialTab);
  const showTeam = !!access.data?.can_view_team;
  return (
    <>
      <PageTitle title="Daily work report" back="/action" />
      <div className="mx-auto flex max-w-5xl flex-col gap-3 p-page">
        {showTeam && (
          <PillTabs
            label="Whose reports"
            tabs={[
              { id: "mine", label: "My report" },
              { id: "team", label: "Team reports" },
            ]}
            value={tab}
            onChange={setTab}
          />
        )}
        {tab === "team" && showTeam ? <TeamWork today={today} /> : <MyWork today={today} taskId={taskId} />}
      </div>
    </>
  );
}

function DayPicker({ day, today, onChange, past = 7 }: { day: string; today: string; onChange: (d: string) => void; past?: number }) {
  return (
    <div className="flex items-center gap-2">
      <Button variant="outlined" aria-label="Previous day" disabled={day <= addDays(today, -past)} onClick={() => onChange(addDays(day, -1))}>
        ‹
      </Button>
      <span className="min-w-36 text-center font-semibold" aria-live="polite">
        {day === today ? "Today" : dayNice(day)}
      </span>
      <Button variant="outlined" aria-label="Next day" disabled={day >= today} onClick={() => onChange(addDays(day, 1))}>
        ›
      </Button>
    </div>
  );
}

function MyWork({ today, taskId }: { today: string; taskId: string }) {
  const [day, setDay] = useState(today);
  const logs = useRpc<{ rows: WorkLog[] }>("list_work_logs", { p_from: day, p_to: day });
  const tasks = useRpc<Task[]>("list_tasks", { p_scope: "mine", p_status: "open" });
  const [editing, setEditing] = useState<WorkLog | "new" | null>(taskId ? "new" : null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<WorkLog | null>(null);
  const a = useAction();
  const rows = logs.data?.rows ?? [];
  const total = rows.reduce((s, w) => s + (w.minutes ?? 0), 0);
  const editable = day >= addDays(today, -7);
  return (
    <section aria-label="My report" className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <DayPicker day={day} today={today} onChange={setDay} />
          {total > 0 && <span className="text-body-md text-text-secondary">Total {minutesLabel(total)}</span>}
        </div>
        {notice && <Banner tone="success">{notice}</Banner>}
        {a.error && <Banner>{a.error}</Banner>}
        {logs.error ? (
          <ErrorState message={msg(logs.error, "Could not load your report.")} onRetry={() => void logs.mutate()} />
        ) : !logs.data ? (
          <LoadingState />
        ) : rows.length === 0 ? (
          <EmptyState art="edit_note" title="Nothing written for this day" body="Add what you worked on, with details, so your team leader and HR can see it." />
        ) : (
          <ul className="flex flex-col gap-2" aria-label="Entries">
            {rows.map((w) => (
              <li key={w.id}>
                <SectionCard>
                  <div className="flex items-start justify-between gap-2">
                    <p className="min-w-0 flex-1 font-semibold">{w.title}</p>
                    {w.minutes ? <span className="text-body-md text-text-secondary">{minutesLabel(w.minutes)}</span> : null}
                  </div>
                  {w.task && <p className="text-body-sm text-primary">Task: {w.task.title}</p>}
                  <p className="mt-1 whitespace-pre-wrap text-body-md text-text-secondary">{w.details}</p>
                  {w.can_edit && (
                    <div className="mt-2 flex gap-2">
                      <Button variant="text" onClick={() => setEditing(w)}>
                        Edit
                      </Button>
                      <Button variant="text" onClick={() => setConfirm(w)}>
                        Remove
                      </Button>
                    </div>
                  )}
                </SectionCard>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        {editable && editing === null && (
          <Button className="w-full" onClick={() => setEditing("new")}>
            Add entry
          </Button>
        )}
        {editing !== null && (
          <SectionCard>
            <WorkEntryForm
              key={editing === "new" ? `new-${day}` : editing.id}
              today={today}
              day={day}
              entry={editing === "new" ? null : editing}
              tasks={tasks.data ?? []}
              initialTask={editing === "new" ? taskId : ""}
              onCancel={() => setEditing(null)}
              onSaved={async (d) => {
                setEditing(null);
                setNotice("Saved.");
                if (d !== day) setDay(d);
                await logs.mutate();
              }}
            />
          </SectionCard>
        )}
      </div>
      {confirm && (
        <Sheet title="Remove this entry?" onClose={() => setConfirm(null)}>
          <p className="text-body-md">“{confirm.title}” will be removed from your report.</p>
          <div className="mt-4 flex flex-col gap-2">
            <Button
              variant="danger"
              busy={a.busy}
              onClick={() =>
                a.run(async () => {
                  const w = confirm;
                  setConfirm(null);
                  await rpc("delete_work_log", { p_id: w.id });
                  setNotice("Removed.");
                  await logs.mutate();
                }, "Could not remove.")
              }
            >
              Remove
            </Button>
            <Button variant="outlined" onClick={() => setConfirm(null)}>
              Keep
            </Button>
          </div>
        </Sheet>
      )}
    </section>
  );
}

function WorkEntryForm({
  today,
  day,
  entry,
  tasks,
  initialTask,
  onCancel,
  onSaved,
}: {
  today: string;
  day: string;
  entry: WorkLog | null;
  tasks: Task[];
  initialTask: string;
  onCancel: () => void;
  onSaved: (day: string) => Promise<void>;
}) {
  const hours = (m: number | null) => (m ? (m % 60 === 0 ? String(m / 60) : `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`) : "");
  const [f, setF] = useState<WorkForm>({
    work_date: entry?.work_date ?? day,
    title: entry?.title ?? (initialTask ? (tasks.find((t) => t.id === initialTask)?.title ?? "") : ""),
    details: entry?.details ?? "",
    duration: hours(entry?.minutes ?? null),
    task_id: entry?.task?.id ?? initialTask,
  });
  const [errors, setErrors] = useState<Partial<Record<keyof WorkForm, string>>>({});
  const a = useAction();
  const taskOpts = [...tasks.map((t) => ({ value: t.id, label: t.title })), ...(entry?.task && !tasks.some((t) => t.id === entry.task!.id) ? [{ value: entry.task.id, label: entry.task.title }] : [])];
  return (
    <form
      noValidate
      aria-label={entry ? "Edit entry" : "New entry"}
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        const errs = workErrors(f, today);
        setErrors(errs);
        if (Object.keys(errs).length) return;
        void a.run(async () => {
          await rpc("save_work_log", {
            p_id: entry?.id ?? null,
            p_work_date: f.work_date,
            p_title: f.title.trim(),
            p_details: f.details.trim(),
            p_minutes: parseDuration(f.duration),
            p_task_id: f.task_id || null,
            p_expected_version: entry?.version ?? null,
          });
          await onSaved(f.work_date);
        }, "Could not save the entry.");
      }}
    >
      <h3 className="text-title-sm font-semibold">{entry ? "Edit entry" : "New entry"}</h3>
      {a.error && <Banner>{a.error}</Banner>}
      <TextField label="Date" type="date" min={addDays(today, -7)} max={today} value={f.work_date} onChange={(e) => setF({ ...f, work_date: e.target.value })} error={errors.work_date ?? a.fields.work_date} />
      <TextField label="What did you work on?" value={f.title} maxLength={200} onChange={(e) => setF({ ...f, title: e.target.value })} error={errors.title ?? a.fields.title} />
      <TextArea label="Details" value={f.details} maxLength={4000} rows={5} onChange={(v) => setF({ ...f, details: v })} error={errors.details ?? a.fields.details} hint="Exactly what you did, results, and anything blocked." />
      <TextField label="Time spent (optional)" inputMode="decimal" placeholder="1.5 or 1:30" value={f.duration} onChange={(e) => setF({ ...f, duration: e.target.value })} error={errors.duration ?? a.fields.minutes} />
      {taskOpts.length > 0 && <Select label="For a task (optional)" value={f.task_id} onChange={(v) => setF({ ...f, task_id: v })} options={taskOpts} placeholder="No task" error={a.fields.task_id} />}
      <div className="flex gap-2">
        <Button type="submit" busy={a.busy}>
          Save
        </Button>
        <Button variant="text" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function TeamWork({ today }: { today: string }) {
  const [day, setDay] = useState(today);
  const [query, setQuery] = useState("");
  const q = useRpc<{ date: string; rows: TeamWorkRow[] }>("list_team_work", { p_date: day });
  const rows = (q.data?.rows ?? []).filter((r) => !query.trim() || `${r.employee.name} ${r.employee.code}`.toLowerCase().includes(query.trim().toLowerCase()));
  const submitted = (q.data?.rows ?? []).filter((r) => r.entries.length > 0).length;
  return (
    <section aria-label="Team reports" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <DayPicker day={day} today={today} onChange={setDay} past={62} />
        {q.data && (
          <span className="text-body-md text-text-secondary">
            {submitted} of {q.data.rows.length} wrote a report
          </span>
        )}
      </div>
      <TextField label="Search people" value={query} onChange={(e) => setQuery(e.target.value)} />
      {q.error ? (
        <ErrorState message={msg(q.error, "Could not load team reports.")} onRetry={() => void q.mutate()} />
      ) : !q.data ? (
        <LoadingState />
      ) : rows.length === 0 ? (
        <EmptyState art="groups" title="No one to show" />
      ) : (
        <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" aria-label="People">
          {rows.map((r) => (
            <li key={r.employee.id}>
              <SectionCard className="h-full">
                <div className="flex items-start justify-between gap-2">
                  <Link href={`/work/${r.employee.id}`} className="min-w-0 flex-1 font-semibold text-primary">
                    {r.employee.name}
                  </Link>
                  {r.entries.length === 0 ? <StatusChip label="Not written" tone="warning" /> : <span className="text-body-md text-text-secondary">{minutesLabel(r.total_minutes) || `${r.entries.length} entr${r.entries.length === 1 ? "y" : "ies"}`}</span>}
                </div>
                <p className="text-body-sm text-text-secondary">
                  {r.employee.code} · {TIER_LABEL[r.employee.tier] ?? "Employee"} · {r.open_tasks} open task{r.open_tasks === 1 ? "" : "s"}
                </p>
                <ul className="mt-2 flex flex-col gap-1">
                  {r.entries.map((w) => (
                    <li key={w.id} className="text-body-md">
                      <span className="font-medium">{w.title}</span>
                      {w.minutes ? <span className="text-text-secondary"> · {minutesLabel(w.minutes)}</span> : null}
                      <span className="block line-clamp-2 text-body-sm text-text-secondary">{w.details}</span>
                    </li>
                  ))}
                </ul>
              </SectionCard>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** One person's reports over the last 14 days (for their leader, HR or Admin). */
export function PersonWork({ id, now }: { id: string; now?: Date }) {
  const today = useToday(now);
  const q = useRpc<{ employee: { id: string; code: string; name: string }; rows: WorkLog[] }>("list_work_logs", { p_employee_id: id, p_from: addDays(today, -13), p_to: today });
  if (q.error) return <><PageTitle title="Work report" back="/work?tab=team" /><ErrorState message={msg(q.error, "Could not load the report.")} onRetry={() => void q.mutate()} /></>;
  if (!q.data) return <><PageTitle title="Work report" back="/work?tab=team" /><LoadingState /></>;
  const days = Array.from({ length: 14 }, (_, i) => addDays(today, -i));
  return (
    <>
      <PageTitle title={q.data.employee.name} back="/work?tab=team" />
      <div className="mx-auto flex max-w-3xl flex-col gap-3 p-page">
        <p className="text-body-md text-text-secondary">Daily work reports, last 14 days.</p>
        {days.map((d) => {
          const rows = q.data!.rows.filter((w) => w.work_date === d);
          const total = rows.reduce((s, w) => s + (w.minutes ?? 0), 0);
          return (
            <SectionCard key={d}>
              <div className="flex items-center justify-between">
                <h2 className="font-semibold">{d === today ? "Today" : dayNice(d)}</h2>
                {rows.length === 0 ? <span className="text-body-sm text-text-secondary">Nothing written</span> : total > 0 && <span className="text-body-sm text-text-secondary">{minutesLabel(total)}</span>}
              </div>
              {rows.map((w) => (
                <div key={w.id} className="mt-2">
                  <p className="font-medium">
                    {w.title}
                    {w.minutes ? <span className="font-normal text-text-secondary"> · {minutesLabel(w.minutes)}</span> : null}
                  </p>
                  {w.task && <p className="text-body-sm text-primary">Task: {w.task.title}</p>}
                  <p className="whitespace-pre-wrap text-body-md text-text-secondary">{w.details}</p>
                </div>
              ))}
            </SectionCard>
          );
        })}
      </div>
    </>
  );
}
