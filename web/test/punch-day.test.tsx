import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MyPunchDay, OutdoorPunchIn, OutdoorReview, PunchFixes } from "@/components/screens/punch-day";
import { actionScopes } from "@/lib/menu";
import { clockIn, fixErrors, needsReason, outdoorErrors, punchOutErrors, type Outdoor, type PunchDay, type PunchFix } from "@/lib/punch-day";
import { caps } from "@/lib/roles";
import { SessionProvider } from "@/lib/session";
import { ctx, fail, mockFetch, ok } from "./helpers";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, replace: push, back: vi.fn() }), usePathname: () => "/attendance/today", useSearchParams: () => new URLSearchParams() }));

function wrap(ui: React.ReactNode) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <SessionProvider>{ui}</SessionProvider>
    </SWRConfig>,
  );
}
beforeEach(() => {
  URL.createObjectURL = vi.fn(() => "blob:photo");
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  vi.unstubAllGlobals();
  push.mockReset();
});

const NOW = new Date("2026-11-16T06:00:00Z"); // 11:30 in Asia/Kolkata
const TZ = "Asia/Kolkata";
const asha = { id: "m1", code: "EMP0001", name: "Asha Rao" };
const pday = (over: Partial<PunchDay> = {}): PunchDay => ({
  date: "2026-11-16", is_today: true, has_machines: true, day: null, outdoor: null, fix: null,
  can_app_out: false, can_outdoor_in: true, can_request_fix: false, ...over,
});
const inDay = {
  first_in_at: "2026-11-16T03:35:00Z", out_at: null, out_source: null, worked_minutes: null, scan_count: 1, machine: "Front door",
  machine_in_at: "2026-11-16T03:35:00Z", in_corrected: false, app_out_reason: null, correction_reason: null,
} satisfies PunchDay["day"];
const outdoor = (over: Partial<Outdoor> = {}): Outdoor => ({
  id: "o1", work_date: "2026-11-16", reason: "Client visit at Anna Nagar", punch_in_at: "2026-11-16T04:00:00Z", punch_out_at: null,
  photo_file_version_id: "v1", latitude: 13.08, longitude: 80.27, status: "counted", rejected_at: null, reject_reason: null, rejected_by: null,
  employee: asha, can_reject: true, ...over,
});
const fix = (over: Partial<PunchFix> = {}): PunchFix => ({
  id: "f1", date: "2026-11-16", in_at: "2026-11-16T03:25:00Z", out_at: null, reason: "Queue at the machine", status: "pending",
  created_at: "2026-11-16T05:00:00Z", reviewed_at: null, review_note: null, reviewed_by: null, employee: asha,
  day: { first_in_at: "2026-11-16T03:35:00Z", out_at: null, out_source: null }, can_review: true, can_withdraw: false, ...over,
});

describe("punch rules", () => {
  const today = { isToday: true, nowClock: "11:30", inClock: "09:05" };
  it("punching out now needs nothing; an earlier time needs a reason", () => {
    expect(punchOutErrors({ time: "", reason: "" }, today)).toEqual({});
    expect(punchOutErrors({ time: "11:20", reason: "" }, today)).toEqual({});
    expect(punchOutErrors({ time: "10:00", reason: "" }, today).reason).toBeDefined();
    expect(punchOutErrors({ time: "10:00", reason: "Left for a client" }, today)).toEqual({});
    expect(punchOutErrors({ time: "09:00", reason: "x" }, today).time).toMatch(/after your punch-in at 09:05/);
    expect(punchOutErrors({ time: "12:00", reason: "" }, today).time).toMatch(/not come yet/);
    expect(punchOutErrors({ time: "1830", reason: "" }, today).time).toMatch(/like 18:30/);
  });
  it("another day always needs a time and a reason", () => {
    const past = { isToday: false, nowClock: "11:30", inClock: "09:05" };
    expect(punchOutErrors({ time: "", reason: "" }, past)).toEqual({ time: "Enter the time you left.", reason: "Say why you are setting an earlier time." });
    expect(punchOutErrors({ time: "18:30", reason: "Forgot" }, past)).toEqual({});
    expect(needsReason({ time: "", reason: "" }, past)).toBe(true);
  });
  it("fix requests need one time, in before out, and a reason", () => {
    expect(fixErrors({ in_time: "", out_time: "", reason: "" })).toEqual({ in_time: "Enter the right punch-in or punch-out time.", reason: "Say what went wrong (at least 5 characters)." });
    expect(fixErrors({ in_time: "10:00", out_time: "09:00", reason: "Machine queue" }).out_time).toBeDefined();
    expect(fixErrors({ in_time: "", out_time: "18:30", reason: "Machine queue" })).toEqual({});
  });
  it("outdoor punch-in needs a reason and a photo", () => {
    expect(outdoorErrors({ reason: "hi", photo: null })).toEqual({ reason: "Say where you are and what the work is.", photo: "Take a photo as proof." });
    expect(outdoorErrors({ reason: "Client visit", photo: new File(["x"], "a.jpg", { type: "image/jpeg" }) })).toEqual({});
  });
  it("clock in the org time zone", () => {
    expect(clockIn("2026-11-16T03:35:00Z", TZ)).toBe("09:05");
    expect(clockIn(null, TZ)).toBe("");
  });
  it("menus: everyone gets My punch and outdoor; HR gets the review lists", () => {
    const labels = (role: "employee" | "hr") => actionScopes(caps(ctx(role))).flatMap((s) => s.items.map((i) => i.label));
    expect(labels("employee")).toEqual(expect.arrayContaining(["My punch", "Outdoor punch-in"]));
    expect(labels("employee")).not.toContain("Punch fix requests");
    expect(labels("hr")).toEqual(expect.arrayContaining(["Punch fix requests", "Outdoor punch-ins"]));
  });
});

