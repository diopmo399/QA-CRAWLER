import { Component, OnInit } from '@angular/core';
import { DossierApi } from './dossier-api.service';

@Component({
  selector: 'app-history',
  template: `<section><h2>Historique</h2></section>`,
})
export class HistoryComponent implements OnInit {
  constructor(private api: DossierApi) {}

  ngOnInit(): void {
    this.api.history().subscribe();
  }
}
