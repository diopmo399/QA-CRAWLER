import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'playwright';
import type { ScenarioConfig } from '../../config/config.js';
import type { ConfigOverrides } from '../../config/config-loader.js';
import { runCorrectionSession, type CorrectionSessionState } from '../../recording/correction-session.js';
import {
  correctStoredTarget,
  FLOW_FILES,
  storedCorrectionProposal,
  type StoredRecording,
} from '../../recording/recording-workspace.js';
import {
  describeTarget,
  hasTarget,
  type PickedElement,
  type RowBinding,
} from '../../recording/target-correction.js';
import { openTargetPicker, type TargetPicker } from '../../recording/target-picker.js';
import { isSensitiveKey } from '../../data/test-data-set.js';
import { redactText } from '../../security/redactor.js';
import type { CorrectionView } from '../core/contracts.js';
import { stepDescription } from './recordings.js';

/**
 * LA CORRECTION D'UNE CIBLE DEPUIS LE SDK, comme dans la fenêtre du recorder : le moteur de rejeu suit
 * le même chemin (étapes 1 à N-1) dans un navigateur VISIBLE sur la machine du serveur, la page reste
 * tenue devant l'étape, l'humain y désigne l'élément (mode sélection : le clic n'atteint jamais
 * l'application). Le Dashboard montre la proposition ; la cible n'est remplacée que sur validation, puis
 * le rejeu peut reprendre à l'étape corrigée dans la même session. Une session à la fois ; une session
 * inactive se ferme d'elle-même.
 */
export interface CorrectionRuntime {
  /** Tests : sans fenêtre. */
  headless?: boolean;
  /** Tests : ce que fait « l'humain » dans la page tenue, une fois le mode sélection ouvert. */
  drive?: (page: Page, stepId: string) => Promise<void>;
  /** Fermeture d'une session sans activité (défaut 10 minutes). */
  idleMs?: number;
}

export interface CorrectionStart {
  key: string;
  recording: StoredRecording;
  stepId: string;
  missionFile: string;
  overrides: ConfigOverrides;
  env: NodeJS.ProcessEnv;
  language: 'fr' | 'en';
  config: ScenarioConfig;
}

interface Session {
  key: string;
  view: CorrectionView;
  directory: string;
  language: 'fr' | 'en';
  release: () => void;
  state?: CorrectionSessionState;
  picker?: TargetPicker;
  picked?: PickedElement;
  position: number;
  timer?: NodeJS.Timeout;
}

export class CorrectionBusyError extends Error {
  constructor() {
    super('a target correction is already open on this server: one at a time');
    this.name = 'CorrectionBusyError';
  }
}

export class CorrectionManager {
  private session?: Session;

  constructor(private readonly runtime: CorrectionRuntime = {}) {}

  view(key: string): CorrectionView | undefined {
    return this.session?.key === key ? { ...this.session.view } : undefined;
  }

  /** Ouvre la session : rejoue jusqu'à l'étape (en arrière-plan) puis ouvre le mode sélection. */
  start(input: CorrectionStart): CorrectionView {
    if (this.session) throw new CorrectionBusyError();
    const flow = input.recording.flow;
    const index = flow.steps.findIndex((item) => item.id === input.stepId);
    const item = flow.steps[index];
    if (!item || !hasTarget(item.step)) throw new Error(`step ${input.stepId} has no target to correct`);
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const session: Session = {
      key: input.key,
      view: {
        stepId: input.stepId,
        label: stepDescription(item, input.language),
        status: 'REPLAYING',
        executed: 0,
        total: 0,
      },
      directory: input.recording.directory,
      language: input.language,
      release,
      position: index + 1,
    };
    this.session = session;
    this.touch(session);
    void this.run(session, input, released);
    return { ...session.view };
  }

  private async run(session: Session, input: CorrectionStart, released: Promise<void>): Promise<void> {
    const scenarioFile = path.join(session.directory, 'replay.flow.yaml');
    try {
      await writeFile(
        scenarioFile,
        await readFile(path.join(session.directory, FLOW_FILES.yaml), 'utf8'),
        'utf8',
      );
      const outcome = await runCorrectionSession({
        scenarioFile,
        missionFile: input.missionFile,
        overrides: input.overrides,
        env: input.env,
        directory: session.directory,
        stepIndex: session.position,
        headless: this.runtime.headless ?? false,
        recovery: input.config.replay.contextRecovery,
        onStep: (executed, total) => {
          session.view.executed = executed;
          session.view.total = total;
        },
        hold: async (state) => {
          session.state = state;
          if (!state.reached) {
            session.view.status = 'UNREACHABLE';
            if (state.stoppedAt)
              session.view.stoppedAt = { ...state.stoppedAt, reason: redactText(state.stoppedAt.reason) };
            return;
          }
          session.picker = await openTargetPicker(state.page, input.config, input.language);
          await state.page.bringToFront().catch(() => undefined);
          this.pick(session, input.recording);
          await released;
        },
      });
      if ('error' in outcome && this.session === session) {
        session.view.status = 'FAILED';
        session.view.error = redactText(outcome.error);
      }
    } catch (error) {
      if (this.session === session) {
        session.view.status = 'FAILED';
        session.view.error = redactText(error instanceof Error ? error.message : String(error));
      }
    }
  }

