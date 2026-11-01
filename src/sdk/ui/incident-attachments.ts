import {
  ATTACHMENT_TYPES,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  type IncidentAttachment,
} from '../core/incident-contracts.js';
import { formatDate, icon } from './dashboard-parts.js';
import { panelState, type Lang, type WorkspaceContext } from './incident-parts.js';
import { esc } from './view.js';

/**
 * LES PIÈCES JOINTES DANS L'ESPACE D'INVESTIGATION (Vue d'ensemble › Résumé) : la liste « Pièces jointes
 * (n) » (nom, type, taille, ajoutée par / le), l'ajout (sélecteur de fichiers, mêmes vérifications que le
 * formulaire de création : types acceptés, taille et nombre maximaux ; le serveur revérifie le contenu),
 * la suppression confirmée dans la page (droit RUN) et l'aperçu dans le panneau des détails : l'image
 * (`data:`) ou le texte, valeurs sensibles masquées par le serveur. Des fonctions pures : le contrôleur lit
 * le contenu (`incidents.attachment`), envoie (`addAttachment`) et supprime (`removeAttachment`).
 *
 * Actions : `ws-att-open` (`ref`), `ws-att-close`, `ws-att-remove` (`ref`, demande la confirmation),
 * `ws-att-remove-yes` / `ws-att-remove-no`, `ws-att-retry` (relit la pièce ouverte) ; `ws-att-add` sur le `<input
 * type="file">` (événement `change`).
 */

/** Le contenu lu d'une pièce jointe, ou l'état de sa lecture. */
export interface AttachmentContentEntry {
  dataUrl?: string;
  text?: string;
  /** La démonstration : contenu généré, dit comme tel. */
  demo?: boolean;
  state?: 'loading' | 'denied' | { error: string };
}

/** Un fichier écarté avant l'envoi, avec sa raison (même tri que le formulaire de création). */
export interface RejectedFile {
  name: string;
  reason: 'type' | 'empty' | 'size' | 'count' | 'read';
}

export interface AttachmentsUi {
  /** La pièce jointe montrée dans le panneau des détails. */
  open?: string;
  /** Le contenu lu, par identifiant. */
  content: Record<string, AttachmentContentEntry>;
  /** La suppression demandée (confirmation dans la page). */
  confirmRemove?: string;
  /** Les fichiers écartés au dernier ajout. */
  rejected: RejectedFile[];
  /** L'erreur du dernier ajout ou de la dernière suppression. */
  error?: string;
}

export const emptyAttachmentsUi = (): AttachmentsUi => ({ content: {}, rejected: [] });

/** Les types acceptés par le sélecteur de fichiers (`accept`), comme le formulaire de création. */
export const ATTACHMENT_PICKER_ACCEPT = [
  ...ATTACHMENT_TYPES,
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.txt',
  '.log',
  '.json',
].join(',');

/**
 * Le réducteur PUR des actions d'affichage (`ws-att-open`, `ws-att-close`, `ws-att-remove`,
 * `ws-att-remove-no`) ; les envois au serveur sont faits par le contrôleur.
 */
export function reduceAttachments(
  ui: AttachmentsUi,
  action: string,
  dataset: Record<string, string | undefined>,
): AttachmentsUi | undefined {
  switch (action) {
    case 'ws-att-open': {
      const ref = dataset.ref;
      if (!ref) return ui;
      if (ui.open === ref) {
        const { open: _closed, ...rest } = ui;
        return rest;
      }
      return { ...ui, open: ref };
    }
    case 'ws-att-close': {
      const { open: _closed, ...rest } = ui;
      return rest;
    }
    case 'ws-att-remove':
      return dataset.ref ? { ...ui, confirmRemove: dataset.ref } : ui;
    case 'ws-att-remove-no': {
      const { confirmRemove: _no, ...rest } = ui;
      return rest;
    }
    default:
      return undefined;
  }
}

/** Une pièce jointe retirée : son contenu oublié, l'aperçu et la confirmation refermés. */
export function withoutAttachment(ui: AttachmentsUi, id: string): AttachmentsUi {
  const content = Object.fromEntries(Object.entries(ui.content).filter(([key]) => key !== id));
  const next: AttachmentsUi = { content, rejected: ui.rejected };
  if (ui.open && ui.open !== id) next.open = ui.open;
  if (ui.error) next.error = ui.error;
  return next;
}

// ── Textes ───────────────────────────────────────────────────────────────────────────────────

