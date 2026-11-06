import { Component, EventEmitter, Output } from '@angular/core';

/** Un composant partagé entre deux onglets, qui prévient son parent. */
@Component({
  selector: 'app-shared-panel',
  template: `<section><button type="button" (click)="save()">Sauver</button></section>`,
})
export class SharedPanelComponent {
  @Output() saved = new EventEmitter<void>();

  save(): void {
    this.saved.emit();
  }
}
