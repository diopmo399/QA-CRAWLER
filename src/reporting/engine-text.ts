/**
 * Traduction en français des textes produits par le moteur (raisons du score de base,
 * preuves des motifs, nouveauté, invariants, écritures bloquées). Le moteur écrit en
 * anglais dans ses journaux et ses fichiers JSON ; le rapport HTML suit la langue.
 * Un texte inconnu est laissé tel quel.
 */
const FR_PHRASES: [RegExp, string][] = [
  // scorer de base
  [/never executed from this state/g, 'jamais exécutée depuis cet écran'],
  [/\bnew route ([^\s,)]+)/g, 'nouvelle route $1'],
  [/([^\s,(]+): (\d+) state\(s\) known/g, '$1 : $2 état(s) connu(s)'],
  [/\bmenu link\b/g, 'lien de menu'],
  [/\bnavigation link\b/g, 'lien de navigation'],
  [/\bdetails link\b/g, 'lien vers une fiche'],
  [/\bpagination link\b/g, 'lien de pagination'],
  [/\bsearch link\b/g, 'lien de recherche'],
  [/\bfilter link\b/g, 'lien de filtre'],
  [/(\w[\w-]*) control\b/g, 'contrôle $1'],
  [/may show a new state/g, 'peut montrer un nouvel écran'],
  [/already used from another state/g, 'déjà utilisée depuis un autre écran'],
  [/(check|select) may reveal more of the form/g, '$1 peut révéler une partie du formulaire'],
  [/URL matches the goal "([^"]*)"/g, 'l’URL correspond à l’objectif « $1 »'],
  [/matches the goal "([^"]*)"/g, 'correspond à l’objectif « $1 »'],
  [/export\/download \("([^"]*)"\)/g, 'export / téléchargement (« $1 »)'],
  [/known from the baseline/g, 'connue de la baseline'],
  [/in front of the screen/g, 'devant l’écran'],
  // nouveauté
  [/\bnew heading\b/g, 'nouveau titre'],
  [/(\d+) new action\(s\)/g, '$1 nouvelle(s) action(s)'],
  [/\bnew form\b/g, 'nouveau formulaire'],
  [/\bnew pattern\b/g, 'nouveau motif'],
  [/never seen in previous runs/g, 'jamais vu lors des runs précédents'],
  // preuves des motifs
  [/table without rows/g, 'tableau sans ligne'],
  [/(\d+) row\(s\)/g, '$1 ligne(s)'],
  [/^table\b/g, 'tableau'],
  [/(\d+) list\(s\)/g, '$1 liste(s)'],
  [/(\d+) cards\b/g, '$1 cartes'],
  [/button "([^"]*)" \((\w+)\)/g, 'bouton « $1 » ($2)'],
  [/button "([^"]*)"/g, 'bouton « $1 »'],
  [/(\d+) per-row actions/g, '$1 actions par ligne'],
  [/search or pagination around the list/g, 'recherche ou pagination autour de la liste'],
  [/password field/g, 'champ mot de passe'],
  [/username \/ e-mail field/g, 'champ identifiant / courriel'],
  [/sign-in wording/g, 'vocabulaire de connexion'],
  [/(\d+) empty field\(s\)/g, '$1 champ(s) vide(s)'],
  [/(\d+)\/(\d+) field\(s\) already filled/g, '$1/$2 champ(s) déjà rempli(s)'],
  [/create wording/g, 'vocabulaire de création'],
  [/edit wording/g, 'vocabulaire de modification'],
  [/submit button/g, 'bouton d’envoi'],
  [/record route/g, 'route d’enregistrement'],
  [/no record list/g, 'pas de liste d’enregistrements'],
  [/edit button/g, 'bouton modifier'],
  [/back button/g, 'bouton retour'],
  [/^breadcrumb\b/g, 'fil d’Ariane'],
  [/search field/g, 'champ de recherche'],
  [/search button/g, 'bouton de recherche'],
  [/results list/g, 'liste de résultats'],
  [/(\d+) filter control\(s\)/g, '$1 filtre(s)'],
  [/filtered list/g, 'liste filtrée'],
  [/pagination bar/g, 'barre de pagination'],
  [/(\d+) pagination control\(s\)/g, '$1 contrôle(s) de pagination'],
  [/paged list/g, 'liste paginée'],
  [/(\d+) steps\b/g, '$1 étapes'],
  [/next \/ previous step controls/g, 'boutons étape suivante / précédente'],
  [/next button/g, 'bouton suivant'],
  [/fields in the step/g, 'champs dans l’étape'],
  [/^dialog\b/g, 'fenêtre'],
  [/no field in the dialog/g, 'aucun champ dans la fenêtre'],
  [/confirm button in the dialog/g, 'bouton de confirmation dans la fenêtre'],
  [/cancel button in the dialog/g, 'bouton annuler dans la fenêtre'],
  [/screen still usable/g, 'écran encore utilisable'],
  [/(\d+) named regions/g, '$1 régions nommées'],
  [/(\d+) menu entries/g, '$1 entrées de menu'],
  [/dashboard \/ home wording/g, 'vocabulaire tableau de bord / accueil'],
  [/list of records/g, 'liste d’enregistrements'],
  [/detail pane/g, 'panneau de détail'],
  [/selected item/g, 'élément sélectionné'],
  [/(\d+) tabs\b/g, '$1 onglets'],
  [/\btablist\b/g, 'liste d’onglets'],
  [/^navigation$/g, 'navigation'],
  [/file input \/ drop zone/g, 'champ fichier / zone de dépôt'],
  [/upload button/g, 'bouton d’envoi de fichier'],
  [/(\d+) control\(s\) only/g, 'seulement $1 contrôle(s)'],
  [/no form field/g, 'aucun champ'],
  [/document answered (\d+)/g, 'la page a répondu $1'],
  [/^title "/g, 'titre « '],
  // invariants
  [/resulting screen/g, 'écran obtenu'],
  [/request\(s\) below/g, 'requête(s) sous'],
  [/no recognised pattern/g, 'aucun motif reconnu'],
  [/no resulting screen/g, 'aucun écran obtenu'],
  [/page accessible/g, 'page accessible'],
  [/\baccess (allowed|denied|forbidden|login)\b/g, 'accès $1'],
  [/\bor\b/g, 'ou'],
  [/text "([^"]*)" shown/g, 'texte « $1 » affiché'],
  [/text "([^"]*)" absent/g, 'texte « $1 » absent'],
  [/text not shown/g, 'texte absent'],
  [/"([^"]*)" shown/g, '« $1 » affiché'],
  // garde d'écriture
  [/filling the form "([^"]*)"/g, 'remplissage du formulaire « $1 »'],
  [/flow "([^"]*)" step "([^"]*)"/g, 'flow « $1 », étape « $2 »'],
  [/^exploration$/g, 'exploration'],
  // raisons des objectifs
  [
    /not observed before the end of the exploration \(([^)]*)\)/g,
    'non observé avant la fin de l’exploration ($1)',
  ],
  [/"([^"]*)" is blocked by the safety policy/g, '« $1 » est bloqué par la politique de sécurité'],
  [/a sub-goal is blocked/g, 'un sous-objectif est bloqué'],
];

/** Libellés des types de preuve d'un objectif et des compteurs du budget. */
const FR_LABELS: Record<string, string> = {
  url: 'URL',
  title: 'titre de page',
  heading: 'titre',
  region: 'région',
  breadcrumb: 'fil d’Ariane',
  tab: 'onglet',
  action: 'action',
  pattern: 'motif',
  form: 'formulaire',
  states: 'écrans',
  actions: 'actions',
  mutations: 'modifications',
  validationCases: 'cas de validation',
  propertyCases: 'cas de propriété',
};

export function engineLabel(key: string, language: 'en' | 'fr'): string {
  return language === 'fr' ? (FR_LABELS[key] ?? key) : key;
}

export function translateEngineText(text: string, language: 'en' | 'fr'): string {
  if (language !== 'fr') return text;
  let translated = text;
  for (const [pattern, replacement] of FR_PHRASES) translated = translated.replace(pattern, replacement);
  return translated;
}
