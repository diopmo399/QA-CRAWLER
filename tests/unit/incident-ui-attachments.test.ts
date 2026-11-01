import { describe, expect, it } from 'vitest';
import { MAX_ATTACHMENTS, type IncidentAttachment } from '../../src/sdk/core/incident-contracts.js';
import {
  attachmentSize,
  emptyAttachmentsUi,
  INCIDENT_ATTACHMENTS_CSS,
  reduceAttachments,
  renderAttachmentsCard,
  renderAttachmentView,
  withoutAttachment,
} from '../../src/sdk/ui/incident-attachments.js';
import { demoIncident } from '../../src/sdk/ui/incident-demo.js';
import { workspaceLinks } from '../../src/sdk/ui/incident-links.js';
import { workspaceContext, type WorkspaceContext } from '../../src/sdk/ui/incident-parts.js';

/**
 * LES PIÈCES JOINTES DE L'ESPACE D'INVESTIGATION : la carte « Pièces jointes (n) » (nom, type, taille,
 * ajoutée par / le), l'aperçu dans le panneau des détails (image `data:` seulement, texte masqué par le
 * serveur, états de lecture), le retrait confirmé dans la page, l'ajout selon les droits ; la démonstration
 * dit son contenu généré et n'ajoute ni ne retire rien.
 */
const item = (over: Partial<IncidentAttachment> = {}): IncidentAttachment => ({
  id: 'att_1',
  name: 'capture.png',
  type: 'image/png',
  bytes: 2048,
  addedAt: '2026-01-15T09:00:00.000Z',
  addedBy: 'ana',
  ...over,
});

function ctxOf(
  attachments: IncidentAttachment[],
  options: { run?: boolean; demo?: boolean; lang?: 'fr' | 'en' } = {},
): WorkspaceContext {
  const incident = { ...demoIncident(), id: 'inc_realincident1', attachments };
  return workspaceContext({
    incident,
    lang: options.lang ?? 'fr',
    links: workspaceLinks(incident),
    demo: options.demo ?? false,
    demoInShell: true,
    can: (right) => right !== 'RUN' || options.run !== false,
  });
}

describe('attachments — the card', () => {
  it('lists each attachment with its name, type, size and author; each name opens the preview', () => {
    const html = renderAttachmentsCard(
      ctxOf([item(), item({ id: 'att_2', name: 'console.txt', type: 'text/plain', bytes: 300 })]),
      emptyAttachmentsUi(),
    );
    expect(html).toContain('Pièces jointes (2)');
    expect(html).toContain('data-action="ws-att-open" data-ref="att_1" aria-pressed="false"');
    expect(html).toContain('<code>image/png</code>');
    expect(html).toContain('2 Kio');
    expect(html).toContain('300 o');
    expect(html).toContain('par ana');
    expect(html).toContain('data-action="ws-att-remove" data-ref="att_2"');
    expect(html).toContain(
      'type="file" id="ws-att-file" class="ws-att-file" data-action="ws-att-add" multiple',
    );
    expect(html).toContain('aria-describedby="ws-att-h"');
    const open = renderAttachmentsCard(ctxOf([item()]), { ...emptyAttachmentsUi(), open: 'att_1' });
    expect(open).toContain('aria-pressed="true"');
    expect(renderAttachmentsCard(ctxOf([]), emptyAttachmentsUi())).toContain('Aucune pièce jointe');
  });

  it('removal is confirmed in the page; the busy operation disables the buttons', () => {
    const confirming = renderAttachmentsCard(ctxOf([item()]), {
      ...emptyAttachmentsUi(),
      confirmRemove: 'att_1',
    });
    expect(confirming).toContain('data-action="ws-att-remove-yes" data-ref="att_1"');
    expect(confirming).toContain('data-action="ws-att-remove-no" data-ref="att_1"');
    expect(confirming).not.toContain('data-action="ws-att-remove" ');
    const busy = renderAttachmentsCard(ctxOf([item()]), emptyAttachmentsUi(), 'ws-att-add');
    expect(busy).toMatch(/data-action="ws-att-remove"[^>]*disabled/);
    expect(busy).toMatch(/data-action="ws-att-add"[^>]*disabled/);
  });

  it('without the RUN right nothing can be added or removed; the demo says why, the limit is said', () => {
    const reader = renderAttachmentsCard(ctxOf([item()], { run: false }), emptyAttachmentsUi());
    expect(reader).not.toContain('data-action="ws-att-remove"');
    expect(reader).not.toContain('data-action="ws-att-add"');
    expect(reader).toContain('Votre rôle ne permet pas');
    const demo = renderAttachmentsCard(ctxOf([item()], { demo: true }), emptyAttachmentsUi());
    expect(demo).not.toContain('data-action="ws-att-remove"');
    expect(demo).toMatch(/data-action="ws-att-add"[^>]*disabled/);
    expect(demo).toContain('Données de démonstration');
    const full = renderAttachmentsCard(
      ctxOf(Array.from({ length: MAX_ATTACHMENTS }, (_, at) => item({ id: `att_${String(at)}` }))),
      emptyAttachmentsUi(),
    );
    expect(full).toMatch(/data-action="ws-att-add"[^>]*disabled/);
    expect(full).toContain(`Nombre maximal atteint (${String(MAX_ATTACHMENTS)})`);
  });

  it('the files set aside and the last error are said, with an alert role', () => {
    const html = renderAttachmentsCard(ctxOf([item()]), {
      ...emptyAttachmentsUi(),
      rejected: [
        { name: 'outil.exe', reason: 'type' },
        { name: 'film.png', reason: 'size' },
      ],
      error: 'CONTENT_MISMATCH',
    });
    expect(html).toContain('<code>outil.exe</code> — type non accepté');
    expect(html).toContain('<code>film.png</code> — trop volumineux');
    expect(html).toContain('<p class="err" role="alert">CONTENT_MISMATCH</p>');
  });
});

