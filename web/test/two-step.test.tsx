import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SWRConfig } from "swr";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoginForm } from "@/components/screens/login-form";
import { TwoStepAdmin } from "@/components/screens/employees";
import { TwoStepNudge, TwoStepSettings, codesText, groupKey, svgDataUrl } from "@/components/screens/two-step";
import { SessionProvider } from "@/lib/session";
import { ctx, fail, mockFetch, ok } from "./helpers";

function wrap(ui: React.ReactNode, initialPhase: "loading" | "signedOut" = "loading") {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <SessionProvider initialPhase={initialPhase}>{ui}</SessionProvider>
    </SWRConfig>,
  );
}
afterEach(() => vi.unstubAllGlobals());

const CODES = ["K7QM-2XRP", "AB23-CD45", "EF67-GH89", "JK23-MN45", "PQ67-RS89", "TU23-VW45", "XY67-ZA89", "BC23-DE45", "FG67-HJ89", "KM23-NP45"];

describe("helpers", () => {
  it("groups the key, builds a data URL and the saved text", () => {
    expect(groupKey("ABCDEFGHIJKLMNOP")).toBe("ABCD EFGH IJKL MNOP");
    expect(groupKey("ABCDEF")).toBe("ABCD EF");
    expect(groupKey("")).toBe("");
    expect(svgDataUrl("<svg a='1'>#</svg>")).toBe("data:image/svg+xml;charset=utf-8,%3Csvg%20a%3D'1'%3E%23%3C%2Fsvg%3E");
    expect(codesText(["A", "B"])).toContain("Each code works once.");
    expect(codesText(["A", "B"]).endsWith("A\nB\n")).toBe(true);
  });
});

describe("sign-in with two-step", () => {
  function routes(over: Record<string, (b: unknown) => [number, unknown]> = {}) {
    let signedIn = false;
    const calls = mockFetch({
      "/rpc/get_session_context": () => (signedIn ? ok(ctx("hr")) : fail(401, "AUTH_REQUIRED")),
      "/auth/login": () => ok({ two_step_required: true, challenge: "C".repeat(43) }),
      "/auth/login/two-step": (b) => {
        const code = (b as { code: string }).code.replace(/\s/g, "");
        if (code === "123456" || code === "k7qm-2xrp") {
          signedIn = true;
          return ok({ must_change_password: false, credential_hold: false });
        }
        return fail(422, "INVALID_CODE", "That code is not right. Try the newest code in your app.");
      },
      ...over,
    });
    return calls;
  }
  const signIn = async () => {
    await userEvent.type(await screen.findByLabelText("Employee ID"), "EMP001");
    await userEvent.type(screen.getByLabelText("Password"), "right-password");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
  };

  it("asks for the code after the password and then signs in", async () => {
    const calls = routes();
    wrap(<LoginForm />, "signedOut");
    await signIn();
    expect(await screen.findByRole("heading", { name: "Two-step sign-in" })).toBeInTheDocument();
    const code = screen.getByLabelText("6-digit code");
    expect(code).toHaveAttribute("autocomplete", "one-time-code");
    expect(code).toHaveAttribute("inputmode", "numeric");
    // Local check before sending.
    await userEvent.type(code, "12");
    await userEvent.click(screen.getByRole("button", { name: "Verify" }));
    expect(screen.getByText("Enter the 6-digit code from your authenticator app.")).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/auth/login/two-step")).toBe(false);
    // Wrong, then right.
    await userEvent.clear(code);
    await userEvent.type(code, "654321");
    await userEvent.click(screen.getByRole("button", { name: "Verify" }));
    expect(await screen.findByText(/That code is not right/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("6-digit code"), "123 456");
    await userEvent.click(screen.getByRole("button", { name: "Verify" }));
    await waitFor(() => expect(calls.filter((c) => c.path === "/rpc/get_session_context").length).toBeGreaterThan(0));
    const sent = calls.filter((c) => c.path === "/auth/login/two-step").map((c) => c.body);
    expect(sent.at(-1)).toEqual({ challenge: "C".repeat(43), code: "123 456" });
  });

  it("accepts a recovery code instead", async () => {
    routes();
    wrap(<LoginForm />, "signedOut");
    await signIn();
    await userEvent.click(await screen.findByRole("button", { name: "Use a recovery code" }));
    const box = screen.getByLabelText("Recovery code");
    await userEvent.type(box, "123456");
    await userEvent.click(screen.getByRole("button", { name: "Verify" }));
    expect(screen.getByText(/Enter one of your recovery codes/)).toBeInTheDocument();
    await userEvent.clear(box);
    await userEvent.type(box, "k7qm-2xrp");
    await userEvent.click(screen.getByRole("button", { name: "Verify" }));
    await waitFor(() => expect(screen.queryByText(/Enter one of your recovery codes/)).toBeNull());
  });

  it("an expired challenge goes back to the password with the reason", async () => {
    routes({ "/auth/login/two-step": () => fail(401, "CHALLENGE_EXPIRED", "This sign-in has expired. Enter your password again.") });
    wrap(<LoginForm />, "signedOut");
    await signIn();
    await userEvent.type(await screen.findByLabelText("6-digit code"), "111111");
    await userEvent.click(screen.getByRole("button", { name: "Verify" }));
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.getByText("This sign-in has expired. Enter your password again.")).toBeInTheDocument();
  });

  it("start over returns to the password step", async () => {
    routes();
    wrap(<LoginForm />, "signedOut");
    await signIn();
    await userEvent.click(await screen.findByRole("button", { name: "Start over" }));
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toHaveValue("");
  });

  it("accounts without two-step sign in directly", async () => {
    let signedIn = false;
    const calls = mockFetch({
      "/rpc/get_session_context": () => (signedIn ? ok(ctx("employee")) : fail(401, "AUTH_REQUIRED")),
      "/auth/login": () => ((signedIn = true), ok({ must_change_password: false, credential_hold: false })),
    });
    wrap(<LoginForm />, "signedOut");
    await signIn();
    await waitFor(() => expect(calls.filter((c) => c.path === "/rpc/get_session_context").length).toBeGreaterThan(0));
    expect(screen.queryByRole("heading", { name: "Two-step sign-in" })).toBeNull();
  });
});

