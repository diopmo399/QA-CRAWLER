package test.cond.backend;

import jakarta.persistence.*;

@Entity
@Table(name = "DOCUMENT")
public class Document {
    @Id
    @GeneratedValue
    private Long id;

    @Column(name = "VERIFIED")
    private boolean verified;

    public boolean isVerified() { return verified; }
}
