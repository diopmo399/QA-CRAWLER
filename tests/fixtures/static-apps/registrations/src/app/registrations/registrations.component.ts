import { Component, OnInit, inject } from '@angular/core';
import { Registration } from './registration.models';
import { RegistrationService } from './registration.service';

@Component({
  selector: 'app-registrations',
  template: `<h1>Inscriptions</h1>
    @for (registration of registrations; track registration.id) {
      <a [routerLink]="['/registrations', registration.id]">{{ registration.name }}</a>
    }`,
})
export class RegistrationsComponent implements OnInit {
  private readonly service = inject(RegistrationService);
  registrations: Registration[] = [];

  ngOnInit(): void {
    this.service.list().subscribe((registrations) => {
      this.registrations = registrations;
    });
  }
}
