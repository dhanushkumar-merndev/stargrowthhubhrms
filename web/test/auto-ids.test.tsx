import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SWRConfig } from "swr";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MachinePeople } from "@/components/screens/devices";
import { hireDefaultsErrors, machineHireBody, machineHireName, machinePersonKey, type MachinePerson } from "@/lib/devices";
import { newEmployeeErrors, provisionPayload, type NewEmployeeForm } from "@/lib/people";
import { SessionProvider } from "@/lib/session";
import { ctx, fail, mockFetch, ok } from "./helpers";

function wrap(ui: React.ReactNode) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <SessionProvider>{ui}</SessionProvider>
    </SWRConfig>,
  );
}
afterEach(() => vi.unstubAllGlobals());

const NOW = new Date("2026-11-16T06:00:00Z");
const person = (over: Partial<MachinePerson> = {}): MachinePerson => ({
  serial: "SN1", pin: "31", name: "Ravi K", is_device_admin: false, device_label: "Front door", last_reported_at: null, punches: 2, ...over,
});
const structure = {
  departments: [],
  teams: [{ id: "t1", name: "Ops", active: true }],
  offices: [{ id: "o1", name: "HQ", active: true }],
  shifts: [{ id: "s1", name: "General", active: true }, { id: "s2", name: "Night", active: true }],
};
const form = (over: Partial<NewEmployeeForm> = {}): NewEmployeeForm => ({
  employee_code: "", full_name: "Meena S", join_date: "2026-11-16", team_id: "t1", office_id: "o1", shift_id: "s1", department_id: "",
  role: "member", designation: "", business_email: "", business_phone: "", device_pin: "", ...over,
});

describe("automatic employee IDs (form rules)", () => {
  it("an empty ID is fine and is not sent: the server generates it", () => {
    expect(newEmployeeErrors(form(), false)).toEqual({});
    expect(provisionPayload(form()).fields).not.toHaveProperty("employee_code");
    expect(provisionPayload(form({ employee_code: "   " })).fields).not.toHaveProperty("employee_code");
  });
  it("a typed ID (imports) is still checked and normalised", () => {
    expect(newEmployeeErrors(form({ employee_code: "a" }), false).employee_code).toMatch(/3–32/);
    expect(newEmployeeErrors(form({ employee_code: "bad code!" }), false).employee_code).toBeDefined();
    expect(provisionPayload(form({ employee_code: "emp 0950" })).fields.employee_code).toBe("EMP0950");
  });
});

describe("new from machine (rules)", () => {
  it("uses the machine name, cleaned, or a placeholder", () => {
    expect(machineHireName(person())).toBe("Ravi K");
    expect(machineHireName(person({ name: "  Priya \u0007  M  " }))).toBe("Priya M");
    expect(machineHireName(person({ name: null }))).toBe("Machine user 31");
    expect(machineHireName(person({ name: "X" }))).toBe("Machine user 31");
    expect(machineHireName(person({ name: "y".repeat(300) }))).toHaveLength(200);
  });
  it("keys are per machine and PIN", () => {
    expect(machinePersonKey(person())).not.toBe(machinePersonKey(person({ serial: "SN2" })));
  });
  it("defaults must be complete and the date real", () => {
    expect(hireDefaultsErrors({ team_id: "", office_id: "", shift_id: "", join_date: "2026-02-30x" })).toEqual({
      team_id: "Choose a team.", office_id: "Choose an office.", shift_id: "Choose a shift.", join_date: "Choose the join date.",
    });
    expect(hireDefaultsErrors({ team_id: "t", office_id: "o", shift_id: "s", join_date: "2026-11-16" })).toEqual({});
  });
  it("the hire keeps the machine PIN and sends no employee ID", () => {
    const b = machineHireBody(person(), { team_id: "t1", office_id: "o1", shift_id: "s1", join_date: "2026-11-16" }, "op-1");
    expect(b).toEqual({
      operation_id: "op-1",
      fields: { full_name: "Ravi K", join_date: "2026-11-16", team_id: "t1", office_id: "o1", shift_id: "s1", role: "member" },
      device_pin: "31",
      device_serial: "SN1",
    });
  });
});

