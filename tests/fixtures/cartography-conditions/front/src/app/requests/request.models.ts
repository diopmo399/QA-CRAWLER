export interface NewRequest {
  companyType: string;
  companyName: string;
  registrationNumber: string;
}

export interface RequestState {
  showCompanySection: boolean;
  showValidationSection: boolean;
  canValidate: boolean;
}
