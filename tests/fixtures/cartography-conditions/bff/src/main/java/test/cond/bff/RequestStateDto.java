package test.cond.bff;

public class RequestStateDto {
    private boolean showCompanySection;
    private boolean showValidationSection;
    private boolean canValidate;

    public boolean getShowCompanySection() { return showCompanySection; }
    public boolean getShowValidationSection() { return showValidationSection; }
    public boolean getCanValidate() { return canValidate; }
    public void setShowCompanySection(boolean value) { this.showCompanySection = value; }
    public void setShowValidationSection(boolean value) { this.showValidationSection = value; }
    public void setCanValidate(boolean value) { this.canValidate = value; }
}
