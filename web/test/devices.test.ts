import { describe, expect, it, vi } from "vitest";
import {
  correctionErrors,
  countByStatus,
  deviceTab,
  deviceFormErrors,
  devicePayload,
  drift,
  formatLocal,
  isOnline,
  localTime,
  mergePunches,
  minutes,
  rejectionLabel,
  relative,
  sortPunches,
  suggestMatch,
  verifyLabel,
  windowError,
  type DeviceForm,
  type DevicePunch,
} from "@/lib/devices";
import { LiveClient } from "@/lib/live";

const punch = (id: string, received_at: string, over: Partial<DevicePunch> = {}): DevicePunch => ({
  id, serial: "SN1", device_label: "Door", pin: "7", employee: null, kind: "in", counted: true,
  device_time: received_at, device_local_time: "2026-11-14 09:00:00", received_at, verify_mode: 1, has_photo: false, ...over,
});

describe("device formatting", () => {
  it("shows machine wall time without shifting timezones", () => {
    expect(formatLocal("2026-11-11 10:02:03")).toBe("11 Nov, 10:02:03");
    expect(formatLocal("2026-01-01T00:00")).toBe("1 Jan, 00:00:00");
    expect(formatLocal("garbage")).toBe("—");
    expect(formatLocal(null)).toBe("—");
    expect(localTime("2026-11-11 23:59:59")).toBe("23:59:59");
    expect(localTime(undefined)).toBe("—");
  });

  it("verify modes, minutes and drift", () => {
    expect(verifyLabel(1)).toBe("Fingerprint");
    expect(verifyLabel(15)).toBe("Face");
    expect(verifyLabel(99)).toBe("Mode 99");
    expect(verifyLabel(null)).toBe("Unknown");
    expect(minutes(null)).toBe("—");
    expect(minutes(59.9)).toBe("59m");
    expect(minutes(125)).toBe("2h 05m");
    expect(minutes(-5)).toBe("0m");
    expect(drift(null)).toBe("—");
    expect(drift(3)).toBe("In sync");
    expect(drift(-42)).toBe("−42s");
    expect(drift(600)).toBe("+10 min");
  });

  it("relative times and online state", () => {
    const now = Date.parse("2026-11-14T10:00:00Z");
    expect(relative(null, now)).toBe("never");
    expect(relative("bad", now)).toBe("never");
    expect(relative("2026-11-14T09:59:58Z", now)).toBe("just now");
    expect(relative("2026-11-14T09:59:30Z", now)).toBe("30s ago");
    expect(relative("2026-11-14T09:00:00Z", now)).toBe("1h ago");
    expect(relative("2026-11-12T10:00:00Z", now)).toBe("2d ago");
    expect(isOnline({ active: true, last_seen_at: "2026-11-14T09:58:00Z" }, now)).toBe(true);
    expect(isOnline({ active: true, last_seen_at: "2026-11-14T09:56:00Z" }, now)).toBe(false);
    expect(isOnline({ active: false, last_seen_at: "2026-11-14T09:59:59Z" }, now)).toBe(false);
    expect(isOnline({ active: true, last_seen_at: null }, now)).toBe(false);
  });

  it("rejection codes read as plain words, unknown ones too", () => {
    expect(rejectionLabel("biometric_discarded")).toMatch(/never stored/);
    expect(rejectionLabel("photo_storage_off")).toMatch(/photo/i);
    expect(rejectionLabel("brand_new_code")).toBe("brand new code");
  });

  it("counts day rows by status", () => {
    expect(countByStatus([{ status: "in_office" }, { status: "in_office" }, { status: "absent" }])).toEqual({ in_office: 2, absent: 1 });
    expect(countByStatus([])).toEqual({});
  });
});

describe("tabs", () => {
  it("unknown or missing tabs open Today", () => {
    expect(deviceTab("live")).toBe("live");
    expect(deviceTab("staff")).toBe("staff");
    expect(deviceTab("admin")).toBe("today");
    expect(deviceTab(undefined)).toBe("today");
    expect(deviceTab(null)).toBe("today");
  });
});

