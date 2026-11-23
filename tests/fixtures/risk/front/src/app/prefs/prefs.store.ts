import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

/** Cas K : le thème est gardé volontairement (relu du stockage du navigateur, réécrit à chaque choix). */
@Injectable({ providedIn: 'root' })
export class PrefsStore {
  private readonly theme = new BehaviorSubject<string>(localStorage.getItem('theme') ?? 'light');
  readonly theme$ = this.theme.asObservable();

  choose(theme: string): void {
    this.theme.next(theme);
    localStorage.setItem('theme', theme);
  }
}
