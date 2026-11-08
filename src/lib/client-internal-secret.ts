// Opt-in: expose the internal API secret to the browser only when the operator
// explicitly sets NEXT_PUBLIC_INTERNAL_API_SECRET = INTERNAL_API_SECRET in the
// deployment env. When unset, these calls behave as before (no secret header).
export function internalApiHeaders(): Record<string, string> {
  const secret = process.env.NEXT_PUBLIC_INTERNAL_API_SECRET;
  return secret ? { "x-internal-secret": secret } : {};
}
