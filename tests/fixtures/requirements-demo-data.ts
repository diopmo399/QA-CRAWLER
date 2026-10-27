import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDocx, buildXlsx, wp, wtable } from './office-builder.js';
import { buildPdf } from './pdf-builder.js';

/**
 * LES DONNÉES DE LA DÉMONSTRATION des exigences (examples/requirements-demo) : une médiathèque
 * fictive. Tout le contenu est inventé. Les fichiers sont écrits par les mêmes générateurs que les
 * tests (de vrais .docx, .xlsx et .pdf, lus par les connecteurs comme n'importe quel document).
 *
 *   npx tsx tests/fixtures/requirements-demo-data.ts [dossier]   (défaut : examples/requirements-demo/data)
 *
 * Ce que chaque document fait apparaître dans la démonstration :
 *   - la spécification Word v1 : exigences, règles et critères rangés par section (parents proposés),
 *     un tableau, une phrase normative sans identifiant (à classer par une personne) ;
 *   - le classeur Excel : de nouvelles exigences, un identifiant déjà pris par le document Word
 *     (conflit), une exigence sans identifiant proche d'une exigence existante (doublon probable) ;
 *   - l'annexe PDF : des exigences non fonctionnelles ;
 *   - la spécification Word v2 : une exigence modifiée, une retirée, une nouvelle.
 */
export interface DemoFile {
  name: string;
  data: Buffer;
}

function specification(version: 1 | 2): Buffer {
  const reminder =
    version === 1
      ? 'REQ-103 Le système doit envoyer un rappel à l’abonné deux jours avant la date de retour.'
      : 'REQ-103 Le système doit envoyer un rappel à l’abonné trois jours avant la date de retour.';
  return buildDocx(
    [
      wp('Médiathèque des Quatre Vents — prêts et réservations', { style: 'Heading1' }),
      wp(`Spécification fictive de démonstration. Version ${String(version)}.`),

      wp('Réserver un document', { style: 'Titre2' }),
      wp('REQ-101 Le système doit permettre à un abonné de réserver un document disponible.'),
      wp('RG-11 Une réservation non retirée sous sept jours est annulée.'),
      wp(
        'CA-101 Étant donné un document disponible, quand l’abonné le réserve, alors le document passe à l’état réservé.',
      ),

      wp('Emprunter un document', { style: 'Titre2' }),
      wp('REQ-102 Le système doit enregistrer le prêt d’un document à un abonné.'),
      wp('RG-12 Un abonné ne peut pas avoir plus de cinq prêts en cours.'),
      wp(
        'CA-102 Étant donné un abonné avec cinq prêts en cours, quand il emprunte un sixième document, alors le prêt est refusé.',
      ),
      ...(version === 1
        ? [
            wp(
              'CA-103 Étant donné un prêt enregistré, quand l’abonné consulte son compte, alors la date de retour prévue est affichée.',
            ),
          ]
        : []),

      wp('Rendre et prolonger', { style: 'Titre2' }),
      wp(reminder),
      wtable([
        ['ID', 'Titre', 'Priorité'],
        ['REQ-104', 'Prolonger un prêt une seule fois', 'Moyenne'],
      ]),
      wp('Un document en retard ne doit pas pouvoir être prolongé.'),
      ...(version === 2
        ? [
            wp('Amendes', { style: 'Titre2' }),
            wp('REQ-107 Le système doit calculer une pénalité de retard par jour et par document.'),
          ]
        : []),
    ].join(''),
    {
      title: 'Médiathèque — prêts et réservations (fictif)',
      modified: version === 1 ? '2026-09-14T09:00:00Z' : '2026-10-21T15:30:00Z',
    },
  );
}

function workbook(): Buffer {
  return buildXlsx(
    [
      {
        name: 'Exigences',
        rows: [
          ['Médiathèque — exigences du portail (fictif)'],
          ['ID', 'Titre', 'Priorité', 'Règle métier'],
          ['REQ-105', 'Rechercher un document par titre ou par auteur', 'Haute', null],
          [
            'REQ-106',
            'Consulter l’historique de ses prêts',
            'Basse',
            'L’historique couvre les 24 derniers mois',
          ],
          ['REQ-102', 'Enregistrer un prêt depuis le portail', 'Haute', null],
          [null, 'Le système doit permettre à l’abonné de réserver tout document disponible', 'Haute', null],
        ],
        merges: ['A1:D1'],
      },
      {
        name: 'Critères',
        rows: [
          ['ID', 'Exigence', 'Critère'],
          [
            'CA-105',
            'REQ-105',
            'Étant donné un catalogue, quand l’abonné cherche « Verne », alors les titres de cet auteur sont listés.',
          ],
        ],
      },
    ],
    { title: 'Médiathèque — exigences du portail (fictif)' },
  );
}

function annex(): Buffer {
  return buildPdf(
    [
      {
        lines: [
          [18, 'Annexe — qualité de service (fictif)'],
          [11, 'Ces exigences valent pour le portail public de la médiathèque.'],
          [14, 'Accessibilité'],
          [11, 'ENF-01 Les pages publiques doivent respecter le niveau AA des règles d’accessibilité.'],
          [14, 'Performance'],
          [11, 'ENF-02 La recherche doit répondre en moins de deux secondes pour 95 % des requêtes.'],
          [11, 'ENF-03 Le portail doit rester disponible 99,5 % du temps sur un mois.'],
        ],
      },
    ],
    { title: 'Annexe qualite de service (fictif)' },
  );
}

export function demoFiles(): DemoFile[] {
  return [
    { name: 'mediatheque-specification-v1.docx', data: specification(1) },
    { name: 'mediatheque-portail.xlsx', data: workbook() },
    { name: 'mediatheque-annexe-qualite.pdf', data: annex() },
    { name: 'mediatheque-specification-v2.docx', data: specification(2) },
  ];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = path.resolve(process.argv[2] ?? 'examples/requirements-demo/data');
  await mkdir(out, { recursive: true });
  for (const file of demoFiles()) {
    await writeFile(path.join(out, file.name), file.data);
    console.log(`${file.name} (${String(file.data.length)} octets)`);
  }
}
