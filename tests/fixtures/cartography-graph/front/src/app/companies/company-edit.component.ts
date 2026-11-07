import { Component, inject } from '@angular/core';
import { FormBuilder } from '@angular/forms';
import { CompanyChange } from './company.models';
import { CompanyService } from './company.service';

@Component({
  selector: 'app-company-edit',
  template: `<form [formGroup]="form" (ngSubmit)="updateCompany()">
    <label for="ename">Company name</label>
    <input id="ename" type="text" formControlName="companyName" />
    <label for="status">Status</label>
    <input id="status" type="text" formControlName="status" />
    <button type="submit">Update</button>
  </form>`,
})
export class CompanyEditComponent {
  private readonly fb = inject(FormBuilder);
  private readonly service = inject(CompanyService);

  form = this.fb.group({
    companyName: [''],
    status: [''],
  });

  updateCompany(): void {
    const change: CompanyChange = {
      companyName: this.form.controls.companyName.value,
      status: this.form.controls.status.value,
    };
    this.service.update(change).subscribe();
  }
}