describe("live feed merge", () => {
  it("sorts newest first with a stable id tie-break", () => {
    const l = sortPunches([punch("a", "2026-11-14T09:00:00Z"), punch("c", "2026-11-14T10:00:00Z"), punch("b", "2026-11-14T09:00:00Z")]);
    expect(l.map((p) => p.id)).toEqual(["c", "b", "a"]);
  });

  it("updates, adds, drops rows that no longer match, and caps the list", () => {
    const prev = [punch("a", "2026-11-14T09:00:00Z"), punch("b", "2026-11-14T09:01:00Z")];
    const next = mergePunches(prev, ["a", "b", "n"], [punch("a", "2026-11-14T09:00:00Z", { kind: "duplicate" }), punch("n", "2026-11-14T09:05:00Z")]);
    expect(next.map((p) => p.id)).toEqual(["n", "a"]);
    expect(next[1].kind).toBe("duplicate");
    const many = Array.from({ length: 5 }, (_, i) => punch(`p${i}`, `2026-11-14T09:0${i}:00Z`));
    expect(mergePunches(many, [], [], 3).map((p) => p.id)).toEqual(["p4", "p3", "p2"]);
  });
});

describe("name suggestions", () => {
  const people = [
    { id: "1", code: "E1", name: "Priya Menon" },
    { id: "2", code: "E2", name: "Priya Sharma" },
    { id: "3", code: "E3", name: "Arjun K" },
  ];
  it("suggests only one clear match", () => {
    expect(suggestMatch("ARJUN K.", people)?.id).toBe("3");
    expect(suggestMatch("Arjun", people)?.id).toBe("3");
    expect(suggestMatch("priya menon (night)", people)?.id).toBe("1");
    expect(suggestMatch("Priya", people)).toBeNull();
    expect(suggestMatch("Zed", people)).toBeNull();
    expect(suggestMatch("x", people)).toBeNull();
    expect(suggestMatch(null, people)).toBeNull();
  });
});

describe("forms", () => {
  const base: DeviceForm = { serial: "ckjb12", label: " Front door ", officeId: "", mode: "http", active: true, token: "", tokenAction: "keep" };
  it("validates a new machine", () => {
    expect(deviceFormErrors(base, false)).toEqual({});
    expect(deviceFormErrors({ ...base, serial: "ab" }, false).serial).toBeTruthy();
    expect(deviceFormErrors({ ...base, serial: "bad serial!" }, false).serial).toBeTruthy();
    expect(deviceFormErrors({ ...base, serial: "" }, true)).toEqual({});
    expect(deviceFormErrors({ ...base, label: "  " }, false).label).toBeTruthy();
    expect(deviceFormErrors({ ...base, label: "x".repeat(81) }, false).label).toBeTruthy();
    expect(deviceFormErrors({ ...base, tokenAction: "set", token: "short" }, false).token).toBeTruthy();
    expect(deviceFormErrors({ ...base, tokenAction: "set", token: "x".repeat(16) }, false)).toEqual({});
  });
  it("builds the payload: upper-case serial on create, id on edit, token actions", () => {
    expect(devicePayload(base)).toEqual({ serial: "CKJB12", label: "Front door", office_id: null, mode: "http", active: true });
    const edit = devicePayload({ ...base, officeId: "o1", tokenAction: "remove" }, "d1");
    expect(edit).toEqual({ id: "d1", label: "Front door", office_id: "o1", mode: "http", active: true, token: "" });
    expect(devicePayload({ ...base, tokenAction: "set", token: "t".repeat(16) }, "d1").token).toBe("t".repeat(16));
  });
  it("correction and window rules match the database", () => {
    expect(correctionErrors("18:30", "Forgot", false)).toEqual({});
    expect(correctionErrors("", "Forgot", false).outTime).toBeTruthy();
    expect(correctionErrors("24:00", "Forgot", false).outTime).toBeTruthy();
    expect(correctionErrors("", "Wrong time", true)).toEqual({});
    expect(correctionErrors("18:30", " ab ", false).reason).toBeTruthy();
    expect(correctionErrors("18:30", "x".repeat(301), false).reason).toBeTruthy();
    expect(windowError("10")).toBeNull();
    for (const bad of ["0", "61", "1.5", "", "ten"]) expect(windowError(bad)).toBeTruthy();
  });
});

// ---------------------------------------------------------------- LiveClient

