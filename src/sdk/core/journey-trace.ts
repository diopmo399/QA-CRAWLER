import type { ExecutionDataTraceView, ExecutionVerdict } from './contracts.js';

/**
 * LA TRAÇABILITÉ DES DONNÉES D'UN PARCOURS, en trois couches séparées :
 *   1. les DÉFINITIONS (statiques) : chaque donnée des contrats des blocs du parcours — type, sens, version,
 *      provenance, blocs producteurs et consommateurs ;
 *   2. les CORRESPONDANCES configurées : explicites (une entrée reliée à une clé), automatiques (même nom),
 *      données du jeu, variables d'itération — et les correspondances seulement SUGGÉRÉES, jamais confirmées ;
 *   3. les TRACES OBSERVÉES pendant une exécution réelle : chaque événement (génération, capture,
 *      transformation, itération, utilisation, écrasement refusé), relié à sa source.
 * Un statut « confirmé » n'existe que si l'exécution l'a observé : une production puis une utilisation de la
 * même occurrence de valeur. Rien n'est inventé : sans exécution, il n'y a que des définitions.
 */

/**
 * - CONFIRMED : produite puis utilisée, la même occurrence, dans l'exécution choisie ;
 * - PRODUCED_ONLY : produite, jamais utilisée dans cette exécution ;
 * - STATIC : une valeur fixe du jeu de données, utilisée (rien n'est produit pendant l'exécution) ;
 * - NOT_OBSERVED : définie dans les contrats, absente de la trace de l'exécution ;
 * - NO_EXECUTION : aucune exécution réelle de ce parcours : rien n'est observable ;
 * - MISSING : une entrée sans producteur sur au moins un chemin ;
 * - UNSUPPORTED : déclarée, mais aucune étape ne la produit ou le moteur ne sait pas la tracer.
 */
export const TRACE_STATUSES = [
  'CONFIRMED',
  'PRODUCED_ONLY',
  'STATIC',
  'NOT_OBSERVED',
  'NO_EXECUTION',
  'MISSING',
  'UNSUPPORTED',
] as const;
export type TraceStatus = (typeof TRACE_STATUSES)[number];

/** Un bloc (nœud du parcours ou élément d'une boucle) qui produit ou consomme une donnée. */
export interface TraceEndpoint {
  node: string;
  block: string;
  /** La version retenue par le parcours, et celle de la bibliothèque si elle diffère. */
  version?: number;
  libraryVersion?: number;
  /** Les étapes du bloc (positions) qui la produisent ou la lisent, d'après son contrat. */
  steps: number[];
  /** La clé du contrat du bloc, quand le parcours la relie à une autre clé (`with:`). */
  contractKey?: string;
  /** Le nœud de boucle qui contient ce bloc. */
  loop?: string;
}

export interface TraceVariable {
  /** La clé de la donnée dans le scénario (celle que la trace observe). */
  key: string;
  label?: string;
  type: string;
  typeSource?: string;
  meaning?: string;
  /** La version de la définition de la donnée (contrat du producteur). */
  version: number;
  /** GENERATED, CAPTURED, DATA, INPUT, ITERATION, VALUE (saisie dans le parcours). */
  origin: string;
  sensitive: boolean;
  producers: TraceEndpoint[];
  consumers: TraceEndpoint[];
  status: TraceStatus;
  /** Pourquoi ce statut : des faits (événements, contrats), jamais une supposition. */
  justification: string[];
  /** Ce que l'exécution choisie a observé. */
  observed?: {
    occurrences: { valueId: string; value?: string; masked?: boolean; withheld?: boolean }[];
    productions: number;
    uses: number;
    firstAt?: string;
    lastAt?: string;
  };
  /** Entrée manquante, collision, version incompatible, valeur périmée… */
  problems: string[];
}

/** Une correspondance du parcours : d'où une entrée reçoit sa donnée. */
export interface TraceCorrespondence {
  /** Le producteur (nœud), `data` (jeu d'un bloc), `loop:<nœud>` (variable d'itération), ou absent. */
  from?: string;
  fromKey?: string;
  to: string;
  toKey: string;
  /** EXPLICIT : reliée par une personne ; AUTOMATIC : même nom ; DATA : jeu de données ; LOOP : itération ;
   *  SUGGESTED : seulement proposée (jamais retenue sans validation) ; MISSING : rien ne la fournit. */
  kind: 'EXPLICIT' | 'AUTOMATIC' | 'DATA' | 'LOOP' | 'SUGGESTED' | 'MISSING';
  reason?: string;
  path?: number;
}

/** Un bloc du parcours, pour le bandeau du flux d'exécution (en haut de la vue). */
export interface TraceFlowNode {
  id: string;
  kind: 'START' | 'BLOCK' | 'WAIT' | 'LOOP' | 'CONDITION' | 'JOIN' | 'END';
  label: string;
  version?: number;
  inputs: string[];
  outputs: string[];
  /** BLOCK dans une boucle : la boucle qui le contient. */
  loop?: string;
}

/** Une exécution réelle de ce parcours (scénario créé ou exécution de simulation). */
export interface TraceRun {
  run: string;
  createdAt: string;
  verdict: ExecutionVerdict;
  simulation?: boolean;
  scenarios: string[];
}

/** Un événement observé, rattaché au nœud du parcours qui l'a produit ou lu (quand il est identifiable). */
export interface TraceEvent extends ExecutionDataTraceView {
  /** Le scénario (le chemin) dans lequel l'événement a eu lieu. */
  flow: string;
  /** Le nœud du parcours (bloc) ; absent si le bloc apparaît plusieurs fois sans être départagé. */
  node?: string;
}

export interface JourneyTraceability {
  journey: string;
  flow: { nodes: TraceFlowNode[]; edges: { from: string; to: string; data?: string[] }[] };
  variables: TraceVariable[];
  correspondences: TraceCorrespondence[];
  runs: TraceRun[];
  run?: TraceRun;
  events: TraceEvent[];
  /** OK : traces lues ; NO_EXECUTION : jamais exécuté ; NO_TRACES : exécution sans trace des données. */
  state: 'OK' | 'NO_EXECUTION' | 'NO_TRACES';
  /** Les limites connues de ce qui est montré (ex. un bloc répété sans départage). */
  notes: string[];
}
