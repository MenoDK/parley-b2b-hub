/**
 * Where the other company may send a person back to.
 *
 * Accepting any URL is an open redirect: the victim sees a link on a domain they trust, clicks, and lands on a page the
 * attacker controls, often a copy of the login screen. The defence is an allow-list of whole *origins* (scheme + host +
 * port), never a prefix: `https://shop.example.com.evil.test` starts with our domain and is not it.
 *
 * Returns the URL when it is allowed and `null` when it is not. Returning null instead of throwing is deliberate: a
 * refused return link must not break the hand-over; the person just loses the "back" button.
 */
export function allowedReturnUrl(
  raw: string | null | undefined,
  allowedOrigins: readonly string[],
  options: { allowLoopbackHttp?: boolean } = {},
): string | null {
  const value = raw?.trim();
  if (!value || allowedOrigins.length === 0) return null;
  let target: URL;
  try {
    target = new URL(value);
  } catch {
    return null;
  }
  const loopback = target.hostname === 'localhost' || target.hostname === '127.0.0.1';
  if (target.protocol !== 'https:' && !(options.allowLoopbackHttp && loopback && target.protocol === 'http:')) {
    return null;
  }
  if (target.username || target.password) return null; // https://trusted@evil.test
  return allowedOrigins.includes(target.origin) ? target.toString() : null;
}
