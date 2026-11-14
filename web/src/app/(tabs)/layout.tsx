import { NavBar } from "@/components/nav-bar";

// shell.dart: the three main tabs share the bottom navigation bar.
export default function TabsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <div className="min-h-dvh pb-[calc(68px+env(safe-area-inset-bottom))]">{children}</div>
      <NavBar />
    </>
  );
}
