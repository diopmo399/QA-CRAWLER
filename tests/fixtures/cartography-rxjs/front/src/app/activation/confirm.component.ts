import { Component, EventEmitter, Output } from '@angular/core';

@Component({
  selector: 'app-confirm',
  template: `<button type="button" (click)="confirm()">Confirmer</button>`,
})
export class ConfirmComponent {
  @Output() confirmed = new EventEmitter<void>();

  confirm(): void {
    this.confirmed.emit();
  }
}
