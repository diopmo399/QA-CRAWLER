import { Component, inject } from '@angular/core';
import { FormBuilder, Validators } from '@angular/forms';
import { CreateRequest } from './request.models';
import { RequestService } from './request.service';

@Component({
  selector: 'app-request-create',
  templateUrl: './request-create.component.html',
})
export class RequestCreateComponent {
  private readonly fb = inject(FormBuilder);
  private readonly service = inject(RequestService);

  form = this.fb.group({
    companyName: ['', [Validators.required, Validators.maxLength(120)]],
    contactEmail: ['', [Validators.required, Validators.email]],
    notes: [''],
  });

  save(): void {
    const request: CreateRequest = {
      companyName: this.form.controls.companyName.value,
      contactEmail: this.form.controls.contactEmail.value,
    };
    this.service.create(request).subscribe();
  }
}