describe("New from machine (screen)", () => {
  it("fetches from machines, adds selected people with automatic IDs and lists their passwords", async () => {
    const user = userEvent.setup();
    let listed = [person(), person({ pin: "32", name: "Meena", is_device_admin: true, punches: 1 })];
    let n = 0;
    const calls = mockFetch({
      "/rpc/get_session_context": () => ok(ctx("hr")),
      "/rpc/list_machine_people": () => ok(listed),
      "/rpc/list_org_structure": () => ok(structure),
      "/rpc/fetch_device_users": () => ok({ machines: 2, queued: 1 }),
      "/admin/users": () => {
        n += 1;
        listed = listed.slice(1);
        return ok({ employee_id: `e${n}`, employee_code: `EMP000${n}`, temporary_password: `Pw-${n}` });
      },
    });
    wrap(<MachinePeople now={NOW} />);
    expect(await screen.findByText("Ravi K")).toBeInTheDocument();
    expect(screen.getByText(/machine admin/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Fetch from machines" }));
    expect(await screen.findByText(/Asked 2 machines/)).toBeInTheDocument();

    // A single team and office are picked; the shift must be chosen.
    expect(screen.getByLabelText("Team")).toHaveValue("t1");
    await user.click(screen.getByLabelText("Select Ravi K"));
    await user.click(screen.getByRole("button", { name: "Add selected (1)" }));
    expect(screen.getByText("Choose a shift.")).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/admin/users")).toBe(false);

    await user.selectOptions(screen.getByLabelText("Shift"), "s2");
    await user.click(screen.getByRole("button", { name: "Add selected (1)" }));
    expect(await screen.findByText("1 of 1 added.")).toBeInTheDocument();
    const sent = calls.find((c) => c.path === "/admin/users")!.body as ReturnType<typeof machineHireBody>;
    expect(sent.fields).toMatchObject({ full_name: "Ravi K", shift_id: "s2", team_id: "t1", office_id: "o1", join_date: "2026-11-16" });
    expect(sent.fields).not.toHaveProperty("employee_code");
    expect(sent).toMatchObject({ device_pin: "31", device_serial: "SN1" });
    const added = screen.getByRole("list", { name: "Added people" });
    expect(within(added).getByText("EMP0001 · Pw-1")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByLabelText("Select Ravi K")).not.toBeInTheDocument());
  });

  it("Add all keeps going past one failure and stops at the employee limit", async () => {
    const user = userEvent.setup();
    const people = [person({ pin: "1", name: "Aa One" }), person({ pin: "2", name: "Bb Two" }), person({ pin: "3", name: "Cc Three" }), person({ pin: "4", name: "Dd Four" })];
    let n = 0;
    const calls = mockFetch({
      "/rpc/get_session_context": () => ok(ctx("admin")),
      "/rpc/list_machine_people": () => ok(people),
      "/rpc/list_org_structure": () => ok({ ...structure, shifts: [structure.shifts[0]] }),
      "/admin/users": () => {
        n += 1;
        if (n === 2) return fail(409, "CONFLICT", "This machine user is already linked to someone.");
        if (n === 3) return fail(422, "ACTIVE_EMPLOYEE_CAP_REACHED", "The active employee limit (3) is reached.");
        return ok({ employee_id: `e${n}`, employee_code: `EMP000${n}`, temporary_password: `Pw-${n}` });
      },
    });
    wrap(<MachinePeople now={NOW} />);
    await user.click(await screen.findByRole("button", { name: "Add all (4)" }));
    expect(await screen.findByText(/1 of 4 added/)).toBeInTheDocument();
    expect(calls.filter((c) => c.path === "/admin/users")).toHaveLength(3);
    expect(screen.getByText("This machine user is already linked to someone.")).toBeInTheDocument();
    expect(screen.getByText(/active employee limit/)).toBeInTheDocument();
  });

  it("shows an empty state, and errors with a retry", async () => {
    mockFetch({
      "/rpc/get_session_context": () => ok(ctx("hr")),
      "/rpc/list_machine_people": () => ok([]),
      "/rpc/list_org_structure": () => ok(structure),
    });
    wrap(<MachinePeople now={NOW} />);
    expect(await screen.findByText("Everyone is in the app")).toBeInTheDocument();
  });

  it("a failed fetch request is reported", async () => {
    const user = userEvent.setup();
    mockFetch({
      "/rpc/get_session_context": () => ok(ctx("hr")),
      "/rpc/list_machine_people": () => ok([person()]),
      "/rpc/list_org_structure": () => ok(structure),
      "/rpc/fetch_device_users": () => fail(403, "ACCESS_DENIED", "Not allowed."),
    });
    wrap(<MachinePeople now={NOW} />);
    await user.click(await screen.findByRole("button", { name: "Fetch from machines" }));
    expect(await screen.findByText("Not allowed.")).toBeInTheDocument();
  });
});
