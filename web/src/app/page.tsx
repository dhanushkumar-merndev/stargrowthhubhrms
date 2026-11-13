import Image from "next/image";

// P0 placeholder. The real Home screen (S03) arrives in P3/P4.
export default function Home() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-4 px-page py-6">
      <div className="flex items-center gap-3">
        <Image src="/icons/icon-192.png" alt="" width={44} height={44} priority />
        <h1 className="text-headline-sm font-medium">HRMS</h1>
      </div>
      <section className="rounded-card bg-attendance-card p-card">
        <h2 className="text-title-md font-semibold">Setting up</h2>
        <p className="mt-2 text-body-md text-text-secondary">
          The web app is being built. Sign-in, punching and the rest of the features arrive in the next phases.
        </p>
      </section>
    </main>
  );
}
