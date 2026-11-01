/**
 * L'accès aux fichiers de l'analyse de code : la forme de `GuardedFiles`
 * (`src/incident/guarded-fs.ts`), déclarée ici pour que le moteur d'analyse ne dépende que de cette
 * forme (typage structurel). En production, c'est `guardedFiles(policy)` : chaque liste et chaque
 * lecture passent par le Scope Policy Engine.
 */
export interface GuardedFiles {
  /** Lecture d'un fichier autorisé ; lève une erreur (ScopeDeniedError, avec `decision`) sinon. */
  readText(path: string): Promise<string>;
  /** Fichiers (absolus, triés) sous `root` portant une des extensions ; limité par le périmètre. */
  list(root: string, options: { extensions: string[] }): Promise<string[]>;
  readonly denied: { path: string; reason: string }[];
  readonly truncated: string[];
}