const TEXT = {
  fr: {
    title: 'Pièces jointes',
    count: (n: number) => `Pièces jointes (${String(n)})`,
    none: 'Aucune pièce jointe pour cet incident.',
    name: 'Nom',
    type: 'Type',
    size: 'Taille',
    added: 'Ajoutée',
    addedBy: (who: string, at: string) => `par ${who}, ${at}`,
    open: (name: string) => `Afficher « ${name} » dans le panneau des détails`,
    remove: (name: string) => `Retirer « ${name} »`,
    removeConfirm: 'Retirer',
    removeHint: (name: string) => `Retirer « ${name} » de l’incident ? Le fichier est supprimé du serveur.`,
    keep: 'Garder',
    add: 'Ajouter',
    addHint: (max: number, size: string) =>
      `Captures (PNG, JPEG, WEBP) et textes (journaux, JSON) ; ${size} au plus par fichier, ${String(max)} fichiers au plus. Le serveur vérifie le contenu.`,
    full: (max: number) => `Nombre maximal atteint (${String(max)}).`,
    noRight: 'Votre rôle ne permet pas d’ajouter ni de retirer une pièce jointe.',
    demoOff: 'Données de démonstration : ajout et retrait indisponibles.',
    rejected: {
      type: 'type non accepté',
      empty: 'fichier vide',
      size: 'trop volumineux',
      count: 'nombre maximal atteint',
      read: 'lecture impossible',
    } as Record<RejectedFile['reason'], string>,
    rejectedTitle: 'Fichiers écartés',
    viewer: 'Pièce jointe',
    close: 'Fermer l’aperçu',
    loading: 'Lecture de la pièce jointe…',
    denied: 'Votre rôle ne permet pas de lire cette pièce jointe.',
    masked: 'Texte affiché tel que le serveur l’a masqué (valeurs sensibles remplacées).',
    demo: 'Données de démonstration : contenu généré pour la démonstration.',
    gone: 'Cette pièce jointe n’existe plus (incident relu entre-temps).',
    image: (name: string) => `Image jointe : ${name}`,
    textLabel: (name: string) => `Texte joint : ${name}`,
  },
  en: {
    title: 'Attachments',
    count: (n: number) => `Attachments (${String(n)})`,
    none: 'No attachment for this incident.',
    name: 'Name',
    type: 'Type',
    size: 'Size',
    added: 'Added',
    addedBy: (who: string, at: string) => `by ${who}, ${at}`,
    open: (name: string) => `Show “${name}” in the details panel`,
    remove: (name: string) => `Remove “${name}”`,
    removeConfirm: 'Remove',
    removeHint: (name: string) => `Remove “${name}” from the incident? The file is deleted from the server.`,
    keep: 'Keep',
    add: 'Add',
    addHint: (max: number, size: string) =>
      `Screenshots (PNG, JPEG, WEBP) and texts (logs, JSON); ${size} at most per file, ${String(max)} files at most. The server checks the content.`,
    full: (max: number) => `Maximum reached (${String(max)}).`,
    noRight: 'Your role does not allow adding or removing an attachment.',
    demoOff: 'Demonstration data: adding and removing are unavailable.',
    rejected: {
      type: 'type not accepted',
      empty: 'empty file',
      size: 'too large',
      count: 'maximum reached',
      read: 'could not be read',
    } as Record<RejectedFile['reason'], string>,
    rejectedTitle: 'Files set aside',
    viewer: 'Attachment',
    close: 'Close the preview',
    loading: 'Reading the attachment…',
    denied: 'Your role does not allow reading this attachment.',
    masked: 'Text shown as masked by the server (sensitive values replaced).',
    demo: 'Demonstration data: content generated for the demonstration.',
    gone: 'This attachment no longer exists (incident read again meanwhile).',
    image: (name: string) => `Attached image: ${name}`,
    textLabel: (name: string) => `Attached text: ${name}`,
  },
};

export const attachmentsText = (lang: Lang): (typeof TEXT)['fr'] => TEXT[lang];

/** Une taille lisible (octets, Kio, Mio), comme le formulaire de création. */
export function attachmentSize(bytes: number, lang: Lang): string {
  const unit = lang === 'fr' ? ['o', 'Kio', 'Mio'] : ['B', 'KiB', 'MiB'];
  if (bytes < 1024) return `${String(bytes)} ${unit[0] ?? ''}`;
  if (bytes < 1024 * 1024) return `${String(Math.round(bytes / 1024))} ${unit[1] ?? ''}`;
  const mib = (bytes / (1024 * 1024)).toFixed(1);
  return `${lang === 'fr' ? mib.replace('.', ',') : mib} ${unit[2] ?? ''}`;
}

const isImageType = (type: string): boolean => type.startsWith('image/');

/** Une image `data:` d'un type accepté (rien d'autre n'est jamais affiché). */
const isDataImageUrl = (url: string): boolean =>
  /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(url);

/** Pourquoi l'ajout et le retrait sont indisponibles (undefined : disponibles). */
function blocker(ctx: WorkspaceContext): string | undefined {
  const t = TEXT[ctx.lang];
  if (ctx.demo) return t.demoOff;
  if (!ctx.can('RUN')) return t.noRight;
  return undefined;
}

