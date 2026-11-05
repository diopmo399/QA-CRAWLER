package test.bff;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestTemplate;

@Service
public class CompanyBffService {
    private final RestTemplate restTemplate;

    @Value("${backend.url}")
    private String backendUrl;

    public CompanyBffService(RestTemplate restTemplate) {
        this.restTemplate = restTemplate;
    }

    public void create(CompanyDto dto) {
        CompanyBody body = new CompanyBody();
        body.setName(dto.getCompanyName());
        restTemplate.postForObject(backendUrl + "/companies", body, Void.class);
    }
}
