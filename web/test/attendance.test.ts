import { describe, expect, it } from "vitest";
import {
  addDays,
  blockedText,
  clock,
  correctionErrors,
  correctionInstants,
  dayLabel,
  dayStatus,
  duration,
  leaveSlotLabel,
  monthRange,
  sourceLabel,
  todayIn,
  zonedIso,
} from "@/lib/attendance";
import { csvCell, reportCsv } from "@/components/screens/hours-report";

describe("dayStatus", () => {
  const s = (status: string, extra: { effective_source?: string | null; is_late?: boolean } = {}) =>
    dayStatus({ status, effective_source: extra.effective_source ?? null, is_late: extra.is_late ?? false });

  it("labels every status in words with a tone", () => {
    expect(s("present")).toEqual({ label: "Present", tone: "success" });
    expect(s("present", { is_late: true })).toEqual({ label: "Present · late", tone: "warning" });
    expect(s("present", { effective_source: "wfh" }).label).toBe("Work from home");
    expect(s("present", { effective_source: "outside" }).label).toBe("Outside work");
    expect(s("upcoming", { effective_source: "wfh" })).toEqual({ label: "Work from home", tone: "info" });
    expect(s("upcoming").label).toBe("Upcoming");
    expect(s("absent").tone).toBe("error");
    expect(s("needs_correction").label).toBe("Needs correction");
    expect(s("in_progress").label).toBe("In progress");
    expect(s("not_yet_in").tone).toBe("warning");
    for (const k of ["leave", "holiday", "weekly_off", "day_off"]) expect(s(k).label).not.toBe(k);
  });

  it("falls back to the raw status (or a dash) for unknown values", () => {
    expect(s("brand_new").label).toBe("brand_new");
    expect(s("").label).toBe("—");
  });

  it("source and leave labels", () => {
    expect(sourceLabel("manual")).toMatch(/correction/);
    expect(sourceLabel(null)).toBe("Location verified");
    expect(leaveSlotLabel(1)).toBe("AM leave");
    expect(leaveSlotLabel(3)).toBe("Full-day leave");
    expect(leaveSlotLabel(0)).toBe("");
  });
});