describe("TwoStepSettings", () => {
  it("turns on: password, scan, code, then recovery codes that must be saved", async () => {
    let enabled = false;
    const calls = mockFetch({
      "/rpc/get_session_context": () => ok(ctx("hr")),
      "/rpc/get_two_step_status": () => ok({ enabled, enabled_at: enabled ? "2026-11-14T06:00:00Z" : null, recovery_left: enabled ? 10 : 0, recommended: true }),
      "/auth/two-step/setup": (b) => ((b as { password: string }).password === "pw" ? ok({ secret: "ABCDEFGHIJKLMNOP", uri: "otpauth://totp/HRMS:EMP001?secret=ABCDEFGHIJKLMNOP", qr_svg: "<svg></svg>" }) : fail(403, "REAUTH_REQUIRED", "Password is incorrect.", { password: "Incorrect" })),
      "/auth/two-step/enable": () => ((enabled = true), ok({ recovery_codes: CODES })),
    });
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    wrap(<TwoStepSettings />);
    expect(await screen.findByText(/You can see and change other people/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Turn on two-step sign-in" }));
    await userEvent.type(screen.getByLabelText("Your password"), "bad");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("Incorrect")).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText("Your password"));
    await userEvent.type(screen.getByLabelText("Your password"), "pw");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    const qr = await screen.findByRole("img", { name: "QR code for your authenticator app" });
    expect(qr.getAttribute("src")).toMatch(/^data:image\/svg\+xml/);
    expect(screen.getByText("ABCD EFGH IJKL MNOP")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open in your authenticator app/ })).toHaveAttribute("href", "otpauth://totp/HRMS:EMP001?secret=ABCDEFGHIJKLMNOP");
    await userEvent.type(screen.getByLabelText("6-digit code"), "12a");
    await userEvent.click(screen.getByRole("button", { name: "Turn on" }));
    expect(screen.getByText("Enter the 6-digit code shown in the app.")).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText("6-digit code"));
    await userEvent.type(screen.getByLabelText("6-digit code"), "123456");
    await userEvent.click(screen.getByRole("button", { name: "Turn on" }));
    const list = await screen.findByRole("list", { name: "Recovery codes" });
    expect(list.querySelectorAll("li")).toHaveLength(10);
    expect(screen.getByRole("link", { name: "Download" })).toHaveAttribute("download", "hrms-recovery-codes.txt");
    await userEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith(CODES.join("\n"));
    const done = screen.getByRole("button", { name: "Done" });
    expect(done).toBeDisabled();
    await userEvent.click(screen.getByLabelText("I have saved my recovery codes"));
    await userEvent.click(done);
    expect(await screen.findByText("Two-step sign-in is on.")).toBeInTheDocument();
    expect(calls.find((c) => c.path === "/auth/two-step/enable")?.body).toEqual({ code: "123456" });
  });

  it("turns off with password and code; warns when few codes are left", async () => {
    let enabled = true;
    const calls = mockFetch({
      "/rpc/get_session_context": () => ok(ctx("admin")),
      "/rpc/get_two_step_status": () => ok({ enabled, enabled_at: "2026-11-01T06:00:00Z", recovery_left: 2, recommended: true }),
      "/auth/two-step/disable": () => ((enabled = false), ok({ enabled: false })),
    });
    wrap(<TwoStepSettings />);
    expect(await screen.findByText(/2 recovery codes left/)).toBeInTheDocument();
    expect(screen.getByText(/running low on recovery codes/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Turn off" }));
    const submit = screen.getByRole("button", { name: "Turn off" });
    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Your password"), "pw");
    await userEvent.type(screen.getByLabelText(/Code from your app/), "654321");
    await userEvent.click(submit);
    expect(await screen.findByText("Two-step sign-in is off.")).toBeInTheDocument();
    expect(calls.find((c) => c.path === "/auth/two-step/disable")?.body).toEqual({ password: "pw", code: "654321" });
  });

  it("gets new recovery codes", async () => {
    mockFetch({
      "/rpc/get_session_context": () => ok(ctx("admin")),
      "/rpc/get_two_step_status": () => ok({ enabled: true, enabled_at: null, recovery_left: 10, recommended: true }),
      "/auth/two-step/recovery": () => ok({ recovery_codes: CODES }),
    });
    wrap(<TwoStepSettings />);
    await userEvent.click(await screen.findByRole("button", { name: "Get new recovery codes" }));
    expect(screen.getByText("Your old recovery codes will stop working.")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Your password"), "pw");
    await userEvent.type(screen.getByLabelText(/Code from your app/), "K7QM-2XRP");
    await userEvent.click(screen.getByRole("button", { name: "Get new codes" }));
    expect(await screen.findByRole("list", { name: "Recovery codes" })).toBeInTheDocument();
  });

  it("employees see no warning", async () => {
    mockFetch({ "/rpc/get_session_context": () => ok(ctx("employee")), "/rpc/get_two_step_status": () => ok({ enabled: false, enabled_at: null, recovery_left: 0, recommended: false }) });
    wrap(<TwoStepSettings />);
    await screen.findByRole("button", { name: "Turn on two-step sign-in" });
    expect(screen.queryByText(/You can see and change other people/)).toBeNull();
  });
});

describe("TwoStepNudge", () => {
  it("shows only when recommended and off", async () => {
    mockFetch({ "/rpc/get_session_context": () => ok(ctx("hr")), "/rpc/get_two_step_status": () => ok({ enabled: false, recommended: true, recovery_left: 0, enabled_at: null }) });
    const a = wrap(<TwoStepNudge />);
    expect(await screen.findByRole("link", { name: /turn on two-step sign-in/ })).toHaveAttribute("href", "/settings/two-step");
    a.unmount();
    mockFetch({ "/rpc/get_session_context": () => ok(ctx("hr")), "/rpc/get_two_step_status": () => ok({ enabled: true, recommended: true, recovery_left: 10, enabled_at: null }) });
    const b = wrap(<TwoStepNudge />);
    await new Promise((r) => setTimeout(r, 50));
    expect(b.container).toBeEmptyDOMElement();
  });
});

describe("TwoStepAdmin", () => {
  it("Admin sees the status and turns it off after confirming", async () => {
    let enabled = true;
    const calls = mockFetch({
      "/rpc/get_session_context": () => ok(ctx("admin")),
      "/rpc/get_employee_two_step": () => ok({ enabled }),
      "/rpc/reset_two_step": () => ((enabled = false), ok({ reset: true })),
    });
    wrap(<TwoStepAdmin id="e9" />);
    await userEvent.click(await screen.findByRole("button", { name: "Turn off two-step sign-in" }));
    expect(screen.getByText(/lost their phone and recovery codes/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Turn off" }));
    expect(await screen.findByText(/They can sign in with their password/)).toBeInTheDocument();
    expect(calls.find((c) => c.path === "/rpc/reset_two_step")?.body).toEqual({ p_employee_id: "e9" });
    await waitFor(() => expect(screen.getByText("Off")).toBeInTheDocument());
  });

  it("is hidden from HR", async () => {
    const calls = mockFetch({ "/rpc/get_session_context": () => ok(ctx("hr")) });
    const r = wrap(<TwoStepAdmin id="e9" />);
    await new Promise((res) => setTimeout(res, 50));
    expect(r.container).toBeEmptyDOMElement();
    expect(calls.some((c) => c.path === "/rpc/get_employee_two_step")).toBe(false);
    fireEvent.click(document.body);
  });
});
