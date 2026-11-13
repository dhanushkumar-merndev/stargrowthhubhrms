import Image from "next/image";

export const dynamic = "force-static";

export default function Offline() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 px-page text-center">
      <Image src="/illus/cloud_off.svg" alt="" width={96} height={96} priority />
      <h1 className="text-title-lg font-medium">You are offline</h1>
      <p className="text-body-md text-text-secondary">
        Connect to the internet to punch, apply for leave or see the latest data.
      </p>
    </main>
  );
}
