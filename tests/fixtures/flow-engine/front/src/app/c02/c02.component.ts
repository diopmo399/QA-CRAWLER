import { Component } from '@angular/core';
import { emitOn } from './c02.helpers';
import { IndirectStore } from './c02.store';

@Component({ selector: 'app-c02', template: '<button (click)="viaCallback()">Save</button>' })
export class IndirectComponent {
  constructor(private store: IndirectStore) {}

  viaCallback(): void {
    this.runNow(() => this.store.dispatch({ type: 'SAVE' }));
  }

  viaBind(): void {
    const send = this.store.dispatch.bind(this.store);
    send({ type: 'SAVE' });
  }

  viaHelper(): void {
    emitOn(this.store, { type: 'SAVE' });
  }

  viaReference(): void {
    this.runNow(this.doSave);
  }

  // Négatif : une valeur (pas une méthode) passée en argument n'est pas un appel.
  viaValue(): void {
    this.note(this.title);
  }

  // La référence est rangée, pas appelée : l'exécution n'est pas démontrée.
  viaStored(): void {
    this.keep(this.doSave);
  }

  title = 'x';
  private last = '';
  private kept?: () => void;

  private note(value: string): void {
    this.last = value;
  }

  private keep(fn: () => void): void {
    this.kept = fn;
  }

  private doSave = (): void => {
    this.store.dispatch({ type: 'SAVE' });
  };

  private runNow(fn: () => void): void {
    fn();
  }
}
