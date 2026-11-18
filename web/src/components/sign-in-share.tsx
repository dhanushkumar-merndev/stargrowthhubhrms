"use client";

import { useState } from "react";
import { employeeSignInUrl } from "@/lib/routing";
import { Button } from "./ui";

export function SignInShare({ code, name, password }: { code: string; name?: string; password?: string }) {
  const [feedback, setFeedback] = useState<"copied" | "manual" | null>(null);
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  function details() {
    return [
      name ? `HRMS sign-in for ${name}` : "HRMS sign-in",
      `Sign-in link: ${employeeSignInUrl(window.location.origin, code)}`,
      `Username (Employee ID): ${code}`,
      ...(password
        ? [`Temporary password: ${password}`, "Sign in with this temporary password and choose a new one when prompted."]
        : ["Sign in with your current HRMS password."]),
    ].join("\n");
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(details());
      setFeedback("copied");
    } catch {
      setFeedback("manual");
    }
  }

  async function share() {
    try {
      await navigator.share({ title: "HRMS sign-in", text: details() });
    } catch (error) {
      if (!(error instanceof Error && error.name === "AbortError")) await copy();
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outlined" onClick={copy}>Copy sign-in details</Button>
        {canShare && <Button type="button" variant="text" onClick={share}>Share sign-in details</Button>}
      </div>
      {feedback === "copied" && <p role="status" className="text-body-sm text-success">Sign-in details copied.</p>}
      {feedback === "manual" && (
        <label className="text-body-sm text-text-secondary">
          Select and copy the sign-in details.
          <textarea
            className="mt-1 w-full rounded-input border border-border bg-surface p-2 text-text"
            value={details()}
            onFocus={(e) => e.currentTarget.select()}
            rows={5}
            readOnly
          />
        </label>
      )}
    </div>
  );
}
