import type { ReactNode } from "react";

/** The Hive hexagon from design/screens (Login, Onboarding). */
export function HiveMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="size-[18px] shrink-0">
      <path d="M12 1.5l9.1 5.25v10.5L12 22.5l-9.1-5.25V6.75z" fill="var(--lime)" />
    </svg>
  );
}

/** Login.dc.html's page: the Hive mark on top, a 420px column with no card, a quiet footer. */
export function AuthFrame({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col">
      <header className="flex items-center gap-2.5 px-7 py-5">
        <HiveMark />
        <b className="text-[15px] font-bold tracking-tight">Hive</b>
        <span className="rounded-md border px-1.5 text-[11px] font-semibold text-muted-foreground">Unibuz</span>
      </header>
      <main className="flex flex-1 items-start justify-center px-4 pt-24 pb-12">
        <div className="flex w-full max-w-[420px] flex-col gap-5">{children}</div>
      </main>
      <footer className="px-7 py-5 text-xs text-muted-foreground">Unibuz internal tool</footer>
    </div>
  );
}

/** The page's 24px title and its muted line. */
export function AuthHeading({ title, description }: { title: string; description: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <h1 className="text-2xl/[30px] font-semibold tracking-[-0.015em]">{title}</h1>
      <p className="text-sm/[21px] text-muted-foreground">{description}</p>
    </div>
  );
}
