import path from 'node:path';
import type { AiRef, AiRefKind, AiSourceLocation } from '../../sdk/core/incident-ai-contracts.js';
import type { CodeIndex, Incident } from '../../sdk/core/incident-contracts.js';

/**
 * L'INDEX DES RÉFÉRENCES : tout ce qu'un agent a le DROIT de citer, parce que ça existe dans l'incident
 * (requêtes, preuves — y compris celles des expériences —, symboles, fichiers de l'index de code ou lus
 * par un outil pendant le run, nœuds et arêtes du graphe, hypothèses, expériences, étapes). Une
 * référence inconnue est une raison de rejet : jamais une localisation fabriquée.
 *
 * Identifiants acceptés :
 * - `evidence` : un `Evidence.id` (reproductions, expériences) ou un échange HTTP (`HttpExchange.id`) ;
 * - `request` : un `HttpExchange.id` ;
 * - `symbol` : un `CodeSymbol.id` (`app:fichier#Nom`) ;
 * - `file` : `app:chemin/relatif` ou le seul chemin relatif (« / »), connu de l'index ou lu pendant le run ;
 * - `node` : `GraphNode.id` ; `edge` : `from->to` ;
 * - `hypothesis`, `experiment` : leurs ids ;
 * - `step` : `reproduction:step-N`, `reproduction:N` ou `N` (index 1-based d'une action rejouée).
 */
export interface RefIndexFile {
  applicationId: string;
  /** Relatif à la racine du dépôt, séparateur « / ». */
  file: string;
}

export const EDGE_SEPARATOR = '->';

/** `from->to` : l'identifiant d'une arête (le contrat n'en a pas). */
export const edgeId = (from: string, to: string): string => `${from}${EDGE_SEPARATOR}${to}`;

/** Un chemin relatif normalisé : séparateur « / », sans « ./ » initial ni « / » final. */
export function normalizeRelativeFile(file: string): string {
  let value = file.trim().replace(/\\/g, '/');
  while (value.startsWith('./')) value = value.slice(2);
  value = value.replace(/\/{2,}/g, '/');
  if (value.endsWith('/')) value = value.slice(0, -1);
  return value;
}

export class RefIndex {
  private readonly sets: Record<AiRefKind, Set<string>> = {
    evidence: new Set(),
    request: new Set(),
    symbol: new Set(),
    file: new Set(),
    node: new Set(),
    edge: new Set(),
    hypothesis: new Set(),
    experiment: new Set(),
    step: new Set(),
  };
  /** `app:fichier` → les symboles déclarés dans ce fichier (ids et noms simples). */
  private readonly symbolsByFile = new Map<string, Set<string>>();
  private readonly applications = new Set<string>();
  private readonly roots = new Map<string, string>();
  private readonly readFiles: RefIndexFile[] = [];

  constructor(incident: Incident, files: Iterable<RefIndexFile> = []) {
    this.index(incident);
    for (const file of files) this.addFile(file.applicationId, file.file);
  }

  /** Les fichiers ajoutés après la construction (lus par les outils pendant le run). */
  get filesRead(): readonly RefIndexFile[] {
    return this.readFiles;
  }

  /** Les identifiants connus d'une sorte (pour un paquet de preuves ou un test). */
  ids(kind: AiRefKind): string[] {
    return [...this.sets[kind]].sort();
  }

  /** Un fichier lu par un outil pendant le run devient citable (chemin absolu accepté s'il est sous une racine). */
  addFile(applicationId: string, file: string): void {
    const relative = this.relativeOf(applicationId, file);
    if (relative === undefined || relative === '') return;
    const key = `${applicationId}:${relative}`;
    if (!this.sets.file.has(key)) this.readFiles.push({ applicationId, file: relative });
    this.sets.file.add(key);
    this.sets.file.add(relative);
    this.applications.add(applicationId);
  }

  has(ref: AiRef): boolean {
    if (typeof ref.id !== 'string' || ref.id.trim() === '') return false;
    const set = this.sets[ref.kind] as Set<string> | undefined;
    if (!set) return false;
    const id = ref.id.trim();
    switch (ref.kind) {
      case 'file':
        return set.has(id) || set.has(normalizeRelativeFile(id));
      case 'edge':
        return set.has(id) || set.has(id.replace(/\s*(→|->|=>)\s*/, EDGE_SEPARATOR));
      case 'step':
        return set.has(id) || set.has(this.stepAlias(id));
      default:
        return set.has(id);
    }
  }

  /** Un endroit du code : application connue, fichier connu, ligne ≥ 1, symbole déclaré dans ce fichier quand l'index en a. */
  hasLocation(location: AiSourceLocation): boolean {
    return this.locationProblem(location) === undefined;
  }

  /** La raison pour laquelle une localisation est refusée ; undefined quand elle existe. */
  locationProblem(location: AiSourceLocation): string | undefined {
    if (typeof location.applicationId !== 'string' || !this.applications.has(location.applicationId))
      return `application inconnue « ${location.applicationId} »`;
    if (typeof location.file !== 'string' || location.file.trim() === '') return 'fichier manquant';
    const relative = this.relativeOf(location.applicationId, location.file);
    if (relative === undefined)
      return `fichier hors du dépôt de « ${location.applicationId} » : « ${location.file} »`;
    const key = `${location.applicationId}:${relative}`;
    if (!this.sets.file.has(key)) return `fichier inconnu « ${key} »`;
    if (location.line !== undefined && (!Number.isInteger(location.line) || location.line < 1))
      return `ligne invalide « ${String(location.line)} » dans « ${key} »`;
    if (location.symbol !== undefined && location.symbol !== '') {
      const declared = this.symbolsByFile.get(key);
      if (
        declared &&
        declared.size > 0 &&
        !declared.has(location.symbol) &&
        !this.sets.symbol.has(location.symbol)
      )
        return `symbole inconnu « ${location.symbol} » dans « ${key} »`;
    }
    return undefined;
  }

