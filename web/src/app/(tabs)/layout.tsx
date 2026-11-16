import { NavBar } from "@/components/nav-bar";

// shell.dart: the three main tabs share the bottom navigation bar (phones;
// tablets and desktops use the sidebar in components/shell.tsx).
export default function TabsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <div className="min-h-dvh pb-[calc(68px+env(safe-area-inset-bottom))] md:pb-0">{children}</div>
      <NavBar />
    </>
  );
}
