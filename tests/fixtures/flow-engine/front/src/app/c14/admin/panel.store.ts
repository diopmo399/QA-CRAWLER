import { Injectable } from '@angular/core';
import { AdminPanelApi } from './panel.api';

@Injectable({ providedIn: 'root' })
export class PanelStore {
  constructor(private api: AdminPanelApi) {}

  load(): void {
    this.api.list().subscribe();
  }
}
