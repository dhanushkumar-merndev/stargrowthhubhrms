import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SWRConfig } from "swr";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandPalette } from "@/components/command-palette";
import { Attendance, fixLink } from "@/components/screens/attendance";
import { AttendancePrint } from "@/components/screens/attendance-print";
import { CorrectionForm } from "@/components/screens/request-forms";
import type { DayRow, Totals } from "@/lib/attendance";
import { commandItems, isPaletteKey, rankCommands } from "@/lib/command";
import { caps } from "@/lib/roles";
import { SessionProvider } from "@/lib/session";
import { ATTENDANCE_HEADER, attendanceFileName, attendanceRows, buildXlsx, colName, monthParam, sheetName, sheetXml, xmlText, XLSX_TYPE } from "@/lib/xlsx";
import { readZipDirectory, readZipEntry } from "@/lib/zip";
import { ctx, mockFetch, ok } from "./helpers";
import { nav } from "./setup";

function wrap(ui: React.ReactNode) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <SessionProvider>{ui}</SessionProvider>
    </SWRConfig>,
  );
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  nav.push.mockReset();
});

const NOW = new Date("2026-11-14T06:00:00Z"); // 11:30 IST

const day = (over: Partial<DayRow> = {}): DayRow => ({
  employee_id: "e1",
  shift_date: "2026-11-03",
  instance_id: "i1",
  kind: "work",
  is_required: true,
  status: "present",
  start_at: "2026-11-03T04:30:00Z",
  end_at: "2026-11-03T13:30:00Z",
  timezone: "Asia/Kolkata",
  session_id: "s1",
  session_state: "closed",
  effective_in_at: "2026-11-03T04:35:00Z",
  effective_out_at: "2026-11-03T13:05:00Z",
  effective_source: "office",
  leave_slots: 0,
  required_seconds: 30600,
  presence_seconds: 30600,
  credited_seconds: 30600,
  shortfall_seconds: 0,
  extra_seconds: 0,
  is_late: false,
  late_seconds: 0,
  is_early_departure: false,
  early_seconds: 0,
  ...over,
});
const totals: Totals = { required_seconds: 61200, credited_seconds: 45000, shortfall_seconds: 16200, extra_seconds: 0, present_days: 2, absent_days: 1, late_days: 1, leave_days: 0, unresolved_days: 1 };

const text = async (b: Blob, path: string) => {
  const dir = await readZipDirectory(b);
  const e = dir.find((x) => x.path === path);
  if (!e) throw new Error(`missing ${path}`);
  return new TextDecoder().decode(await readZipEntry(b, e));
};

