package test.cond.backend;

import org.springframework.stereotype.Service;

@Service
public class RequestStateService {
    private final RequestRepository repository;
    private final ValidationEligibilityService eligibility;

    public RequestStateService(RequestRepository repository, ValidationEligibilityService eligibility) {
        this.repository = repository;
        this.eligibility = eligibility;
    }

    public RequestStateView state() {
        Request request = repository.findById(1L).orElseThrow();
        RequestStateView view = new RequestStateView();
        view.setShowCompanySection(eligibility.needsCompany(request));
        view.setShowValidationSection(eligibility.isEligibleForValidation(request));
        view.setCanValidate(eligibility.canValidate(request));
        return view;
    }
}
