import { Injectable } from '@angular/core';
import { BehaviorSubject, Subject, filter, map, switchMap } from 'rxjs';
import { ActivationFacade } from './activation.facade';
import { ActivationService } from './activation.service';
import { ActivationStatus } from './activation.models';

/** Un store maison (aucun nom en « Store ») : un état gardé dans des Subjects, exposé en Observables. */
@Injectable({ providedIn: 'root' })
export class ActivationContext {
  private readonly requests = new Subject<string>();
  private readonly state = new BehaviorSubject<ActivationStatus>({ status: 'NEW', canActivate: false });
  readonly status$ = this.state.pipe(map((s) => s.status));
  readonly allowed$ = this.state.pipe(map((s) => s.canActivate));
  readonly result$ = this.requests.pipe(
    filter((id) => !!id),
    switchMap((id) => this.facade.activate(id)),
  );

  constructor(
    private facade: ActivationFacade,
    private service: ActivationService,
  ) {
    this.result$.subscribe((r) => this.state.next(r));
  }

  activate(id: string): void {
    this.requests.next(id);
  }

  load(): void {
    this.service.status().subscribe((s) => this.state.next(s));
  }
}
