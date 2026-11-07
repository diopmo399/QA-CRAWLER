import { Component, inject } from '@angular/core';
import { FormBuilder, Validators } from '@angular/forms';
import { NewCompany } from './company.models';
import { CompanyService } from './company.service';

@Component({
  selector: 'app-company-form',
  template: `<h1>New company</h1>
    <form [formGroup]="form" (ngSubmit)="save()">
      <label for="name">Company name</label>
      <input id="name" type="text" formControlName="companyName" />
      <button type="submit">Create</button>
    </form>`,
})
export class CompanyFormComponent {
  private readonly fb = inject(FormBuilder);
  private readonly service = inject(CompanyService);

  form = this.fb.group({
    companyName: ['', Validators.required],
  });

  save(): void {
    const company: NewCompany = {
      companyName: this.form.controls.companyName.value,
    };
    this.service.create(company).subscribe();
  }
}