describe("xlsx writer", () => {
  it("names columns past Z", () => {
    expect([0, 25, 26, 27, 51, 52, 701, 702].map(colName)).toEqual(["A", "Z", "AA", "AB", "AZ", "BA", "ZZ", "AAA"]);
  });

  it("escapes XML and drops characters XML cannot hold", () => {
    expect(xmlText(`a<b>&"c"`)).toBe("a&lt;b&gt;&amp;&quot;c&quot;");
    expect(xmlText("x\u0000\u0007\u001Fy\tz\n")).toBe("xy\tz\n");
    expect(xmlText("ok\uD800bad")).toBe("okbad"); // lone surrogate
    expect(xmlText("😀")).toBe("😀"); // a valid pair survives
  });

  it("keeps sheet names inside Excel's rules", () => {
    expect(sheetName("November 2026")).toBe("November 2026");
    expect(sheetName("a/b\\c[d]:e*f?")).toBe("a b c d  e f");
    expect(sheetName("x".repeat(40))).toHaveLength(31);
    expect(sheetName("''")).toBe("Sheet1");
    expect(sheetName("   ")).toBe("Sheet1");
  });

  it("writes numbers as values, text as inline strings, and skips empties", () => {
    const xml = sheetXml([["Name", "Hours"], ["=HYPERLINK(\"http://x\")", 7.5], [null, Number.NaN], ["", undefined]]);
    expect(xml).toContain('<c r="A1" s="1" t="inlineStr"><is><t xml:space="preserve">Name</t></is></c>');
    expect(xml).toContain('<c r="B2"><v>7.5</v></c>');
    // A formula-looking value stays text: no <f> element anywhere.
    expect(xml).toContain("=HYPERLINK(&quot;http://x&quot;)");
    expect(xml).not.toContain("<f>");
    expect(xml).not.toContain('r="A3"');
    expect(xml).not.toContain('r="B3"'); // NaN dropped
    expect(xml).toContain('<row r="4"></row>');
    expect(xml).toContain('state="frozen"');
  });

  it("does not freeze a header-only sheet and caps very long cells", () => {
    const xml = sheetXml([["only"]]);
    expect(xml).not.toContain("frozen");
    expect(sheetXml([["h"], ["y".repeat(40000)]])).toContain("y".repeat(32767) + "</t>");
    expect(sheetXml([["h"], ["y".repeat(40000)]])).not.toContain("y".repeat(32768));
  });

  it("builds a valid package that reads back", async () => {
    const b = buildXlsx("Nov <2026>", [["A", "B"], ["x", 1]], NOW);
    expect(b.type).toBe(XLSX_TYPE);
    const dir = await readZipDirectory(b);
    expect(dir.map((e) => e.path).sort()).toEqual(["[Content_Types].xml", "_rels/.rels", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml"]);
    expect(await text(b, "xl/workbook.xml")).toContain('name="Nov &lt;2026&gt;"');
    expect(await text(b, "xl/worksheets/sheet1.xml")).toContain("<v>1</v>");
    expect(await text(b, "[Content_Types].xml")).toContain("/xl/worksheets/sheet1.xml");
  });
});

describe("own attendance export rows", () => {
  it("lists days up to today with local times and hours, then totals", () => {
    const rows = attendanceRows(
      [
        day(),
        day({ shift_date: "2026-11-04", is_late: true, late_seconds: 1250, credited_seconds: 14400, shortfall_seconds: 16200, leave_slots: 2 }),
        day({ shift_date: "2026-11-20", status: "upcoming" }),
      ],
      totals,
      "2026-11-14",
    );
    expect(rows[0]).toEqual(ATTENDANCE_HEADER);
    expect(rows[1]).toEqual(["2026-11-03", "Present", "10:05", "18:35", 8.5, 8.5, 0, "", ""]);
    expect(rows[2]).toEqual(["2026-11-04", "Present · late", "10:05", "18:35", 4, 8.5, 4.5, 21, "PM leave"]);
    expect(rows).toHaveLength(5); // header, 2 days, blank, totals
    expect(rows[3]).toEqual([]);
    expect(rows[4].slice(0, 2)).toEqual(["Total", "2 present · 1 late · 1 absent"]);
    expect(rows[4][4]).toBe(12.5);
  });

  it("shows blanks for missing punches and never negative hours", () => {
    const [, r] = attendanceRows([day({ status: "absent", effective_in_at: null, effective_out_at: null, credited_seconds: -5, shortfall_seconds: 30600 })], totals, "2026-11-14");
    expect(r.slice(0, 5)).toEqual(["2026-11-03", "Absent", "", "", 0]);
  });

  it("parses the month query strictly", () => {
    expect(monthParam("2026-11")).toBe("2026-11-01");
    for (const bad of ["2026-13", "2026-00", "2026-1", "26-11", "2026-11-01", "", null, undefined, "2026-11<script>"]) expect(monthParam(bad)).toBeNull();
    expect(attendanceFileName("2026-11-01")).toBe("attendance-2026-11.xlsx");
  });
});

describe("forgot-checkout self-fix", () => {
  it("offers the right fix only on days that need one", () => {
    expect(fixLink(day())).toBeNull();
    expect(fixLink(day({ status: "needs_correction", effective_out_at: null }))).toEqual({ href: "/corrections/new?date=2026-11-03&fix=out", label: "Fix check-out for Tue, 3 Nov" });
    expect(fixLink(day({ status: "needs_correction", effective_in_at: null, effective_out_at: null }))?.href).toBe("/corrections/new?date=2026-11-03");
    expect(fixLink(day({ status: "in_progress", effective_out_at: null }))).toBeNull(); // today, still at work
  });
});

function attendanceRoutes(rows: DayRow[]) {
  return mockFetch({
    "/rpc/get_session_context": () => ok(ctx("employee")),
    "/rpc/list_my_attendance": () => ok({ rows, totals }),
  });
}

describe("Attendance screen exports and fixes", () => {
  it("downloads the month as Excel and links to the print view", async () => {
    attendanceRoutes([day(), day({ shift_date: "2026-11-04", status: "needs_correction", effective_out_at: null })]);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe("attendance-2026-11.xlsx");
    });
    wrap(<Attendance now={NOW} />);
    await userEvent.click(await screen.findByRole("button", { name: "Download Excel" }));
    expect(click).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("link", { name: "Print / PDF" })).toHaveAttribute("href", "/attendance/print?month=2026-11");
    expect(screen.getByRole("link", { name: "Fix check-out for Wed, 4 Nov" })).toHaveAttribute("href", "/corrections/new?date=2026-11-04&fix=out");
  });

  it("disables the download when there are no days", async () => {
    attendanceRoutes([]);
    wrap(<Attendance now={NOW} />);
    expect(await screen.findByRole("button", { name: "Download Excel" })).toBeDisabled();
  });

  it("the print link follows the month picker", async () => {
    attendanceRoutes([day()]);
    wrap(<Attendance now={NOW} />);
    await screen.findByRole("button", { name: "Download Excel" });
    await userEvent.click(screen.getByRole("button", { name: "Previous month" }));
    await waitFor(() => expect(screen.getByRole("link", { name: "Print / PDF" })).toHaveAttribute("href", "/attendance/print?month=2026-10"));
  });
});

