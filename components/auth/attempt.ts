type AuthError = { message?: string; code?: string };
type AuthFailure = { message: string };

export async function attempt(call: () => Promise<{ error: AuthError | null }>, fallback: string): Promise<AuthFailure | null> {
  try {
    const { error } = await call();
    return error ? { message: error.message || fallback } : null;
  } catch (error) {
    return { message: (error instanceof Error && error.message) || fallback };
  }
}
