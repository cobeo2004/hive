"use client";

import { FolderGit2Icon, InboxIcon, KanbanIcon, type LucideIcon, MenuIcon, PanelLeftIcon, SettingsIcon } from "lucide-react";
import { LayoutGroup, MotionConfig, motion } from "motion/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactElement, type ReactNode, useEffect, useState } from "react";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Sheet, SheetPopup, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { crumbsOf } from "./shell-model";
import { UserMenu, type PanelUser } from "./user-menu";

/** The layout reads this cookie, so a reload keeps the rail collapsed. */
export const COLLAPSED_COOKIE = "sidebar_state";

type NavItem = { href: "/inbox" | "/" | "/repositories" | "/settings"; label: string; icon: LucideIcon };

/** The canvas nav: the jobs, then the inbox of jobs that need the owner. Machines and Other activity stay reachable by URL. */
const NAV: readonly (readonly NavItem[])[] = [
  [
    { href: "/", label: "Jobs", icon: KanbanIcon },
    { href: "/inbox", label: "Inbox", icon: InboxIcon },
    { href: "/repositories", label: "Repositories", icon: FolderGit2Icon },
    { href: "/settings", label: "Settings", icon: SettingsIcon },
  ],
];

const spring = { type: "spring", stiffness: 500, damping: 40 } as const;

const isActive = (href: NavItem["href"], pathname: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));

/** Typing in a field must never toggle the rail or walk a list. */
export const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

function RailTip({ collapsed, label, children }: { collapsed: boolean; label: ReactNode; children: ReactElement }) {
  return (
    <Tooltip disabled={!collapsed}>
      <TooltipTrigger render={children} />
      <TooltipPopup side="right" sideOffset={8}>
        {label}
      </TooltipPopup>
    </Tooltip>
  );
}

