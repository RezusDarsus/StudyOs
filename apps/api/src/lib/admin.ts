/** Deployment-controlled allowlist; never accepted from profile or signup input. */
export function isAdminEmail(email: string): boolean {
  return (process.env.ADMIN_EMAILS ?? '').split(',')
    .map((value) => value.trim().toLowerCase()).filter(Boolean)
    .includes(email.trim().toLowerCase());
}
