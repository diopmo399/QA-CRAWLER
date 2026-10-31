import { parseAllDocuments } from 'yaml';

/**
 * La configuration Spring (`application.yml`, `application.properties`) aplatie en clés pointées
 * (`catalog.url`), pour résoudre les `@Value("${catalog.url}")` des clients HTTP. Les documents YAML
 * réservés à un profil (`spring.config.activate.on-profile`) ne sont pas fusionnés : la valeur par
 * défaut est la seule sûre sans connaître le profil actif.
 */

export function readSpringProperties(file: string, text: string): Record<string, string> {
  return /\.ya?ml$/i.test(file) ? readYaml(text) : readProperties(text);
}

function readYaml(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  let documents;
  try {
    documents = parseAllDocuments(text);
  } catch {
    return out;
  }
  if (!Array.isArray(documents)) return out;
  for (const doc of documents) {
    if (doc.errors.length > 0) continue;
    const flat: Record<string, string> = {};
    flatten(doc.toJS() as unknown, '', flat);
    if (flat['spring.config.activate.on-profile'] !== undefined || flat['spring.profiles'] !== undefined)
      continue;
    Object.assign(out, flat);
  }
  return out;
}

function flatten(value: unknown, prefix: string, out: Record<string, string>): void {
  if (value === null || value === undefined) {
    if (prefix) out[prefix] = '';
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      flatten(item, `${prefix}[${index}]`, out);
    });
    return;
  }
  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      flatten(child, prefix ? `${prefix}.${key}` : key, out);
    }
    return;
  }
  if (prefix) out[prefix] = typeof value === 'string' ? value : JSON.stringify(value);
}

function readProperties(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = (lines[i] ?? '').replace(/^\s+/, '');
    if (line === '' || line.startsWith('#') || line.startsWith('!')) continue;
    // Continuation : une ligne terminée par un nombre impair de `\`.
    while (/(^|[^\\])(\\\\)*\\$/.test(line) && i + 1 < lines.length) {
      line = line.slice(0, -1) + (lines[++i] ?? '').replace(/^\s+/, '');
    }
    const match = /^((?:\\.|[^:=\s\\])+)\s*[:=\s]\s*(.*)$/.exec(line);
    const key = match ? unescapeProperty(match[1] ?? '') : unescapeProperty(line);
    const value = match ? unescapeProperty(match[2] ?? '') : '';
    if (key) out[key] = value;
  }
  return out;
}

function unescapeProperty(raw: string): string {
  return raw.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_all, e: string) => {
    if (e.length === 5) return String.fromCharCode(parseInt(e.slice(1), 16));
    return e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e;
  });
}

export interface PlaceholderResolution {
  value: string;
  /** Tous les `${…}` ont une valeur (propriété ou valeur par défaut). */
  resolved: boolean;
  /** Les clés sans valeur. */
  unresolved: string[];
}

/**
 * Résout les `${clé}` et `${clé:défaut}` (imbriqués, récursifs, profondeur bornée). Une clé absente
 * sans défaut reste écrite `${clé}` et est signalée.
 */
export function resolvePlaceholders(
  text: string,
  properties: Record<string, string>,
  depth = 0,
): PlaceholderResolution {
  const unresolved: string[] = [];
  let out = '';
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf('${', i);
    if (start < 0) {
      out += text.slice(i);
      break;
    }
    out += text.slice(i, start);
    // Accolade fermante équilibrée (`${a:${b}}`).
    let level = 0;
    let end = -1;
    for (let k = start + 2; k < text.length; k++) {
      if (text.startsWith('${', k)) {
        level++;
        k++;
      } else if (text[k] === '}') {
        if (level === 0) {
          end = k;
          break;
        }
        level--;
      }
    }
    if (end < 0) {
      out += text.slice(start);
      break;
    }
    const inner = text.slice(start + 2, end);
    const colon = topLevelColon(inner);
    const key = colon < 0 ? inner : inner.slice(0, colon);
    const fallback = colon < 0 ? undefined : inner.slice(colon + 1);
    const found = properties[key];
    const candidate = found ?? fallback;
    if (candidate === undefined || depth > 8) {
      unresolved.push(key);
      out += '${' + key + '}';
    } else {
      const nested = resolvePlaceholders(candidate, properties, depth + 1);
      unresolved.push(...nested.unresolved);
      out += nested.value;
    }
    i = end + 1;
  }
  return { value: out, resolved: unresolved.length === 0, unresolved };
}

function topLevelColon(text: string): number {
  let level = 0;
  for (let k = 0; k < text.length; k++) {
    if (text.startsWith('${', k)) {
      level++;
      k++;
    } else if (text[k] === '}') level--;
    else if (text[k] === ':' && level === 0) return k;
  }
  return -1;
}