class FakeSource {
  static all: FakeSource[] = [];
  readyState = 0;
  onopen: ((ev: Event) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  listeners = new Map<string, ((ev: MessageEvent) => void)[]>();
  closed = false;
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeSource.all.push(this);
  }
  addEventListener(type: string, fn: (ev: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  open() {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }
  emit(kind: string, data: unknown) {
    (this.listeners.get(kind) ?? []).forEach((fn) => fn(new MessageEvent(kind, { data: typeof data === "string" ? data : JSON.stringify(data) })));
  }
  fail(closed: boolean) {
    this.readyState = closed ? 2 : 0;
    this.onerror?.(new Event("error"));
  }
}

describe("LiveClient", () => {
  const setup = () => {
    FakeSource.all = [];
    const timers: { fn: () => void; ms: number }[] = [];
    const c = new LiveClient(
      (url) => new FakeSource(url),
      (fn, ms) => {
        timers.push({ fn, ms });
        return 0 as unknown as ReturnType<typeof setTimeout>;
      },
    );
    return { c, timers };
  };

  it("shares one connection, routes by kind and drops duplicates and junk", () => {
    const { c } = setup();
    const a = vi.fn();
    const b = vi.fn();
    const conn: string[] = [];
    c.onConn((s) => conn.push(s));
    c.subscribe(["device.punch"], a);
    c.subscribe(["device.command", "device.punch"], b);
    expect(FakeSource.all).toHaveLength(1);
    expect(FakeSource.all[0].url).toBe("/api/v1/live");
    const s = FakeSource.all[0];
    s.open();
    s.emit("device.punch", { id: 1, kind: "device.punch", payload: { id: "p1" } });
    s.emit("device.punch", { id: 1, kind: "device.punch", payload: { id: "p1" } }); // duplicate
    s.emit("device.command", { id: 2, kind: "device.command", payload: {} });
    s.emit("device.punch", "not json");
    s.emit("device.punch", { kind: "device.punch" }); // no id
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
    expect(conn).toEqual(["connecting", "live"]);
  });

  it("lets the browser retry transient errors, then resumes after the last id with backoff", () => {
    const { c, timers } = setup();
    const conn: string[] = [];
    c.onConn((s) => conn.push(s));
    c.subscribe(["device.punch"], vi.fn());
    const s1 = FakeSource.all[0];
    s1.open();
    s1.emit("device.punch", { id: 41, kind: "device.punch", payload: {} });
    s1.fail(false); // EventSource reconnects by itself
    expect(timers).toHaveLength(0);
    s1.fail(true); // it gave up
    expect(timers.map((t) => t.ms)).toEqual([1000]);
    timers[0].fn();
    expect(FakeSource.all).toHaveLength(2);
    expect(FakeSource.all[1].url).toBe("/api/v1/live?after=41");
    FakeSource.all[1].fail(true);
    expect(timers.map((t) => t.ms)).toEqual([1000, 2000]);
    // events from a stale source are ignored
    const late = vi.fn();
    c.subscribe(["device.punch"], late);
    s1.emit("device.punch", { id: 99, kind: "device.punch", payload: {} });
    expect(late).not.toHaveBeenCalled();
    expect(conn).toContain("offline");
  });

  it("closes the connection when the last listener leaves, and reopens fresh", () => {
    const { c } = setup();
    const off1 = c.subscribe(["device.punch"], vi.fn());
    const off2 = c.subscribe(["device.day"], vi.fn());
    off1();
    expect(FakeSource.all[0].closed).toBe(false);
    off2();
    expect(FakeSource.all[0].closed).toBe(true);
    c.subscribe(["notification.new"], vi.fn());
    expect(FakeSource.all).toHaveLength(2);
    expect(FakeSource.all[1].listeners.has("notification.new")).toBe(true);
    expect(FakeSource.all[1].listeners.has("device.punch")).toBe(false);
  });

  it("adds listeners for new kinds on an open connection", () => {
    const { c } = setup();
    c.subscribe(["device.punch"], vi.fn());
    const fn = vi.fn();
    c.subscribe(["device.command"], fn);
    FakeSource.all[0].emit("device.command", { id: 5, kind: "device.command", payload: {} });
    expect(fn).toHaveBeenCalledOnce();
    expect(FakeSource.all).toHaveLength(1);
  });
});
