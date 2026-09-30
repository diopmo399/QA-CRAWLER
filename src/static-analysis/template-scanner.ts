/**
 * Lecture ciblée d'un gabarit Angular (HTML) : les éléments reliés à un contrôle de
 * formulaire (formControlName, [formControl]) et les liens de navigation (routerLink).
 * Ce n'est pas un parseur HTML général : seules les balises ouvrantes et leurs
 * attributs sont lus, ce qui suffit à ces deux faits. Rien n'est exécuté.
 */

export interface TemplateControl {
  control: string;
  tag: string;
  inputType?: string;
  line: number;
}

export interface TemplateLink {
  target: string;
  line: number;
}

export interface TemplateFacts {
  controls: TemplateControl[];
  links: TemplateLink[];
}

const TAG = /<([a-zA-Z][\w-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*\/?>/g;
const ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

export function scanTemplate(html: string): TemplateFacts {
  const controls: TemplateControl[] = [];
  const links: TemplateLink[] = [];
  const lineAt = lineIndex(html);
  for (const tag of html.matchAll(TAG)) {
    const name = (tag[1] ?? '').toLowerCase();
    const attributes = new Map<string, string>();
    for (const attribute of (tag[2] ?? '').matchAll(ATTRIBUTE))
      attributes.set((attribute[1] ?? '').toLowerCase(), attribute[2] ?? attribute[3] ?? attribute[4] ?? '');
    const line = lineAt(tag.index);
    const control = controlOf(attributes);
    if (control)
      controls.push({
        control,
        tag: name,
        ...(attributes.get('type') ? { inputType: attributes.get('type')?.toLowerCase() } : {}),
        line,
      });
    const link = linkOf(attributes);
    if (link) links.push({ target: link, line });
  }
  return { controls, links };
}

function controlOf(attributes: Map<string, string>): string | undefined {
  const plain = attributes.get('formcontrolname');
  if (plain && /^[\w$]+$/.test(plain)) return plain;
  const bound = attributes.get('[formcontrolname]');
  const quoted = bound ? /^\s*['"]([\w$]+)['"]\s*$/.exec(bound)?.[1] : undefined;
  if (quoted) return quoted;
  // [formControl]="form.controls.email" / "form.controls['email']" / "form.get('email')"
  const direct = attributes.get('[formcontrol]');
  if (direct) {
    const match =
      /controls\.([\w$]+)\s*$/.exec(direct) ??
      /controls\[\s*['"]([\w$]+)['"]\s*\]\s*$/.exec(direct) ??
      /\.get\(\s*['"]([\w$]+)['"]\s*\)\s*$/.exec(direct);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function linkOf(attributes: Map<string, string>): string | undefined {
  const plain = attributes.get('routerlink');
  if (plain && !plain.includes('{')) return plain.trim();
  const bound = attributes.get('[routerlink]');
  if (!bound) return undefined;
  const single = /^\s*['"]([^'"]+)['"]\s*$/.exec(bound)?.[1];
  if (single) return single;
  const array = /^\s*\[(.*)\]\s*$/.exec(bound)?.[1];
  if (!array) return undefined;
  const parts = array.split(',').map((part) => part.trim());
  const segments = parts.map((part) => /^['"]([^'"]+)['"]$/.exec(part)?.[1] ?? ':param');
  if (segments.every((segment) => segment === ':param')) return undefined;
  return segments.join('/').replace(/\/{2,}/g, '/');
}

function lineIndex(text: string): (offset: number) => number {
  const starts = [0];
  for (let index = 0; index < text.length; index++) if (text[index] === '\n') starts.push(index + 1);
  return (offset) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if ((starts[middle] ?? 0) <= offset) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };
}
