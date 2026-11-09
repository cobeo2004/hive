/** The signed-in user as the panel's checks read it (lib/auth/server.ts `currentUser`). */
export type SessionUser = {
  id?: string;
  email: string;
  name?: string;
  role?: string | null;
  twoFactorEnabled?: boolean | null;
  setupDoneAt?: Date | null;
};

/** A member is any user whose session passed TOTP: Better Auth issues a session to an enrolled user only after the code (R33). */
export function isMember(user: SessionUser | null | undefined): user is SessionUser {
  return user?.twoFactorEnabled === true;
}

export function isAdmin(user: SessionUser | null | undefined): user is SessionUser {
  return isMember(user) && user.role === "admin";
}
