Feature: About page
  Scenario: the about page is reachable
    Given I open "/"
    When I click on "About"
    Then the URL contains "/about.html"
