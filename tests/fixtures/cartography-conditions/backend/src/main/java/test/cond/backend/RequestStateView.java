package test.cond.backend;

public class RequestStateView {
    private boolean showCompanySection;
    private boolean showValidationSection;
    private boolean canValidate;

    public void setShowCompanySection(boolean value) { this.showCompanySection = value; }
    public void setShowValidationSection(boolean value) { this.showValidationSection = value; }
    public void setCanValidate(boolean value) { this.canValidate = value; }
}
