import { Component, inject } from '@angular/core';
import { FormBuilder, Validators } from '@angular/forms';
import { NewCompany } from './company.models';
import { CompanyService } from './company.service';

@Component({
  selector: 'app-company-create',
  template: `<form [formGroup]="form" (ngSubmit)="create()">
    <label for="qname">Company name</label>
    <input id="qname" type="text" formControlName="companyName" />
    <button type="submit">Create</button>
  </form>`,
})
export class CompanyCreateComponent {
  private readonly fb = inject(FormBuilder);
  private readonly service = inject(CompanyService);

  form = this.fb.group({
    companyName: ['', Validators.required],
  });

  create(): void {
    const company: NewCompany = {
      companyName: this.form.controls.companyName.value,
      companyId: '',
    };
    this.service.create(company).subscribe();
  }
}
