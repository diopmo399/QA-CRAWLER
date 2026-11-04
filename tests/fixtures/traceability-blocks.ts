import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Journey, LibraryBlockView } from '../../src/sdk/core/index.js';

/**
 * LES BLOCS ET LE PARCOURS DE RÉFÉRENCE DE LA TRAÇABILITÉ (application de test `loop-app`) : créer une société
 * (nom généré, identifiant capturé), attente de confirmation, créer un dossier (lit nom et identifiant, capture
 * l'identifiant du dossier dans la réponse HTTP), pour chaque personne : ajouter la personne, vérifier le statut.
 */
export const TRACE_BLOCKS: Record<string, { flow: string; data?: string }> = {
  'create-company': {
    flow: `name: Create company\nstartAt: /\nreusable: true\ntestData: test-data.yaml\nsteps:\n  - goto: /\n  - click: { role: button, name: New company }\n    allow: MUTATION\n  - fill: { label: Company name, value: { testData: company.name } }\n  - click: { role: button, name: Create company }\n    allow: MUTATION\n  - expect: { text: Company created }\n    timeoutMs: 5000\n  - capture: { as: company.id, text: { css: "#company-id" } }\n`,
    data: 'values:\n  company:\n    name: { strategy: generated, generator: company }\n',
  },
  'create-request': {
    flow: `name: Create request\nreusable: true\nsteps:\n  - click: { role: button, name: New request }\n    allow: MUTATION\n  - fill: { label: Request title, value: "Onboarding \${testData:company.id}" }\n  - fill: { label: Company, value: "\${testData:company.name}" }\n  - click: { role: button, name: Create request }\n    allow: MUTATION\n  - capture: { as: request.id, response: { method: POST, url: /api/requests, field: id } }\n  - expect: { text: Status DRAFT }\n`,
  },
  'add-person': {
    flow: `name: Add person\nreusable: true\nsteps:\n  - fill: { label: First name, value: "\${testData:person.firstName}" }\n  - fill: { label: Last name, value: "\${testData:person.lastName}" }\n  - fill: { label: Email, value: "\${testData:person.email}" }\n  - click: { role: button, name: Add person }\n    allow: MUTATION\n  - expect: { text: "\${testData:person.firstName} \${testData:person.lastName}" }\n    timeoutMs: 5000\n`,
  },
  'check-status': {
    flow: `name: Check request status\nreusable: true\nsteps:\n  - expect: { text: Status COMPLETE }\n  - expect: { text: "\${testData:company.name}" }\n  - expect: { text: "Request \${testData:request.id}" }\n`,
  },
  'other-company': {
    flow: `name: Name another company\nreusable: true\ntestData: test-data.yaml\nsteps:\n  - fill: { label: Company name, value: { testData: company.name } }\n`,
    data: 'values:\n  company:\n    name: { strategy: literal, value: Fixed Name }\n',
  },
};

/** Écrit les blocs dans le dossier des flows d'un projet. */
export async function writeTraceBlocks(flows: string): Promise<void> {
  for (const [folder, block] of Object.entries(TRACE_BLOCKS)) {
    await mkdir(path.join(flows, folder), { recursive: true });
    await writeFile(path.join(flows, folder, `${folder}.flow.yaml`), block.flow);
    if (block.data) await writeFile(path.join(flows, folder, 'test-data.yaml'), block.data);
  }
}

/** Le parcours de référence, avec les versions actuelles des blocs. */
export function traceJourney(blocks: readonly LibraryBlockView[], name = 'Request traceability'): Journey {
  const version = (block: string): number => blocks.find((entry) => entry.name === block)?.version ?? 1;
  const block = (id: string, name: string, y: number) => ({
    id,
    kind: 'BLOCK' as const,
    block: name,
    version: version(name),
    x: 0,
    y,
  });
  return {
    name,
    mode: 'LINEAR',
    graph: {
      nodes: [
        { id: 'n1', kind: 'START', x: 0, y: 0 },
        block('n3', 'Create company', 100),
        {
          id: 'n4',
          kind: 'WAIT',
          wait: { type: 'TEXT', text: 'Company created', timeoutS: 10, onTimeout: 'FAIL' },
          x: 0,
          y: 200,
        },
        block('n5', 'Create request', 300),
        {
          id: 'n6',
          kind: 'LOOP',
          loop: {
            type: 'FOR_EACH',
            as: 'person',
            items: [
              { firstName: 'Ada', lastName: 'Byron', email: 'ada@example.test' },
              { firstName: 'Alan', lastName: 'Turing', email: 'alan@example.test' },
              { firstName: 'Grace', lastName: 'Hopper', email: 'grace@example.test' },
            ],
            maxIterations: 3,
            timeoutS: 120,
            onFailure: 'STOP',
            body: [{ id: 'n6i1', kind: 'BLOCK', block: 'Add person', version: version('Add person') }],
          },
          x: 0,
          y: 400,
        },
        block('n7', 'Check request status', 500),
        { id: 'n2', kind: 'END', x: 0, y: 600 },
      ],
      edges: [
        { id: 'e1', from: 'n1', to: 'n3' },
        { id: 'e2', from: 'n3', to: 'n4' },
        { id: 'e3', from: 'n4', to: 'n5' },
        { id: 'e4', from: 'n5', to: 'n6' },
        { id: 'e5', from: 'n6', to: 'n7' },
        { id: 'e6', from: 'n7', to: 'n2' },
      ],
    },
  };
}
