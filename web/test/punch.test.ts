import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import {
  LocationError,
  MAX_SAMPLE_AGE_MS,
  PasskeyError,
  type PunchDeps,
  acc,
  canonicalPayloadV1,
  distanceMeters,
  fromB64url,
  lat,
  lng,
  punchChallenge,
  punchErrorText,
  registerPasskey,
  registrationChallenge,
  submitPunch,
  toB64url,
} from "@/lib/punch";

const FIELDS = {
  challengeId: "6F1C1B5E-0000-4000-8000-000000000002",
  nonce: "abcdefghijklmnop",
  operationKey: "6f1c1b5e-0000-4000-8000-000000000001",
  employeeId: "6f1c1b5e-0000-4000-8000-000000000006",
  deviceId: "6f1c1b5e-0000-4000-8000-000000000004",
  action: "IN" as const,
  targetId: "6f1c1b5e-0000-4000-8000-000000000003",
  officeId: "6f1c1b5e-0000-4000-8000-000000000005",
  latitude: "12.9716000",
  longitude: "-77.5946000",
  accuracy: "5.00",
  sampleAtMs: "1763100000000",
};

describe("canonical payload v1", () => {
  it("matches the server byte for byte (golden value shared with Rust)", async () => {
    const p = canonicalPayloadV1(FIELDS);
    expect(p.split("\n")).toHaveLength(13);
    expect(p.startsWith("hrms-punch-v1\n6f1c1b5e-0000-4000-8000-000000000002\n")).toBe(true);
    expect(p.endsWith("\n")).toBe(false);
    expect(toB64url(await punchChallenge(FIELDS))).toBe("9kisx0wwW07R3mlitQDtsWr62EvIZKfU6tMbVZxbo6k");
    expect(toB64url(await registrationChallenge("ABC", "n1"))).toBe("cw0rtAMvrNXDiOUYeCgMqt_Spm3pH5PwLyl5KG4X_Bc");
  });

  it("formats numbers exactly like the server expects", () => {
    expect(lat(12.97)).toBe("12.9700000");
    expect(lng(-77.5946)).toBe("-77.5946000");
    expect(lat(-90)).toBe("-90.0000000");
    expect(acc(4.567)).toBe("4.57");
    expect(acc(0)).toBe("0.01");
    expect(acc(123456)).toBe("9999.99");
  });

  it("base64url round-trips without padding", () => {
    const bytes = new Uint8Array([251, 255, 0, 1, 2]);
    const s = toB64url(bytes);
    expect(s).not.toMatch(/[+/=]/);
    expect(Array.from(fromB64url(s))).toEqual(Array.from(bytes));
    expect(Array.from(fromB64url("YQ"))).toEqual([97]);
  });

  it("estimates distance in metres", () => {
    expect(distanceMeters(12.9716, 77.5946, 12.9716, 77.5946)).toBe(0);
    const d = distanceMeters(12.9716, 77.5946, 12.9725, 77.5946);
    expect(d).toBeGreaterThan(95);
    expect(d).toBeLessThan(105);
  });
});

// ---------------------------------------------------------------- fakes

const ME = { id: "6f1c1b5e-0000-4000-8000-000000000006", code: "EMP001", name: "Asha Rao" };
const TARGET = {
  action: "IN" as const,
  targetId: FIELDS.targetId,
  officeId: FIELDS.officeId,
  deviceId: FIELDS.deviceId,
  credentialId: "AAECAwQFBgcICQoLDA0ODw",
};
const buf = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

