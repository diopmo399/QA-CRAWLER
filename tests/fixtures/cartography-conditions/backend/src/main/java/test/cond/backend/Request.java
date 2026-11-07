package test.cond.backend;

import jakarta.persistence.*;
import java.util.List;

@Entity
@Table(name = "REQUEST")
public class Request {
    @Id
    @GeneratedValue
    private Long id;

    @Column(name = "STATUS")
    private String status;

    @Column(name = "TYPE")
    private String type;

    @Column(name = "NAME")
    private String name;

    @Column(name = "AMOUNT")
    private Integer amount;

    @OneToMany
    private List<Document> documents;

    public String getStatus() { return status; }
    public String getType() { return type; }
    public Integer getAmount() { return amount; }
    public List<Document> getDocuments() { return documents; }
    public void setStatus(String status) { this.status = status; }
    public void setType(String type) { this.type = type; }
    public void setName(String name) { this.name = name; }
}
