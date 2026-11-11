import { Component } from '@angular/core';
import { AdminService } from './admin.service';

/** Même nom de classe que l'autre ListComponent, dans un autre dossier. */
@Component({
  selector: 'app-admin-list',
  template: '<button type="button" (click)="refresh()">Rafraîchir</button>',
})
export class ListComponent {
  rows: string[] = [];

  constructor(private service: AdminService) {}

  refresh(): void {
    this.service.load().subscribe((rows) => (this.rows = rows));
  }
}
