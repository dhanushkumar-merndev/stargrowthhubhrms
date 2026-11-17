import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SWRConfig } from "swr";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Directory, ProfileScreen } from "@/components/screens/people";
import { BankDetails, Documents, Payslips, PayrollUploads } from "@/components/screens/payroll";
import { SessionProvider } from "@/lib/session";
import { ctx, fail, mockFetch, ok } from "./helpers";

function wrap(ui: React.ReactNode) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <SessionProvider>{ui}</SessionProvider>
    </SWRConfig>,
  );
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const NOW = new Date("2026-11-14T06:00:00Z");
const pdf = (name = "a.pdf") => new File(["%PDF-1.4"], name, { type: "application/pdf" });
const session = (role: "employee" | "hr" | "admin" = "employee") => ({ "/rpc/get_session_context": () => ok(ctx(role)) });

const priv = { personal_email: null, personal_phone: "98765 43210", address: null, emergency_contact_name: null, emergency_contact_phone: null, date_of_birth: null, version: 4 };
const profile = (over: Record<string, unknown> = {}) => ({
  id: "e1", code: "EMP001", name: "Asha Rao", designation: "Engineer", position_label: "member", role: "employee", roles: [], status: "active",
  join_date: "2026-10-01", end_date: null, business_email: "asha@acme.test", business_phone: null, avatar_file_version_id: null,
  department: null, team: { id: "t1", name: "Management" }, office: { id: "o1", name: "Bengaluru HQ" }, manager: null,
  shift: { id: "s1", name: "General", start_local: "10:00:00", end_local: "19:00:00", weekly_mask: 31 },
  private: priv, profile_request: null, version: 3, ...over,
});