function deps(over: Partial<PunchDeps> = {}) {
  const order: string[] = [];
  const now = 1_763_100_000_000;
  const d: PunchDeps & { order: string[] } = {
    order,
    now: () => now,
    operationId: () => FIELDS.operationKey,
    rpId: "web-hrms.vercel.app",
    locate: vi.fn(async () => {
      order.push("locate");
      return { latitude: 12.9716, longitude: -77.5946, accuracy: 5, timestamp: now - 1000 };
    }),
    rpc: vi.fn(async (name: string) => {
      order.push(name);
      if (name === "create_punch_challenge")
        return { challenge_id: FIELDS.challengeId, nonce: FIELDS.nonce, server_time: new Date(now + 2000).toISOString() };
      if (name === "create_device_challenge") return { challenge_id: "abc", nonce: "n1" };
      if (name === "get_punch_operation") return { found: false };
      throw new Error("unexpected " + name);
    }) as unknown as PunchDeps["rpc"],
    post: vi.fn(async (path: string) => {
      order.push(path);
      return path === "/punch" ? { ok: true, data: { action: "IN", event_id: "ev1" } } : { data: { device_id: "dev1" } };
    }) as unknown as PunchDeps["post"],
    credentials: {
      create: vi.fn(async () => {
        order.push("create");
        return {
          rawId: new Uint8Array([1, 2, 3]).buffer,
          response: { clientDataJSON: buf("{}"), getAuthenticatorData: () => buf("auth") },
        } as unknown as Credential;
      }),
      get: vi.fn(async () => {
        order.push("get");
        return {
          rawId: new Uint8Array([0, 1, 2]).buffer,
          response: { clientDataJSON: buf("cd"), authenticatorData: buf("ad"), signature: buf("sig") },
        } as unknown as Credential;
      }),
    },
    ...over,
  };
  return d;
}

