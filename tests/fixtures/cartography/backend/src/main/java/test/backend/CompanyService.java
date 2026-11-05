package test.backend;

import org.springframework.stereotype.Service;

@Service
public class CompanyService {
    private final CompanyRepository repository;
    private final PartnerVerificationClient partner;

    public CompanyService(CompanyRepository repository, PartnerVerificationClient partner) {
        this.repository = repository;
        this.partner = partner;
    }

    public Company create(CompanyCommand command) {
        partner.verifyCompany(command.getName());
        Company company = new Company();
        company.setName(command.getName());
        return repository.save(company);
    }
}