/**
 * La carte « Pièces jointes (n) » : la liste (chaque nom ouvre l'aperçu dans le panneau des détails), le
 * retrait confirmé dans la page, l'ajout (`ws-att-add`). `busy` : l'opération du serveur en cours.
 */
export function renderAttachmentsCard(ctx: WorkspaceContext, ui: AttachmentsUi, busy?: string): string {
  const t = TEXT[ctx.lang];
  const list = ctx.incident.attachments ?? [];
  const reason = blocker(ctx);
  const full = list.length >= MAX_ATTACHMENTS;
  const working = busy !== undefined;
  const rows = list
    .map((item) => {
      const open = ui.open === item.id;
      const confirming = ui.confirmRemove === item.id;
      const remove =
        reason !== undefined
          ? ''
          : confirming
            ? `<span class="ws-att-confirm" role="group" aria-label="${esc(t.remove(item.name))}"><small>${esc(t.removeHint(item.name))}</small><button type="button" class="btn small danger" data-action="ws-att-remove-yes" data-ref="${esc(item.id)}"${working ? ' disabled' : ''} aria-busy="${String(busy === 'ws-att-remove-yes')}">${esc(t.removeConfirm)}</button><button type="button" class="btn small ghost" data-action="ws-att-remove-no" data-ref="${esc(item.id)}">${esc(t.keep)}</button></span>`
            : `<button type="button" class="ws-att-rm" data-action="ws-att-remove" data-ref="${esc(item.id)}" aria-label="${esc(t.remove(item.name))}" title="${esc(t.remove(item.name))}"${working ? ' disabled' : ''}>${icon('trash')}</button>`;
      return `<li class="ws-att-row${open ? ' ws-att-on' : ''}"><button type="button" class="ws-att-open" data-action="ws-att-open" data-ref="${esc(item.id)}" aria-pressed="${String(open)}" title="${esc(t.open(item.name))}"><span class="ws-att-i" aria-hidden="true">${icon(isImageType(item.type) ? 'eye' : 'editor')}</span><span class="ws-att-n">${esc(item.name)}</span></button><span class="ws-att-meta"><code>${esc(item.type)}</code><span>${esc(attachmentSize(item.bytes, ctx.lang))}</span><span class="mu">${esc(t.addedBy(item.addedBy, formatDate(item.addedAt, ctx.lang)))}</span></span>${remove}</li>`;
    })
    .join('');
  const pickerOff = reason !== undefined || full || working;
  const pickerTitle = reason ?? (full ? t.full(MAX_ATTACHMENTS) : undefined);
  const picker =
    reason !== undefined && !ctx.demo
      ? ''
      : `<span class="ws-att-pick"><input type="file" id="ws-att-file" class="ws-att-file" data-action="ws-att-add" multiple accept="${esc(ATTACHMENT_PICKER_ACCEPT)}" aria-describedby="ws-att-h"${pickerOff ? ' disabled' : ''}${pickerTitle ? ` title="${esc(pickerTitle)}"` : ''}><label for="ws-att-file" class="btn small${pickerOff ? ' disabled' : ''}" aria-busy="${String(busy === 'ws-att-add')}"${pickerTitle ? ` title="${esc(pickerTitle)}"` : ''}>${busy === 'ws-att-add' ? '<span class="spin sm" aria-hidden="true"></span>' : icon('plus')}<span>${esc(t.add)}</span></label></span>`;
  const rejected =
    ui.rejected.length > 0
      ? `<div class="ws-att-rej" role="alert"><b>${esc(t.rejectedTitle)} :</b><ul class="plain tight">${ui.rejected
          .map((file) => `<li><code>${esc(file.name)}</code> — ${esc(t.rejected[file.reason])}</li>`)
          .join('')}</ul></div>`
      : '';
  const error = ui.error ? `<p class="err" role="alert">${esc(ui.error)}</p>` : '';
  const hint = `<small id="ws-att-h" class="mu">${esc(
    reason ??
      (full
        ? t.full(MAX_ATTACHMENTS)
        : t.addHint(MAX_ATTACHMENTS, attachmentSize(MAX_ATTACHMENT_BYTES, ctx.lang))),
  )}</small>`;
  return `<section class="card ws-att" aria-labelledby="ws-att-t"><div class="ws-att-h"><h2 id="ws-att-t" class="fl">${esc(t.count(list.length))}</h2>${picker}</div>${
    list.length === 0 ? `<p class="mu">${esc(t.none)}</p>` : `<ul class="plain ws-att-list">${rows}</ul>`
  }${error}${rejected}${hint}</section>`;
}

