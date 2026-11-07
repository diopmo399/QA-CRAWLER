package test.backend;

import jakarta.persistence.*;

@Entity
@Table(name = "COMPANY")
public class Company {
    @Id
    @GeneratedValue
    private Long id;

    @Column(name = "NAME", nullable = false)
    private String name;

    public void setName(String name) { this.name = name; }
}
