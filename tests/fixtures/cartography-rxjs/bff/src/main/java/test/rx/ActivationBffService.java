package test.rx;

import org.springframework.stereotype.Service;

@Service
public class ActivationBffService {
    public ActivationStatusDto activate(ActivationRequest request) {
        ActivationStatusDto dto = new ActivationStatusDto();
        dto.setStatus("READY");
        return dto;
    }

    public ActivationStatusDto status() {
        return new ActivationStatusDto();
    }
}
