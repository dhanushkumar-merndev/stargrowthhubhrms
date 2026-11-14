import Link from "next/link";

// NotAvailableScreen: features of later phases land here until they ship.
export default function NotFound() {
  return (
    <main className="grid min-h-dvh place-items-center bg-surface p-8 text-center">
      <div className="grid max-w-sm place-items-center gap-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/illus/construction.svg" width={96} height={96} alt="" />
        <h1 className="text-headline-sm font-medium">Not available yet</h1>
        <p className="text-body-md text-text-secondary">This part of HRMS is not on the web yet. It is coming soon.</p>
        <Link href="/home" className="inline-flex min-h-[52px] items-center rounded-button bg-primary px-6 font-semibold text-white">
          Go home
        </Link>
      </div>
    </main>
  );
}
