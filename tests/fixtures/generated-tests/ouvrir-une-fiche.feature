# language: fr
# Recorded by QA-CRAWLER (human flow recorder), session rec-20261029051426-a4f064, 2026-10-29T05:14:26.178Z
# Typed values are never recorded: { testData } is a valid value chosen at replay, secrets come from { env }.
# Review before use. The safety policy still applies when it is replayed.
Fonctionnalité: Ouvrir une fiche

  Scénario: Ouvrir une fiche
    # HUMAN_RECORDED · SEMANTIC · h001 · target VALIDATED_AFTER_RERENDER · functionalIntent NAVIGATE CONFIRMED 0.894 · raw r2
    Quand je clique sur le lien "Utilisateurs"
    # HUMAN_RECORDED · SEMANTIC · h002 · target AMBIGUOUS · REQUIRES_REPLAY_VALIDATION · functionalIntent OPEN_USER PROBABLE 0.832 · raw r4
    Et je clique sur le lien "Utilisateur 1"
    # INFERRED_OUTCOME · raw r4
    Alors l'URL contient "/users/"
