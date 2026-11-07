import { Component, OnInit } from '@angular/core';
import { DossierApi } from './dossier-api.service';

@Component({
  selector: 'app-documents',
  template: `<section><h2>Pièces</h2></section>`,
})
export class DocumentsComponent implements OnInit {
  constructor(private api: DossierApi) {}

  ngOnInit(): void {
    this.api.documents().subscribe();
  }
}
