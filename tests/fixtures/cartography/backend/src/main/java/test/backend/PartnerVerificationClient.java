package test.backend;

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

    public VerificationResult verifyCompany(String companyName) {
        VerificationRequest request = new VerificationRequest();
        request.setCompanyName(companyName);
        return restTemplate.postForObject(partnerUrl + "/companies/verify", request, VerificationResult.class);
    }

    public void notifyTarget(String target, VerificationRequest request) {
        restTemplate.postForObject(target, request, Void.class);
    }
}
