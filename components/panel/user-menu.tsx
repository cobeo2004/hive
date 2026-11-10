"use client";

import { LogOutIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { authClient } from "@/lib/auth/client";

export type PanelUser = { name: string; email: string };

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");

/** Who is signed in, and the way out (R3): the panel's only account control. */
export function UserMenu({ user }: { user: PanelUser }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  return (
    <Menu>
      <MenuTrigger render={<Button aria-label={`Signed in as ${user.email}. Account menu`} size="icon-sm" variant="ghost" />}>
        <span className="text-[11px] font-semibold">{initials(user.name) || "ME"}</span>
      </MenuTrigger>
      <MenuPopup align="start" side="top" className="w-56">
        <MenuGroup>
          <MenuGroupLabel>
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-foreground">{user.name}</span>
              <span className="truncate">{user.email}</span>
            </span>
          </MenuGroupLabel>
          <MenuSeparator />
          <MenuItem
            disabled={pending}
            onClick={async () => {
              setPending(true);
              await authClient.signOut();
              router.replace("/auth/sign-in");
              router.refresh();
            }}
          >
            <LogOutIcon />
            {pending ? "Signing out" : "Sign out"}
          </MenuItem>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
