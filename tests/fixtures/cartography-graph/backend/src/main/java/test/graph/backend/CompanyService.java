package test.graph.backend;

import org.springframework.stereotype.Service;

@Service
public class CompanyService {
    private final CompanyRepository repository;
    private final PartnerVerificationClient partner;

    public CompanyService(CompanyRepository repository, PartnerVerificationClient partner) {
        this.repository = repository;
        this.partner = partner;
    }

    public Company createCompany(CompanyCommand command) {
        partner.callPartnerApi(command.getName());
        Company company = new Company();
        company.setName(command.getName());
        return repository.save(company);
    }

    public void searchCompany(CompanyCommand command) {
        partner.callPartnerApi(command.getName());
        repository.findAll();
    }

    public Company updateCompany(CompanyCommand command) {
        partner.fetchStatus();
        Company company = new Company();
        company.setStatus(command.getStatus());
        return repository.save(company);
    }

    public Company loadCompany() {
        partner.fetchStatus();
        return repository.findById(1L).orElse(null);
    }
}
