package test.bff;

import jakarta.validation.constraints.NotBlank;

public class UpdateRequestDto {
    @NotBlank
    private String companyName;

    public String getCompanyName() { return companyName; }
    public void setCompanyName(String companyName) { this.companyName = companyName; }
}
