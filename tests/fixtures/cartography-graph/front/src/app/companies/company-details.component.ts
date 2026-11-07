import { Component, OnInit, inject } from '@angular/core';
import { FormBuilder } from '@angular/forms';
import { CompanyService } from './company.service';

@Component({
  selector: 'app-company-details',
  template: `<form [formGroup]="form">
    <label for="dname">Company name</label>
    <input id="dname" type="text" formControlName="companyName" />
  </form>`,
})
export class CompanyDetailsComponent implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly service = inject(CompanyService);

  form = this.fb.group({
    companyName: [''],
  });

  ngOnInit(): void {
    this.service.load().subscribe((company) => {
      this.form.patchValue({ companyName: company.companyName });
    });
  }
}
