/** The signed-in user as the panel's checks read it (lib/auth/server.ts `currentUser`). */
export type SessionUser = {
  id?: string;
  email: string;
  name?: string;
  role?: string | null;
  twoFactorEnabled?: boolean | null;
  setupDoneAt?: Date | null;
};

/** A member has TOTP on and finished /setup (R33). Enrolment ends every session but the one that verified, so an enrolled user's session passed TOTP. */
export function isMember(user: SessionUser | null | undefined): user is SessionUser {
  return user?.twoFactorEnabled === true && !!user.setupDoneAt;
}

export function isAdmin(user: SessionUser | null | undefined): user is SessionUser {
  return isMember(user) && user.role === "admin";
}
