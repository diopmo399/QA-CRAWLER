package test.backend;

import jakarta.persistence.*;

@Entity
@Table(name = "REQUEST")
public class Request {
    @Id
    @GeneratedValue
    private Long id;

    @Column(name = "ORGANIZATION_NAME", nullable = false, length = 100)
    private String organizationName;

    private String email;

    @Column(name = "STATUS")
    private String status;

    public void setOrganizationName(String organizationName) { this.organizationName = organizationName; }
    public void setEmail(String email) { this.email = email; }
    public void setStatus(String status) { this.status = status; }
}