describe("AttendancePrint", () => {
  it("renders a table with the person and totals, and prints on request", async () => {
    const calls = attendanceRoutes([day()]);
    const print = vi.fn();
    vi.stubGlobal("print", print);
    wrap(<AttendancePrint month="2026-11-01" now={NOW} />);
    const table = await screen.findByRole("table");
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(ATTENDANCE_HEADER);
    expect(within(table).getByText("2026-11-03")).toBeInTheDocument();
    expect(within(table).getByText("Total")).toBeInTheDocument();
    expect(await screen.findByText(/Asha Rao \(EMP001\) · Acme/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Attendance · November 2026" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Print / Save as PDF" }));
    expect(print).toHaveBeenCalled();
    expect(calls.find((c) => c.path === "/rpc/list_my_attendance")?.body).toEqual({ p_from: "2026-11-01", p_to: "2026-11-30" });
  });

  it("clamps a future or missing month to this month", async () => {
    const calls = attendanceRoutes([]);
    wrap(<AttendancePrint month="2027-05-01" now={NOW} />);
    expect(await screen.findByText("No days to show for this month yet.")).toBeInTheDocument();
    expect(calls.find((c) => c.path === "/rpc/list_my_attendance")?.body).toEqual({ p_from: "2026-11-01", p_to: "2026-11-30" });
  });
});

