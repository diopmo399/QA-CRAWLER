import { Component, inject } from '@angular/core';
import { Registration } from './registration.models';
import { RegistrationService } from './registration.service';

@Component({ selector: 'app-registration-detail', templateUrl: './registration-detail.component.html' })
export class RegistrationDetailComponent {
  private readonly service = inject(RegistrationService);
  registration!: Registration;

  submit(): void {
    if (this.registration.status !== 'DRAFT') {
      return;
    }
    this.service.submit(this.registration.id).subscribe((updated) => {
      this.registration = updated;
    });
  }

  approve(): void {
    if (this.registration.status !== 'PENDING') {
      return;
    }
    this.service.approve(this.registration.id).subscribe((updated) => {
      this.registration = updated;
    });
  }

  reject(): void {
    this.service.reject(this.registration.id).subscribe((updated) => {
      this.registration = updated;
    });
  }

  cancel(): void {
    this.service.cancel(this.registration.id).subscribe((updated) => {
      this.registration = updated;
    });
  }
}
