package test.backend;

import org.springframework.stereotype.Service;

@Service
public class RequestService {
    private final RequestRepository repository;

    public RequestService(RequestRepository repository) {
        this.repository = repository;
    }

    public Request create(CreateRequestCommand command) {
        Request entity = new Request();
        entity.setOrganizationName(command.getOrganizationName());
        entity.setEmail(command.getEmail());
        entity.setStatus("DRAFT");
        return repository.save(entity);
    }

    public Request get(Long id) {
        return repository.findById(id).orElseThrow();
    }

    public Request update(Long id, UpdateRequestCommand command) {
        Request entity = repository.findById(id).orElseThrow();
        entity.setOrganizationName(command.getOrganizationName());
        return repository.save(entity);
    }

    public Request validate(Long id) {
        Request entity = repository.findById(id).orElseThrow();
        entity.setStatus("VALIDATED");
        return repository.save(entity);
    }
}
