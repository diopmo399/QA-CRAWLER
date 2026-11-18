/**
 * Les flèches des diagrammes du parcours, dans le style d'Archify : tracé à angle droit (horizontal puis
 * vertical puis horizontal, ou l'inverse), coins arrondis, pointe 10 × 7 (à taille fixe, même sur un trait épaissi), et quatre classes de trait —
 * `emphasis` (vert, le chemin démontré, parcouru d'une comète), `default` (ardoise), `dashed` (violet,
 * tirets) et `security` (rose, tirets) — plus `gap` (pointillés gris) pour une relation non démontrée.
 * Fonctions pures : les diagrammes calculés au rendu et le tracé après rendu de l'architecture s'en servent.
 */

/** Les classes de flèche. */
export const ARROW_ROLES = ['emphasis', 'default', 'dashed', 'security', 'gap'] as const;
export type ArrowRole = (typeof ARROW_ROLES)[number];

export interface Pt {
  x: number;
  y: number;
}

/** L'orientation d'un tracé : `h` (H-V-H), `v` (V-H-V), `hv` (un coude), `vh` (un coude). */
export type Orient = 'h' | 'v' | 'hv' | 'vh';

const f = (n: number): string => (Math.round(n * 10) / 10).toString();

/**
 * Le tracé orthogonal d'une flèche de `a` à `b`, coudé au milieu (ou à `c`, abscisse pour `h`, ordonnée
 * pour `v`), et le point où poser son étiquette : au milieu du segment central.
 */
export function orthPath(a: Pt, b: Pt, o: Orient = 'h', c?: number): { d: string; mid: Pt } {
  if (o === 'hv')
    return {
      d: `M${f(a.x)} ${f(a.y)}L${f(b.x)} ${f(a.y)}L${f(b.x)} ${f(b.y)}`,
      mid: { x: (a.x + b.x) / 2, y: a.y },
    };
  if (o === 'vh')
    return {
      d: `M${f(a.x)} ${f(a.y)}L${f(a.x)} ${f(b.y)}L${f(b.x)} ${f(b.y)}`,
      mid: { x: (a.x + b.x) / 2, y: b.y },
    };
  if (o === 'h') {
    if (Math.abs(a.y - b.y) < 0.5)
      return { d: `M${f(a.x)} ${f(a.y)}L${f(b.x)} ${f(b.y)}`, mid: { x: (a.x + b.x) / 2, y: a.y } };
    const mx = c ?? (a.x + b.x) / 2;
    return {
      d: `M${f(a.x)} ${f(a.y)}L${f(mx)} ${f(a.y)}L${f(mx)} ${f(b.y)}L${f(b.x)} ${f(b.y)}`,
      mid: { x: mx, y: (a.y + b.y) / 2 },
    };
  }
  if (Math.abs(a.x - b.x) < 0.5)
    return { d: `M${f(a.x)} ${f(a.y)}L${f(b.x)} ${f(b.y)}`, mid: { x: a.x, y: (a.y + b.y) / 2 } };
  const my = c ?? (a.y + b.y) / 2;
  return {
    d: `M${f(a.x)} ${f(a.y)}L${f(a.x)} ${f(my)}L${f(b.x)} ${f(my)}L${f(b.x)} ${f(b.y)}`,
    mid: { x: (a.x + b.x) / 2, y: my },
  };
}

/** Les pointes de flèche, une par classe (identifiants préfixés : plusieurs diagrammes peuvent coexister). */
export function arrowMarkers(prefix: string): string {
  return `<defs>${ARROW_ROLES.map((r) => `<marker id="${prefix}-${r}" class="ah ah-${r}" viewBox="0 0 10 7" markerUnits="userSpaceOnUse" markerWidth="13" markerHeight="9.1" refX="9" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7"/></marker>`).join('')}</defs>`;
}

/** Une flèche : sa classe, son état de mise en avant (`on`, `off` ou rien) et, si elle en a une, sa comète. */
export interface ArrowSpec {
  d: string;
  role: ArrowRole;
  state?: 'on' | 'off';
  /** Le rang de la comète (décalage de départ) ; absent : pas de comète. */
  comet?: number;
  /** Attributs `data-*` supplémentaires (ex. `data-from="3"`), déjà échappés. */
  data?: string;
}

/**
 * Le SVG d'une flèche. La comète d'Archify : un halo flou et une tête vive qui parcourent le trait, les
 * flèches successives l'une après l'autre ; elle se tait quand la flèche est estompée.
 */
export function arrowSvg(prefix: string, a: ArrowSpec): string {
  const st = a.state ? ` ${a.state}` : '';
  const path = `<path class="dg-e r-${a.role}${st}" d="${a.d}" marker-end="url(#${prefix}-${a.role})"${a.data ?? ''}/>`;
  if (a.comet === undefined || a.state === 'off') return path;
  const delay = `animation-delay:${(a.comet * 0.35).toFixed(2)}s`;
  return `${path}<path class="dg-c glow${st}" d="${a.d}" pathLength="100" style="${delay}"/><path class="dg-c head${st}" d="${a.d}" pathLength="100" style="${delay}"/>`;
}

/** Les règles CSS communes aux flèches (à inclure une fois dans la feuille du tableau de bord). */
export const ARROW_CSS = `
.dg-e{fill:none;stroke-linejoin:round;stroke-linecap:round;transition:opacity .25s ease,stroke-width .2s ease}
.dg-e.r-emphasis{stroke:#059669;stroke-width:1.8}
.dg-e.r-default{stroke:#64748b;stroke-width:1.4}
.dg-e.r-dashed{stroke:#7c3aed;stroke-width:1.4;stroke-dasharray:4 4}
.dg-e.r-security{stroke:#e11d48;stroke-width:1.4;stroke-dasharray:5 5}
.dg-e.r-gap{stroke:#94a3b8;stroke-width:1.4;stroke-dasharray:2 4}
.dg-e.on{stroke-width:2.6}.dg-e.off{opacity:.12}
.ah-emphasis polygon{fill:#059669}.ah-default polygon{fill:#64748b}.ah-dashed polygon{fill:#7c3aed}
.ah-security polygon{fill:#e11d48}.ah-gap polygon{fill:#94a3b8}
.dg-c{fill:none;stroke-linecap:round;pointer-events:none;animation:dg-comet 4s linear infinite backwards;transition:opacity .25s}
.dg-c.glow{stroke:#059669;stroke-width:8;stroke-dasharray:12 88;filter:blur(2.5px);opacity:.38}
.dg-c.head{stroke:#035f43;stroke-width:2.8;stroke-dasharray:5 95}
.dg-c.on{animation-duration:2s}
@keyframes dg-comet{from{stroke-dashoffset:100}to{stroke-dashoffset:0}}
@media (prefers-reduced-motion:reduce){.dg-c{display:none}.dg-e{transition:none}}
`;