  /** Le mode sélection dans la page tenue ; l'élément désigné devient une proposition (rien n'est écrit). */
  private pick(session: Session, recording: StoredRecording): void {
    const picker = session.picker;
    const state = session.state;
    if (!picker || !state) return;
    session.view.status = 'PICKING';
    delete session.view.proposal;
    delete session.picked;
    this.touch(session);
    const label = session.view.label;
    void picker.pick(label).then((picked) => {
      if (this.session !== session) return;
      this.touch(session);
      if (!picked) {
        session.view.status = 'HELD';
        return;
      }
      session.picked = picked;
      const known = this.known(session);
      const proposal = storedCorrectionProposal(
        recording,
        session.view.stepId,
        picked,
        known,
        session.language,
      );
      if ('error' in proposal) {
        session.view.status = 'FAILED';
        session.view.error = proposal.error;
        return;
      }
      const item = recording.flow.steps.find((entry) => entry.id === session.view.stepId);
      session.view.status = 'PICKED';
      session.view.proposal = {
        label: proposal.label,
        current: item && hasTarget(item.step) ? describeTarget(item.step.target) : '',
        next: describeTarget(proposal.target),
        order: proposal.order,
        ambiguous: proposal.ambiguous,
        traits: {
          role: proposal.traits.role,
          tag: proposal.traits.tag,
          ...(proposal.traits.name ? { name: proposal.traits.name } : {}),
          ...(proposal.traits.label ? { label: proposal.traits.label } : {}),
          ...(proposal.traits.text ? { text: proposal.traits.text } : {}),
          ...(proposal.traits.testId ? { testId: proposal.traits.testId } : {}),
          ...(proposal.traits.section ? { section: proposal.traits.section } : {}),
        },
        ...(proposal.rowOptions
          ? {
              rowOptions: proposal.rowOptions.map((option) => ({
                id: option.id,
                row: option.row,
                ...(option.via ? { via: option.via } : {}),
                ...(option.match ? { match: option.match } : {}),
                ...(option.fixed ? { fixed: true } : {}),
              })),
            }
          : {}),
        ...(proposal.rowCells ? { rowCells: proposal.rowCells } : {}),
        ...(proposal.variables ? { variables: proposal.variables.map((entry) => entry.key) } : {}),
      };
    });
    if (this.runtime.drive) void this.runtime.drive(state.page, session.view.stepId).catch(() => undefined);
  }

  /** Les données du run (jamais une donnée sensible) : ce que la page tenue montre maintenant. */
  private known(session: Session): { key: string; value: string }[] {
    return (session.state?.runData ?? []).filter((entry) => !isSensitiveKey(entry.key));
  }

  /** Désigner un autre élément (la page reste tenue). */
  pickAgain(key: string, recording: StoredRecording): CorrectionView {
    const session = this.own(key);
    if (!session.state?.reached || !session.picker) throw new Error('no page is held for this correction');
    this.pick(session, recording);
    return { ...session.view };
  }

  /** La cible de l'étape remplacée par l'élément désigné (option de ligne, liaison d'une colonne). */
  async apply(
    key: string,
    recording: StoredRecording,
    choice: { option?: string; binding?: RowBinding },
  ): Promise<CorrectionView> {
    const session = this.own(key);
    const picked = session.picked;
    if (session.view.status !== 'PICKED' || !picked) throw new Error('no element was picked');
    const outcome = await correctStoredTarget(
      recording,
      {
        stepId: session.view.stepId,
        picked,
        known: this.known(session),
        ...(choice.option ? { option: choice.option } : {}),
        ...(choice.binding ? { binding: choice.binding } : {}),
      },
      session.language,
    );
    if ('error' in outcome) throw new Error(outcome.error);
    this.touch(session);
    session.view.status = 'APPLIED';
    session.view.applied = { previous: outcome.previous, next: outcome.next };
    session.view.resumable = session.state?.reached === true && session.state.position() === session.position;
    return { ...session.view };
  }

  /** Reprend le rejeu à l'étape corrigée, dans la page tenue (le contexte est comparé, puis restauré). */
  async resume(key: string): Promise<CorrectionView> {
    const session = this.own(key);
    const state = session.state;
    if (session.view.status !== 'APPLIED' || !state?.reached) throw new Error('nothing to resume');
    const scenarioFile = path.join(session.directory, 'replay.flow.yaml');
    await writeFile(
      scenarioFile,
      await readFile(path.join(session.directory, FLOW_FILES.yaml), 'utf8'),
      'utf8',
    );
    session.view.status = 'RESUMING';
    session.view.executed = 0;
    this.touch(session);
    void state
      .resume({
        scenarioFile,
        onStep: (executed, total) => {
          session.view.executed = executed;
          session.view.total = total;
        },
      })
      .then((outcome) => {
        if (this.session !== session) return;
        session.view.status = 'RESUMED';
        session.view.resume = {
          status: outcome.status,
          from: outcome.from,
          strategy: outcome.decision.strategy,
          reasons: outcome.decision.reasons.map((reason) => redactText(reason)),
        };
        this.touch(session);
      })
      .catch((error: unknown) => {
        if (this.session !== session) return;
        session.view.status = 'FAILED';
        session.view.error = redactText(error instanceof Error ? error.message : String(error));
      });
    return { ...session.view };
  }

  /** Ferme la session : le mode sélection s'arrête, la page tenue et son navigateur se ferment. */
  close(key: string): void {
    const session = this.session;
    if (session?.key !== key) return;
    this.end(session);
  }

  /** Ferme toute session (arrêt du serveur). */
  closeAll(): void {
    if (this.session) this.end(this.session);
  }

  private end(session: Session): void {
    if (session.timer) clearTimeout(session.timer);
    session.picker?.cancel();
    session.release();
    if (this.session === session) this.session = undefined;
  }

  private own(key: string): Session {
    const session = this.session;
    if (session?.key !== key) throw new Error('no correction is open for this recording');
    return session;
  }

  private touch(session: Session): void {
    if (session.timer) clearTimeout(session.timer);
    session.timer = setTimeout(
      () => {
        this.end(session);
      },
      this.runtime.idleMs ?? 10 * 60_000,
    );
    session.timer.unref();
  }
}