describe("CorrectionForm fix=out", () => {
  it("prefills the recorded check-in and asks only for the leaving time", async () => {
    const calls = mockFetch({
      "/rpc/get_session_context": () => ok(ctx("employee")),
      "/rpc/list_my_attendance": () => ok({ rows: [day({ shift_date: "2026-11-13", status: "needs_correction", effective_in_at: "2026-11-13T04:00:00Z", effective_out_at: null })], totals }),
      "/rpc/save_correction_request": () => ok({ id: "r1" }),
    });
    wrap(<CorrectionForm initialDate="2026-11-13" fix="out" now={NOW} />);
    expect(await screen.findByText("You checked in at 09:30. Enter the time you actually left.")).toBeInTheDocument();
    expect(screen.getByLabelText("Checked in at")).toHaveValue("09:30");
    await userEvent.type(screen.getByLabelText("Checked out at"), "18:15");
    await userEvent.type(screen.getByLabelText(/Reason/), "Forgot to punch out at the door");
    await userEvent.click(screen.getByRole("button", { name: "Send to HR" }));
    await screen.findByText("Correction sent");
    const sent = calls.find((c) => c.path === "/rpc/save_correction_request")?.body as Record<string, unknown>;
    expect(sent.p_proposed_in_at).toBe("2026-11-13T04:00:00.000Z");
    expect(sent.p_proposed_out_at).toBe("2026-11-13T12:45:00.000Z");
  });

  it("lets the person change the prefilled time, and drops it for another date", async () => {
    mockFetch({
      "/rpc/get_session_context": () => ok(ctx("employee")),
      "/rpc/list_my_attendance": () => ok({ rows: [day({ shift_date: "2026-11-13", effective_in_at: "2026-11-13T04:00:00Z", effective_out_at: null })], totals }),
    });
    wrap(<CorrectionForm initialDate="2026-11-13" fix="out" now={NOW} />);
    const input = await screen.findByLabelText("Checked in at");
    await waitFor(() => expect(input).toHaveValue("09:30"));
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-11-12" } });
    expect(input).toHaveValue("");
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-11-13" } });
    expect(input).toHaveValue("09:30");
    fireEvent.change(input, { target: { value: "09:10" } });
    expect(input).toHaveValue("09:10");
  });

  it("without a recorded check-in asks for both times", async () => {
    mockFetch({ "/rpc/get_session_context": () => ok(ctx("employee")), "/rpc/list_my_attendance": () => ok({ rows: [], totals }) });
    wrap(<CorrectionForm initialDate="2026-11-13" fix="out" now={NOW} />);
    expect(await screen.findByText("Enter the times you checked in and actually left.")).toBeInTheDocument();
    expect(screen.getByLabelText("Checked in at")).toHaveValue("");
  });

  it("does not load the day when no fix is asked", async () => {
    const calls = mockFetch({ "/rpc/get_session_context": () => ok(ctx("employee")) });
    wrap(<CorrectionForm initialDate="2026-11-13" now={NOW} />);
    await screen.findByLabelText("Checked in at");
    expect(calls.some((c) => c.path === "/rpc/list_my_attendance")).toBe(false);
  });
});

describe("command search", () => {
  it("lists only what the role can open, without duplicates", () => {
    const emp = commandItems(caps(ctx("employee")));
    const admin = commandItems(caps(ctx("admin")));
    expect(admin.length).toBeGreaterThan(emp.length);
    expect(new Set(admin.map((c) => c.href)).size).toBe(admin.length);
    expect(emp.some((c) => c.href.startsWith("/admin"))).toBe(false);
    expect(admin.some((c) => c.href === "/admin/audit")).toBe(true);
  });

  it("ranks word-start matches, label before group, and needs every word", () => {
    const items = [
      { label: "Audit log", href: "/a", group: "Admin" },
      { label: "Leave policies", href: "/l", group: "Admin" },
      { label: "Apply leave", href: "/al", group: "Requests" },
      { label: "Holidays", href: "/h", group: "Leave" },
    ];
    expect(rankCommands(items, "leave").map((c) => c.href)).toEqual(["/l", "/al", "/h"]);
    expect(rankCommands(items, "lea pol").map((c) => c.href)).toEqual(["/l"]);
    expect(rankCommands(items, "eave")).toEqual([]); // not a word start
    expect(rankCommands(items, "  ").length).toBe(4);
    expect(rankCommands(items, "", 2).length).toBe(2);
    expect(rankCommands(items, "AUDIT!")[0].href).toBe("/a");
  });

  it("recognises Ctrl-K and ⌘-K only", () => {
    expect(isPaletteKey({ key: "k", ctrlKey: true, metaKey: false, altKey: false })).toBe(true);
    expect(isPaletteKey({ key: "K", ctrlKey: false, metaKey: true, altKey: false })).toBe(true);
    expect(isPaletteKey({ key: "k", ctrlKey: true, metaKey: false, altKey: true })).toBe(false);
    expect(isPaletteKey({ key: "k", ctrlKey: false, metaKey: false, altKey: false })).toBe(false);
    expect(isPaletteKey({ key: "j", ctrlKey: true, metaKey: false, altKey: false })).toBe(false);
  });
});