function Nav({
  collapsed,
  inboxCount,
  sidebar,
  user,
  onNavigate,
  onToggle,
}: {
  collapsed: boolean;
  inboxCount: ReactNode;
  sidebar: ReactNode;
  user: PanelUser;
  onNavigate?: () => void;
  onToggle?: () => void;
}) {
  const pathname = usePathname();
  const fade = cn("transition-opacity duration-150", collapsed && "pointer-events-none opacity-0");
  return (
    <div className="flex h-full min-h-0 flex-col whitespace-nowrap">
      <div className={cn("flex shrink-0 items-center gap-2.5 px-3.5 pt-3 pb-2.5", collapsed && "flex-col gap-2 px-0")}>
        <svg viewBox="0 0 24 24" aria-hidden="true" className="size-[18px] shrink-0">
          <path d="M12 1.5l9.1 5.25v10.5L12 22.5l-9.1-5.25V6.75z" fill="var(--lime)" />
        </svg>
        <b className={cn("text-[15px] font-bold tracking-tight text-foreground", fade, collapsed && "hidden")}>Hive</b>
        <span className={cn("rounded-md border px-1.5 text-[11px] font-semibold text-muted-foreground", fade, collapsed && "hidden")}>Unibuz</span>
        {onToggle && (
          <RailTip
            collapsed
            label={
              <span className="flex items-center gap-1.5">
                {collapsed ? "Expand" : "Collapse"}
                <Kbd>[</Kbd>
              </span>
            }
          >
            <Button
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              aria-expanded={!collapsed}
              className={cn(!collapsed && "ms-auto -me-1.5")}
              onClick={onToggle}
              size="icon-sm"
              variant="ghost"
            >
              <PanelLeftIcon />
            </Button>
          </RailTip>
        )}
      </div>
      <nav aria-label="Panel" data-collapsed={collapsed || undefined} className="flex shrink-0 flex-col gap-4 overflow-x-hidden border-b px-1.5 pt-1 pb-2">
        {NAV.map((group) => (
          <div key={group[0]!.href} className="flex flex-col gap-px">
            {group.map(({ href, label, icon: Icon }) => {
              const on = isActive(href, pathname);
              return (
                <RailTip key={href} collapsed={collapsed} label={label}>
                  <Link
                    href={href}
                    onClick={onNavigate}
                    aria-current={on ? "page" : undefined}
                    aria-label={collapsed ? label : undefined}
                    className={cn(
                      "relative flex h-8 items-center gap-2.5 overflow-hidden rounded-lg px-2.5 font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                      on
                        ? "bg-primary/10 font-semibold text-foreground shadow-[inset_0_0_0_1px_var(--border)]"
                        : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                    )}
                  >
                    {on && (
                      <motion.span layoutId="panel-nav-marker" transition={spring} className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-primary" />
                    )}
                    <Icon className="size-4 shrink-0" />
                    <span className={cn("min-w-0 flex-1 truncate", fade)}>{label}</span>
                    {href === "/inbox" && inboxCount}
                  </Link>
                </RailTip>
              );
            })}
          </div>
        ))}
      </nav>
      {/* Hidden while the rail is collapsed; the Sheet always shows it. */}
      <div
        className={cn("min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-1.5 py-1", collapsed && "hidden")}
        onClick={(e) => {
          // The links inside are the interactive elements; the wrapper only closes the Sheet, as the nav links above do.
          if ((e.target as HTMLElement).closest("a")) onNavigate?.();
        }}
      >
        {sidebar}
      </div>
      {collapsed && <div className="flex-1" />}
      <div className={cn("flex h-12 shrink-0 items-center gap-1 border-t px-1.5", collapsed && "justify-center px-0")}>
        <UserMenu user={user} />
        <span className={cn("min-w-0 truncate text-xs text-foreground", collapsed && "hidden")}>{user.name}</span>
      </div>
    </div>
  );
}

/** The breadcrumb bar over every page, with the menu button that opens the sidebar Sheet below md. */
function Crumbs({ onMenu }: { onMenu: () => void }) {
  const crumbs = crumbsOf(usePathname());
  return (
    <nav aria-label="Breadcrumb" className="flex min-h-[52px] shrink-0 items-center gap-2 border-b px-3 text-sm md:px-6">
      <Button aria-label="Open navigation" className="md:hidden" onClick={onMenu} size="icon-sm" variant="ghost">
        <MenuIcon />
      </Button>
      {crumbs.map((crumb, i) => (
        <span key={crumb} className="flex items-center gap-2">
          {i > 0 && (
            <span aria-hidden className="text-(--border-strong)">
              /
            </span>
          )}
          {i === crumbs.length - 1 ? (
            <span aria-current="page" className="font-semibold text-foreground">
              {crumb}
            </span>
          ) : (
            <span className="text-muted-foreground">{crumb}</span>
          )}
        </span>
      ))}
      <div className="ms-auto">
        <ThemeToggle />
      </div>
    </nav>
  );
}

/** The app frame: the canvas sidebar on the left that collapses with `[`, and a column each page fills under the breadcrumb bar. */
export function PanelShell({
  defaultCollapsed,
  inboxCount,
  sidebar,
  user,
  children,
}: {
  defaultCollapsed: boolean;
  inboxCount: ReactNode;
  sidebar: ReactNode;
  user: PanelUser;
  children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    document.cookie = `${COLLAPSED_COOKIE}=${!collapsed}; path=/; max-age=${60 * 60 * 24 * 365}`;
  }, [collapsed]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "[" || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      setCollapsed((c) => !c);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <MotionConfig reducedMotion="user">
      <LayoutGroup id="panel-shell">
        <div className="flex h-svh min-h-0 w-full overflow-hidden bg-background text-sm">
          <motion.aside
            aria-label="Sidebar"
            animate={{ width: collapsed ? 48 : 264 }}
            initial={false}
            transition={spring}
            className="hidden shrink-0 overflow-hidden border-e bg-(--surface-1) md:block"
          >
            <Nav collapsed={collapsed} inboxCount={inboxCount} onToggle={() => setCollapsed((c) => !c)} sidebar={sidebar} user={user} />
          </motion.aside>
          <Sheet open={navOpen} onOpenChange={setNavOpen}>
            <SheetPopup side="left" className="w-72 max-w-[85%] bg-(--surface-1) md:hidden">
              <SheetTitle className="sr-only">Navigation</SheetTitle>
              <Nav collapsed={false} inboxCount={inboxCount} onNavigate={() => setNavOpen(false)} sidebar={sidebar} user={user} />
            </SheetPopup>
          </Sheet>
          <main className="flex min-h-0 min-w-0 flex-1 flex-col">
            <Crumbs onMenu={() => setNavOpen(true)} />
            {children}
          </main>
        </div>
      </LayoutGroup>
    </MotionConfig>
  );
}
