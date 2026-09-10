export function normalizeBrowserUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error('Browser navigation requires a website address.');

  const bareHostWithPort =
    /^(?:localhost|\d{1,3}(?:\.\d{1,3}){3}|[a-z\d-]+(?:\.[a-z\d-]+)+):\d+(?:[/?#]|$)/i.test(
      trimmed,
    );
  const explicitScheme = bareHostWithPort
    ? undefined
    : /^([a-z][a-z\d+.-]*):/i.exec(trimmed)?.[1]?.toLowerCase();
  if (explicitScheme && explicitScheme !== 'http' && explicitScheme !== 'https') {
    throw new Error('Browser navigation supports only http:// and https:// URLs.');
  }

  let normalized: string;
  if (explicitScheme) normalized = trimmed;
  else if (trimmed.startsWith('//')) normalized = `https:${trimmed}`;
  else {
    const ipv6Loopback = normalizeBareIpv6Loopback(trimmed);
    if (ipv6Loopback) normalized = ipv6Loopback;
    else if (/^(localhost|127\.0\.0\.1|\[::1\]|::1)(:\d+)?([/?#]|$)/i.test(trimmed))
      normalized = `http://${trimmed}`;
    else normalized = `https://${trimmed}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error('Browser navigation requires a valid http:// or https:// URL.');
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error('Browser navigation supports only http:// and https:// URLs.');
  }
  return normalized;
}

function normalizeBareIpv6Loopback(value: string): string | null {
  const match = /^::1(?::(\d+))?([/?#].*|)$/i.exec(value);
  if (!match) return null;
  const port = match[1] ? `:${match[1]}` : '';
  const path = match[2];
  return `http://[::1]${port}${path}`;
}
