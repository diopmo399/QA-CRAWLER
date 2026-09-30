import { Component, OnInit, inject } from '@angular/core';
import { FormBuilder, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../core/auth.service';
import { CreateAccountRequest } from './account.models';
import { AccountService } from './account.service';
import { ProfileService } from './profile.service';
import { ProvinceService } from './province.service';

@Component({ selector: 'app-account-form', templateUrl: './account-form.component.html' })
export class AccountFormComponent implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly profileService = inject(ProfileService);
  private readonly provinceService = inject(ProvinceService);
  private readonly accountService = inject(AccountService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  loading = false;
  mode = 'CREATE';
  isAdmin = false;
  provinces: string[] = [];
  discount = 0;

  form = this.fb.group({
    email: ['', [Validators.required, Validators.email]],
    accountType: ['PERSONAL', Validators.required],
    companyName: [''],
    companyNumber: [''],
    country: ['CA'],
    province: [''],
    customerId: [''],
    age: [''],
    guardianName: [''],
    quantity: [1],
    price: [20],
    total: [20],
  });

  ngOnInit(): void {
    this.profileService.getProfile().subscribe((profile) => {
      this.form.patchValue({ email: profile.email, accountType: profile.accountType });
    });
    this.form.controls.accountType.valueChanges.subscribe((type) => {
      if (type === 'BUSINESS') {
        this.form.controls.companyNumber.addValidators(Validators.required);
      } else {
        this.form.controls.companyNumber.clearValidators();
      }
      this.form.controls.companyNumber.updateValueAndValidity();
    });
    this.form.controls.country.valueChanges.subscribe((country) => {
      this.loadProvinces(country);
      if (country === 'CA') {
        this.form.controls.province.addValidators(Validators.required);
      }
    });
    this.form.controls.age.valueChanges.subscribe((age) => {
      if (Number(age) > 0 && Number(age) < 18) {
        this.form.controls.guardianName.addValidators(Validators.required);
      }
    });
    this.form.controls.quantity.valueChanges.subscribe(() => {
      const value = this.form.getRawValue();
      this.form.controls.total.setValue(value.quantity * value.price * (1 - this.discount));
    });
  }

  loadProvinces(country: string): void {
    this.provinceService.list(country).subscribe((provinces) => {
      this.provinces = provinces;
    });
  }

  applyDiscount(total: number, customerType: string): void {
    if (total > 1000 && customerType === 'BUSINESS') {
      this.discount = 0.1;
    }
  }

  save(): void {
    const response = this.accountService.lastResponse;
    if (!response) {
      return;
    }
    const request: CreateAccountRequest = {
      email: this.form.controls.email.value,
      accountType: this.form.controls.accountType.value,
      country: this.form.controls.country.value,
    };
    if (this.form.controls.accountType.value === 'BUSINESS') {
      request.taxNumber = this.form.controls.companyNumber.value;
    }
    this.accountService.create(request).subscribe(() => {
      if (this.auth.hasRole('ADMIN')) {
        this.router.navigate(['/administration']);
      }
    });
  }
}
