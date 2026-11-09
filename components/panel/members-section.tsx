"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { createInvite, createResetLink, setMemberRole } from "@/app/actions/members";
import { CopyBox } from "@/components/copy-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Member, Role } from "@/lib/members";
import { SettingsSection } from "./settings-section";

const ROLES = [
  { value: "admin", label: "Admin" },
  { value: "engineer", label: "Engineer" },
] as const;

const when = (date: Date) => new Date(date).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });

/** Settings → Members (R4, R32): the team, invites and reset links. The page shows it to admins only; the actions check too. */
export function MembersSection({ members: initial }: { members: Member[] }) {
  const router = useRouter();
  const [members, setMembers] = useState(initial);
  const [roleFailure, setRoleFailure] = useState<{ id: string; message: string } | null>(null);
  const [savingRole, setSavingRole] = useState<string | null>(null);
  const [resetting, setResetting] = useState<string | null>(null);
  const [resetFailure, setResetFailure] = useState<string | null>(null);
  const [resetLink, setResetLink] = useState<{ email: string; url: string } | null>(null);
  const [email, setEmail] = useState("");
  const [inviting, setInviting] = useState(false);
  const [inviteFailure, setInviteFailure] = useState<string | null>(null);
  const [invite, setInvite] = useState<{ url: string; expiresAt: Date } | null>(null);

  async function changeRole(member: Member, role: Role) {
    setSavingRole(member.id);
    setRoleFailure(null);
    const result = await setMemberRole(member.id, role);
    setSavingRole(null);
    if (!result.ok) {
      setRoleFailure({ id: member.id, message: result.message });
      return;
    }
    setMembers((current) => current.map((row) => (row.id === member.id ? { ...row, role } : row)));
    router.refresh();
  }

  async function reset(member: Member) {
    setResetting(member.email);
    setResetFailure(null);
    setResetLink(null);
    const result = await createResetLink(member.email);
    setResetting(null);
    if (!result.ok) {
      setResetFailure(result.message);
      return;
    }
    setResetLink({ email: member.email, url: result.url });
  }

  async function submitInvite(event: FormEvent) {
    event.preventDefault();
    setInviting(true);
    setInviteFailure(null);
    setInvite(null);
    const result = await createInvite(email);
    setInviting(false);
    if (!result.ok) {
      setInviteFailure(result.message);
      return;
    }
    setInvite({ url: result.url, expiresAt: result.expiresAt });
    setEmail("");
  }

  return (
    <SettingsSection
      description="Who can sign in, and what each one may do. An admin manages members, repositories and settings; an engineer works jobs and reviews PRs."
      id="members"
      title="Members"
    >
      <Card>
        <CardContent className="flex flex-col gap-6">
          <div className="flex flex-col divide-y rounded-lg border">
            {members.map((member) => (
              <div className="flex flex-col gap-2 px-4 py-3" key={member.id}>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-medium">{member.name}</span>
                    <span className="truncate text-sm text-muted-foreground">{member.email}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    <Badge variant={member.twoFactorEnabled ? "success" : "warning"}>{member.twoFactorEnabled ? "2FA on" : "2FA off"}</Badge>
                    <Badge variant={member.setupDone ? "outline" : "warning"}>{member.setupDone ? "Set up" : "Setup pending"}</Badge>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <Select disabled={savingRole === member.id} items={ROLES} onValueChange={(role) => void changeRole(member, role as Role)} value={member.role}>
                      <SelectTrigger aria-label={`Role for ${member.name}`} className="w-32">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectPopup>
                        {ROLES.map((role) => (
                          <SelectItem key={role.value} value={role.value}>
                            {role.label}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                    <Button disabled={resetting === member.email} onClick={() => void reset(member)} size="sm" variant="outline">
                      {resetting === member.email ? "Making link" : "Reset link"}
                    </Button>
                  </span>
                </div>
                {roleFailure?.id === member.id && (
                  <p role="alert" className="text-sm text-destructive">
                    {roleFailure.message}
                  </p>
                )}
                {resetLink?.email === member.email && <CopyBox label="reset link" value={resetLink.url} />}
              </div>
            ))}
          </div>
          {resetFailure && (
            <p role="alert" className="text-sm text-destructive">
              {resetFailure}
            </p>
          )}

          <form className="flex flex-col gap-3 border-t pt-6" onSubmit={submitInvite}>
            <Field>
              <FieldLabel htmlFor="members-invite">Invite</FieldLabel>
              <div className="flex w-full flex-col gap-2 sm:flex-row">
                <Input
                  id="members-invite"
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="name@unibuz.com.au"
                  required
                  type="email"
                  value={email}
                />
                <Button className="shrink-0" disabled={inviting} type="submit">
                  {inviting ? "Making link" : "Create invite"}
                </Button>
              </div>
              <FieldDescription>An @unibuz.com.au email. Hive does not send the link; copy it to them yourself.</FieldDescription>
              {inviteFailure && (
                <p role="alert" className="text-sm text-destructive">
                  {inviteFailure}
                </p>
              )}
              {invite && (
                <div className="flex w-full flex-col gap-2 pt-1">
                  <CopyBox label="invite link" value={invite.url} />
                  <span className="text-xs text-muted-foreground">Expires {when(invite.expiresAt)}.</span>
                </div>
              )}
            </Field>
          </form>
        </CardContent>
      </Card>
    </SettingsSection>
  );
}
