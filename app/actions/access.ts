"use server";

import { headers } from "next/headers";
import { acceptInvite, acceptReset, acceptSetup, peekLink, type LinkKind } from "@/lib/access-links";
import { auth } from "@/lib/auth/server";

// The link pages (/auth/setup, /auth/accept, /auth/reset) and /setup's Account step. Each returns
// { ok: true, ... } or { ok: false, message } with a message fit to show.

type Failed = { ok: false; message: string };
const failed = (error: unknown): Failed => ({ ok: false, message: error instanceof Error ? error.message : String(error) });

/** Whether a link page's token is still good; the pages show "This link is invalid or used." on null. */
export async function checkLink(kind: LinkKind, token: string) {
  return peekLink(kind, token);
}

async function signIn(email: string, password: string) {
  // nextCookies sets the session cookie on this action's response. The user has no TOTP yet, so the
  // proxy lets this session reach /setup only (R33).
  await auth.api.signInEmail({ body: { email, password }, headers: await headers() });
}

/** Creates the first admin from a setup link and signs them in; the page then goes to /setup. */
export async function acceptSetupLink(token: string, form: { name: string; email: string; password: string }): Promise<{ ok: true } | Failed> {
  try {
    await acceptSetup(token, form);
    await signIn(form.email.trim().toLowerCase(), form.password);
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}

/** Creates an engineer from an invite and signs them in; the page then goes to /setup. */
export async function acceptInviteLink(token: string, form: { name: string; password: string }): Promise<{ ok: true } | Failed> {
  try {
    const link = await peekLink("invite", token);
    await acceptInvite(token, form);
    await signIn(link!.email!, form.password);
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}

/** Sets a new password from a reset link. It signs no one in: the page sends the user to /auth/sign-in. */
export async function resetPassword(token: string, form: { password: string }): Promise<{ ok: true } | Failed> {
  try {
    await acceptReset(token, form);
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}

/** Starts TOTP enrolment: the QR code's otpauth URI, its secret, and the backup codes to show once. */
export async function startTotp(password: string): Promise<{ ok: true; totpURI: string; secret: string; backupCodes: string[] } | Failed> {
  try {
    const enabled = await auth.api.enableTwoFactor({ body: { password, method: "totp" }, headers: await headers() });
    if (enabled.method !== "totp") throw new Error("TOTP is required.");
    const { totpURI, backupCodes } = enabled;
    return { ok: true, totpURI, secret: new URL(totpURI).searchParams.get("secret") ?? "", backupCodes };
  } catch (error) {
    return failed(error);
  }
}

/** Confirms enrolment with a code from the app; two-factor is on once this succeeds. */
export async function verifyTotp(code: string): Promise<{ ok: true } | Failed> {
  try {
    await auth.api.verifyTOTP({ body: { code }, headers: await headers() });
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}
