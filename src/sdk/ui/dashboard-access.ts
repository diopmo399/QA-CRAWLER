import type { JournalEntry, MemberCreated, MemberView, Right, Role } from '../core/contracts.js';
import { JOURNAL_KINDS, RIGHTS, ROLE_RIGHTS, ROLES } from '../core/contracts.js';
import type { DashboardState } from './dashboard-view.js';
import { formatDate, header, icon, pill } from './dashboard-parts.js';
import { esc } from './view.js';

/**
 * L'ÉCRAN ACCÈS ET JOURNAL, et la connexion par jeton nominatif. Des fonctions pures. Les droits
 * affichés sont ceux que le serveur rend (`access.me`) ; masquer un bouton n'est qu'un confort : le
 * serveur refuse de toute façon ce que le rôle ne permet pas. Un jeton n'est montré qu'une fois, à sa
 * création ; le jeton de connexion n'est jamais affiché.
 */
export interface AccessUi {
  members?: MemberView[];
  journal?: JournalEntry[];
  journalKind: string;
  newMember: { name: string; role: Role };
  /** Le membre tout juste créé et son jeton (affiché une fois, jusqu'à « J'ai transmis le jeton »). */
  created?: MemberCreated;
  error?: string;
  copyNote?: string;
  signInError?: string;
}

export const emptyAccessUi = (): AccessUi => ({
  journalKind: 'ALL',
  newMember: { name: '', role: 'ANALYST' },
});

/** Le Dashboard peut-il proposer cette action ? Sans réponse du serveur (ancien serveur) : proposée, le serveur décidera. */
export function can(state: DashboardState, right: Right): boolean {
  return !state.me || state.me.rights.includes(right);
}

const initials = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('');

export function signInView(state: DashboardState): string {
  const a = state.t.access;
  return `<section class="card signin"><h1>${esc(a.signInTitle)}</h1><p class="mu">${esc(a.signInSub)}</p><form class="col" data-action="sign-in"><label class="field">${esc(a.tokenField)}<input type="password" data-bind="token" autocomplete="off" spellcheck="false" class="mono" required></label><button class="btn primary" type="submit">${esc(a.signIn)}</button>${state.access.signInError ? `<p class="err" role="alert">${esc(state.access.signInError)}</p>` : ''}<small class="mu">${esc(a.signInNote)}</small></form></section>`;
}

function roleOptions(state: DashboardState, selected: string | undefined, withEmpty?: string): string {
  const a = state.t.access;
  return `${withEmpty === undefined ? '' : `<option value="" ${selected ? '' : 'selected'}>${esc(withEmpty)}</option>`}${ROLES.map(
    (role) =>
      `<option value="${role}" ${selected === role ? 'selected' : ''}>${esc(a.roles[role] ?? role)}</option>`,
  ).join('')}`;
}

