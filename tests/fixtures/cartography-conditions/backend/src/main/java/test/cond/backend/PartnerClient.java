package test.cond.backend;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestTemplate;

@Service
public class PartnerClient {
    private final RestTemplate restTemplate;

    @Value("${partner.url}")
    private String partnerUrl;

    public PartnerClient(RestTemplate restTemplate) {
        this.restTemplate = restTemplate;
    }

    public void verify(Request request) {
        PartnerVerifyRequest body = new PartnerVerifyRequest();
        body.setStatus(request.getStatus());
        restTemplate.postForObject(partnerUrl + "/partner/verify", body, Void.class);
    }
}
