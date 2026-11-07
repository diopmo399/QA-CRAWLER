package test.backend;

import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

public class CreateRequestCommand {
    @NotBlank
    @Size(max = 100)
    private String organizationName;

    @Email
    private String email;

    public String getOrganizationName() { return organizationName; }
    public String getEmail() { return email; }
}