describe("My punch", () => {
  it("shows the machine punch-in and punches out now", async () => {
    const user = userEvent.setup();
    let d = pday({ day: inDay, can_app_out: true, can_outdoor_in: false, can_request_fix: true });
    const calls = mockFetch({
      "/rpc/get_session_context": () => ok(ctx("employee")),
      "/rpc/get_my_punch_day": () => ok(d),
      "/rpc/app_punch_out": () => {
        d = { ...d, can_app_out: false, day: { ...inDay, out_at: "2026-11-16T06:00:00Z", out_source: "app", worked_minutes: 145 } };
        return ok({ date: "2026-11-16", out_at: "2026-11-16T06:00:00Z" });
      },
    });
    wrap(<MyPunchDay now={NOW} />);
    expect(await screen.findByText("At Front door")).toBeInTheDocument();
    expect(screen.getByText("9:05 am")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Punch in for outdoor work" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Punch out" }));
    const sheet = screen.getByRole("dialog", { name: "Punch out" });
    await user.click(within(sheet).getByRole("button", { name: "Punch out now" }));
    expect(await screen.findByText("Punched out at 11:30 am.")).toBeInTheDocument();
    expect(calls.find((c) => c.path === "/rpc/app_punch_out")!.body).toEqual({ p_date: "2026-11-16", p_out_time: null, p_reason: null });
    expect(await screen.findByText("Worked 2 h 25 m")).toBeInTheDocument();
    expect(screen.getByText("from the app")).toBeInTheDocument();
  });

  it("an earlier punch-out asks for a reason first", async () => {
    const user = userEvent.setup();
    const calls = mockFetch({
      "/rpc/get_session_context": () => ok(ctx("employee")),
      "/rpc/get_my_punch_day": () => ok(pday({ day: inDay, can_app_out: true, can_outdoor_in: false })),
      "/rpc/app_punch_out": () => ok({ date: "2026-11-16", out_at: "2026-11-16T04:30:00Z" }),
    });
    wrap(<MyPunchDay now={NOW} />);
    await user.click(await screen.findByRole("button", { name: "Punch out" }));
    const sheet = screen.getByRole("dialog", { name: "Punch out" });
    await user.type(within(sheet).getByLabelText("Time (optional)"), "10:00");
    await user.click(within(sheet).getByRole("button", { name: "Punch out at 10:00" }));
    expect(within(sheet).getByText("Say why you are setting an earlier time.")).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/rpc/app_punch_out")).toBe(false);
    await user.type(within(sheet).getByLabelText("Why the earlier time?"), "Left for a client");
    await user.click(within(sheet).getByRole("button", { name: "Punch out at 10:00" }));
    await waitFor(() => expect(calls.find((c) => c.path === "/rpc/app_punch_out")?.body).toEqual({ p_date: "2026-11-16", p_out_time: "10:00", p_reason: "Left for a client" }));
  });

  it("not in yet: points to the machine and to outdoor punch-in; days switch", async () => {
    const user = userEvent.setup();
    const calls = mockFetch({
      "/rpc/get_session_context": () => ok(ctx("employee")),
      "/rpc/get_my_punch_day": (b) => ok(pday((b as { p_date: string }).p_date === "2026-11-15" ? { date: "2026-11-15", is_today: false, can_outdoor_in: false } : {})),
    });
    wrap(<MyPunchDay now={NOW} />);
    expect(await screen.findByText("Not punched in yet")).toBeInTheDocument();
    expect(screen.getByText(/Punch in at the attendance machine/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Punch in for outdoor work" })).toHaveAttribute("href", "/attendance/outdoor/new");
    await user.click(screen.getByRole("tab", { name: "Yesterday" }));
    expect(await screen.findByText("No punch that day")).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/rpc/get_my_punch_day" && (c.body as { p_date: string }).p_date === "2026-11-15")).toBe(true);
  });

  it("asks HR to fix a wrong time and shows the request", async () => {
    const user = userEvent.setup();
    let d = pday({ day: inDay, can_outdoor_in: false, can_request_fix: true });
    const calls = mockFetch({
      "/rpc/get_session_context": () => ok(ctx("employee")),
      "/rpc/get_my_punch_day": () => ok(d),
      "/rpc/request_punch_fix": () => {
        d = { ...d, can_request_fix: false, fix: fix({ can_review: false, can_withdraw: true }) };
        return ok(d.fix);
      },
      "/rpc/withdraw_punch_fix": () => ok(fix({ status: "withdrawn" })),
    });
    wrap(<MyPunchDay now={NOW} />);
    await user.click(await screen.findByRole("button", { name: /Ask HR to fix it/ }));
    const sheet = screen.getByRole("dialog", { name: "Ask HR to fix a time" });
    await user.click(within(sheet).getByRole("button", { name: "Send to HR" }));
    expect(within(sheet).getByText("Enter the right punch-in or punch-out time.")).toBeInTheDocument();
    await user.type(within(sheet).getByLabelText("Right punch-in"), "08:55");
    await user.type(within(sheet).getByLabelText("What went wrong?"), "Queue at the machine");
    await user.click(within(sheet).getByRole("button", { name: "Send to HR" }));
    expect(await screen.findByText(/Sent to HR/)).toBeInTheDocument();
    expect(calls.find((c) => c.path === "/rpc/request_punch_fix")!.body).toEqual({ p_date: "2026-11-16", p_in_time: "08:55", p_out_time: null, p_reason: "Queue at the machine" });
    expect(await screen.findByText("Waiting for HR")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Withdraw" }));
    expect(await screen.findByText("Request withdrawn.")).toBeInTheDocument();
  });

  it("an outdoor day shows its status and a rejection", async () => {
    mockFetch({
      "/rpc/get_session_context": () => ok(ctx("employee")),
      "/rpc/get_my_punch_day": () => ok(pday({ can_outdoor_in: false, outdoor: outdoor({ status: "rejected", reject_reason: "Not on the plan", rejected_by: "Lead Person" }) })),
    });
    wrap(<MyPunchDay now={NOW} />);
    expect(await screen.findByText("Outdoor work")).toBeInTheDocument();
    expect(screen.getByText("Rejected by Lead Person: Not on the plan")).toBeInTheDocument();
  });

  it("server refusals are shown", async () => {
    const user = userEvent.setup();
    mockFetch({
      "/rpc/get_session_context": () => ok(ctx("employee")),
      "/rpc/get_my_punch_day": () => ok(pday({ day: inDay, can_app_out: true, can_outdoor_in: false })),
      "/rpc/app_punch_out": () => fail(409, "CONFLICT", "You already punched out at the machine that day."),
    });
    wrap(<MyPunchDay now={NOW} />);
    await user.click(await screen.findByRole("button", { name: "Punch out" }));
    await user.click(screen.getByRole("button", { name: "Punch out now" }));
    expect(await screen.findByText("You already punched out at the machine that day.")).toBeInTheDocument();
  });
});

describe("Outdoor punch-in", () => {
  it("needs a reason and a photo, then uploads and punches in with the location", async () => {
    const user = userEvent.setup();
    const calls = mockFetch({
      "/rpc/get_session_context": () => ok(ctx("employee")),
      "/files": () => [201, { data: { file_version_id: "v9" } }],
      "/rpc/outdoor_punch_in": () => ok(outdoor()),
    });
    const locate = vi.fn(async () => ({ latitude: 13.08, longitude: 80.27 }));
    wrap(<OutdoorPunchIn locate={locate} />);
    await user.click(screen.getByRole("button", { name: "Punch in" }));
    expect(screen.getByText("Say where you are and what the work is.")).toBeInTheDocument();
    expect(screen.getByText("Take a photo as proof.")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Where are you, and what is the work?"), "Client visit at Anna Nagar");
    await user.upload(screen.getByLabelText("Photo as proof"), new File(["jpegbytes"], "site.jpg", { type: "image/jpeg" }));
    expect(screen.getByAltText("Your photo")).toHaveAttribute("src", "blob:photo");
    await user.click(screen.getByRole("button", { name: "Punch in" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/attendance/today"));
    const up = calls.find((c) => c.path === "/files")!;
    expect(up.query.get("class")).toBe("correction_attachment");
    expect(calls.find((c) => c.path === "/rpc/outdoor_punch_in")!.body).toEqual({
      p_reason: "Client visit at Anna Nagar", p_photo_file_version_id: "v9", p_latitude: 13.08, p_longitude: 80.27,
    });
  });
  it("works without a location and shows refusals", async () => {
    const user = userEvent.setup();
    const calls = mockFetch({
      "/rpc/get_session_context": () => ok(ctx("employee")),
      "/files": () => [201, { data: { file_version_id: "v9" } }],
      "/rpc/outdoor_punch_in": () => fail(409, "CONFLICT", "You already punched in at the machine today."),
    });
    wrap(<OutdoorPunchIn locate={async () => null} />);
    await user.type(screen.getByLabelText("Where are you, and what is the work?"), "Site survey at the port");
    await user.upload(screen.getByLabelText("Photo as proof"), new File(["x"], "s.png", { type: "image/png" }));
    await user.click(screen.getByRole("button", { name: "Punch in" }));
    expect(await screen.findByText("You already punched in at the machine today.")).toBeInTheDocument();
    expect((calls.find((c) => c.path === "/rpc/outdoor_punch_in")!.body as { p_latitude: unknown }).p_latitude).toBeNull();
    expect(push).not.toHaveBeenCalled();
  });
});

describe("Outdoor punch-ins (review)", () => {
  it("lists them, opens the photo and rejects with a reason", async () => {
    const user = userEvent.setup();
    let rows = [outdoor(), outdoor({ id: "o2", employee: { id: "x", code: "EMP9", name: "Ravi" }, can_reject: false, latitude: null, longitude: null })];
    const calls = mockFetch({
      "/rpc/get_session_context": () => ok(ctx("hr")),
      "/rpc/list_outdoor_punches": () => ok({ from: "2026-11-10", to: "2026-11-16", rows }),
      "/files/v1": () => [200, "jpegbytes"],
      "/rpc/reject_outdoor_punch": () => {
        rows = [outdoor({ status: "rejected", reject_reason: "Not on the plan", can_reject: false }), rows[1]];
        return ok(rows[0]);
      },
    });
    wrap(<OutdoorReview now={NOW} />);
    expect(await screen.findByText("Asha Rao")).toBeInTheDocument();
    expect(calls.find((c) => c.path === "/rpc/list_outdoor_punches")!.body).toEqual({ p_from: "2026-11-10", p_to: "2026-11-16" });
    expect(screen.getAllByRole("link", { name: "Map" })).toHaveLength(1);
    await user.click(screen.getAllByRole("button", { name: "View photo" })[0]);
    expect(await screen.findByAltText("Outdoor photo from Asha Rao")).toBeInTheDocument();
    expect(calls.find((c) => c.path === "/files/v1")!.query.get("purpose")).toBe("review");
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getAllByRole("button", { name: "Reject" })).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Reject" }));
    const sheet = screen.getByRole("dialog", { name: "Reject Asha Rao's punch-in?" });
    await user.click(within(sheet).getByRole("button", { name: "Reject" }));
    expect(within(sheet).getByText("Say why it is rejected.")).toBeInTheDocument();
    await user.type(within(sheet).getByLabelText("Reason"), "Not on the plan");
    await user.click(within(sheet).getByRole("button", { name: "Reject" }));
    expect(await screen.findByText("Rejected. They have been told.")).toBeInTheDocument();
    expect(await screen.findByText("Rejected: Not on the plan")).toBeInTheDocument();
  });
});

describe("Punch fix requests", () => {
  it("HR approves one and rejects another with a note", async () => {
    const user = userEvent.setup();
    let rows = [fix(), fix({ id: "f2", employee: { id: "x", code: "EMP9", name: "Ravi" }, in_at: null, out_at: "2026-11-16T12:30:00Z" })];
    const calls = mockFetch({
      "/rpc/get_session_context": () => ok(ctx("hr")),
      "/rpc/list_punch_fixes": () => ok(rows),
      "/rpc/review_punch_fix": (b) => {
        const id = (b as { p_id: string }).p_id;
        rows = rows.filter((r) => r.id !== id);
        return ok(fix({ id, status: "approved" }));
      },
    });
    wrap(<PunchFixes now={NOW} />);
    expect(await screen.findByText("Asha Rao")).toBeInTheDocument();
    expect(screen.getByText("8:55 am")).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "Approve" })[0]);
    expect(await screen.findByText(/Fixed Asha Rao's punch/)).toBeInTheDocument();
    expect(calls.find((c) => c.path === "/rpc/review_punch_fix")!.body).toEqual({ p_id: "f1", p_approve: true, p_note: null });
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Reject" })).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "Reject" }));
    const sheet = screen.getByRole("dialog", { name: "Reject this fix?" });
    await user.type(within(sheet).getByLabelText(/Reason/), "The machine log shows 9:40");
    await user.click(within(sheet).getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(calls.filter((c) => c.path === "/rpc/review_punch_fix")).toHaveLength(2));
    expect(calls.filter((c) => c.path === "/rpc/review_punch_fix")[1].body).toEqual({ p_id: "f2", p_approve: false, p_note: "The machine log shows 9:40" });
  });
});
