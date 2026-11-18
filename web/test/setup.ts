import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

afterEach(() => cleanup());

// next/navigation is mocked per test through these handles.
export const nav = { path: "/home", replace: vi.fn(), push: vi.fn(), back: vi.fn() };
vi.mock("next/navigation", () => ({
  usePathname: () => nav.path,
  useRouter: () => ({ replace: nav.replace, push: nav.push, back: nav.back, prefetch: vi.fn() }),
}));

// jsdom has no object URLs; files are shown from them.
if (!URL.createObjectURL) {
  let n = 0;
  URL.createObjectURL = () => `blob:test/${++n}`;
  URL.revokeObjectURL = () => undefined;
}

// jsdom's Blob lacks arrayBuffer(); browsers have it.
if (!Blob.prototype.arrayBuffer) {
  Blob.prototype.arrayBuffer = function (this: Blob) {
    return new Promise<ArrayBuffer>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result as ArrayBuffer);
      r.onerror = () => reject(r.error);
      r.readAsArrayBuffer(this);
    });
  };
}
