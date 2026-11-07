package test.cond.backend;

import org.springframework.stereotype.Service;

@Service
public class ValidationEligibilityService {
    public boolean isEligibleForValidation(Request request) {
        return "SUBMITTED".equals(request.getStatus());
    }

    public boolean canValidate(Request request) {
        for (Document document : request.getDocuments()) {
            if (!document.isVerified()) {
                return false;
            }
        }
        return request.getAmount() != null && request.getAmount() > 0;
    }

    public boolean needsCompany(Request request) {
        return "COMPANY".equals(request.getType());
    }
}
