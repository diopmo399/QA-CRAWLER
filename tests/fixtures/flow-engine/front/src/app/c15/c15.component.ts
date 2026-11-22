import { Component, OnInit } from '@angular/core';
import { GateKind, GateMode, SaveOnly } from './c15.api';
import { GateStore } from './c15.store';

@Component({ selector: 'app-c15', template: '<button (click)="save()">Save</button>' })
export class GateComponent implements OnInit {
  constructor(private store: GateStore) {}

  ngOnInit(): void {
    this.store.notLoad$.subscribe();
    this.store.urgentSave$.subscribe();
    this.store.others$.subscribe();
  }

  save(): void {
    this.store.dispatch({ type: 'SAVE' });
  }

  load(): void {
    this.store.dispatch({ type: 'LOAD' });
  }

  // La valeur n'est pas connue, mais son type écrit n'en admet que deux.
  forward(kind: 'SAVE' | 'REJECT'): void {
    this.store.dispatch({ type: kind });
  }

  // Deux membres d'un enum : le troisième n'est jamais transmis.
  apply(mode: GateMode.Create | GateMode.Update): void {
    this.store.run(mode);
  }

  // Un objet dont le type fixe le champ : une seule valeur possible, d'après le type.
  resend(action: SaveOnly): void {
    this.store.dispatch(action);
  }

  // Un type qui n'aide pas (toutes les valeurs) : rien n'est écarté.
  replay(kind: string): void {
    this.store.dispatch({ type: kind as GateKind });
  }
}
