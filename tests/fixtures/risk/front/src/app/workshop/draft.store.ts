import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

/** Cas I : écrit, jamais lu par un autre parcours (aucune propagation). */
@Injectable({ providedIn: 'root' })
export class DraftStore {
  private readonly draft = new BehaviorSubject<string>('');

  write(text: string): void {
    this.draft.next(text);
  }
}

/** Fourni par le composant : un exemplaire par écran, détruit avec lui. */
@Injectable()
export class ScopedStore {
  private readonly step = new BehaviorSubject<number>(0);
  readonly step$ = this.step.asObservable();

  go(step: number): void {
    this.step.next(step);
  }
}

/** Cas L : le Subject est public, d'autres classes peuvent l'écrire par des chemins non résolus. */
@Injectable({ providedIn: 'root' })
export class SessionStore {
  readonly user = new BehaviorSubject<string | null>(null);

  login(name: string): void {
    this.user.next(name);
  }
}
