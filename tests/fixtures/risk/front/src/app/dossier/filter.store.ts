import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

/** Cas H : un critère partagé par deux onglets du même dossier. */
@Injectable({ providedIn: 'root' })
export class FilterStore {
  private readonly filter = new BehaviorSubject<string>('');
  readonly filter$ = this.filter.asObservable();

  apply(value: string): void {
    this.filter.next(value);
  }
}