describe("CommandPalette", () => {
  const people = { rows: [{ id: "e9", name: "Ravi Kumar", code: "EMP009" }], total: 1 };

  it("opens with Ctrl-K for HR, navigates with arrows and Enter, closes with Esc", async () => {
    mockFetch({ "/rpc/get_session_context": () => ok(ctx("hr")), "/rpc/list_employees": () => ok(people) });
    wrap(<CommandPalette />);
    await waitFor(() => {
      fireEvent.keyDown(window, { key: "k", ctrlKey: true });
      expect(screen.getByRole("dialog", { name: "Search" })).toBeInTheDocument();
    });
    const box = screen.getByRole("combobox", { name: "Search screens and people" });
    expect(box).toHaveFocus();
    await userEvent.type(box, "notif");
    const opts = screen.getAllByRole("option");
    expect(opts[0]).toHaveTextContent("Notifications");
    expect(opts[0]).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{Enter}");
    expect(nav.push).toHaveBeenCalledWith("/notifications");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const box2 = screen.getByRole("combobox");
    await userEvent.keyboard("{Escape}");
    expect(box2).not.toBeInTheDocument();
  });

  it("finds employees after two characters", async () => {
    const calls = mockFetch({ "/rpc/get_session_context": () => ok(ctx("admin")), "/rpc/list_employees": () => ok(people) });
    wrap(<CommandPalette />);
    await waitFor(() => {
      fireEvent.keyDown(window, { key: "k", ctrlKey: true });
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
    await userEvent.type(screen.getByRole("combobox"), "r");
    await new Promise((r) => setTimeout(r, 300));
    expect(calls.some((c) => c.path === "/rpc/list_employees")).toBe(false);
    await userEvent.type(screen.getByRole("combobox"), "a");
    const hit = await screen.findByRole("option", { name: /Ravi Kumar · EMP009/ });
    expect(calls.find((c) => c.path === "/rpc/list_employees")?.body).toMatchObject({ p_search: "ra", p_status: "all", p_limit: 5 });
    await userEvent.click(hit);
    expect(nav.push).toHaveBeenCalledWith("/employees/e9");
  });

  it("arrow keys wrap around", async () => {
    mockFetch({ "/rpc/get_session_context": () => ok(ctx("admin")) });
    wrap(<CommandPalette />);
    await waitFor(() => {
      fireEvent.keyDown(window, { key: "k", ctrlKey: true });
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
    const opts = () => screen.getAllByRole("option");
    await userEvent.keyboard("{ArrowUp}");
    expect(opts()[opts().length - 1]).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{ArrowDown}");
    expect(opts()[0]).toHaveAttribute("aria-selected", "true");
  });

  it("shows No matches", async () => {
    mockFetch({ "/rpc/get_session_context": () => ok(ctx("admin")), "/rpc/list_employees": () => ok({ rows: [], total: 0 }) });
    wrap(<CommandPalette />);
    await waitFor(() => {
      fireEvent.keyDown(window, { key: "k", ctrlKey: true });
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
    await userEvent.type(screen.getByRole("combobox"), "zzqx");
    expect(await screen.findByText("No matches")).toBeInTheDocument();
  });

  it("does nothing for employees", async () => {
    mockFetch({ "/rpc/get_session_context": () => ok(ctx("employee")) });
    wrap(<CommandPalette />);
    await new Promise((r) => setTimeout(r, 50));
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("CalendarFeed", () => {
  it("builds https and webcal addresses", async () => {
    const { feedUrl, webcalUrl } = await import("@/components/screens/calendar-feed");
    expect(feedUrl("https://hrms.example/", "abc_-")).toBe("https://hrms.example/api/v1/calendar/abc_-.ics");
    expect(webcalUrl("https://hrms.example/api/v1/calendar/x.ics")).toBe("webcal://hrms.example/api/v1/calendar/x.ics");
    expect(webcalUrl("http://localhost:3100/a.ics")).toBe("webcal://localhost:3100/a.ics");
  });

  it("creates a link, shows it once, copies it, and turns it off", async () => {
    const { CalendarFeed } = await import("@/components/screens/calendar-feed");
    let enabled = false;
    const token = "T".repeat(43);
    const calls = mockFetch({
      "/rpc/get_session_context": () => ok(ctx("employee")),
      "/rpc/get_calendar_feed": () => ok({ enabled, created_at: enabled ? "2026-11-14T06:00:00Z" : null, last_used_at: null }),
      "/rpc/create_calendar_feed": () => ((enabled = true), ok({ enabled: true, token, created_at: "2026-11-14T06:00:00Z", last_used_at: null })),
      "/rpc/revoke_calendar_feed": () => ((enabled = false), ok({ enabled: false })),
    });
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    wrap(<CalendarFeed origin="https://hrms.example" />);
    expect(await screen.findByText("You have no calendar link yet.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Create calendar link" }));
    const field = await screen.findByLabelText("Calendar link");
    expect(field).toHaveValue(`https://hrms.example/api/v1/calendar/${token}.ics`);
    expect(screen.getByRole("link", { name: "Open in calendar app" })).toHaveAttribute("href", `webcal://hrms.example/api/v1/calendar/${token}.ics`);
    await userEvent.click(screen.getByRole("button", { name: "Copy link" }));
    expect(writeText).toHaveBeenCalledWith(`https://hrms.example/api/v1/calendar/${token}.ics`);
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Turn off" }));
    expect(await screen.findByText("You have no calendar link yet.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Calendar link")).not.toBeInTheDocument();
    expect(calls.filter((c) => c.path === "/rpc/revoke_calendar_feed")).toHaveLength(1);
  });

  it("asks before replacing an existing link, and can keep the old one", async () => {
    const { CalendarFeed } = await import("@/components/screens/calendar-feed");
    const calls = mockFetch({
      "/rpc/get_session_context": () => ok(ctx("employee")),
      "/rpc/get_calendar_feed": () => ok({ enabled: true, created_at: "2026-11-01T06:00:00Z", last_used_at: null }),
      "/rpc/create_calendar_feed": () => ok({ enabled: true, token: "N".repeat(43), created_at: "2026-11-14T06:00:00Z", last_used_at: null }),
    });
    wrap(<CalendarFeed origin="https://h" />);
    expect(await screen.findByText("Your calendar link is on.")).toBeInTheDocument();
    expect(screen.getByText(/last used never/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Make a new link" }));
    await userEvent.click(screen.getByRole("button", { name: "Keep the old one" }));
    expect(calls.some((c) => c.path === "/rpc/create_calendar_feed")).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Make a new link" }));
    await userEvent.click(screen.getByRole("button", { name: "Make new link" }));
    expect(await screen.findByLabelText("Calendar link")).toHaveValue(`https://h/api/v1/calendar/${"N".repeat(43)}.ics`);
  });

  it("explains a failed copy and a failed create", async () => {
    const { CalendarFeed } = await import("@/components/screens/calendar-feed");
    let fails = true;
    mockFetch({
      "/rpc/get_session_context": () => ok(ctx("employee")),
      "/rpc/get_calendar_feed": () => ok({ enabled: false, created_at: null, last_used_at: null }),
      "/rpc/create_calendar_feed": () => (fails ? ((fails = false), [500, { error: { code: "INTERNAL", message: "boom" } }]) : ok({ enabled: true, token: "Z".repeat(43) })),
    });
    Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn(async () => Promise.reject(new Error("denied"))) }, configurable: true });
    wrap(<CalendarFeed origin="https://h" />);
    await userEvent.click(await screen.findByRole("button", { name: "Create calendar link" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Create calendar link" }));
    await userEvent.click(await screen.findByRole("button", { name: "Copy link" }));
    expect(await screen.findByText("Could not copy. Select the link and copy it yourself.")).toBeInTheDocument();
  });
});

describe("celebrations", () => {
  const c = (over: Record<string, unknown> = {}) => ({ employee_id: "e2", name: "Ravi Kumar", kind: "birthday", date: "2026-11-14", years: null, is_today: true, is_me: false, ...over });

  it("words each kind, ordinal and day", async () => {
    const { celebrationText } = await import("@/components/screens/celebrations");
    const T = "2026-11-14";
    expect(celebrationText(c() as never, T)).toEqual({ title: "Ravi Kumar's birthday", when: "Today" });
    expect(celebrationText(c({ is_me: true }) as never, T).title).toBe("Your birthday");
    expect(celebrationText(c({ kind: "anniversary", years: 1, is_today: false, date: "2026-11-15" }) as never, T)).toEqual({ title: "Ravi Kumar's 1st work anniversary", when: "Tomorrow" });
    for (const [y, w] of [[2, "2nd"], [3, "3rd"], [4, "4th"], [11, "11th"], [12, "12th"], [13, "13th"], [21, "21st"], [22, "22nd"], [101, "101st"], [111, "111th"]] as const)
      expect(celebrationText(c({ kind: "anniversary", years: y }) as never, T).title).toContain(` ${w} work`);
    expect(celebrationText(c({ kind: "anniversary", years: 0 }) as never, T).title).toBe("Ravi Kumar's work anniversary");
    expect(celebrationText(c({ is_today: false, date: "2026-11-18" }) as never, T).when).toBe("Wed, 18 Nov");
    // Month and year rollover for "Tomorrow".
    expect(celebrationText(c({ is_today: false, date: "2027-01-01" }) as never, "2026-12-31").when).toBe("Tomorrow");
  });

  it("shows the Home card only when something is coming up", async () => {
    const { CelebrationsCard } = await import("@/components/screens/celebrations");
    mockFetch({ "/rpc/get_session_context": () => ok(ctx("employee")), "/rpc/list_celebrations": () => ok({ today: "2026-11-14", rows: [c(), c({ employee_id: "e1", name: "Asha Rao", kind: "anniversary", years: 3, is_me: true })] }) });
    wrap(<CelebrationsCard />);
    const card = await screen.findByRole("region", { name: "Celebrations" });
    expect(within(card).getByText("Ravi Kumar's birthday")).toBeInTheDocument();
    expect(within(card).getByText("Your 3rd work anniversary")).toBeInTheDocument();
    expect(within(card).getByRole("link", { name: /Privacy/ })).toHaveAttribute("href", "/settings/celebrations");
  });

  it("caps the card at six and hides it when empty or failing", async () => {
    const { CelebrationsCard } = await import("@/components/screens/celebrations");
    const many = Array.from({ length: 8 }, (_, i) => c({ employee_id: `e${i}`, name: `P${i}` }));
    mockFetch({ "/rpc/get_session_context": () => ok(ctx("employee")), "/rpc/list_celebrations": () => ok({ today: "2026-11-14", rows: many }) });
    const { unmount } = wrap(<CelebrationsCard />);
    expect(await screen.findByText("and 2 more this week")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(6);
    unmount();
    mockFetch({ "/rpc/get_session_context": () => ok(ctx("employee")), "/rpc/list_celebrations": () => ok({ today: "2026-11-14", rows: [] }) });
    const r2 = wrap(<CelebrationsCard />);
    await new Promise((r) => setTimeout(r, 50));
    expect(r2.container).toBeEmptyDOMElement();
    r2.unmount();
    mockFetch({ "/rpc/get_session_context": () => ok(ctx("employee")), "/rpc/list_celebrations": () => [500, { error: { code: "INTERNAL", message: "x" } }] });
    const r3 = wrap(<CelebrationsCard />);
    await new Promise((r) => setTimeout(r, 50));
    expect(r3.container).toBeEmptyDOMElement();
  });

  it("saves the privacy choices and explains a missing date of birth", async () => {
    const { CelebrationSettings } = await import("@/components/screens/celebrations");
    const calls = mockFetch({
      "/rpc/get_session_context": () => ok(ctx("employee")),
      "/rpc/get_celebration_prefs": () => ok({ share_birthday: false, share_anniversary: true, has_birthday: false }),
      "/rpc/set_celebration_prefs": () => ok({ share_birthday: true, share_anniversary: false, has_birthday: false }),
    });
    wrap(<CelebrationSettings />);
    expect(await screen.findByText(/Add your date of birth in your profile first/)).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText(/Show my birthday/));
    await userEvent.click(screen.getByLabelText(/Show my work anniversary/));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved.")).toBeInTheDocument();
    expect(calls.find((x) => x.path === "/rpc/set_celebration_prefs")?.body).toEqual({ p_share_birthday: true, p_share_anniversary: false });
  });
});

describe("saved banner survives the refreshed form", () => {
  it("celebration choices", async () => {
    const { CelebrationSettings } = await import("@/components/screens/celebrations");
    let prefs = { share_birthday: false, share_anniversary: true, has_birthday: true };
    mockFetch({
      "/rpc/get_session_context": () => ok(ctx("employee")),
      "/rpc/get_celebration_prefs": () => ok(prefs),
      "/rpc/set_celebration_prefs": (b) => {
        const x = b as { p_share_birthday: boolean; p_share_anniversary: boolean };
        prefs = { ...prefs, share_birthday: x.p_share_birthday, share_anniversary: x.p_share_anniversary };
        return ok(prefs);
      },
    });
    wrap(<CelebrationSettings />);
    await userEvent.click(await screen.findByLabelText(/Show my birthday/));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText(/Show my birthday/)).toBeChecked());
    expect(screen.getByText("Saved.")).toBeInTheDocument();
  });
});

describe("comp-off request", () => {
  it("explains the rule, blocks future days, and sends one day", async () => {
    const { AttendanceRequestForm } = await import("@/components/screens/request-forms");
    const calls = mockFetch({ "/rpc/get_session_context": () => ok(ctx("employee")), "/rpc/save_attendance_request": () => ok({ id: "r1" }) });
    wrap(<AttendanceRequestForm kind="comp_off" initialDate="2026-11-09" now={NOW} />);
    expect(await screen.findByRole("heading", { name: "Request comp-off" })).toBeInTheDocument();
    expect(screen.getByText(/6 hours or more earns a full day/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-11-20" } });
    await userEvent.type(screen.getByLabelText(/Reason/), "Year-end stock count");
    await userEvent.click(screen.getByRole("button", { name: "Send to HR" }));
    expect(screen.getByText("Choose a day you have already worked.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-11-09" } });
    await userEvent.click(screen.getByRole("button", { name: "Send to HR" }));
    expect(await screen.findByText(/added to your leave balance/)).toBeInTheDocument();
    expect(calls.find((c) => c.path === "/rpc/save_attendance_request")?.body).toMatchObject({ p_kind: "comp_off", p_start_date: "2026-11-09", p_end_date: null });
  });

  it("shows the server's reason on the date field", async () => {
    const { AttendanceRequestForm } = await import("@/components/screens/request-forms");
    const { fail } = await import("./helpers");
    mockFetch({
      "/rpc/get_session_context": () => ok(ctx("employee")),
      "/rpc/save_attendance_request": () => fail(422, "VALIDATION_FAILED", "Please check the request.", { start_date: "This was a working day. Comp-off is for working on a holiday or day off" }),
    });
    wrap(<AttendanceRequestForm kind="comp_off" initialDate="2026-11-10" now={NOW} />);
    await userEvent.type(await screen.findByLabelText(/Reason/), "Worked late");
    await userEvent.click(screen.getByRole("button", { name: "Send to HR" }));
    expect(await screen.findByText(/This was a working day/)).toBeInTheDocument();
  });

  it("is labelled, editable and reviewable like the other attendance requests", async () => {
    const { KIND_LABEL, REVIEW_KINDS, editHref, ownerActions } = await import("@/lib/requests");
    const { actionScopes } = await import("@/lib/menu");
    expect(KIND_LABEL.comp_off).toBe("Comp-off");
    expect(REVIEW_KINDS.map((k) => k.id)).toContain("comp_off");
    expect(editHref({ kind: "comp_off", id: "r9" })).toBe("/requests/new/comp-off?edit=r9");
    expect(ownerActions({ kind: "comp_off", state: "submitted" }, false).edit).toBe(true);
    expect(ownerActions({ kind: "comp_off", state: "approved" }, false).cancel).toBe(false);
    expect(actionScopes(caps(ctx("employee")))[0].items.some((i) => i.href === "/requests/new/comp-off")).toBe(true);
  });
});
