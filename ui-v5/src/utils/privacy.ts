/**
 * Global Privacy Mask utility mirroring `omnia_core::redactor::PrivacyMask`.
 * Masks public/LAN IPs (preserving loopback 127.0.0.1 / ::1), MAC addresses,
 * Wi-Fi SSIDs, email addresses, OS user profile paths, and credential hints
 * across all rendered views and one-click exports.
 */

const IPV4_RE = /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\/\d{1,2})?\b/g;
const IPV6_RE = /\b(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{0,4}(?:\/\d{1,3})?\b/g;
const MAC_RE = /\b(?:[0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}\b/g;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const WIN_USER_PATH_RE = /([A-Za-z]:\\Users\\)([^\\/:*?"<>|\s]+)/gi;
const UNIX_USER_PATH_RE = /(\/(?:home|Users)\/)([^/\s]+)/g;
const SECRET_TOKEN_RE = /\b(?:sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{12,}|AIza[0-9A-Za-z_-]{16,}|Bearer\s+[A-Za-z0-9._-]{10,})\b/gi;

const SENSITIVE_KEY_RE =
  /^(?:ssid|mac|mac_?address|public_?ipv[46]|ipv[46]_?cidrs?|gateways?|dns_?egress_?ip|masked_?hint|email|user_?name|hostname|local_?ip|remote_?addr)$/i;

export function maskIpValue(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === '127.0.0.1' || trimmed === '::1' || trimmed === '0.0.0.0') {
    return trimmed;
  }
  if (trimmed.includes(':')) {
    return 'xxxx:xxxx::/masked';
  }
  const [ip, cidr] = trimmed.split('/');
  const parts = ip.split('.');
  if (parts.length === 4) {
    const masked = `${parts[0]}.${parts[1]}.x.x`;
    return cidr ? `${masked}/${cidr}` : masked;
  }
  return '[MASKED_IP]';
}

export function maskText(input: string, enabled: boolean): string {
  if (!enabled || !input) return input;
  return input
    .replace(SECRET_TOKEN_RE, '[MASKED_CRED]')
    .replace(EMAIL_RE, '[MASKED_EMAIL]')
    .replace(MAC_RE, 'xx:xx:xx:xx:xx:xx')
    .replace(WIN_USER_PATH_RE, '$1[MASKED_USER]')
    .replace(UNIX_USER_PATH_RE, '$1[MASKED_USER]')
    .replace(IPV4_RE, (m) => maskIpValue(m))
    .replace(IPV6_RE, (m) => (m === '::1' ? m : 'xxxx:xxxx::masked'));
}

export function maskSensitiveField(value: string | null | undefined, enabled: boolean, fallback = '—'): string {
  if (value === null || value === undefined || value === '') return fallback;
  if (!enabled) return value;
  const masked = maskText(value, true);
  if (masked !== value) return masked;
  if (value.length <= 4) return '••••';
  return `${value.slice(0, 2)}••••${value.slice(-2)}`;
}

export function maskJson<T>(value: T, enabled: boolean, keyName = ''): T {
  if (!enabled || value === null || value === undefined) return value;
  if (typeof value === 'string') {
    if (SENSITIVE_KEY_RE.test(keyName)) {
      return maskSensitiveField(value, true, '') as unknown as T;
    }
    return maskText(value, true) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => maskJson(item, true, keyName)) as unknown as T;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = maskJson(v, true, k);
    }
    return out as T;
  }
  return value;
}

export function downloadTextFile(filename: string, content: string, mimeType = 'application/json;charset=utf-8'): void {
  if (typeof document === 'undefined') return;
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