describe("My profile", () => {
  it("shows work details with the shift days", async () => {
    mockFetch({ ...session(), "/rpc/get_my_profile": () => ok(profile()) });
    wrap(<ProfileScreen now={NOW} />);
    expect(await screen.findByText("Bengaluru HQ")).toBeInTheDocument();
    expect(screen.getByText("Mon, Tue, Wed, Thu, Fri")).toBeInTheDocument();
    expect(screen.getByText("General · 10:00–19:00")).toBeInTheDocument();
    expect(screen.getByText("Visible only to you, HR and Admin.")).toBeInTheDocument();
    expect(screen.getByText("Ask HR or Admin to change your work details.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/settings");
    expect(screen.getByText("98765 43210")).toBeInTheDocument();
  });

  it("an open change request is linked and edited in place", async () => {
    mockFetch({ ...session(), "/rpc/get_my_profile": () => ok(profile({ profile_request: { id: "r9", state: "submitted", version: 2 } })) });
    wrap(<ProfileScreen now={NOW} />);
    expect(await screen.findByRole("link", { name: "View request" })).toHaveAttribute("href", "/requests/r9");
    expect(screen.getByText(/The approved details below stay active until approval/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit request" })).toBeInTheDocument();
  });

  it("sends only the changed fields once, and checks them first", async () => {
    const user = userEvent.setup();
    const calls = mockFetch({ ...session(), "/rpc/get_my_profile": () => ok(profile()), "/rpc/save_profile_details_request": () => ok({ id: "r1" }) });
    wrap(<ProfileScreen now={NOW} />);
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    await user.click(screen.getByRole("button", { name: "Send to HR" }));
    expect(await screen.findByText("Nothing changed.")).toBeInTheDocument();
    const email = screen.getByLabelText("Personal email");
    await user.type(email, "not-an-email");
    await user.click(screen.getByRole("button", { name: "Send to HR" }));
    expect(calls.some((c) => c.path === "/rpc/save_profile_details_request")).toBe(false);
    await user.clear(email);
    await user.type(email, "asha@home.test");
    await user.click(screen.getByRole("button", { name: "Send to HR" }));
    expect(await screen.findByText("Change request sent to HR.")).toBeInTheDocument();
    const sent = calls.filter((c) => c.path === "/rpc/save_profile_details_request");
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toMatchObject({ p_request_id: null, p_patch: { personal_email: "asha@home.test" }, p_expected_private_version: 4 });
    expect(Object.keys((sent[0].body as { p_patch: object }).p_patch)).toEqual(["personal_email"]);
  });

  it("a stale version asks to reload", async () => {
    const user = userEvent.setup();
    mockFetch({ ...session(), "/rpc/get_my_profile": () => ok(profile()), "/rpc/save_profile_details_request": () => fail(409, "STALE_VERSION") });
    wrap(<ProfileScreen now={NOW} />);
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    await user.type(screen.getByLabelText("Address"), "12 MG Road");
    await user.click(screen.getByRole("button", { name: "Send to HR" }));
    expect(await screen.findByText(/changed since you opened this/)).toBeInTheDocument();
  });

  it("photo: rejects a PDF, uploads an image as an avatar and publishes it", async () => {
    const user = userEvent.setup({ applyAccept: false });
    const calls = mockFetch({ ...session(), "/rpc/get_my_profile": () => ok(profile()), "/files": () => ok({ file_version_id: "av1" }), "/rpc/publish_document": () => ok({}) });
    wrap(<ProfileScreen now={NOW} />);
    await user.click(await screen.findByRole("button", { name: "Add photo" }));
    const dialog = screen.getByRole("dialog", { name: "Profile photo" });
    const input = within(dialog).getByLabelText("Photo");
    await user.upload(input, pdf());
    expect(within(dialog).getByText("Use a JPG, PNG or WebP image.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Save photo" })).toBeDisabled();
    await user.upload(input, new File(["png"], "me.png", { type: "image/png" }));
    expect(within(dialog).getByAltText("New photo preview")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Save photo" }));
    expect(await screen.findByText("Photo updated.")).toBeInTheDocument();
    const up = calls.find((c) => c.path === "/files")!;
    expect(up.query.get("class")).toBe("avatar");
    expect(up.query.get("owner_employee_id")).toBe("e1");
    expect(calls.find((c) => c.path === "/rpc/publish_document")!.body).toEqual({ p_file_version_id: "av1" });
  });
});

describe("Directory", () => {
  const row = (i: number) => ({ id: `p${i}`, code: `E${i}`, name: `Person ${i}`, designation: null, position_label: "member", role: i === 1 ? "hr" : "employee", business_email: i === 1 ? "hr@acme.test" : null, business_phone: i === 1 ? "+91 80 1234" : null, avatar_file_version_id: null, department: null, team: { id: "t1", name: "Ops" } });
  const structure = { departments: [], teams: [{ id: "t1", name: "Ops", active: true }, { id: "t2", name: "Old", active: false }], offices: [], shifts: [] };

  it("lists people with contact links, hides inactive teams and pages", async () => {
    const user = userEvent.setup();
    const calls = mockFetch({
      ...session(),
      "/rpc/list_org_structure": () => ok(structure),
      "/rpc/list_directory": (b) => ok({ rows: [row(1), row(2)], total: 30, limit: 25, offset: (b as { p_offset: number }).p_offset }),
    });
    wrap(<Directory />);
    expect(await screen.findByText("Person 1")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Email" })).toHaveAttribute("href", "mailto:hr@acme.test");
    expect(screen.getByRole("link", { name: "Call" })).toHaveAttribute("href", "tel:+91801234");
    expect(screen.queryByRole("option", { name: "Old" })).not.toBeInTheDocument();
    expect(screen.getByText("1–25 of 30")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/rpc/list_directory" && (c.body as { p_offset: number }).p_offset === 25)).toBe(true));
  });

  it("debounces the search and shows an empty state", async () => {
    const user = userEvent.setup();
    const calls = mockFetch({ ...session(), "/rpc/list_org_structure": () => ok(structure), "/rpc/list_directory": (b) => ok({ rows: (b as { p_search: string | null }).p_search ? [] : [row(2)], total: 0, limit: 25, offset: 0 }) });
    wrap(<Directory />);
    await screen.findByText("Person 2");
    await user.type(screen.getByLabelText("Search"), "zed");
    expect(await screen.findByText("Nobody matches “zed”")).toBeInTheDocument();
    const searches = calls.filter((c) => c.path === "/rpc/list_directory").map((c) => (c.body as { p_search: string | null }).p_search);
    expect(searches).not.toContain("z");
    expect(searches).toContain("zed");
  });
});

describe("Payslips", () => {
  it("only published months open, through the audited file path", async () => {
    const user = userEvent.setup();
    const calls = mockFetch({
      ...session(),
      "/rpc/list_my_payslips": () =>
        ok({
          slots: [
            { salary_month: "2026-10-01", status: "available", file_version_id: "fv1", published_at: "2026-11-01T05:00:00Z", replaced: true, revision_no: 2 },
            { salary_month: "2026-09-01", status: "missing", file_version_id: null, published_at: null, replaced: false, revision_no: null },
            { salary_month: "2026-08-01", status: "archived", file_version_id: null, published_at: null, replaced: false, revision_no: null },
          ],
        }),
      "/files/fv1": () => [200, "%PDF"],
    });
    wrap(<Payslips />);
    const oct = await screen.findByRole("button", { name: /October 2026/ });
    expect(screen.getByRole("button", { name: /September 2026/ })).toBeDisabled();
    expect(screen.getByText(/Archived — ask HR/)).toBeInTheDocument();
    expect(oct).toHaveTextContent("updated");
    await user.click(oct);
    expect(await screen.findByTitle("Payslip · October 2026")).toHaveAttribute("sandbox", "");
    expect(calls.find((c) => c.path === "/files/fv1")!.query.get("purpose")).toBe("view");
  });

  it("an empty history shows the empty state", async () => {
    mockFetch({ ...session(), "/rpc/list_my_payslips": () => ok({ slots: [] }) });
    wrap(<Payslips />);
    expect(await screen.findByText("No payslips yet")).toBeInTheDocument();
  });
});

const salary = (over: Record<string, unknown> = {}) => ({
  profile: { monthly_salary: 45000, currency: "INR", effective_from: "2026-10-01", bank_name: "HDFC", account_holder: "Asha Rao", account_last4: "1234", ifsc: "HDFC0001234", bank_status: "approved", bank_approved_at: null, updated_at: null, version: 2 },
  bank_request: null, lifetime_paid: 90000, paid_months: 2, recent: [], ...over,
});

describe("Bank details", () => {
  it("checks the form, needs proof, then uploads it and sends clean values", async () => {
    const user = userEvent.setup();
    const calls = mockFetch({ ...session(), "/rpc/get_my_salary": () => ok(salary()), "/files": () => ok({ file_version_id: "pf1" }), "/rpc/save_bank_details_request": () => ok({ id: "r1" }) });
    wrap(<BankDetails />);
    await user.type(await screen.findByLabelText("Bank name"), "ICICI");
    await user.type(screen.getByLabelText("Account holder name"), "Asha Rao");
    await user.type(screen.getByLabelText("Account number"), "1234 5678 9012");
    await user.type(screen.getByLabelText("Confirm account number"), "123456789099");
    await user.type(screen.getByLabelText("IFSC"), "icic0001");
    await user.click(screen.getByRole("button", { name: "Send to HR" }));
    expect(screen.getByText("The account numbers do not match.")).toBeInTheDocument();
    expect(screen.getByText(/IFSC is 11 characters/)).toBeInTheDocument();
    expect(screen.getByText("Say why the account is changing.")).toBeInTheDocument();
    const confirm = screen.getByLabelText("Confirm account number");
    await user.clear(confirm);
    await user.type(confirm, "123456789012");
    const ifsc = screen.getByLabelText("IFSC");
    await user.clear(ifsc);
    await user.type(ifsc, "icic0001234");
    expect(ifsc).toHaveValue("ICIC0001234");
    await user.type(screen.getByLabelText("Why is it changing?"), "New salary account");
    await user.click(screen.getByRole("button", { name: "Send to HR" }));
    expect(screen.getByText(/Attach a cancelled cheque/)).toBeInTheDocument();
    await user.upload(screen.getByLabelText("Proof (cancelled cheque or passbook)"), pdf("cheque.pdf"));
    await user.click(screen.getByRole("button", { name: "Send to HR" }));
    expect(await screen.findByText(/Sent to HR/)).toBeInTheDocument();
    expect(calls.find((c) => c.path === "/files")!.query.get("class")).toBe("correction_attachment");
    expect(calls.find((c) => c.path === "/rpc/save_bank_details_request")!.body).toMatchObject({
      p_account_number: "123456789012", p_ifsc: "ICIC0001234", p_attachment_file_version_id: "pf1", p_reason: "New salary account", p_request_id: null,
    });
  });

  it("a first account does not ask for a reason", async () => {
    mockFetch({ ...session(), "/rpc/get_my_salary": () => ok(salary({ profile: { ...salary().profile, account_last4: null, bank_status: "not_set" } })) });
    wrap(<BankDetails />);
    await screen.findByLabelText("Bank name");
    expect(screen.queryByLabelText("Why is it changing?")).not.toBeInTheDocument();
  });
});

describe("Payroll uploads", () => {
  const emp = { id: "e2", code: "EMP002", name: "Ravi K", designation: null, position_label: "member", role: "employee", roles: [], status: "active", join_date: null, end_date: null, setup_pending: false, version: 1, business_email: null, business_phone: null, avatar_file_version_id: null, department: null, team: null };
  const slip = (current: string | null) => ({ payslip_id: "ps1", salary_month: "2026-10-01", version: 5, employee: { id: "e2", code: "EMP002", name: "Ravi K" }, published_at: null, current_file_version_id: current, versions: [] });

  async function pickAndUpload(user: ReturnType<typeof userEvent.setup>) {
    await user.type(await screen.findByLabelText("Employee"), "ravi");
    await user.click(await screen.findByRole("button", { name: /Ravi K/ }));
    const month = screen.getByLabelText("Salary month");
    await user.clear(month);
    await user.type(month, "2026-10");
    await user.upload(screen.getByLabelText("Payslip"), pdf());
    await user.click(screen.getByRole("button", { name: "Upload and check" }));
  }

  it("uploads, previews and publishes with the payslip version and the amount", async () => {
    const user = userEvent.setup();
    const calls = mockFetch({
      ...session("hr"),
      "/rpc/list_employees": () => ok({ rows: [emp], total: 1, limit: 8, offset: 0 }),
      "/rpc/list_payslip_uploads": (b) => ok({ rows: (b as { p_employee_id: string | null }).p_employee_id ? [slip(null)] : [], total: 0, limit: 20, offset: 0 }),
      "/files": () => ok({ file_version_id: "fv9" }),
      "/rpc/publish_payslip": () => ok({}),
      "/rpc/set_payslip_amount": () => ok({}),
    });
    wrap(<PayrollUploads now={NOW} />);
    await pickAndUpload(user);
    expect(await screen.findByRole("button", { name: "Publish" })).toBeInTheDocument();
    const up = calls.find((c) => c.path === "/files")!;
    expect(up.query.get("class")).toBe("payslip");
    expect(up.query.get("salary_month")).toBe("2026-10-01");
    expect(up.query.get("owner_employee_id")).toBe("e2");
    await user.type(screen.getByLabelText("Amount paid (optional)"), "45,000.5x");
    expect(screen.getByText(/Enter an amount like/)).toBeInTheDocument();
    await user.clear(screen.getByLabelText("Amount paid (optional)"));
    await user.type(screen.getByLabelText("Amount paid (optional)"), "45,000.50");
    await user.click(screen.getByRole("button", { name: "Publish" }));
    expect(await screen.findByText(/October 2026 payslip published for Ravi K with the amount paid/)).toBeInTheDocument();
    expect(calls.find((c) => c.path === "/rpc/publish_payslip")!.body).toEqual({ p_file_version_id: "fv9", p_reason: null, p_expected_version: 5 });
    expect(calls.find((c) => c.path === "/rpc/set_payslip_amount")!.body).toMatchObject({ p_employee_id: "e2", p_net_amount: 45000.5 });
  });

  it("replacing a published payslip needs a reason", async () => {
    const user = userEvent.setup();
    const calls = mockFetch({
      ...session("hr"),
      "/rpc/list_employees": () => ok({ rows: [emp], total: 1, limit: 8, offset: 0 }),
      "/rpc/list_payslip_uploads": (b) => ok({ rows: (b as { p_employee_id: string | null }).p_employee_id ? [slip("old")] : [], total: 0, limit: 20, offset: 0 }),
      "/files": () => ok({ file_version_id: "fv9" }),
      "/rpc/publish_payslip": () => ok({}),
    });
    wrap(<PayrollUploads now={NOW} />);
    await pickAndUpload(user);
    await user.click(await screen.findByRole("button", { name: "Publish replacement" }));
    expect(screen.getByText("Give a reason for replacing the published payslip.")).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/rpc/publish_payslip")).toBe(false);
    await user.type(screen.getByLabelText("Reason for replacing the published payslip"), "Wrong bonus");
    await user.click(screen.getByRole("button", { name: "Publish replacement" }));
    await waitFor(() => expect(calls.find((c) => c.path === "/rpc/publish_payslip")?.body).toMatchObject({ p_reason: "Wrong bonus" }));
  });

  it("a server-side rejection (bad PDF) is shown and nothing is published", async () => {
    const user = userEvent.setup();
    const calls = mockFetch({
      ...session("hr"),
      "/rpc/list_employees": () => ok({ rows: [emp], total: 1, limit: 8, offset: 0 }),
      "/rpc/list_payslip_uploads": () => ok({ rows: [], total: 0, limit: 20, offset: 0 }),
      "/files": () => fail(422, "INVALID_FILE_TYPE", "Encrypted PDFs are not accepted."),
    });
    wrap(<PayrollUploads now={NOW} />);
    await pickAndUpload(user);
    expect(await screen.findByText("Encrypted PDFs are not accepted.")).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/rpc/publish_payslip")).toBe(false);
  });
});

describe("Documents", () => {
  const docs = (over: Record<string, unknown> = {}) => ({
    can_publish_policy: false, can_upload: true, count: 1, limit: 10, title_max: 50,
    company: [{ record_id: "c1", title: "Leave policy", file_version_id: "cv1", document_date: "2026-01-01", size_bytes: 2048 }],
    mine: [{ record_id: "m1", title: "Aadhaar", class: "employee_document", state: "published", file_version_id: "mv1", size_bytes: 1000, document_date: null, created_at: "", published_at: null }],
    ...over,
  });

  it("uploads a document dated today and publishes it", async () => {
    const user = userEvent.setup();
    const calls = mockFetch({ ...session(), "/rpc/list_my_documents": () => ok(docs()), "/files": () => ok({ file_version_id: "nv1" }), "/rpc/publish_document": () => ok({}) });
    wrap(<Documents now={NOW} />);
    expect(await screen.findByText("Leave policy")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add policy" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add" }));
    const dialog = screen.getByRole("dialog", { name: "Add document" });
    await user.click(within(dialog).getByRole("button", { name: "Upload" }));
    expect(within(dialog).getByText("Give the document a name.")).toBeInTheDocument();
    expect(within(dialog).getByText("Choose a PDF.")).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("Name"), "PAN card");
    await user.upload(within(dialog).getByLabelText("File"), pdf());
    await user.click(within(dialog).getByRole("button", { name: "Upload" }));
    expect(await screen.findByText("Document uploaded.")).toBeInTheDocument();
    const up = calls.find((c) => c.path === "/files")!;
    expect(up.query.get("class")).toBe("employee_document");
    expect(up.query.get("document_date")).toBe("2026-11-14");
    expect(up.query.get("title")).toBe("PAN card");
  });

  it("the limit disables adding; rename and remove go through their RPCs", async () => {
    const user = userEvent.setup();
    const calls = mockFetch({ ...session(), "/rpc/list_my_documents": () => ok(docs({ count: 10 })), "/rpc/rename_employee_document": () => ok({}), "/rpc/remove_employee_document": () => ok({}) });
    wrap(<Documents now={NOW} />);
    expect(await screen.findByRole("button", { name: "Add" })).toBeDisabled();
    expect(screen.getByText(/remove one to add another/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Rename" }));
    const name = within(screen.getByRole("dialog")).getByLabelText("Name");
    await user.clear(name);
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Save" }));
    expect(within(screen.getByRole("dialog")).getByText("Give the document a name.")).toBeInTheDocument();
    await user.type(name, "Aadhaar card");
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Renamed.")).toBeInTheDocument();
    expect(calls.find((c) => c.path === "/rpc/rename_employee_document")!.body).toEqual({ p_record_id: "m1", p_title: "Aadhaar card" });
    await user.click(screen.getByRole("button", { name: "Remove" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Remove" }));
    expect(await screen.findByText("Removed.")).toBeInTheDocument();
  });

  it("HR with policy rights can add a dated company policy; the policies page hides personal files", async () => {
    const user = userEvent.setup();
    mockFetch({ ...session("hr"), "/rpc/list_my_documents": () => ok(docs({ can_publish_policy: true })) });
    wrap(<Documents now={NOW} policiesOnly />);
    await user.click(await screen.findByRole("button", { name: "Add policy" }));
    expect(within(screen.getByRole("dialog", { name: "Add company policy" })).getByLabelText("Document date")).toHaveAttribute("max", "2026-11-14");
    expect(screen.queryByText("My documents")).not.toBeInTheDocument();
  });

  it("opening a file that was archived shows the server message", async () => {
    const user = userEvent.setup();
    mockFetch({ ...session(), "/rpc/list_my_documents": () => ok(docs()), "/files/cv1": () => fail(410, "ARCHIVED", "Archived locally — contact HR.") });
    wrap(<Documents now={NOW} />);
    await user.click((await screen.findAllByRole("button", { name: "Open" }))[0]);
    expect(await screen.findByText("Archived locally — contact HR.")).toBeInTheDocument();
  });
});

