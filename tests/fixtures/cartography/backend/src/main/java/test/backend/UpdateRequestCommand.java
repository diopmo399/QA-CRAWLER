package test.backend;

import jakarta.validation.constraints.NotBlank;

public class UpdateRequestCommand {
    @NotBlank
    private String organizationName;

    public String getOrganizationName() { return organizationName; }
}
