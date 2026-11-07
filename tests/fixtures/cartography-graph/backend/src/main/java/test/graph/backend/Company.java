package test.graph.backend;

import jakarta.persistence.*;
import java.time.LocalDate;

@Entity
@Table(name = "COMPANY")
public class Company {
    @Id
    @GeneratedValue
    @Column(name = "ID")
    private Long id;

    @Column(name = "COMPANY_NAME", nullable = false)
    private String name;

    @Column(name = "STATUS")
    private String status;

    @Column(name = "VERIFICATION_DATE")
    private LocalDate verificationDate;

    public void setName(String name) { this.name = name; }
    public void setStatus(String status) { this.status = status; }
    public void setVerificationDate(LocalDate verificationDate) { this.verificationDate = verificationDate; }
}
