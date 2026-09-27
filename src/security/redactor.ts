/**
 * Retire les secrets de tout ce qui finit dans les logs ou les rapports : URL
 * (paramètres de requête et user:password intégrés), jetons Bearer, JWT, en-têtes
 * Authorization/Cookie et affectations du genre `password=`.
 */

export const REDACTED = '[REDACTED]';

/** Noms de paramètres de requête dont les valeurs sont toujours masquées. */
const SENSITIVE_PARAM =
  /(pass(word|wd)?|pwd|secret|token|api[-_]?key|access[-_]?key|auth|session|sid|jwt|signature|sig|code|credential|otp)/i;

const TEXT_RULES: readonly [RegExp, string][] = [
  // En-têtes Authorization / Cookie recopiés dans des messages
  [
    /\b(authorization|proxy-authorization|cookie|set-cookie|x-api-key)\s*[:=]\s*[^\n\r;,]+/gi,
    `$1: ${REDACTED}`,
  ],
  // Identifiants Bearer / Basic
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

/** Masque les identifiants et les paramètres de requête sensibles d'une URL. Ce qui n'est pas une URL est masqué comme du texte. */
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
  // Les SPA routées par hash (#/reset?token=...) portent des paramètres dans le fragment.
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
