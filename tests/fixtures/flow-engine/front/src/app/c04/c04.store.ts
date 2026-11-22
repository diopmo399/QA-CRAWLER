import { Injectable } from '@angular/core';
import { CheckedAction, CheckedApi } from './c04.api';

@Injectable({ providedIn: 'root' })
export class CheckedStore {
  constructor(private api: CheckedApi) {}

  dispatch(action: CheckedAction): void {
    switch (action.type) {
      case 'LOAD':
        this.api.list().subscribe();
        break;
      case 'SAVE':
        this.api.save().subscribe();
        break;
      case 'REJECT':
        this.api.remove().subscribe();
        break;
    }
  }
}