const lastPost = (d: PunchDeps) => (d.post as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;

describe("registerPasskey", () => {
  it("asks for a user-verified ES256 platform passkey bound to our RP id", async () => {
    const d = deps();
    await expect(registerPasskey(d, ME, "Chrome")).resolves.toEqual({ device_id: "dev1" });
    const opts = (d.credentials.create as ReturnType<typeof vi.fn>).mock.calls[0][0].publicKey;
    expect(opts.rp.id).toBe("web-hrms.vercel.app");
    expect(opts.pubKeyCredParams).toEqual([{ type: "public-key", alg: -7 }]);
    expect(opts.authenticatorSelection.userVerification).toBe("required");
    expect(opts.attestation).toBe("none");
    expect(toB64url(opts.challenge)).toBe("cw0rtAMvrNXDiOUYeCgMqt_Spm3pH5PwLyl5KG4X_Bc");
    const [path, body] = lastPost(d);
    expect(path).toBe("/punch/device");
    expect(body).toMatchObject({ challenge_id: "abc", nonce: "n1", credential_id: "AQID", device_label: "Chrome" });
    expect(body.authenticator_data).toBe(toB64url(buf("auth")));
  });

  it("maps cancellation, unsupported browsers and duplicates to clear errors", async () => {
    const reject = (name: string) =>
      deps({ credentials: { create: vi.fn(async () => Promise.reject(Object.assign(new Error(), { name }))), get: vi.fn() } });
    await expect(registerPasskey(reject("NotAllowedError"), ME)).rejects.toMatchObject({ reason: "cancelled" });
    await expect(registerPasskey(reject("NotSupportedError"), ME)).rejects.toMatchObject({ reason: "unsupported" });
    await expect(registerPasskey(reject("InvalidStateError"), ME)).rejects.toThrow(/already exists/);
    await expect(registerPasskey(reject("Weird"), ME)).rejects.toMatchObject({ reason: "failed" });
    const none = deps({ credentials: { create: vi.fn(async () => null), get: vi.fn() } });
    await expect(registerPasskey(none, ME)).rejects.toMatchObject({ reason: "cancelled" });
    const old = deps({
      credentials: {
        create: vi.fn(async () => ({ rawId: new ArrayBuffer(1), response: { clientDataJSON: buf("{}") } }) as unknown as Credential),
        get: vi.fn(),
      },
    });
    await expect(registerPasskey(old, ME)).rejects.toMatchObject({ reason: "unsupported" });
    const noApi = deps({ credentials: undefined as unknown as PunchDeps["credentials"] });
    await expect(registerPasskey(noApi, ME)).rejects.toBeInstanceOf(PasskeyError);
    expect(noApi.rpc).not.toHaveBeenCalled();
  });
});

describe("submitPunch", () => {
  it("challenge -> fresh location -> passkey -> submit, signing exactly the sent payload", async () => {
    const d = deps();
    const r = await submitPunch(d, ME, TARGET);
    expect(r.data.event_id).toBe("ev1");
    expect(d.order).toEqual(["create_punch_challenge", "locate", "get", "/punch"]);
    const [, body] = lastPost(d);
    // the sample time is shifted into server time (+2 s skew)
    expect(body.sample_at_ms).toBe(String(1_763_100_000_000 - 1000 + 2000));
    const signed = (d.credentials.get as ReturnType<typeof vi.fn>).mock.calls[0][0].publicKey;
    const expected = await punchChallenge({
      challengeId: body.challenge_id,
      nonce: body.nonce,
      operationKey: body.operation_key,
      employeeId: body.employee_id,
      deviceId: body.device_id,
      action: body.action,
      targetId: body.target_id,
      officeId: body.office_id,
      latitude: body.latitude,
      longitude: body.longitude,
      accuracy: body.accuracy,
      sampleAtMs: body.sample_at_ms,
    });
    expect(toB64url(signed.challenge)).toBe(toB64url(expected));
    expect(signed.userVerification).toBe("required");
    expect(toB64url(signed.allowCredentials[0].id)).toBe(TARGET.credentialId);
    expect(body).toMatchObject({ latitude: "12.9716000", longitude: "-77.5946000", accuracy: "5.00", signature: toB64url(buf("sig")) });
  });

  it("refuses a stale location before prompting for the passkey", async () => {
    const d = deps({ locate: vi.fn(async () => ({ latitude: 1, longitude: 1, accuracy: 5, timestamp: 1_763_100_000_000 - MAX_SAMPLE_AGE_MS })) });
    await expect(submitPunch(d, ME, TARGET)).rejects.toBeInstanceOf(LocationError);
    expect(d.credentials.get).not.toHaveBeenCalled();
    expect(d.post).not.toHaveBeenCalled();
  });

  it("passes location denial through with guidance", async () => {
    const d = deps({ locate: vi.fn(async () => Promise.reject(new LocationError("denied"))) });
    await expect(submitPunch(d, ME, TARGET)).rejects.toThrow(/Allow location access/);
  });

  it("does not submit when the passkey prompt is cancelled", async () => {
    const d = deps({
      credentials: { create: vi.fn(), get: vi.fn(async () => Promise.reject(Object.assign(new Error(), { name: "NotAllowedError" }))) },
    });
    await expect(submitPunch(d, ME, TARGET)).rejects.toMatchObject({ reason: "cancelled" });
    expect(d.post).not.toHaveBeenCalled();
  });

  it("recovers a committed punch after the network drops on submit", async () => {
    const d = deps({
      post: vi.fn(async () => Promise.reject(new ApiError("NETWORK", "offline", 0, {}, true))) as unknown as PunchDeps["post"],
      rpc: vi.fn(async (name: string) =>
        name === "create_punch_challenge"
          ? { challenge_id: FIELDS.challengeId, nonce: FIELDS.nonce, server_time: new Date().toISOString() }
          : { found: true, result: { ok: true, data: { event_id: "ev9" } } },
      ) as unknown as PunchDeps["rpc"],
    });
    await expect(submitPunch(d, ME, TARGET)).resolves.toMatchObject({ data: { event_id: "ev9" } });
    expect((d.rpc as ReturnType<typeof vi.fn>).mock.calls.at(-1)).toEqual(["get_punch_operation", { p_operation_key: FIELDS.operationKey }]);
  });

  it("reports the original error when the operation was not committed", async () => {
    const d = deps({ post: vi.fn(async () => Promise.reject(new ApiError("NETWORK", "You are offline.", 0, {}, true))) as unknown as PunchDeps["post"] });
    await expect(submitPunch(d, ME, TARGET)).rejects.toThrow("You are offline.");
  });

  it("never retries server rejections and surfaces their message", async () => {
    const d = deps({
      post: vi.fn(async () => Promise.reject(new ApiError("OUTSIDE_ZONE", "You appear to be outside the office area.", 422))) as unknown as PunchDeps["post"],
    });
    const e = await submitPunch(d, ME, TARGET).catch((x) => x);
    expect(punchErrorText(e)).toBe("You appear to be outside the office area.");
    expect(d.rpc).not.toHaveBeenCalledWith("get_punch_operation", expect.anything());
  });

  it("tolerates a server time it cannot parse (no skew)", async () => {
    const d = deps({
      rpc: vi.fn(async () => ({ challenge_id: "c", nonce: FIELDS.nonce, server_time: "garbage" })) as unknown as PunchDeps["rpc"],
    });
    await submitPunch(d, ME, TARGET);
    expect(lastPost(d)[1].sample_at_ms).toBe(String(1_763_100_000_000 - 1000));
  });

  it("generic text for unknown failures", () => {
    expect(punchErrorText(new Error("x"))).toMatch(/Something went wrong/);
  });
});
