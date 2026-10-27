import type { ImportIssue, SourceKind, SourceLocation } from './model.js';

/**
 * LE DOCUMENT EXTRAIT : ce que tout connecteur rend, quel que soit le format. Des blocs dans l'ordre
 * de lecture, chacun avec son lieu dans la source ; aucune classification (c'est le rôle commun de
 * `classify.ts`). Les différences de format restent visibles : un lieu Excel a une feuille et une
 * cellule, un lieu PDF une page, un lieu Confluence une section.
 */
export type Block =
  | { type: 'heading'; level: number; text: string; location: SourceLocation }
  | { type: 'paragraph'; text: string; location: SourceLocation }
  | { type: 'list'; ordered: boolean; items: string[]; location: SourceLocation }
  | {
      type: 'table';
      header: string[];
      rows: string[][];
      location: SourceLocation;
      /** La cellule de chaque valeur, quand la source en a (Excel : « B4 »). */
      cells?: string[][];
    };

export interface ExtractedDocument {
  source: {
    kind: SourceKind;
    sourceId: string;
    title: string;
    uri?: string;
    version?: string;
    modifiedAt?: string;
    documentFingerprint?: string;
  };
  blocks: Block[];
  /** Métadonnées lisibles de la source (espace, auteur…), jamais un secret. */
  metadata: Record<string, string>;
  /** Liens trouvés dans le contenu (rien n'est suivi sans autorisation). */
  links: { text: string; target: string; location: SourceLocation }[];
  issues: ImportIssue[];
  /** COMPLETE : tout a été lu ; PARTIAL : une partie non lue (voir issues) ; EMPTY : aucun contenu. */
  completeness: 'COMPLETE' | 'PARTIAL' | 'EMPTY';
}

/** Un texte ramené à une ligne : espaces, sauts et insécables réduits. */
export function cleanText(text: string): string {
  return text
    .replace(/[\u00a0\u2007\u202f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