export function accessView(state: DashboardState): string {
  const t = state.t;
  const a = t.access;
  const me = state.me;
  const ui = state.access;
  const project = state.projectId ? state.catalog?.find((entry) => entry.id === state.projectId) : undefined;
  const you = me
    ? `<section class="card"><h2>${esc(a.you)}</h2><p class="big-name">${esc(me.kind === 'SERVICE' ? a.serviceToken : a.youAre(me.name, a.roles[me.role] ?? me.role))}</p>${
        me.projectRole && project
          ? `<p class="mu">${esc(a.projectRole(a.roles[me.projectRole] ?? me.projectRole, project.name))}</p>`
          : ''
      }${me.mode === 'single' ? `<p class="note">${icon('alert')}<span>${esc(a.singleMode)}</span></p>` : ''}</section>`
    : '';
  const matrix = `<section class="card wide"><h2>${esc(a.rightsTitle)}</h2><div class="tw"><table class="tbl rights"><thead><tr><th scope="col">${esc(a.right)}</th>${ROLES.map((role) => `<th scope="col">${esc(a.roles[role] ?? role)}</th>`).join('')}</tr></thead><tbody>${RIGHTS.map(
    (right) =>
      `<tr><th scope="row">${esc(a.rights[right] ?? right)}</th>${ROLES.map((role) =>
        ROLE_RIGHTS[role].includes(right)
          ? `<td class="yes"><span aria-hidden="true">✓</span><span class="sr">${esc(a.yes)}</span></td>`
          : `<td class="no"><span aria-hidden="true">—</span><span class="sr">${esc(a.no)}</span></td>`,
      ).join('')}</tr>`,
  ).join('')}</tbody></table></div></section>`;
  if (!can(state, 'MANAGE_ACCESS'))
    return `${header(esc(t.nav.access), { sub: esc(a.sub) })}<div class="split">${you}</div>${matrix}<section class="card"><p class="mu">${esc(a.adminOnly)}</p></section>`;

  const members = ui.members ?? [];
  const created = ui.created
    ? `<div class="token-box" role="status"><p><b>${esc(a.tokenOnce)} ${esc(ui.created.member.name)}</b></p><code class="tok" data-token>${esc(ui.created.token)}</code><div class="row-acts"><button class="btn" data-action="copy-token">${esc(a.copy)}</button><button class="btn ghost" data-action="hide-token">${esc(a.hideToken)}</button>${ui.copyNote ? `<small class="mu">${esc(ui.copyNote)}</small>` : ''}</div><small class="mu">${esc(a.tokenOnceNote)}</small></div>`
    : '';
  const memberRows = members
    .map((member) => {
      const revoked = member.revokedAt !== undefined;
      const projectRole = project ? member.projects[project.id] : undefined;
      const revoke = revoked
        ? `<span class="mu">${esc(a.revoked(formatDate(member.revokedAt ?? '', t.locale)))}</span>`
        : state.confirm === `revoke:${member.id}`
          ? `<span class="confirm" role="group"><small>${esc(a.revokeHint)}</small><button class="btn danger" data-action="revoke-confirm" data-member="${esc(member.id)}">${esc(a.revokeConfirm)}</button><button class="btn ghost" data-action="confirm-cancel">${esc(t.cancelAction)}</button></span>`
          : `<button class="btn ghost" data-action="revoke" data-member="${esc(member.id)}">${esc(a.revoke)}</button>`;
      return `<li class="member ${revoked ? 'off' : ''}"><span class="avatar" aria-hidden="true">${esc(initials(member.name))}</span><span class="m-name"><b>${esc(member.name)}</b><small class="mu block"><code>${esc(member.id)}</code></small></span><label class="inline">${esc(a.workspaceRole)} <select data-member-role="${esc(member.id)}" ${revoked ? 'disabled' : ''}>${roleOptions(state, member.role)}</select></label>${
        project
          ? `<label class="inline">${esc(a.roleInProject(project.name))} <select data-member-project-role="${esc(member.id)}" ${revoked ? 'disabled' : ''}>${roleOptions(state, projectRole, a.sameAsWorkspace)}</select></label>`
          : ''
      }${revoke}</li>`;
    })
    .join('');
  const form = `<form class="col member-form" data-action="member-form"><h3 class="section-t">${esc(a.newMember)}</h3><div class="fields"><label class="field">${esc(a.memberName)}<input data-member-field="name" value="${esc(ui.newMember.name)}" autocomplete="off"></label><label class="field">${esc(a.memberRole)}<select data-member-field="role">${roleOptions(state, ui.newMember.role)}</select></label></div><div class="form-acts start"><button type="button" class="btn primary" data-action="create-member">${esc(a.create)}</button></div>${ui.error ? `<p class="err" role="alert">${esc(ui.error)}</p>` : ''}</form>`;
  const membersCard = `<section class="card"><h2>${esc(a.membersTitle)}</h2>${created}${members.length === 0 ? `<p class="mu">${esc(a.noMember)}</p>` : `<ul class="plain members">${memberRows}</ul>`}${form}</section>`;

  const journal = ui.journal ?? [];
  const chips = `<div class="chips">${['ALL', ...JOURNAL_KINDS]
    .map(
      (kind) =>
        `<button class="chip" data-action="journal-kind" data-kind="${kind}" aria-pressed="${ui.journalKind === kind ? 'true' : 'false'}">${esc(a.kinds[kind] ?? kind)}</button>`,
    )
    .join('')}</div>`;
  const outcomeTone: Record<string, string> = { OK: 'PASSED', DENIED: 'FAILED', FAILED: 'INCOMPLETE' };
  const table =
    journal.length === 0
      ? `<p class="mu">${esc(a.noEntry)}</p>`
      : `<div class="tw"><table class="tbl"><thead><tr><th scope="col">${esc(a.colWhen)}</th><th scope="col">${esc(a.colWho)}</th><th scope="col">${esc(a.colAction)}</th><th scope="col">${esc(a.colDetail)}</th><th scope="col">${esc(a.colOutcome)}</th></tr></thead><tbody>${journal
          .map(
            (entry) =>
              `<tr><td>${esc(formatDate(entry.at, t.locale))}</td><td><b>${esc(entry.who.name)}</b><small class="mu block">${esc(a.roles[entry.role] ?? entry.role)}</small></td><td><code>${esc(entry.action)}</code><small class="mu block">${esc(a.kinds[entry.kind] ?? entry.kind)}</small></td><td class="path"><code>${esc(`${entry.method} ${entry.path}`)}</code></td><td>${pill(outcomeTone[entry.outcome] ?? 'UNKNOWN', `${a.outcomes[entry.outcome] ?? entry.outcome} · ${String(entry.status)}`)}</td></tr>`,
          )
          .join('')}</tbody></table></div>`;
  const journalCard = `<section class="card wide"><div class="card-h"><h2>${esc(a.journalTitle)}</h2>${chips}</div>${table}<p class="mu">${esc(a.journalNote)}</p></section>`;
  return `${header(esc(t.nav.access), { sub: esc(a.sub) })}<div class="split"><div class="col">${membersCard}</div><aside class="col narrow">${you}</aside></div>${matrix}${journalCard}`;
}
