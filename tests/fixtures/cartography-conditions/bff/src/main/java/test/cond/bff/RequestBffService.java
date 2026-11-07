package test.cond.bff;

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

    public void create(NewRequestDto dto) {
        RequestBody body = new RequestBody();
        body.setType(dto.getCompanyType());
        body.setName(dto.getCompanyName());
        restTemplate.postForObject(backendUrl + "/requests", body, Void.class);
    }

    public RequestStateDto state() {
        RequestStateView view = restTemplate.getForObject(backendUrl + "/requests/current/state", RequestStateView.class);
        RequestStateDto dto = new RequestStateDto();
        dto.setShowCompanySection(view.getShowCompanySection());
        dto.setShowValidationSection(view.getShowValidationSection());
        dto.setCanValidate(view.getCanValidate());
        return dto;
    }

    public void validate() {
        ValidationBody body = new ValidationBody();
        restTemplate.postForObject(backendUrl + "/requests/validate", body, Void.class);
    }

    public void refuse() {
        ValidationBody body = new ValidationBody();
        restTemplate.postForObject(backendUrl + "/requests/refuse", body, Void.class);
    }
}
