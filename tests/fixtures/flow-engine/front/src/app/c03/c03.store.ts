import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';
import { InitAction, InitApi } from './c03.api';

@Injectable({ providedIn: 'root' })
export class InitStore {
  private readonly validation = new Subject<{ valid: boolean }>();
  readonly validation$ = this.validation.asObservable();

  constructor(private api: InitApi) {}

  dispatch(action: InitAction): void {
    switch (action.type) {
      case 'VALIDATE':
        this.validation.next({ valid: true });
        break;
      case 'SAVE':
        this.api.save().subscribe();
        break;
      case 'LOAD':
        this.api.list().subscribe();
        break;
    }
  }
}
