import { Injectable } from '@angular/core';
import { Subject, switchMap } from 'rxjs';
import { ActivationService } from './activation.service';

/** Négatif : un flux défini mais jamais souscrit ; un appel dont l'Observable est perdu. */
@Injectable({ providedIn: 'root' })
export class OrphanStore {
  private readonly trigger = new Subject<void>();
  readonly never$ = this.trigger.pipe(switchMap(() => this.service.status()));

  constructor(private service: ActivationService) {}

  fire(): void {
    this.trigger.next();
  }

  forget(): void {
    this.service.activate('x');
  }
}
