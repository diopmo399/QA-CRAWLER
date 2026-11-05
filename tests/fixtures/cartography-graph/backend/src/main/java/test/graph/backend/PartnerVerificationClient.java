package test.graph.backend;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestTemplate;

@Service
public class PartnerVerificationClient {
    private final RestTemplate restTemplate;

    @Value("${partner.url}")
    private String partnerUrl;

    public PartnerVerificationClient(RestTemplate restTemplate) {
        this.restTemplate = restTemplate;
    }

    public VerificationResult callPartnerApi(String companyName) {
        VerificationRequest request = new VerificationRequest();
        request.setCompanyName(companyName);
        return restTemplate.postForObject(partnerUrl + "/partners/company/verify", request, VerificationResult.class);
    }

    public VerificationResult fetchStatus() {
        return restTemplate.getForObject(partnerUrl + "/partners/company/status", VerificationResult.class);
    }
}
