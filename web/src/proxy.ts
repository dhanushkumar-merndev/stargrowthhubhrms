import { NextResponse, type NextRequest } from "next/server";

// Same-origin API (PLAN.md K7). The browser calls /api/*; we forward to the
// Rust server on Render with the shared proxy secret and the client's real IP.
// Cookies stay first-party on *.vercel.app, and the API cannot be reached
// directly on onrender.com without the secret.
//
// Headers a client sends with these names are overwritten, never trusted.

export function proxy(request: NextRequest) {
  const apiOrigin = process.env.API_ORIGIN;
  const secret = process.env.PROXY_SECRET;
  if (!apiOrigin || !secret) {
    return new NextResponse("API not configured", { status: 503 });
  }

  const path = request.nextUrl.pathname.replace(/^\/api/, "") || "/";
  const target = new URL(path + request.nextUrl.search, apiOrigin);

  const headers = new Headers(request.headers);
  headers.set("x-proxy-secret", secret);
  headers.set("x-client-ip", clientIp(request));
  headers.delete("x-forwarded-host");

  return NextResponse.rewrite(target, { request: { headers } });
}

// Vercel sets x-real-ip and overwrites x-forwarded-for, so both are trustworthy
// here (but not on the Rust side, which only trusts x-client-ip + secret).
function clientIp(request: NextRequest): string {
  const real = request.headers.get("x-real-ip");
  if (real) return real.trim();
  const forwarded = request.headers.get("x-forwarded-for");
  return forwarded ? forwarded.split(",")[0].trim() : "";
}

export const config = {
  matcher: ["/api/:path*"],
};
