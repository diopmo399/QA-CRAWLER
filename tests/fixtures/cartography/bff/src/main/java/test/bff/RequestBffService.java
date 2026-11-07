package test.bff;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestTemplate;

@Service
public class RequestBffService {
    private final RestTemplate restTemplate;

    @Value("${backend.url}")
    private String backendUrl;

    public RequestBffService(RestTemplate restTemplate) {
        this.restTemplate = restTemplate;
    }

    public RequestBffView create(CreateRequestDto dto) {
        BackendRequestBody body = new BackendRequestBody();
        body.setOrganizationName(dto.getCompanyName());
        body.setEmail(dto.getContactEmail());
        return restTemplate.postForObject(backendUrl + "/requests", body, RequestBffView.class);
    }

    public RequestBffView get(Long id) {
        return restTemplate.getForObject(backendUrl + "/requests/{id}", RequestBffView.class, id);
    }

    public RequestBffView update(Long id, UpdateRequestDto dto) {
        BackendRequestBody body = new BackendRequestBody();
        body.setOrganizationName(dto.getCompanyName());
        restTemplate.put(backendUrl + "/requests/{id}", body, id);
        return get(id);
    }
}
