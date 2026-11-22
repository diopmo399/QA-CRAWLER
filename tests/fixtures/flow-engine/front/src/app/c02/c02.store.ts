import { Injectable } from '@angular/core';
import { IndirectAction, IndirectApi } from './c02.api';

@Injectable({ providedIn: 'root' })
export class IndirectStore {
  constructor(private api: IndirectApi) {}

  dispatch(action: IndirectAction): void {
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
