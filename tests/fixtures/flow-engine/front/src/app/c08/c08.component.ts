import { Component } from '@angular/core';
import { ModeService } from './c08.service';

@Component({ selector: 'app-c08', template: '<button (click)="create()">Create</button>' })
export class ModeComponent {
  constructor(private service: ModeService) {}

  create(): void {
    this.service.send('CREATE', {}).subscribe();
  }

  update(): void {
    const mode = 'UPDATE';
    this.service.send(mode, {}).subscribe();
  }
}
