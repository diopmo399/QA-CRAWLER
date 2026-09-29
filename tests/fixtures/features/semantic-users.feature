# language: fr
@mutation
Fonctionnalité: Utilisateurs, décrits par leurs intentions
  Aucun sélecteur, aucun XPath, aucun id : QA-Crawler observe l'écran et résout chaque
  intention (champ, option, bouton, page) avec une confiance expliquée.

  Scénario: Création utilisateur
    Étant donné que je suis sur la page des utilisateurs
    Quand je clique sur "Créer un utilisateur"
    Et je renseigne le prénom avec "Mohamed"
    Et je renseigne le nom avec "Diop"
    Et je renseigne le courriel avec "mohamed@example.com"
    Et je sélectionne "Administrateur" comme rôle
    Et je renseigne la date de naissance avec "1990-05-17"
    Et je saisis "2" dans le nombre d'enfants
    Et je sélectionne "Français" comme langue
    Et je sélectionne "Annuel" comme fréquence de contact
    Et je coche la case compte actif
    Et je renseigne le commentaire avec "Créé par le scénario"
    Et je valide le formulaire
    Alors un message de confirmation est affiché
    Et l'utilisateur doit apparaître dans la liste

  Scénario: Création par tableau
    Étant donné que je suis sur la page des utilisateurs
    Quand je clique sur "Créer un utilisateur"
    Et je remplis le formulaire utilisateur avec :
      | champ    | valeur          |
      | prénom   | Awa             |
      | nom      | Ndiaye          |
      | courriel | awa@example.com |
      | rôle     | Bénévole        |
    Et je valide le formulaire
    Alors l'utilisateur doit être créé
    Et la page Utilisateurs est affichée

  Scénario: Inscription en deux étapes
    Quand j'ouvre l'inscription
    Et je renseigne la ville avec "Québec"
    Et je passe à l'étape suivante
    Alors la page Étape 2 est affichée
