import { describe, expect, it } from 'vitest';
import { incidentReproduction } from '../../src/sdk/core/incident-contracts.js';
import {
  DEMO_INCIDENT_ID,
  demoIncident,
  demoReport,
  demoSource,
  demoSourceTree,
  demoSources,
  isDemoIncident,
} from '../../src/sdk/ui/incident-demo.js';
import { workspaceLinks } from '../../src/sdk/ui/incident-links.js';

/**
 * LE JEU DE DÉMONSTRATION : tiré du vrai résultat de l'investigation de la fixture, fictif (un catalogue de
 * livres), cohérent (chaque relation relie des nœuds existants, chaque référence désigne une preuve ou
 * une requête existante, chaque fichier cité par le graphe est fourni), stable (identifiants, heures et
 * chemins fixes), sans chemin temporaire ni mot proscrit, marqué comme démonstration et jamais présenté
 * comme un diagnostic confirmé.
 */
describe('demonstration dataset', () => {
  const incident = demoIncident();
  const investigation = incident.investigation;
  const graph = investigation.graph;
  const text = JSON.stringify({ incident, tree: demoSourceTree(), sources: demoSources() });

  it('is marked as a demonstration and keeps the diagnosis exactly as found (probable, not confirmed)', () => {
    expect(incident.id).toBe(DEMO_INCIDENT_ID);
    expect(isDemoIncident(incident.id)).toBe(true);
    expect(isDemoIncident('inc_abc123def456')).toBe(false);
    expect(incident.projectId).toBe('demo');
    expect(incident.title.startsWith('[Démo] ')).toBe(true);
    expect(investigation.diagnosis?.status).toBe('PROBABLE');
    expect(investigation.hypotheses.some((hypothesis) => hypothesis.status === 'CONFIRMED')).toBe(false);
    // Le test de non-régression n'est jamais dit réussi sans exécution réelle.
    expect(investigation.regression?.execution?.passed).not.toBe(true);
    expect(demoReport().limitations[0]).toContain('Données de démonstration');
  });

  it('contains the whole investigation: graph, frontend trace, timeline, requests, hypotheses, experiments', () => {
    expect(graph?.nodes.length).toBeGreaterThan(10);
    expect(investigation.frontendTrace?.steps.length).toBeGreaterThan(0);
    expect(investigation.timeline?.length).toBeGreaterThan(10);
    expect(incidentReproduction(incident)?.requests.some((request) => request.status === 500)).toBe(true);
    expect(investigation.hypotheses.length).toBeGreaterThan(0);
    expect(investigation.experiments.length).toBeGreaterThan(0);
    expect(investigation.regression).toBeDefined();
  });

  it('is coherent: relations link existing nodes, references point at existing evidence and requests', () => {
    const nodes = new Set(graph?.nodes.map((node) => node.id));
    for (const edge of graph?.edges ?? []) {
      expect(nodes.has(edge.from), edge.from).toBe(true);
      expect(nodes.has(edge.to), edge.to).toBe(true);
    }
    const requests = new Set(
      investigation.reproductions.flatMap((run) => run.requests.map((request) => request.id)),
    );
    const evidence = new Set([
      ...investigation.reproductions.flatMap((run) => run.evidence.map((item) => item.id)),
      ...investigation.experiments.flatMap((experiment) => experiment.evidence.map((item) => item.id)),
    ]);
    const symbols = new Set(investigation.code?.symbols.map((symbol) => symbol.id));
    const runs = new Set(investigation.reproductions.map((run) => run.id));
    for (const event of investigation.timeline ?? []) {
      if (event.requestId) expect(requests.has(event.requestId), event.requestId).toBe(true);
      if (event.reproduction) expect(runs.has(event.reproduction), event.reproduction).toBe(true);
      for (const ref of event.evidence) expect(requests.has(ref) || evidence.has(ref), ref).toBe(true);
    }
    for (const node of graph?.nodes ?? [])
      for (const ref of node.evidence)
        expect(requests.has(ref) || evidence.has(ref) || symbols.has(ref) || runs.has(ref), ref).toBe(true);
    for (const run of investigation.reproductions)
      for (const action of run.actions)
        for (const id of action.requestIds) expect(requests.has(id), id).toBe(true);
    for (const step of investigation.frontendTrace?.steps ?? [])
      for (const request of step.requests) expect(requests.has(request.requestId)).toBe(true);
    const hypotheses = new Set(investigation.hypotheses.map((hypothesis) => hypothesis.id));
    if (investigation.diagnosis?.rootCause)
      expect(hypotheses.has(investigation.diagnosis.rootCause.hypothesisId)).toBe(true);
    // L'index de sélection se construit sans relation orpheline vers une requête inconnue.
    const links = workspaceLinks(incident);
    for (const key of links.neighbors.keys())
      if (key.startsWith('request:')) expect(requests.has(key.slice('request:'.length)), key).toBe(true);
  });

  it('provides the source files the graph cites, inside the scope tree, under 400 lines each', () => {
    const tree = demoSourceTree();
    const sources = demoSources();
    const files = new Set(
      tree.applications.flatMap((app) => app.files.map((file) => `${app.applicationId}:${file}`)),
    );
    for (const node of graph?.nodes ?? []) {
      if (!node.source) continue;
      const key = `${node.source.applicationId}:${node.source.file}`;
      expect(sources[key], key).toBeDefined();
      expect(files.has(key), key).toBe(true);
    }
    for (const [key, view] of Object.entries(sources)) {
      expect(`${view.applicationId}:${view.file}`).toBe(key);
      expect(view.text.split('\n').length).toBeLessThanOrEqual(400);
    }
    expect(
      demoSource('catalog', 'src/main/java/org/example/catalog/books/CatalogBookService.java')?.text,
    ).toContain('CatalogBookService');
    expect(demoSource('catalog', 'missing.java')).toBeUndefined();
  });

  it('is stable and neutral: fixed ids, times and paths; no temporary path, no forbidden word', () => {
    expect(text).not.toContain('/tmp');
    expect(text).not.toMatch(/inc_[A-Za-z0-9_-]{12}|prj_[A-Za-z0-9]{8,}|exp_[a-z0-9]{12,}/);
    expect(text).not.toMatch(/run-\d{4}-\d\d-\d\dT/);
    for (const app of incident.scope.applications)
      expect(app.repository.root.startsWith('/repos/')).toBe(true);
    expect(incident.createdAt.startsWith('2026-01-15T09:00')).toBe(true);
    // Une copie à chaque appel : l'interface peut la garder sans rien partager.
    const copy = demoIncident();
    copy.title = 'changé';
    expect(demoIncident().title).toBe(incident.title);
    expect(demoIncident()).toEqual(incident);
  });
});
