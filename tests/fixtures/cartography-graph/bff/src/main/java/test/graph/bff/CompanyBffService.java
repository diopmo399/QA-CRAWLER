package test.graph.bff;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestTemplate;

@Service
public class CompanyBffService {
    private final RestTemplate restTemplate;
    private final CompanyMapper mapper;

    @Value("${backend.url}")
    private String backendUrl;

    public CompanyBffService(RestTemplate restTemplate, CompanyMapper mapper) {
        this.restTemplate = restTemplate;
        this.mapper = mapper;
    }

    public void createCompany(CompanyDto dto) {
        CompanyBody body = mapper.mapToDto(dto);
        restTemplate.postForObject(backendUrl + "/companies", body, Void.class);
    }

    public void searchCompany(CompanyDto dto) {
        CompanyBody body = mapper.mapToDto(dto);
        restTemplate.postForObject(backendUrl + "/companies/search", body, Void.class);
    }

    public void updateCompany(CompanyDto dto) {
        CompanyBody body = mapper.mapToDto(dto);
        restTemplate.put(backendUrl + "/companies/current", body);
    }

    public CompanyDto loadCompany() {
        CompanyBody body = restTemplate.getForObject(backendUrl + "/companies/current", CompanyBody.class);
        return mapper.mapFromDto(body);
    }
}
