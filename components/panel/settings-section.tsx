import type { ReactNode } from "react";

const IN_GROUP =
  "in-data-[slot=settings-group]:rounded-none in-data-[slot=settings-group]:border-0 in-data-[slot=settings-group]:bg-transparent in-data-[slot=settings-group]:p-0";
// The form's own Card loses its frame and padding, so the panel isn't boxed twice.
const FLAT_CARD =
  "*:data-[slot=card]:rounded-none *:data-[slot=card]:border-0 *:data-[slot=card]:bg-transparent *:data-[slot=card]:shadow-none *:data-[slot=card]:before:hidden [&>[data-slot=card]>[data-slot=card-panel]]:p-0 [&>[data-slot=card]>[data-slot=card-footer]]:mt-5 [&>[data-slot=card]>[data-slot=card-footer]]:p-0 [&>[data-slot=card]>[data-slot=card-footer].border-t]:pt-4";

/** One settings panel, as on the canvas (`.hv-panel`): its heading and note, then its form. Inside a SettingsGroup it drops the panel and reads as a sub-heading. */
export function SettingsSection({ id, title, description, children }: { id: string; title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className={`flex scroll-mt-6 flex-col gap-3.5 rounded-[14px] border bg-card p-5 ${IN_GROUP}`}>
      <div className="flex flex-col gap-1">
        <h2
          id={`${id}-title`}
          className="text-[15px] leading-[22px] font-semibold in-data-[slot=settings-group]:text-xs in-data-[slot=settings-group]:font-medium in-data-[slot=settings-group]:text-muted-foreground"
        >
          {title}
        </h2>
        {description && <div className="text-xs text-pretty text-muted-foreground">{description}</div>}
      </div>
      <div className={`min-w-0 ${FLAT_CARD}`}>{children}</div>
    </section>
  );
}

/** A canvas section holding several settings, e.g. Subscriptions: Your accounts and the Team pool. */
export function SettingsGroup({ id, title, description, children }: { id: string; title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} data-slot="settings-group" aria-labelledby={`${id}-title`} className="flex scroll-mt-6 flex-col gap-6 rounded-[14px] border bg-card p-5">
      <div className="flex flex-col gap-1">
        <h2 id={`${id}-title`} className="text-[15px] leading-[22px] font-semibold">
          {title}
        </h2>
        {description && <p className="text-pretty text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  );
}

/** The Settings page as on the canvas: title and who sees what, the section links on the left, the panels on the right. */
export function SettingsLayout({ sub, nav, children }: { sub: string; nav: readonly (readonly [id: string, label: string])[]; children: ReactNode }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-5 px-4 pt-6 pb-10 text-sm md:px-7">
        <div className="flex flex-col gap-1">
          <h1 className="text-[22px] leading-7 font-semibold tracking-[-0.015em]">Settings</h1>
          <p className="text-muted-foreground">{sub}</p>
        </div>
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start">
          <nav aria-label="Settings sections" className="flex flex-wrap gap-0.5 lg:sticky lg:top-0 lg:w-[220px] lg:shrink-0 lg:flex-col">
            {nav.map(([id, label]) => (
              <a key={id} href={`#${id}`} className="rounded-full px-3.5 py-2 font-semibold text-(--ink-2) hover:bg-(--surface-2)">
                {label}
              </a>
            ))}
          </nav>
          <div className="flex min-w-0 flex-1 flex-col gap-4">{children}</div>
        </div>
      </div>
    </div>
  );
}