describe("formatting", () => {
  it("durations", () => {
    expect(duration(0)).toBe("0m");
    expect(duration(59)).toBe("0m"); // worked time is never rounded up
    expect(duration(45 * 60)).toBe("45m");
    expect(duration(7 * 3600 + 5 * 60)).toBe("7h 05m");
    expect(duration(-3600)).toBe("1h 00m");
    expect(duration(null)).toBe("0m");
  });

  it("clock times are shown in the shift's timezone", () => {
    expect(clock("2026-11-14T04:28:00Z", "Asia/Kolkata")).toBe("9:58 AM");
    expect(clock("2026-11-14T04:28:00Z", "UTC")).toBe("4:28 AM");
    expect(clock(null, "UTC")).toBe("—");
    expect(clock("not a date", "UTC")).toBe("—");
  });

  it("calendar labels never shift by timezone", () => {
    expect(dayLabel("2026-11-14")).toMatch(/Sat.*14.*Nov/);
    expect(dayLabel("2026-01-01")).toMatch(/Thu.*1.*Jan/);
    expect(dayLabel("")).toBe("");
    expect(dayLabel("garbage")).toBe("");
  });

  it("month ranges, including year ends and leap years", () => {
    expect(monthRange("2026-11-14")).toMatchObject({ from: "2026-11-01", to: "2026-11-30" });
    expect(monthRange("2026-01-10", -1)).toMatchObject({ from: "2025-12-01", to: "2025-12-31" });
    expect(monthRange("2028-02-10")).toMatchObject({ from: "2028-02-01", to: "2028-02-29" });
    expect(monthRange("2026-12-31", 1)).toMatchObject({ from: "2027-01-01", to: "2027-01-31" });
    expect(monthRange("2026-11-14").label).toMatch(/November 2026/);
  });

  it("today is computed in the organisation's timezone", () => {
    const late = new Date("2026-11-13T20:00:00Z");
    expect(todayIn("Asia/Kolkata", late)).toBe("2026-11-14");
    expect(todayIn("UTC", late)).toBe("2026-11-13");
    expect(todayIn("America/Los_Angeles", late)).toBe("2026-11-13");
  });

  it("adds days across month and year ends", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
});

describe("blockedText", () => {
  it("explains every reason in plain words", () => {
    expect(blockedText(null)).toBeNull();
    expect(blockedText(undefined)).toBeNull();
    for (const r of ["outside_work", "work_from_home", "on_leave", "holiday", "weekly_off", "day_off", "no_office", "window_closed", "completed", "needs_correction", "x"])
      expect(blockedText(r)).toMatch(/\w/);
    expect(blockedText("not_open_yet", { checkin_opens_at: "2026-11-14T04:00:00Z", timezone: "Asia/Kolkata" })).toBe(
      "Check-in opens at 9:30 AM.",
    );
    expect(blockedText("not_open_yet", null)).toBe("Check-in is not open yet.");
  });
});

describe("corrections", () => {
  const ok = { date: "2026-11-13", inTime: "09:30", outTime: "18:30", reason: "Forgot to punch out" };

  it("accepts a complete request", () => {
    expect(correctionErrors(ok, "2026-11-14")).toEqual({});
  });

  it("refuses future days, missing times, equal times and short or long reasons", () => {
    expect(correctionErrors({ ...ok, date: "2026-11-15" }, "2026-11-14").date).toBeTruthy();
    expect(correctionErrors({ ...ok, date: "" }, "2026-11-14").date).toBeTruthy();
    expect(correctionErrors({ ...ok, inTime: "" }, "2026-11-14").inTime).toBeTruthy();
    expect(correctionErrors({ ...ok, outTime: "9:30" }, "2026-11-14").outTime).toBeTruthy();
    expect(correctionErrors({ ...ok, outTime: "09:30" }, "2026-11-14").outTime).toMatch(/differ/);
    expect(correctionErrors({ ...ok, reason: "   ok  " }, "2026-11-14").reason).toBeTruthy();
    expect(correctionErrors({ ...ok, reason: "x".repeat(501) }, "2026-11-14").reason).toBeTruthy();
    expect(correctionErrors({ ...ok, date: "2026-11-14" }, "2026-11-14")).toEqual({});
  });

  it("converts local times to instants in the organisation's timezone", () => {
    expect(zonedIso("2026-11-13", "09:30", "Asia/Kolkata")).toBe("2026-11-13T04:00:00.000Z");
    expect(zonedIso("2026-11-13", "00:15", "Asia/Kolkata")).toBe("2026-11-12T18:45:00.000Z");
    // across a DST change (New York, 2026-03-08): before and after the jump
    expect(zonedIso("2026-03-07", "12:00", "America/New_York")).toBe("2026-03-07T17:00:00.000Z");
    expect(zonedIso("2026-03-09", "12:00", "America/New_York")).toBe("2026-03-09T16:00:00.000Z");
  });

  it("an earlier check-out is the next day (night shift)", () => {
    const n = correctionInstants("2026-11-13", "22:00", "07:00", "Asia/Kolkata");
    expect(n.overnight).toBe(true);
    expect(n.inAt).toBe("2026-11-13T16:30:00.000Z");
    expect(n.outAt).toBe("2026-11-14T01:30:00.000Z");
    expect(correctionInstants("2026-11-13", "09:00", "18:00", "Asia/Kolkata").overnight).toBe(false);
  });
});

describe("hours CSV", () => {
  it("neutralises formulas and quotes separators", () => {
    expect(csvCell("=HYPERLINK(\"x\")")).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("-1")).toBe("'-1");
    expect(csvCell("@a")).toBe("'@a");
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell("line\nbreak")).toBe('"line\nbreak"');
    expect(csvCell(null)).toBe("");
    expect(csvCell(3)).toBe("3");
  });

  it("writes one row per person with hours to 2 decimals", () => {
    const csv = reportCsv([
      {
        employee: { id: "1", code: "EMP001", name: "Rao, Asha", status: "active" },
        totals: {
          present_days: 20, late_days: 2, absent_days: 1, leave_days: 1, credited_seconds: 5400, required_seconds: 7200,
          shortfall_seconds: 1800, extra_seconds: 0, unresolved_days: 0,
        },
      },
    ]);
    const lines = csv.trimEnd().split("\r\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^Employee code,Name/);
    expect(lines[1]).toBe('EMP001,"Rao, Asha",20,2,1,1,1.50,2.00,0.50');
  });
});
