package test.cond.backend;

import org.springframework.stereotype.Service;

@Service
public class RequestValidationService {
    private final RequestRepository repository;
    private final PartnerClient partner;

    public RequestValidationService(RequestRepository repository, PartnerClient partner) {
        this.repository = repository;
        this.partner = partner;
    }

    public void validate(ValidationCommand command) {
        Request request = repository.findById(1L).orElseThrow();
        partner.verify(request);
        request.setStatus("VALIDATED");
        repository.save(request);
    }

    public void refuse(ValidationCommand command) {
        Request request = repository.findById(1L).orElseThrow();
        request.setStatus("REFUSED");
        repository.save(request);
    }

    public void create(RequestCommand command) {
        Request request = new Request();
        request.setType(command.getType());
        request.setName(command.getName());
        repository.save(request);
    }
}