describe('attachments — the preview', () => {
  const ctx = ctxOf([item(), item({ id: 'att_2', name: 'console.txt', type: 'text/plain' })]);

  it('an image only as a data: URL of an accepted type; a text as read (masked by the server)', () => {
    const image = renderAttachmentView(
      ctx,
      { ...emptyAttachmentsUi(), content: { att_1: { dataUrl: 'data:image/png;base64,iVBORw0KGgo=' } } },
      item(),
    );
    expect(image).toContain(
      '<img src="data:image/png;base64,iVBORw0KGgo=" alt="Image jointe : capture.png">',
    );
    const foreign = renderAttachmentView(
      ctx,
      { ...emptyAttachmentsUi(), content: { att_1: { dataUrl: 'https://example.org/x.png' } } },
      item(),
    );
    expect(foreign).not.toContain('<img');
    const text = renderAttachmentView(
      ctx,
      { ...emptyAttachmentsUi(), content: { att_2: { text: 'Authorization: [REDACTED]\n<b>' } } },
      item({ id: 'att_2', name: 'console.txt', type: 'text/plain' }),
    );
    expect(text).toContain('Authorization: [REDACTED]\n&lt;b&gt;');
    expect(text).toContain('valeurs sensibles remplacées');
    expect(text).toContain('data-action="ws-att-close"');
  });

  it('loading, denied, failed (with retry), gone; generated demo content is labelled', () => {
    expect(renderAttachmentView(ctx, emptyAttachmentsUi(), item())).toContain('aria-busy="true"');
    expect(
      renderAttachmentView(ctx, { ...emptyAttachmentsUi(), content: { att_1: { state: 'denied' } } }, item()),
    ).toContain('Votre rôle ne permet pas de lire');
    expect(
      renderAttachmentView(
        ctx,
        { ...emptyAttachmentsUi(), content: { att_1: { state: { error: 'boom' } } } },
        item(),
      ),
    ).toContain('data-action="ws-att-retry"');
    expect(renderAttachmentView(ctx, emptyAttachmentsUi(), undefined)).toContain('n’existe plus');
    const demo = renderAttachmentView(
      ctx,
      { ...emptyAttachmentsUi(), content: { att_2: { text: 'journal', demo: true } } },
      item({ id: 'att_2', name: 'console.txt', type: 'text/plain' }),
    );
    expect(demo).toContain('Données de démonstration : contenu généré pour la démonstration.');
    expect(demo).not.toContain('valeurs sensibles remplacées');
  });
});

describe('attachments — state and texts', () => {
  it('open toggles, close, remove asks and keeps; a removed attachment is forgotten', () => {
    let ui = reduceAttachments(emptyAttachmentsUi(), 'ws-att-open', { ref: 'att_1' }) ?? emptyAttachmentsUi();
    expect(ui.open).toBe('att_1');
    expect(reduceAttachments(ui, 'ws-att-open', { ref: 'att_1' })?.open).toBeUndefined();
    expect(reduceAttachments(ui, 'ws-att-close', {})?.open).toBeUndefined();
    ui = reduceAttachments(ui, 'ws-att-remove', { ref: 'att_1' }) ?? ui;
    expect(ui.confirmRemove).toBe('att_1');
    expect(reduceAttachments(ui, 'ws-att-remove-no', {})?.confirmRemove).toBeUndefined();
    expect(reduceAttachments(ui, 'ws-other', {})).toBeUndefined();
    const gone = withoutAttachment(
      { ...ui, content: { att_1: { text: 'x' }, att_2: { text: 'y' } } },
      'att_1',
    );
    expect(gone.content).toEqual({ att_2: { text: 'y' } });
    expect(gone.open).toBeUndefined();
    expect(gone.confirmRemove).toBeUndefined();
  });

  it('sizes, English texts, theme tokens only', () => {
    expect(attachmentSize(512, 'fr')).toBe('512 o');
    expect(attachmentSize(3 * 1024 * 1024 + 300_000, 'fr')).toBe('3,3 Mio');
    expect(attachmentSize(3 * 1024 * 1024 + 300_000, 'en')).toBe('3.3 MiB');
    const en = renderAttachmentsCard(ctxOf([item()], { lang: 'en' }), emptyAttachmentsUi());
    expect(en).toContain('Attachments (1)');
    expect(en).toContain('by ana');
    expect(INCIDENT_ATTACHMENTS_CSS).not.toMatch(/#[0-9a-fA-F]{3,6}\b|rgb\(/);
  });
});