/** L'aperçu d'une pièce jointe dans le panneau des détails (image, texte masqué, ou état de la lecture). */
export function renderAttachmentView(
  ctx: WorkspaceContext,
  ui: AttachmentsUi,
  attachment: IncidentAttachment | undefined,
): string {
  const t = TEXT[ctx.lang];
  if (!attachment) return panelState(ctx.lang, 'empty', t.gone);
  const entry = ui.content[attachment.id];
  let body: string;
  if (entry?.state === 'denied') body = panelState(ctx.lang, 'denied', t.denied);
  else if (entry?.state && typeof entry.state === 'object')
    body = panelState(ctx.lang, 'error', entry.state.error, 'ws-att-retry');
  else if (entry?.dataUrl !== undefined && isDataImageUrl(entry.dataUrl))
    body = `<figure class="ws-att-fig"><img src="${esc(entry.dataUrl)}" alt="${esc(t.image(attachment.name))}"></figure>`;
  else if (entry?.text !== undefined)
    body = `<pre class="ws-att-text" tabindex="0" aria-label="${esc(t.textLabel(attachment.name))}">${esc(entry.text)}</pre>${entry.demo ? '' : `<p class="mu"><small>${esc(t.masked)}</small></p>`}`;
  else body = panelState(ctx.lang, 'loading', t.loading);
  const demo = entry?.demo
    ? `<p class="note ws-att-demo" role="note">${icon('info')}<span>${esc(t.demo)}</span></p>`
    : '';
  return `<article class="ws-ctx-card ws-att-view" aria-labelledby="ws-att-v-t"><div class="ws-ctx-h2"><p class="ws-ctx-eyebrow">${esc(t.viewer)} · <code>${esc(attachment.type)}</code></p><button type="button" class="ws-pane-btn" data-action="ws-att-close" aria-label="${esc(t.close)}" title="${esc(t.close)}">${icon('close')}</button></div><h3 id="ws-att-v-t">${esc(attachment.name)}</h3><p class="mu ws-att-vmeta">${esc(attachment.type)} · ${esc(attachmentSize(attachment.bytes, ctx.lang))} · ${esc(t.addedBy(attachment.addedBy, formatDate(attachment.addedAt, ctx.lang)))}</p>${demo}${body}</article>`;
}

/** Les styles des pièces jointes (jetons du thème seulement, clair et sombre). */
export const INCIDENT_ATTACHMENTS_CSS = `
.ws-att{display:flex;flex-direction:column;gap:8px;min-width:0}
.ws-att-h{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
.ws-att-h h2{margin:0}
.ws-att-list{display:flex;flex-direction:column;gap:4px;margin:0;padding:0}
.ws-att-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:6px 8px;border:1px solid var(--qa-color-border);border-radius:8px;background:var(--qa-color-surface)}
.ws-att-row.ws-att-on{border-color:var(--qa-color-primary);background:var(--qa-color-surface-2)}
.ws-att-open{display:inline-flex;align-items:center;gap:6px;min-height:30px;min-width:0;flex:1 1 180px;padding:0 4px;border:0;background:none;color:var(--qa-color-text);cursor:pointer;font:inherit;text-align:left}
.ws-att-open:hover .ws-att-n{text-decoration:underline}
.ws-att-n{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
.ws-att-i .ico{width:16px;height:16px}
.ws-att-meta{display:inline-flex;gap:10px;flex-wrap:wrap;font-size:12px;align-items:center}
.ws-att-rm{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border:1px solid var(--qa-color-border);border-radius:8px;background:var(--qa-color-surface);color:var(--qa-color-muted);cursor:pointer}
.ws-att-rm:hover{border-color:var(--qa-color-danger);color:var(--qa-color-danger)}
.ws-att-rm .ico{width:15px;height:15px}
.ws-att-confirm{display:inline-flex;gap:6px;align-items:center;flex-wrap:wrap}
.ws-att-pick{position:relative;display:inline-flex}
.ws-att-file{position:absolute;width:1px;height:1px;opacity:0;overflow:hidden}
.ws-att-pick:focus-within label{outline:2px solid var(--qa-color-primary);outline-offset:2px}
.ws-att-pick label.disabled{opacity:.6;cursor:not-allowed}
.ws-att-rej{font-size:13px}
.ws-att-fig{margin:0;border:1px solid var(--qa-color-border);border-radius:8px;overflow:hidden;background:var(--qa-color-surface-2)}
.ws-att-fig img{display:block;max-width:100%;min-width:min(100%,240px);height:auto;image-rendering:auto}
.ws-att-demo{margin:0;font-size:12px}
.ws-att-text{margin:0;max-height:420px;overflow:auto;padding:8px;border:1px solid var(--qa-color-border);border-radius:8px;background:var(--qa-color-surface-2);font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere}
.ws-att-vmeta{margin:0;font-size:12px}
`;
