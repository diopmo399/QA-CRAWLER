package test.graph.bff;

import org.springframework.stereotype.Component;

@Component
public class CompanyMapper {
    public CompanyBody mapToDto(CompanyDto dto) {
        CompanyBody body = new CompanyBody();
        body.setName(dto.getCompanyName());
        body.setStatus(dto.getStatus());
        return body;
    }

    public CompanyDto mapFromDto(CompanyBody body) {
        return new CompanyDto();
    }
}
