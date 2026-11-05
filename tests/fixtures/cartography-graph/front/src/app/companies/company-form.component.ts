import { Component, inject } from '@angular/core';
import { FormBuilder, Validators } from '@angular/forms';
import { NewCompany } from './company.models';
import { CompanyService } from './company.service';

@Component({
  selector: 'app-company-form',
  template: `<form [formGroup]="form" (ngSubmit)="save()">
    <label for="name">Company name</label>
    <input id="name" type="text" formControlName="companyName" />
    <label for="cid">Company id</label>
    <input id="cid" type="text" formControlName="companyId" />
    <button type="submit">Save</button>
  </form>`,
})
export class CompanyFormComponent {
  private readonly fb = inject(FormBuilder);
  private readonly service = inject(CompanyService);

  form = this.fb.group({
    companyName: ['', Validators.required],
    companyId: [''],
  });

  save(): void {
    const company: NewCompany = {
      companyName: this.form.controls.companyName.value,
      companyId: this.form.controls.companyId.value,
    };
    this.service.create(company).subscribe();
  }
}