  /** Les raisons de rejet d'une sortie (vide : toutes les références et localisations existent). */
  validateRefs(refs: readonly AiRef[] = [], locations: readonly AiSourceLocation[] = []): string[] {
    const reasons: string[] = [];
    const seen = new Set<string>();
    for (const ref of refs) {
      const kind = typeof ref.kind === 'string' ? ref.kind : String(ref.kind);
      const id = typeof ref.id === 'string' ? ref.id : String(ref.id);
      const key = `${kind}:${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!(kind in this.sets)) reasons.push(`sorte de référence inconnue « ${kind} » (${id})`);
      else if (!this.has({ kind: kind as AiRefKind, id }))
        reasons.push(`référence inconnue ${kind} « ${id} »`);
    }
    for (const location of locations) {
      const problem = this.locationProblem(location);
      if (problem !== undefined) {
        const text = `localisation refusée : ${problem}`;
        if (!reasons.includes(text)) reasons.push(text);
      }
    }
    return reasons;
  }

  // ── Construction ─────────────────────────────────────────────────────────────────────────────

  private index(incident: Incident): void {
    for (const application of incident.scope.applications) {
      this.applications.add(application.id);
      this.roots.set(application.id, path.resolve(application.repository.root));
    }
    const investigation = incident.investigation;
    for (const reproduction of investigation.reproductions) {
      for (const request of reproduction.requests) {
        this.sets.request.add(request.id);
        this.sets.evidence.add(request.id);
      }
      for (const evidence of reproduction.evidence) this.sets.evidence.add(evidence.id);
      for (const action of reproduction.actions) {
        this.sets.step.add(`${reproduction.id}:step-${action.index}`);
        this.sets.step.add(`${reproduction.id}:${action.index}`);
        this.sets.step.add(String(action.index));
      }
    }
    for (const hypothesis of investigation.hypotheses) this.sets.hypothesis.add(hypothesis.id);
    for (const experiment of investigation.experiments) {
      this.sets.experiment.add(experiment.id);
      for (const evidence of experiment.evidence) this.sets.evidence.add(evidence.id);
    }
    if (investigation.code) this.indexCode(investigation.code);
    if (investigation.graph) {
      for (const node of investigation.graph.nodes) {
        this.sets.node.add(node.id);
        if (node.source) this.addFile(node.source.applicationId, node.source.file);
      }
      for (const edge of investigation.graph.edges) this.sets.edge.add(edgeId(edge.from, edge.to));
    }
    if (investigation.frontendTrace) {
      for (const step of investigation.frontendTrace.steps) {
        this.sets.step.add(`${investigation.frontendTrace.reproduction}:step-${step.index}`);
        this.sets.step.add(String(step.index));
      }
    }
    for (const event of investigation.timeline ?? []) {
      if (event.source) this.addFile(event.source.applicationId, event.source.file);
    }
  }

  private indexCode(code: CodeIndex): void {
    for (const application of code.applications) this.applications.add(application.id);
    for (const symbol of code.symbols) {
      this.sets.symbol.add(symbol.id);
      this.addFile(symbol.applicationId, symbol.file);
      const key = `${symbol.applicationId}:${normalizeRelativeFile(symbol.file)}`;
      const declared = this.symbolsByFile.get(key) ?? new Set<string>();
      declared.add(symbol.id);
      declared.add(symbol.name);
      const simple = symbol.name.split('.').at(-1);
      if (simple) declared.add(simple);
      this.symbolsByFile.set(key, declared);
    }
    for (const outgoing of code.outgoing) this.addFile(outgoing.applicationId, outgoing.file);
    for (const call of code.calls) {
      const owner = call.from.split(':')[0];
      if (owner) this.addFile(owner, call.file);
    }
  }

  /** Le chemin relatif d'un fichier d'une application ; undefined s'il est absolu hors de sa racine. */
  private relativeOf(applicationId: string, file: string): string | undefined {
    const value = file.trim().replace(/\\/g, '/');
    if (path.isAbsolute(value) || /^[A-Za-z]:\//.test(value)) {
      const root = this.roots.get(applicationId);
      if (root === undefined) return undefined;
      const relative = path.relative(root, path.resolve(value));
      if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
      return normalizeRelativeFile(relative.split(path.sep).join('/'));
    }
    const relative = normalizeRelativeFile(value);
    if (relative.split('/').includes('..')) return undefined;
    return relative;
  }

  private stepAlias(id: string): string {
    const match = /^(.+?):step-(\d+)$/.exec(id);
    return match ? `${match[1] ?? ''}:${match[2] ?? ''}` : id;
  }
}

/** Les raisons de rejet des références et localisations d'une sortie (vide = valide). */
export function validateRefs(
  index: RefIndex,
  refs: readonly AiRef[] = [],
  locations: readonly AiSourceLocation[] = [],
): string[] {
  return index.validateRefs(refs, locations);
}
