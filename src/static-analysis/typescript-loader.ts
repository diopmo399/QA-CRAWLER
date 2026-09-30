import type * as TypeScript from 'typescript';

/**
 * Le compilateur TypeScript (déjà une dépendance du projet) sert de PARSEUR : il lit
 * le TypeScript et le JavaScript et rend un AST. Il n'exécute jamais le code analysé.
 * Chargé à la demande : sans analyse statique, il n'est jamais chargé ; absent de
 * l'installation, l'analyse est UNAVAILABLE et le crawler continue sans elle.
 */
export type TypeScriptModule = (typeof TypeScript)['default'];

let loaded: Promise<TypeScriptModule | undefined> | undefined;

export function loadTypeScript(): Promise<TypeScriptModule | undefined> {
  loaded ??= import('typescript').then((module) => module.default).catch(() => undefined);
  return loaded;
}
