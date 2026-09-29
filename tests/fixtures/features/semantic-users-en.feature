@mutation
Feature: Users, in English, on a French screen

  Scenario: Create a user
    Given I am on the users page
    When I click "Créer un utilisateur"
    And I fill in the first name with "Lina"
    And I fill in the last name with "Haddad"
    And I enter "lina@example.com" in the email field
    And I select "Utilisateur" as role
    And I submit the form
    Then a confirmation message is displayed
