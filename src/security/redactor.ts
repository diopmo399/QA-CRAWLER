/**
 * Removes secrets from anything that ends up in logs or reports: URLs
 * (query parameters and embedded user:password), bearer tokens, JWTs,
 * Authorization/Cookie headers and `password=` style assignments.
 */

export const REDACTED = '[REDACTED]';

/** Query parameter names whose values are always hidden. */
const SENSITIVE_PARAM =
  /(pass(word|wd)?|pwd|secret|token|api[-_]?key|access[-_]?key|auth|session|sid|jwt|signature|sig|code|credential|otp)/i;

const TEXT_RULES: readonly [RegExp, string][] = [
  // Authorization / Cookie headers copied into messages
  [
    /\b(authorization|proxy-authorization|cookie|set-cookie|x-api-key)\s*[:=]\s*[^\n\r;,]+/gi,
    `$1: ${REDACTED}`,
  ],
  // Bearer / Basic credentials
  [/\b(bearer|basic)\s+[a-z0-9._~+/=-]{6,}/gi, `$1 ${REDACTED}`],
  // JSON Web Tokens
  [/\beyJ[a-zA-Z0-9_-]{5,}\.[a-zA-Z0-9_-]{5,}\.[a-zA-Z0-9_-]{5,}\b/g, REDACTED],
  // password=..., "token": "..."
  [
    /(["']?\b(?:pass(?:word|wd)?|pwd|secret|token|api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret)\b["']?\s*[:=]\s*)(["']?)[^\s"'&,;}]+\2/gi,
    `$1$2${REDACTED}$2`,
  ],
];

export function redactText(text: string): string {
  let result = redactUrlsInText(text);
  for (const [pattern, replacement] of TEXT_RULES) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

/** Redacts credentials and sensitive query params of a single URL. Non-URLs are returned text-redacted. */
export function redactUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  if (url.username || url.password) {
    url.username = url.username ? REDACTED : '';
    url.password = url.password ? REDACTED : '';
  }
  const redactParams = (params: URLSearchParams): boolean => {
    let changed = false;
    for (const key of [...new Set(params.keys())]) {
      if (SENSITIVE_PARAM.test(key)) {
        params.set(key, REDACTED);
        changed = true;
      }
    }
    return changed;
  };
  redactParams(url.searchParams);
  // Hash-routed SPAs (#/reset?token=...) carry params in the fragment.
  const queryInHash = url.hash.indexOf('?');
  if (queryInHash >= 0) {
    const hashParams = new URLSearchParams(url.hash.slice(queryInHash + 1));
    if (redactParams(hashParams)) {
      url.hash = `${url.hash.slice(0, queryInHash)}?${hashParams.toString()}`;
    }
  }
  return url.toString().replaceAll(encodeURIComponent(REDACTED), REDACTED);
}

function redactUrlsInText(text: string): string {
  return text.replace(/\bhttps?:\/\/[^\s"'<>)]+/gi, (match) => redactUrl(match));
}
