import { z } from 'zod';
import {
  loadTestDataSetFile,
  mergeTestDataSets,
  parseTestDataSet,
  TestDataSetError,
  type TestDataSet,
} from '../data/test-data-set.js';
import { ACTION_CLASSIFICATIONS, RISK_KINDS } from '../model/discovered-action.js';
import { SEVERITIES } from '../model/issue.js';
import { REPORT_LANGUAGES } from '../reporting/i18n.js';
import { SCORING_WEIGHT_NAMES, type ScoringWeightName } from '../decision/scoring-weights.js';
import { flowsSchema } from './flow-schema.js';
import { RECOVERY_STRATEGIES } from '../recovery/recovery-model.js';
import { ACCESSIBILITY_RULES } from '../accessibility/accessibility-checker.js';
import { LOG_LEVELS } from '../logging/engine-log.js';
import { UI_PATTERNS } from '../patterns/ui-pattern.js';

/**
 * Configuration de la mission. Le YAML décrit *quoi explorer et dans quelles
 * limites* : l'explorateur découvre lui-même les écrans et les transitions.
 * Les `flows` facultatifs imposent en plus des étapes de test ordonnées
 * (toujours contrôlées par la SafetyPolicy). Chaque section sauf `target.baseUrl`
 * a des valeurs par défaut : une mission minimale, c'est juste une URL.
 */

const nonEmpty = z.string().trim().min(1);

/** learn : construire la baseline ; verify : vérifier l'application par rapport à elle ; explore : chercher du nouveau. */
export const MISSION_MODES = ['explore', 'learn', 'verify'] as const;
export type MissionMode = (typeof MISSION_MODES)[number];

const SCORING_WEIGHT_NAMES_TUPLE = SCORING_WEIGHT_NAMES as [ScoringWeightName, ...ScoringWeightName[]];

const browserSchema = z
  .object({
    headless: z.boolean().default(true),
    viewport: z
      .object({
        width: z.number().int().positive().default(1366),
        height: z.number().int().positive().default(768),
      })
      .strict()
      .default({}),
    locale: nonEmpty.optional(),
    userAgent: nonEmpty.optional(),
    ignoreHttpsErrors: z.boolean().default(false),
    /** Options Chromium supplémentaires. `--disable-dev-shm-usage` évite les plantages dus au petit /dev/shm des conteneurs. */
    args: z.array(nonEmpty).default(['--disable-dev-shm-usage']),
    slowMoMs: z.number().int().min(0).default(0),
  })
  .strict();

const queryParamsSchema = z
  .object({
    /**
     * - pattern : garder les paramètres de requête, mais regrouper les URL par *noms* de paramètres pour le budget par route
     *   (?page=1, ?page=2 … comptent comme la même route).
     * - ignore : supprimer tous les paramètres de requête (chaque chemin est visité une fois).
     * - keep : chaque chaîne de requête distincte est une nouvelle page (limité seulement par maxStates).
     */
    mode: z.enum(['pattern', 'ignore', 'keep']).default('pattern'),
    /** Paramètres toujours retirés avant de comparer des URL (suivi, anti-cache). Joker `*` accepté. */
    ignored: z.array(nonEmpty).default(['utm_*', 'fbclid', 'gclid', '_', 'ts', 'timestamp', 'cachebuster']),
  })
  .strict();

const explorationSchema = z
  .object({
    /** Nombre maximal d'états fonctionnels distincts (écrans, étapes, onglets) à découvrir. */
    maxStates: z.number().int().positive().default(100),
    /** Nombre maximal d'actions exécutées (clics, navigations, saisies). */
    maxActions: z.number().int().positive().default(500),
    /** Nombre maximal de transitions depuis l'état de départ. */
    maxDepth: z.number().int().min(0).default(10),
    maxDurationMinutes: z.number().positive().default(15),
    /** Délai d'une seule action (trouver l'élément + l'exécuter). */
    actionTimeoutMs: z.number().int().positive().default(10_000),
    navigationTimeoutMs: z.number().int().positive().default(15_000),
    /** État de chargement Playwright attendu après chaque navigation. */
    waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle', 'commit']).default('load'),
    /** Attente supplémentaire après chaque action, pour que les SPA (Angular…) affichent l'écran et lancent leurs appels d'API. */
    settleTimeMs: z.number().int().min(0).default(400),
    /**
     * Puis, au plus ce délai, attendre que l'écran soit affiché : plus de roue de chargement
     * ni de barre de progression visible, et une page qui ne bouge plus. 0 : ne pas attendre.
     */
    readyTimeoutMs: z.number().int().min(0).default(10_000),
    /** États distincts explorés par modèle de route (/users/:id → seulement N utilisateurs). */
    maxStatesPerRoute: z.number().int().positive().default(3),
    queryParams: queryParamsSchema.default({}),
    /**
     * Les contrôles pareils d'un écran (jours d'un calendrier, numéros de page,
     * « Voir » sur chaque ligne…) sont essayés au plus ce nombre de fois, pas un par un.
     */
    maxSimilarActions: z.number().int().positive().default(2),
    /**
     * best-first (défaut) : le meilleur candidat de toute la frontière d'exploration, même
     * sur un autre écran quand il vaut nettement plus (switchMargin) ; depth-first : l'écran
     * courant d'abord, retour arrière quand il n'y a plus rien (comportement historique).
     */
    strategy: z.enum(['best-first', 'depth-first']).default('best-first'),
    /** Poids des composantes du score (déterministes). 0 désactive une composante. */
    goalWeight: z.number().min(0).default(1.5),
    patternWeight: z.number().min(0).default(1),
    noveltyWeight: z.number().min(0).default(1),
    coverageWeight: z.number().min(0).default(0.8),
    historyWeight: z.number().min(0).default(0.5),
    /** Écart de score au-delà duquel on quitte l'écran courant pour un meilleur candidat ailleurs. */
    switchMargin: z.number().min(0).default(60),
    /** Bonus d'ancienneté par décision d'attente d'un candidat (anti-starvation). */
    agingBonus: z.number().min(0).default(2),
    /**
     * Graine d'un départage pseudo-aléatoire entre candidats de même score. Absente
     * (défaut) : aucun hasard, l'ordre du document départage. Présente : run reproductible.
     */
    seed: z.number().int().optional(),
    /** Nombre maximal d'actions enregistrées par état. */
    maxRecordedActions: z.number().int().positive().default(200),
    /**
     * Explorer l'application en autonomie à partir de target.startAt. Mettre false
     * pour exécuter seulement les `flows` imposés.
     */
    autonomous: z.boolean().default(true),
  })
  .strict();

/** Un objectif fonctionnel : « users », ou { id, description, keywords, priority }. */
const goalTargetSchema = z.union([
  nonEmpty,
  z
    .object({
      id: nonEmpty,
      description: z.string().optional(),
      /** Mots qui prouvent l'objectif atteint (en plus de l'id et de ses synonymes). */
      keywords: z.array(nonEmpty).default([]),
      /** 1 (bas) … 10 (haut) ; par défaut, l'ordre de la liste. */
      priority: z.number().int().min(1).max(10).optional(),
    })
    .strict(),
]);

const goalsObjectSchema = z
  .object({
    /** Suivre les liens et les routerLinks. */
    discoverNavigation: z.boolean().default(true),
    /** Remplir les champs avec des données de test (jamais les sensibles) pour explorer les formulaires et les étapes d'assistant. */
    discoverForms: z.boolean().default(true),
    /** Cliquer sur les contrôles de la page (onglets, menus, détails, bascules, étapes d'assistant). */
    discoverFlows: z.boolean().default(true),
    /** Signaler les anomalies HTTP, JavaScript et de navigation. */
    detectErrors: z.boolean().default(true),
    /**
     * Ce que cherche la mission, avec les mots de l'application (« utilisateurs »,
     * « permissions »…) : les actions dont le libellé ou l'URL en contient un sont
     * explorées en premier. Déterministe (libellés, textes, URL), aucun modèle.
     */
    keywords: z.array(nonEmpty).default([]),
    /** Forme courte de discover* (navigation, forms, dialogs → discoverFlows). */
    discover: z
      .object({
        navigation: z.boolean().optional(),
        forms: z.boolean().optional(),
        dialogs: z.boolean().optional(),
      })
      .strict()
      .optional(),
    /**
     * Objectifs fonctionnels (« users », « create-user », « permissions ») : le GoalPlanner
     * en fait des sous-objectifs, le crawler trouve lui-même le chemin. Un objectif n'est
     * atteint qu'avec une preuve observable (URL, titre, région…).
     */
    targets: z.array(goalTargetSchema).default([]),
  })
  .strict();

/** `goals` : l'objet complet, ou directement la liste des objectifs fonctionnels. */
const goalsSchema = z.preprocess(
  (value) => (Array.isArray(value) ? { targets: value } : value),
  goalsObjectSchema,
);

/** Catégories d'actions SAFE qu'une mission peut autoriser. */
export const SAFE_ACTION_GROUPS = [
  'navigation',
  'tabs',
  'menus',
  'details',
  'pagination',
  'search',
  'filter',
  'forms',
  'other',
] as const;
export type SafeActionGroup = (typeof SAFE_ACTION_GROUPS)[number];

const checksSchema = z
  .object({
    consoleErrors: z.boolean().default(true),
    consoleWarnings: z.boolean().default(false),
    pageErrors: z.boolean().default(true),
    httpErrors: z.boolean().default(true),
    requestFailures: z.boolean().default(true),
    brokenLinks: z.boolean().default(true),
    /** Capturer chaque page visitée. */
    screenshots: z.boolean().default(true),
    /** Capturer les pages avec une anomalie ERROR/CRITICAL même quand `screenshots` vaut false. */
    screenshotOnError: z.boolean().default(true),
    fullPageScreenshots: z.boolean().default(false),
  })
  .strict();

const httpSchema = z
  .object({
    /** Les réponses dont le statut est >= à cette valeur sont signalées. */
    failOnStatus: z.number().int().min(100).max(599).default(400),
    /** Statuts jamais signalés (par exemple un 401 sur une vérification de session facultative). */
    ignoreStatus: z.array(z.number().int().min(100).max(599)).default([]),
    /** Les URL de requête contenant l'une de ces sous-chaînes ne sont jamais signalées. */
    ignoreUrlPatterns: z.array(nonEmpty).default([]),
  })
  .strict();

const safetySchema = z
  .object({
    /** Noms d'hôte que le crawler peut visiter. Par défaut : l'hôte de target.baseUrl. `*.example.com` accepté. */
    allowedHosts: z.array(nonEmpty).default([]),
    /** Chemins jamais visités. Correspondance par préfixe ; joker `*` accepté (par exemple /admin/*\/delete). */
    ignoredPaths: z.array(nonEmpty).default(['/logout', '/signout', '/sign-out', '/deconnexion']),
    /** Classes d'actions que le crawler peut exécuter automatiquement. */
    allowedActionClasses: z.array(z.enum(ACTION_CLASSIFICATIONS)).default(['SAFE']),
    /** Types d'actions SAFE que la mission peut exécuter. Par défaut : tous. */
    allow: z.array(z.enum(SAFE_ACTION_GROUPS)).default([...SAFE_ACTION_GROUPS]),
    /**
     * Risques qui bloquent toujours une action, quelle que soit sa classe.
     * `sensitive-data` (mots de passe, numéros de carte, secrets) est bloqué même s'il est absent d'ici.
     */
    block: z
      .array(z.enum(RISK_KINDS))
      .default([
        'delete',
        'payment',
        'send',
        'logout',
        'irreversible',
        'sensitive-data',
        'external-navigation',
        'form-submit',
        'download',
      ]),
    /**
     * Actions qui modifient des données (créer, enregistrer, envoyer un formulaire).
     * Désactivé par défaut ; activé, les actions MUTATION et l'envoi de formulaire
     * sont permis, dans un budget par run. Les actions DANGEROUS (supprimer,
     * payer…) ne s'exécutent que si DANGEROUS est dans allowedActionClasses, et comptent dans ce budget.
     */
    mutations: z
      .object({
        enabled: z.boolean().default(false),
        maxPerRun: z.number().int().min(0).default(10),
      })
      .strict()
      .default({}),
    /** Mots-clés supplémentaires (toute langue) ajoutés aux règles de classement intégrées. */
    keywords: z
      .object({
        safe: z.array(nonEmpty).default([]),
        mutation: z.array(nonEmpty).default([]),
        dangerous: z.array(nonEmpty).default([]),
      })
      .strict()
      .default({}),
    /**
     * Garde d'écriture : pendant l'exploration, toute requête POST, PUT, PATCH ou DELETE
     * vers un hôte autorisé est interceptée et annulée, sauf si l'action en cours a le
     * droit de modifier des données (MUTATION/DANGEROUS permise, étape de flow avec
     * `allow`) ou si elle correspond à `allow`. Une requête bloquée est signalée comme
     * effet de bord (une saisie qui écrit côté serveur…). La connexion n'est jamais gênée.
     */
    writeGuard: z
      .object({
        enabled: z.boolean().default(true),
        /** Requêtes d'écriture toujours permises : « POST /api/search », « /graphql », « * /api/*\/query ». Joker `*`. */
        allow: z.array(nonEmpty).default([]),
      })
      .strict()
      .default({}),
  })
  .strict();

const formAuthSchema = z
  .object({
    type: z.literal('form'),
    /** Page de connexion, absolue ou relative à target.baseUrl. */
    loginUrl: nonEmpty,
    usernameSelector: nonEmpty,
    passwordSelector: nonEmpty,
    submitSelector: nonEmpty,
    /** Noms des variables d'environnement qui contiennent les identifiants — jamais les identifiants eux-mêmes. */
    usernameEnv: nonEmpty.default('QA_USERNAME'),
    passwordEnv: nonEmpty.default('QA_PASSWORD'),
    /** La connexion a réussi quand ce sélecteur apparaît… */
    successSelector: nonEmpty.optional(),
    /** …ou quand l'URL contient cette chaîne. */
    successUrlContains: nonEmpty.optional(),
    timeoutMs: z.number().int().positive().default(15_000),
  })
  .strict();

/**
 * Authentification HTTP gérée par le navigateur lui-même (la fenêtre grise
 * « Se connecter » : Basic, par exemple le schéma Basic de SiteMinder ; NTLM
 * selon le serveur). Playwright répond au défi du serveur avec ces identifiants.
 */
const httpAuthSchema = z
  .object({
    type: z.literal('http'),
    /** Noms des variables d'environnement qui contiennent les identifiants — jamais les identifiants eux-mêmes. */
    usernameEnv: nonEmpty.default('QA_USERNAME'),
    passwordEnv: nonEmpty.default('QA_PASSWORD'),
    /**
     * N'envoyer les identifiants qu'à cette origine (https://sso.example.com).
     * Recommandé ; sans elle, ils sont envoyés à tout hôte qui les demande.
     */
    origin: z
      .string()
      .url()
      .refine((value) => /^https?:\/\//i.test(value), 'origin must use http or https')
      .transform((value) => new URL(value).origin)
      .optional(),
    /** Page chargée pour vérifier la connexion (par défaut : target.startAt). */
    checkUrl: nonEmpty.optional(),
    timeoutMs: z.number().int().positive().default(15_000),
  })
  .strict();

const authSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }).strict(),
  formAuthSchema,
  httpAuthSchema,
]);

/**
 * Autres utilisateurs de l'application (lecteur, gestionnaire…). Après
 * l'exploration, chacun ouvre les écrans trouvés — simples chargements de page,
 * jamais une action — pour voir ce qu'il peut atteindre. Identifiants : noms de
 * variables d'environnement seulement.
 */
const actorSchema = z
  .object({
    name: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/, 'letters, digits, dashes and underscores (40 max)'),
    description: z.string().optional(),
    auth: authSchema,
  })
  .strict();

const authorizationRuleSchema = z
  .object({
    actor: nonEmpty,
    /** Préfixe de chemin, joker `*` accepté (/admin/*). */
    path: nonEmpty,
    expect: z.enum(['allowed', 'denied']),
  })
  .strict();

const authorizationSchema = z
  .object({
    enabled: z.boolean().default(true),
    /** Nom de l'utilisateur de la mission (auth) dans les rapports. */
    primaryActor: nonEmpty.default('primary'),
    rules: z.array(authorizationRuleSchema).default([]),
    /** Nombre maximal d'écrans ouverts par acteur. */
    maxTargets: z.number().int().min(1).default(50),
    /** Mots qui montrent un refus sur une page répondue 200 (ajoutés à ceux intégrés). */
    deniedTexts: z.array(nonEmpty).default([]),
  })
  .strict();

/** Permissions du navigateur (noms Playwright) qu'une mission peut accorder explicitement. */
export const BROWSER_PERMISSIONS = [
  'geolocation',
  'notifications',
  'camera',
  'microphone',
  'clipboard-read',
  'clipboard-write',
] as const;
export type BrowserPermission = (typeof BROWSER_PERMISSIONS)[number];

const httpOrigin = z
  .string()
  .url()
  .refine((value) => /^https?:\/\//i.test(value), 'must use http or https')
  .transform((value) => new URL(value).origin);

/**
 * Profils d'identifiants nommés : seulement les NOMS des variables
 * d'environnement qui contiennent les secrets (secrets de CI, env Kubernetes…), jamais les secrets.
 */
const credentialsSchema = z
  .record(nonEmpty, z.object({ usernameEnv: nonEmpty, passwordEnv: nonEmpty }).strict())
  .default({});

/**
 * Interactions levées par le navigateur lui-même, hors du DOM de l'application
 * (fenêtre de connexion native, alert/confirm/prompt, popups, téléchargements,
 * sélecteur de fichier, demandes de permission, navigation vers une autre origine).
 */
const browserInteractionsSchema = z
  .object({
    enabled: z.boolean().default(true),
    /** Durée maximale d'un handler avant l'abandon de son interaction. */
    timeoutMs: z.number().int().positive().default(15_000),
    retry: z
      .object({
        /** Essais quand le navigateur relève la même interaction (par exemple des identifiants refusés). */
        maxAttempts: z.number().int().min(1).max(5).default(2),
      })
      .strict()
      .default({}),
    /** Même interaction (type, origine, action) vue plus de ce nombre de fois : INTERACTION_LOOP_DETECTED. */
    loopThreshold: z.number().int().min(2).default(5),
    /** Origines jamais visitées ni considérées de confiance (popups, redirections, identifiants). */
    blockedOrigins: z.array(httpOrigin).default([]),
    httpAuth: z
      .object({
        /** Profil de `credentials` utilisé pour répondre à la fenêtre de connexion du navigateur. Aucun : AUTH_REQUIRED. */
        credentialProfile: nonEmpty.optional(),
        /** Origines qui peuvent recevoir les identifiants. Par défaut : la cible et les hôtes autorisés. */
        origins: z.array(httpOrigin).default([]),
        /**
         * true : les identifiants sont donnés au navigateur dès son ouverture, pour l'unique origine de
         * `origins` ; Chromium répond lui-même à chaque fenêtre de connexion, dans toutes les popups
         * (aucune course avec une popup SSO qui se charge vite). Les défis ne sont alors plus rapportés
         * un par un (HTTP_AUTH), et un refus n'est pas réessayé.
         */
        answerByBrowser: z.boolean().default(false),
      })
      .strict()
      .default({}),
    dialogs: z
      .object({
        /** alert() : accepter (OK) ou fermer. */
        alert: z.enum(['accept', 'dismiss']).default('accept'),
        /**
         * confirm() : refuser (défaut), ou accept-safe : accepter seulement quand le
         * message ne contient aucune formulation destructive ou de modification.
         */
        confirm: z.enum(['dismiss', 'accept-safe']).default('dismiss'),
        /** Réponses aux prompt() dont le message contient `match`. Les autres sont refusés. */
        promptValues: z
          .array(
            z
              .object({
                match: nonEmpty,
                value: z.union([z.string(), z.object({ env: nonEmpty }).strict()]),
              })
              .strict(),
          )
          .default([]),
      })
      .strict()
      .default({}),
    popups: z
      .object({
        /** Enregistrer la nouvelle page comme un état du graphe (origines autorisées seulement), puis la fermer. */
        observe: z.boolean().default(true),
        /**
         * Laisser la nouvelle page ouverte jusqu'à cette durée pour qu'elle termine
         * seule (une popup SSO qui connecte, puis redirige ou se ferme). Elle est
         * observée puis fermée ensuite, sauf si elle s'est fermée seule. 0 : tout de suite.
         */
        closeAfterMs: z.number().int().min(0).max(60_000).default(0),
      })
      .strict()
      .default({}),
    permissions: z
      .object({
        /** Permissions accordées à l'origine cible. Par défaut : aucune (toute demande est refusée). */
        grant: z.array(z.enum(BROWSER_PERMISSIONS)).default([]),
      })
      .strict()
      .default({}),
  })
  .strict();

const outputSchema = z
  .object({
    reportsDir: nonEmpty.default('reports'),
    screenshotsDir: nonEmpty.default('screenshots'),
    json: z.boolean().default(true),
    html: z.boolean().default(true),
    /** reports/flow-graph.html */
    flowGraphHtml: z.boolean().default(true),
  })
  .strict();

const memorySchema = z
  .object({
    /** Où le graphe des flows est enregistré. Par défaut : <reportsDir>/flow-graph.json. */
    file: nonEmpty.optional(),
    /** Repartir du graphe d'un run précédent : les actions déjà essayées ne le sont pas à nouveau. */
    resume: z.boolean().default(false),
    /**
     * MÉMOIRE : les connaissances des anciens runs influencent-elles le run actuel ?
     * - absent : comportement historique (la base de connaissances `knowledge`, fichier JSON) ;
     * - false : run isolé, seulement la mémoire de travail du run courant ;
     * - true : avec la persistance, l'historique du provider est préchargé dans la mémoire de
     *   travail ; sans persistance, mémoire du run courant seulement.
     */
    enabled: z.boolean().optional(),
    /** Précharger la connaissance historique des transitions (memory.enabled: true et persistance active). */
    historicalKnowledge: z.boolean().default(true),
    /** Budget du préchargement : jamais toute la base. */
    preload: z
      .object({
        maxStates: z.number().int().positive().default(1000),
        maxTransitions: z.number().int().positive().default(5000),
      })
      .strict()
      .default({}),
    /** Mémoire de travail en RAM : le moteur de décision n'interroge jamais la base directement. */
    cache: z
      .object({ enabled: z.boolean().default(true) })
      .strict()
      .default({}),
  })
  .strict();

/** Connexion à une base : hôte / port / nom lus dans l'environnement (ou le YAML) ; identifiants dans l'environnement seulement. */
const databaseSchema = z
  .object({
    type: z.enum(['postgres', 'sqlserver', 'mysql', 'sqlite']),
    host: nonEmpty.optional(),
    hostEnv: nonEmpty.default('QA_DB_HOST'),
    port: z.number().int().positive().optional(),
    portEnv: nonEmpty.default('QA_DB_PORT'),
    database: nonEmpty.optional(),
    databaseEnv: nonEmpty.default('QA_DB_NAME'),
    usernameEnv: nonEmpty.default('QA_DB_USERNAME'),
    passwordEnv: nonEmpty.default('QA_DB_PASSWORD'),
    /** SQLite : fichier de la base. */
    file: nonEmpty.optional(),
    fileEnv: nonEmpty.default('QA_DB_FILE'),
    /** Appliquer les migrations manquantes (uniquement des ajouts). false : une base en retard est une erreur. */
    migrate: z.boolean().default(true),
    connectTimeoutMs: z.number().int().positive().default(5000),
    tls: z
      .object({
        /** Absent : le choix du pilote (PostgreSQL sans TLS, SQL Server chiffré). */
        enabled: z.boolean().optional(),
        /** Accepter un certificat auto-signé : base de développement locale seulement. */
        trustServerCertificate: z.boolean().default(false),
      })
      .strict()
      .default({}),
  })
  .strict();

/**
 * INTELLIGENCE DÉTERMINISTE (Phase 2) : exploiter la connaissance historique de façon
 * explicable. Tout est désactivé par défaut : une mission existante garde exactement son
 * comportement. Chaque capacité a son interrupteur (comparaisons A/B déterministes).
 * Aucune ne peut autoriser une action que la SafetyPolicy bloque.
 */
const intelligenceSchema = z
  .object({
    enabled: z.boolean().default(false),
    confidence: z
      .object({
        enabled: z.boolean().default(true),
        /** Nombre d'observations pour une confiance d'échantillon de 0,5 (n / (n + k)). */
        sampleHalfPoint: z.number().positive().default(5),
      })
      .strict()
      .default({}),
    aging: z
      .object({
        enabled: z.boolean().default(true),
        /** Demi-vie du poids de décision ; par défaut knowledge.halfLifeDays. Le stockage n'est jamais purgé. */
        halfLifeDays: z.number().positive().optional(),
        /** Poids plancher d'une connaissance très ancienne. */
        minWeight: z.number().min(0).max(1).default(0.05),
      })
      .strict()
      .default({}),
    context: z
      .object({ enabled: z.boolean().default(true) })
      .strict()
      .default({}),
    /** NoveltyScore : exécutions passées pondérées par la récence (demi-point : confidence.sampleHalfPoint). */
    novelty: z
      .object({ enabled: z.boolean().default(true) })
      .strict()
      .default({}),
    /** StabilityScore : succès, destinations, p50 / p95 des durées RÉELLES (jamais d'une moyenne). */
    stability: z
      .object({
        enabled: z.boolean().default(true),
        minDurationSamples: z.number().int().min(2).default(5),
        variabilityRatio: z.number().min(1).default(3),
        /** En dessous : UNCERTAIN, jamais « instable ». */
        minConfidence: z.number().min(0).max(1).default(0.4),
      })
      .strict()
      .default({}),
    /**
     * FLAKY DETECTION : les transitions historiquement instables (réussites, destinations).
     * Une transition instable qui change n'est jamais une régression potentielle : WARNING,
     * ou UNKNOWN si elle est très instable.
     */
    flakyDetection: z
      .object({
        enabled: z.boolean().default(true),
        stableAt: z.number().min(0).max(1).default(0.95),
        mostlyStableAt: z.number().min(0).max(1).default(0.8),
        unstableAt: z.number().min(0).max(1).default(0.5),
        /** En dessous de cette confiance (peu d'observations) : UNKNOWN. */
        minConfidence: z.number().min(0).max(1).default(0.4),
      })
      .strict()
      .default({}),
    /**
     * AdaptiveScoring : le score des actions nuancé par la confiance, la nouveauté et la
     * stabilité de l'historique. Désactivé par défaut (il change les décisions) ; sans
     * historique (memory.enabled: false), il n'a aucun effet.
     */
    adaptiveScoring: z
      .object({
        enabled: z.boolean().default(false),
        confidenceWeight: z.number().min(0).max(2).default(1),
        noveltyWeight: z.number().min(0).max(2).default(1),
        stabilityWeight: z.number().min(0).max(2).default(1),
      })
      .strict()
      .default({}),
  })
  .strict();

/**
 * PERSISTANCE : OÙ les runs, états, transitions et connaissances sont stockés. Désactivée
 * par défaut ; QA-CRAWLER n'exige jamais de base de données.
 */
/**
 * RÉGRESSION : l'historique d'une version à l'autre. Désactivé par défaut ; exige la
 * persistance (persistence.enabled) et une mémoire non coupée (memory.enabled ≠ false).
 */
const regressionSchema = z
  .object({
    /** Quand un état est apparu, quand une action a disparu, depuis quand une transition mène ailleurs. */
    flowEvolution: z
      .object({
        enabled: z.boolean().default(false),
        /** Événements gardés par élément. */
        historyLimit: z.number().int().min(1).max(200).default(20),
        /** Éléments chargés au plus. */
        loadLimit: z.number().int().positive().default(20_000),
      })
      .strict()
      .default({}),
    /** NEW → KNOWN → RESOLVED → REOPENED (et FLAKY) : chaque anomalie suivie de run en run. */
    anomalyLifecycle: z
      .object({
        enabled: z.boolean().default(false),
        /** Vérifications consécutives sans l'anomalie (son écran revisité) pour la déclarer RESOLVED. */
        resolveAfterChecks: z.number().int().min(1).max(100).default(3),
        /** Allers-retours (absente puis présente) pour la déclarer FLAKY. */
        flakyAfterFlips: z.number().int().min(1).max(100).default(2),
        loadLimit: z.number().int().positive().default(5_000),
      })
      .strict()
      .default({}),
  })
  .strict();

const persistenceSchema = z
  .object({
    enabled: z.boolean().default(false),
    provider: z.enum(['memory', 'file', 'database']).default('file'),
    file: z
      .object({ directory: nonEmpty.default('.qa-crawler/memory') })
      .strict()
      .default({}),
    database: databaseSchema.optional(),
    /** Stockage inutilisable : fail arrête le run avec une erreur claire ; fallback continue avec le repli. */
    failureMode: z.enum(['fail', 'fallback']).default('fallback'),
    fallback: z
      .object({
        provider: z.enum(['file', 'memory']).default('file'),
        /** Par défaut : persistence.file.directory. */
        directory: nonEmpty.optional(),
      })
      .strict()
      .default({}),
    /** Écritures par lots : états, transitions et connaissances enregistrés toutes les N observations. */
    flushEvery: z.number().int().positive().default(25),
  })
  .strict()
  .superRefine((persistence, ctx) => {
    if (persistence.provider === 'database' && !persistence.database)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['database'],
        message:
          'persistence.database (type: postgres | sqlserver | sqlite) is required when provider is database',
      });
  });

const reportSchema = z
  .object({
    /** La CLI sort avec le code 1 quand une anomalie de cette gravité ou plus est trouvée. NONE désactive cette règle. */
    failOnSeverity: z.enum([...SEVERITIES, 'NONE']).default('ERROR'),
    /** Langue des rapports HTML (index.html, flow-graph.html). result.json reste en anglais. */
    language: z.enum(REPORT_LANGUAGES).default('en'),
  })
  .strict();

const baselineSchema = z
  .object({
    /** Où learn enregistre la baseline (et son historique, sous runs/), et où verify/explore la lisent. */
    dir: nonEmpty.default('baseline'),
    /** Nom de l'application (par défaut : mission.name). */
    application: nonEmpty.optional(),
    /** qa, staging… (par défaut : QA_ENVIRONMENT). */
    environment: nonEmpty.optional(),
    /** Branche et commit du build testé (par défaut : QA_BRANCH/QA_COMMIT, puis les variables de CI). */
    branch: nonEmpty.optional(),
    commit: nonEmpty.optional(),
    /** Dépôt de l'application, pour lire sa branche et son commit avec git (facultatif). */
    gitDir: nonEmpty.optional(),
    /** Runs appris conservés sous runs/. */
    keepRuns: z.number().int().positive().default(20),
  })
  .strict();

const verifySchema = z
  .object({
    /** Code de sortie 1 quand une transition connue a changé, échoue ou n'est plus atteignable. */
    failOnRegression: z.boolean().default(true),
  })
  .strict();

const oraclesSchema = z
  .object({
    /** Juger chaque action exécutée (oracles technique, écran, baseline, contrat). */
    enabled: z.boolean().default(true),
    technical: z
      .object({
        /** HTTP 404 d'un appel d'API : avertissement (défaut) ou échec. */
        api404: z.enum(['warning', 'fail']).default('warning'),
      })
      .strict()
      .default({}),
    ui: z
      .object({
        enabled: z.boolean().default(true),
        /** Mots qui font d'une alerte, bannière ou snackbar visible un message d'erreur (ajoutés à ceux intégrés). */
        errorTexts: z.array(nonEmpty).default([]),
      })
      .strict()
      .default({}),
    baseline: z
      .object({ enabled: z.boolean().default(true) })
      .strict()
      .default({}),
  })
  .strict();

/**
 * Que faire quand une action échoue ou que l'exploration tourne en rond.
 * Les stratégies sont essayées dans l'ordre donné ; une stratégie absente n'est jamais utilisée.
 */
const recoverySchema = z
  .object({
    enabled: z.boolean().default(true),
    strategies: z
      .array(z.enum(RECOVERY_STRATEGIES))
      .min(1)
      .default([...RECOVERY_STRATEGIES]),
    /** Nouvelles tentatives d'une action après une erreur passagère (jamais une action qui envoie des données). */
    maxRetries: z.number().int().min(0).max(3).default(1),
    /** Nouvelles connexions après expiration de la session, par run. */
    maxReauthentications: z.number().int().min(0).max(10).default(2),
    circuitBreaker: z
      .object({
        /** Même état + action + échec ce nombre de fois : l'action n'est plus retentée. */
        threshold: z.number().int().min(1).default(2),
        /** Échecs sur un état avant de l'abandonner. */
        maxFailuresPerState: z.number().int().min(1).default(5),
      })
      .strict()
      .default({}),
    stuck: z
      .object({
        /** A→B→A→B… ce nombre de fois : la branche est abandonnée. */
        oscillationCycles: z.number().int().min(2).default(3),
        /** Actions consécutives qui ne changent rien (même état, aucune requête). */
        maxNoOpActions: z.number().int().min(2).default(15),
        /** Écrans consécutifs encore en chargement. */
        maxBusyObservations: z.number().int().min(1).default(3),
      })
      .strict()
      .default({}),
  })
  .strict();

/** Vérifications d'accessibilité de base sur chaque nouvel écran (un premier signal, pas un audit). */
const accessibilitySchema = z
  .object({
    enabled: z.boolean().default(true),
    rules: z.array(z.enum(ACCESSIBILITY_RULES)).default([...ACCESSIBILITY_RULES]),
    /** Parcourir aussi chaque nouvel écran avec la touche Tab (le focus bouge, pas de piège clavier). */
    keyboardNavigation: z.boolean().default(false),
    maxTabs: z.number().int().min(1).max(200).default(30),
  })
  .strict();

/**
 * Après l'exploration, écrire les chemins trouvés comme des flows imposés
 * (reports/generated-flows.yaml), prêts à être copiés dans une mission.
 */
const flowGenerationSchema = z
  .object({
    enabled: z.boolean().default(true),
    maxFlows: z.number().int().min(1).max(500).default(30),
  })
  .strict();

/**
 * PERFORMANCE : mesurer (traces par action, attentes, résumé, actions lentes). Les seuils sont des
 * budgets de DIAGNOSTIC, jamais des délais d'abandon : une application lente reste testable.
 */
const performanceSchema = z
  .object({
    /**
     * FAST PATH : une étape enregistrée, résolue directement, sans divergence avant, attend sa preuve
     * positive (effet enregistré, cible suivante prête) puis un calme COURT (confirmationQuietMs) au lieu
     * de la fenêtre de stabilité complète. Toutes les vérifications restent (effets, valeurs, sécurité).
     */
    fastPath: z
      .object({
        enabled: z.boolean().default(true),
        confirmationQuietMs: z.number().int().min(50).max(5000).default(150),
      })
      .strict()
      .default({}),
    /**
     * PERFORMANCE BASELINE : un fichier (performance-baseline.json). Absent : il est créé par ce run ;
     * présent : ce run lui est comparé (PERFORMANCE_REGRESSION au-delà de tolerance ET de 500 ms).
     */
    baseline: z
      .object({
        file: z.string().min(1).optional(),
        tolerance: z.number().min(1).max(10).default(1.3),
      })
      .strict()
      .default({}),
    tracing: z
      .object({
        enabled: z.boolean().default(true),
        /** Une action plus lente : SLOW_ACTION_DETECTED (phase, durée, cause, preuves). */
        slowActionThresholdMs: z.number().int().min(100).default(2000),
      })
      .strict()
      .default({}),
  })
  .strict();

/** Journal du moteur (reports/engine-log.jsonl) : ce que l'explorateur a fait, étape par étape. */
const loggingSchema = z
  .object({
    level: z
      .enum(LOG_LEVELS)
      .or(
        z
          .enum(['error', 'warn', 'info', 'debug', 'trace'])
          .transform((value) => value.toUpperCase() as (typeof LOG_LEVELS)[number]),
      )
      .default('INFO'),
    file: z.boolean().default(true),
    /** Écrire reports/decision-trace.json : chaque décision avec tous ses candidats et leurs scores. */
    decisionTrace: z.boolean().default(false),
  })
  .strict();

/**
 * ANALYSE STATIQUE : le code de l'application comme source de preuves supplémentaires
 * (formControlName → propriété de requête → DTO → API → OpenAPI). Désactivée par
 * défaut : sans elle, rien ne change. Le code est lu, jamais exécuté.
 */
const staticAnalysisSchema = z
  .object({
    enabled: z.boolean().default(false),
    /**
     * D'où l'analyseur obtient ses sources. auto : le dépôt (source.root) s'il est lisible,
     * sinon les source maps du déploiement, sinon les bundles ; source ; source-map ;
     * bundle ; hybrid : le dépôt ET le déploiement (le build déployé l'emporte s'ils divergent).
     */
    mode: z.enum(['auto', 'source', 'source-map', 'bundle', 'hybrid']).default('auto'),
    /** ON_DEMAND (défaut) : seulement quand la résolution en a besoin ; EAGER : au début du run. */
    strategy: z.enum(['on-demand', 'eager']).default('on-demand'),
    source: z
      .object({
        enabled: z.boolean().default(true),
        /** Racine du dépôt de l'application (relative au fichier de mission). */
        root: nonEmpty.optional(),
      })
      .strict()
      .default({}),
    bundle: z
      .object({
        enabled: z.boolean().default(true),
        /** Lire les source maps (sourcesContent) quand le serveur les publie. */
        sourceMaps: z.boolean().default(true),
      })
      .strict()
      .default({}),
    /** Source maps publiées par le déploiement : une donnée non fiable, lue avec prudence. */
    sourceMaps: z
      .object({
        enabled: z.boolean().default(true),
        /** Suivre les scripts réellement chargés par le navigateur (réponses de type script). */
        discoverFromRuntime: z.boolean().default(true),
        /** Source maps inline (data:application/json;base64,…). */
        inline: z.boolean().default(true),
        /** Source maps externes (commentaire sourceMappingURL, en-tête SourceMap), hôtes autorisés seulement. */
        external: z.boolean().default(true),
        /** Chunks chargés plus tard (routes à la demande) : le workspace s'enrichit, l'analyse est refaite. */
        incrementalChunks: z.boolean().default(true),
      })
      .strict()
      .default({}),
    /** Sans source map utilisable : analyser le bundle minifié lui-même (couverture LIMITED/PARTIAL). */
    bundleFallback: z
      .object({ enabled: z.boolean().default(true) })
      .strict()
      .default({}),
    cache: z
      .object({
        enabled: z.boolean().default(true),
        /** Par défaut : knowledge/static/ à côté du dossier des rapports (hors du dépôt). */
        directory: nonEmpty.optional(),
      })
      .strict()
      .default({}),
    budgets: z
      .object({
        maxFiles: z.number().int().positive().default(500),
        maxDurationMs: z.number().int().positive().default(30_000),
        maxFileSizeBytes: z.number().int().positive().default(2_000_000),
        /** Nœuds d'AST visités au plus (tous fichiers confondus). */
        maxAstNodes: z.number().int().positive().default(5_000_000),
        /** Scripts du déploiement lus au plus. */
        maxBundles: z.number().int().positive().default(50),
        /** Source maps lues au plus. */
        maxSourceMaps: z.number().int().positive().default(50),
        /** Taille maximale d'une source map (octets, avant décodage). */
        maxSourceMapBytes: z.number().int().positive().default(20_000_000),
        /** Fichiers au plus dans le workspace virtuel. */
        maxExtractedSources: z.number().int().positive().default(2000),
      })
      .strict()
      .default({}),
    analyzers: z
      .object({ angular: z.boolean().default(true), genericJs: z.boolean().default(true) })
      .strict()
      .default({}),
    features: z
      .object({
        routes: z.boolean().default(true),
        forms: z.boolean().default(true),
        validators: z.boolean().default(true),
        dtoMapping: z.boolean().default(true),
        httpCalls: z.boolean().default(true),
        dataFlow: z.boolean().default(true),
        /** Règles candidates (gabarits, code) : lues seulement si rules.enabled les utilise. */
        rules: z.boolean().default(true),
      })
      .strict()
      .default({}),
    semanticResolution: z
      .object({ enabled: z.boolean().default(true) })
      .strict()
      .default({}),
    dryRun: z
      .object({ useStaticKnowledge: z.boolean().default(true) })
      .strict()
      .default({}),
    /** Version et commit de l'application analysée (sinon QA_COMMIT / QA_VERSION, sinon rien). */
    version: nonEmpty.optional(),
    commit: nonEmpty.optional(),
  })
  .strict();

const openApiSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** Fichier OpenAPI 3 (YAML/JSON), ou une URL sur un hôte autorisé. */
    source: nonEmpty.optional(),
  })
  .strict();

const networkSchema = z
  .object({
    /** Attacher à chaque transition les échanges HTTP causés par son action (méthode, URL, statut, durée). */
    trace: z.boolean().default(true),
    /** Types de ressources conservés : images, polices et styles n'ajoutent que du bruit. */
    resourceTypes: z.array(nonEmpty).default(['document', 'xhr', 'fetch']),
    maxRequestsPerAction: z.number().int().positive().default(50),
  })
  .strict();

const scoringSchema = z
  .object({
    /** Surcharges de DEFAULT_SCORING_WEIGHTS (newState, goalText, export…). */
    weights: z.record(z.enum(SCORING_WEIGHT_NAMES_TUPLE), z.number()).default({}),
  })
  .strict();

const semanticsSchema = z
  .object({
    /** Mots ajoutés aux concepts (create, delete, save, cancel…), ou nouveaux concepts. */
    concepts: z.record(nonEmpty, z.array(nonEmpty)).default({}),
    /** Synonymes des termes de la mission (users: [utilisateurs, membres]). */
    synonyms: z.record(nonEmpty, z.array(nonEmpty)).default({}),
  })
  .strict();

const knowledgeSchema = z
  .object({
    /**
     * Base de connaissances : ce que le crawler apprend d'un run à l'autre (taux de
     * succès des actions, transitions dominantes, statuts d'API, durées). Jamais de
     * corps de requête ni de valeur saisie.
     */
    enabled: z.boolean().default(true),
    /**
     * Fichier JSON versionné (à garder hors du dépôt : il décrit l'application testée).
     * Par défaut : knowledge/knowledge-base.json à côté du dossier des rapports.
     */
    file: nonEmpty.optional(),
    /** Demi-vie des observations : une observation de cet âge compte moitié moins. */
    halfLifeDays: z.number().positive().default(30),
    /** Identité de l'application testée, pour ne pas mélanger les connaissances. Par défaut : l'hôte de target.baseUrl. */
    application: nonEmpty.optional(),
    environment: nonEmpty.optional(),
    branch: nonEmpty.optional(),
    /** Commit / version de l'application : une nouvelle version donne une nouvelle chance aux actions qui échouaient. */
    commit: nonEmpty.optional(),
    appVersion: nonEmpty.optional(),
    /** Une transition doit avoir été vue au moins ce nombre de fois pour faire une attente historique. */
    minObservations: z.number().int().positive().default(3),
    /** Part minimale de la cible dominante pour qu'un écart soit signalé. */
    dominance: z.number().min(0.5).max(1).default(0.8),
    /** Action ou appel plus lent que ce multiple de la médiane historique : PERFORMANCE_WARNING. */
    slowFactor: z.number().min(1).default(3),
  })
  .strict();

export const invariantSchema = z
  .object({
    id: nonEmpty,
    description: z.string().optional(),
    severity: z.enum(SEVERITIES).default('ERROR'),
    when: z
      .object({
        /** Chaque requête d'API de l'action. */
        anyRequest: z.boolean().optional(),
        /** Requêtes visées : « POST /api/users », « /api/*\/orders ». Joker `*`. */
        request: nonEmpty.optional(),
        /** Actions dont le libellé contient l'un de ces textes (accents et casse ignorés). */
        actionMatches: z.array(nonEmpty).optional(),
        /** Écrans de départ montrant ce motif. */
        pattern: z.enum(UI_PATTERNS).optional(),
        /** Rôle (acteur) concerné, pour les règles d'accès. */
        actor: nonEmpty.optional(),
        /** Chemin visé, joker `*` / `**`. */
        path: nonEmpty.optional(),
      })
      .strict()
      .default({}),
    expect: z
      .object({
        /** Toutes les réponses sous ce statut (500 : aucune erreur serveur). */
        statusBelow: z.number().int().optional(),
        /** L'écran atteint montre l'un de ces motifs. */
        resultingPattern: z.array(z.enum(UI_PATTERNS)).optional(),
        /** Accès attendu pour l'acteur : allowed, denied, forbidden, login. */
        access: z.array(z.enum(['allowed', 'denied', 'forbidden', 'login'])).optional(),
        textPresent: z.array(nonEmpty).optional(),
        textAbsent: z.array(nonEmpty).optional(),
        /** Durée maximale de l'action. */
        maxDurationMs: z.number().int().positive().optional(),
      })
      .strict(),
  })
  .strict();

const propertyTestingSchema = z
  .object({
    /**
     * Cas générés à partir des contraintes des champs (bornes, partitions d'équivalence) :
     * les cas valides doivent être acceptés, les invalides refusés. Rien n'est envoyé.
     */
    enabled: z.boolean().default(false),
    maxCasesPerForm: z.number().int().positive().default(15),
    maxCasesPerRun: z.number().int().positive().default(100),
  })
  .strict();

const formsSchema = z
  .object({
    /**
     * Remplir les formulaires de chaque écran (champs d'un <form>, d'une fenêtre
     * ou d'un calque) avec des données de test, puis signaler leurs messages de
     * validation. Rien n'est envoyé : voir `submit`.
     */
    exercise: z.boolean().default(true),
    /** Identique à exercise (vocabulaire de la mission). */
    autoFill: z.boolean().optional(),
    /**
     * Tests de validation : quelques valeurs invalides par champ (vide quand il est
     * obligatoire, hors min/max, trop long, mauvais format), chacune suivie de la valeur valide.
     */
    validationTesting: z.boolean().default(false),
    maxValidationCasesPerField: z.number().int().positive().default(3),
    maxValidationCasesPerForm: z.number().int().positive().default(10),
    /** Cas de validation au plus pour tout le run (budget central). */
    maxValidationCasesPerRun: z.number().int().positive().default(200),
    /**
     * Boutons qui envoient un formulaire (« Soumettre », « Enregistrer »… dans un
     * formulaire ou une fenêtre avec des champs). true : permis comme toute
     * MUTATION ; false : jamais cliqués par l'exploration. Non défini : `safety.block`
     * décide (form-submit, bloqué par défaut). Les étapes de flow avec `allow: MUTATION` le peuvent toujours.
     */
    submit: z.boolean().optional(),
    /**
     * Valeurs déjà présentes (préremplies, par défaut, autocomplétées) : gardées quand
     * elles sont valides (KEEP), remplacées si elles sont invalides. false : toujours
     * remplacées par des données de test. Une valeur imposée par un scénario l'emporte toujours.
     */
    preserveExistingValues: z.boolean().default(true),
    /** Dépendances entre champs (avant/après chaque saisie) : pays → province, type → numéro d'entreprise. */
    dependencyDiscovery: z
      .object({
        enabled: z.boolean().default(true),
        /** Champs au plus dont la valeur est changée pour observer leurs effets (puis rétablie). */
        maxFieldMutations: z.number().int().nonnegative().default(10),
        /** Valeurs essayées au plus par champ. */
        maxValuesPerField: z.number().int().positive().default(3),
        maxDurationMs: z.number().int().positive().default(15_000),
      })
      .strict()
      .default({}),
  })
  .strict();

const ruleCategoriesSchema = z
  .object({
    business: z.boolean().default(true),
    visibility: z.boolean().default(true),
    enablement: z.boolean().default(true),
    readonly: z.boolean().default(true),
    validation: z.boolean().default(true),
    calculation: z.boolean().default(true),
    navigation: z.boolean().default(true),
    permission: z.boolean().default(true),
    options: z.boolean().default(true),
  })
  .strict();

/**
 * RÈGLES DE L'APPLICATION : découvertes dans le code (staticAnalysis doit être activée
 * pour la découverte), puis confirmées ou contredites par le navigateur. Une règle du
 * code reste STATIC_DISCOVERED tant que l'exécution ne l'a pas prouvée.
 */
const rulesSchema = z
  .object({
    enabled: z.boolean().default(false),
    staticDiscovery: z.boolean().default(true),
    /** Vérifier les règles dans le navigateur (observation, et changements de valeur rétablis ensuite). */
    runtimeVerification: z.boolean().default(true),
    /** Le moteur de décision favorise les actions qui vérifient des règles non couvertes. */
    influenceDecisionEngine: z.boolean().default(true),
    categories: ruleCategoriesSchema.default({}),
    budgets: z
      .object({
        maxRulesPerPage: z.number().int().positive().default(100),
        /** Changements de valeur au plus pour vérifier des règles (tout le run). */
        maxRuntimeVerifications: z.number().int().nonnegative().default(20),
        maxDurationMs: z.number().int().positive().default(30_000),
      })
      .strict()
      .default({}),
    /** Poids du signal « couverture de règles » dans le score des actions. */
    decisionWeight: z.number().nonnegative().default(1),
  })
  .strict();

const toggle = z.object({ enabled: z.boolean().default(true) }).strict();

/**
 * INTELLIGENCE FONCTIONNELLE : états métier, workflows, invariants, effets secondaires,
 * chemins d'erreur, contrat au runtime, objectifs de test. Désactivée par défaut :
 * enabled=false garde exactement le comportement d'avant ; chaque partie se coupe seule.
 */
/**
 * HUMAN FLOW RECORDER (`qa-crawler record`) : un humain se sert de l'application, le
 * crawler observe et en fait un flow imposé propre (flow.yaml + .feature). Sans effet sur
 * `qa-crawler run` : seule la commande record lit cette section.
 */
const recordingSchema = z
  .object({
    /** false : la commande record refuse de démarrer. */
    enabled: z.boolean().default(true),
    /** Fichiers générés (les deux viennent de la même représentation). */
    outputFormat: z.enum(['yaml', 'gherkin', 'both']).default('both'),
    /** Langue du .feature (par défaut : report.language). */
    language: z.enum(['fr', 'en']).optional(),
    /** Le bandeau « ● RECORDING » (Stop, Checkpoint, Pause) dans la page. */
    overlay: z.boolean().default(true),
    /** Se connecter (auth de la mission) avant de commencer : la connexion n'est pas enregistrée. */
    recordAfterAuthentication: z.boolean().default(true),
    /** Événements bruts gardés au plus (les envois, navigations, changements et points de contrôle ne sont jamais perdus). */
    maxRawEvents: z.number().int().min(100).max(100_000).default(5000),
    maxDurationMinutes: z.number().min(1).max(480).default(60),
    /** Pause (ms) après laquelle une saisie en cours est envoyée (jamais une touche à la fois). */
    inputDebounceMs: z.number().int().min(100).max(5000).default(400),
    /** Attente (ms) après une action avant d'observer l'écran. */
    settleMs: z.number().int().min(100).max(10_000).default(600),
    /** Réponse aux dialogues du navigateur pendant l'enregistrement (l'humain a voulu son clic). */
    dialogs: z
      .object({ confirm: z.enum(['accept', 'dismiss']).default('accept') })
      .strict()
      .default({}),
    /** Variables d'environnement des identifiants tapés pendant l'enregistrement (jamais leurs valeurs). */
    credentials: z
      .object({
        usernameEnv: nonEmpty.default('QA_USERNAME'),
        passwordEnv: nonEmpty.default('QA_PASSWORD'),
      })
      .strict()
      .default({}),
    /** Ajouter ce qui a été appris (workflow, états) à la connaissance fonctionnelle, provenance HUMAN_RECORDED. */
    knowledge: z.boolean().default(true),
    /** Rejouer le flow généré (dry run) juste après : REPLAY_CONFIRMED / REPLAY_FAILED. */
    validate: z.boolean().default(false),
    /**
     * ACTION CORRELATION : une navigation qui suit une action humaine est d'abord son EFFET (le
     * clic reste l'étape, la route devient un résultat) ; `goto` seulement sans cause fiable.
     * false : l'ancien comportement (navigation rattachée au geste qui la précède de peu).
     */
    actionCorrelation: z
      .object({
        enabled: z.boolean().default(true),
        /** Fenêtre (ms) dans laquelle une action peut avoir causé une navigation (handler, API, routeur). */
        causalWindowMs: z.number().int().min(500).max(120_000).default(10_000),
        /** Une navigation qui en suit une autre de moins de… (ms), sans geste entre les deux : une redirection. */
        redirectWindowMs: z.number().int().min(50).max(10_000).default(1500),
        /** Score minimal (0..1) pour rattacher une navigation à une action. */
        minScore: z.number().min(0).max(1).default(0.5),
        /** Un clic sur un élément sans rôle peut devenir le déclencheur de la navigation qui le suit. */
        promoteNoiseClicks: z.boolean().default(true),
        /** Une écriture acceptée par le serveur entre le geste et la navigation compte comme preuve. */
        networkEvidence: z.boolean().default(true),
      })
      .strict()
      .default({}),
    /** Contrôles avant la génération : aucune action métier perdue, pas un flow fait de goto. */
    validation: z
      .object({
        detectSemanticActionLoss: z.boolean().default(true),
        detectNavigationCollapse: z.boolean().default(true),
        /** goto (hors départ) à partir desquels un flow plus fait de goto que de clics est suspect. */
        collapseMinGotos: z.number().int().min(1).default(2),
      })
      .strict()
      .default({}),
    /**
     * FIDÉLITÉ du flow généré (PRESERVE FIRST, UNDERSTAND SECOND, OPTIMIZE LAST) :
     *   EXACT     toutes les interactions fonctionnelles, corrections comprises (seul le bruit
     *             évident du navigateur est fusionné) ;
     *   SEMANTIC  (défaut) le parcours humain : frappe et corrections fusionnées, jamais un
     *             bouton, un onglet, une section, un choix, un envoi ni un contrôle inconnu ;
     *   OPTIMIZED SEMANTIC, plus un flow raccourci séparé (optimized.flow.yaml) : jamais à la place.
     */
    fidelity: z.enum(['EXACT', 'SEMANTIC', 'OPTIMIZED']).default('SEMANTIC'),
    preserveHumanJourney: z.boolean().default(true),
    /**
     * RECORDING SEMANTIC AUDIT : le conseiller d'intelligence (ai.*) RELIT l'interprétation
     * déterministe de chaque action humaine — jamais la capture, jamais une réécriture. Il confirme,
     * signale ou propose une autre lecture (hypothèse AI_PROPOSAL, runtimeConfirmed=false) ; le
     * déterministe reste l'interprétation finale. ai.mode OFF : zéro appel, quoi qu'il soit écrit ici.
     *   SUSPICIOUS_ONLY  seulement les actions qui déclenchent un des `triggers` ;
     *   FULL             toutes les actions (bornées par maxCalls) ; OFF : aucune.
     */
    /**
     * AUTO-VALIDATION DE LA CIBLE pendant l'enregistrement : juste après chaque action, la
     * représentation construite (localisateur + empreinte) est résolue À SEC et comparée à
     * l'élément réellement utilisé — jamais rejouée. Réparée si besoin (bornée), puis revalidée.
     */
    /**
     * CAPTURE AVANT MUTATION : au premier événement d'un geste (appui, entrée dans un champ,
     * première frappe), la cible réellement utilisée, son contexte et un ensemble borné de
     * candidats sont figés dans la page. La cible originale est TOUJOURS candidate (T1), jamais
     * retirée par le budget. Les preuves restent celles de l'enregistrement en cours.
     */
    preActionCapture: z
      .object({
        enabled: z.boolean().default(true),
        maxCandidates: z.number().int().min(1).max(40).default(12),
        includeSameForm: z.boolean().default(true),
        includeSameDialog: z.boolean().default(true),
        includeSameSection: z.boolean().default(true),
      })
      .strict()
      .default({}),
    targetValidation: z
      .object({
        enabled: z.boolean().default(true),
        maxDeterministicRepairAttempts: z.number().int().min(0).max(5).default(2),
        /** Le conseiller (ai.*, recording.intelligenceAudit) audite ce que le déterministe ne règle pas. */
        aiAudit: z.boolean().default(true),
      })
      .strict()
      .default({}),
    /**
     * FLOW AUDIT : le flow GÉNÉRÉ relu dans son ensemble (étapes dupliquées, clic sans effet avant le
     * même clic, double écriture, saisies jamais envoyées, aucune vérification finale…) ; le conseiller
     * (ai.mode ≠ OFF) confirme / conteste et signale le reste. Le flow n'est jamais modifié.
     */
    flowAudit: z
      .object({
        enabled: z.boolean().default(true),
        ai: z.boolean().default(true),
        maxCalls: z.number().int().min(0).max(50).default(5),
      })
      .strict()
      .default({}),
    intelligenceAudit: z
      .object({
        enabled: z.boolean().default(true),
        mode: z.enum(['OFF', 'SUSPICIOUS_ONLY', 'FULL']).default('SUSPICIOUS_ONLY'),
        maxCalls: z.number().int().min(0).max(200).default(10),
        triggers: z
          .object({
            ambiguousTarget: z.boolean().default(true),
            fragileLocator: z.boolean().default(true),
            lowSemanticConfidence: z.boolean().default(true),
            unknownInteraction: z.boolean().default(true),
            possibleDragAndDrop: z.boolean().default(true),
            normalizationLoss: z.boolean().default(true),
            contextMismatch: z.boolean().default(true),
            suspiciousMerge: z.boolean().default(true),
          })
          .strict()
          .default({}),
      })
      .strict()
      .default({}),
    /** Un clic sur un composant maison non reconnu, mais qui a un effet : une action UNRESOLVED gardée. */
    preserveUnknownInteractiveActions: z.boolean().default(true),
    /** Une action qui a changé l'écran (section, champ, fenêtre) n'est jamais fusionnée ni retirée. */
    preserveDomChangingActions: z.boolean().default(true),
    /** Une action dont une suivante dépend (elle a rendu un champ accessible) n'est jamais retirée. */
    preserveDependencyActions: z.boolean().default(true),
    normalization: z
      .object({
        mergeTyping: z.boolean().default(true),
        collapseCorrections: z.boolean().default(true),
        removeTechnicalNoise: z.boolean().default(true),
        removeUnresolvedClicks: z.boolean().default(false),
      })
      .strict()
      .default({}),
    /** FlowOptimizer : un flow raccourci SÉPARÉ (optimized.flow.yaml) ; generated.flow.yaml reste le parcours humain. */
    optimization: z
      .object({ enabled: z.boolean().default(false) })
      .strict()
      .default({}),
    /**
     * RECORDED TEST DATA : les valeurs saisies pendant l'enregistrement deviennent un jeu de
     * données (test-data.yaml) cité par le flow et le .feature : `{ testData: request.title }`.
     * Une valeur sensible n'est jamais lue ni écrite (référence à une variable d'environnement).
     */
    testData: z
      .object({
        enabled: z.boolean().default(true),
        /** Lire la saisie (champs non sensibles seulement) ; false : seulement sa forme, comme avant. */
        extractRecordedValues: z.boolean().default(true),
        /** Le flow cite le jeu de données au lieu de valeurs. */
        replaceFlowLiterals: z.boolean().default(true),
        /** Noms, e-mails, téléphones, adresses : régénérés à chaque rejeu plutôt que gardés. */
        generalizeValues: z.boolean().default(true),
        /** Une valeur générée l'est une fois par run (la même clé citée trois fois = la même valeur). */
        generatePerRun: z.boolean().default(true),
        preserveBusinessLiterals: z.boolean().default(true),
        preserveExistingValues: z.boolean().default(true),
        /** Espace de noms d'après l'entité écrite (POST /api/requests → request.title). */
        namespaceByEntity: z.boolean().default(true),
        /** Longueur maximale d'une valeur gardée (au-delà : régénérée au rejeu). */
        maxValueLength: z.number().int().min(1).max(10_000).default(500),
        sensitiveValues: z
          .object({ useCredentialReferences: z.boolean().default(true) })
          .strict()
          .default({}),
        /** Stratégie par sens ou par nom de champ : email: generated, description: recorded… */
        strategies: z.record(nonEmpty, z.enum(['recorded', 'generated', 'literal', 'template'])).default({}),
        /** Priorité absolue (sauf sécurité) : par clé (request.title) ou nom de champ (title). */
        overrides: z
          .record(
            nonEmpty,
            z
              .object({
                strategy: z.enum(['recorded', 'generated', 'literal', 'template', 'preserve']),
                generator: nonEmpty.optional(),
                template: nonEmpty.optional(),
              })
              .strict(),
          )
          .default({}),
      })
      .strict()
      .default({}),
  })
  .strict();

/**
 * REPLAY d'un flow : RESOLVE → VERIFY TARGET → EXECUTE → OBSERVE → VERIFY EFFECT → CONFIRM.
 * Un clic que Playwright réussit n'est une étape réussie que si son effet est observé (appris
 * à l'enregistrement : contrôles apparus, route, requête ; et la cible de l'étape suivante).
 * verifyActionEffects: false garde le comportement d'avant.
 */
const replaySchema = z
  .object({
    verifyActionEffects: z.boolean().default(true),
    /** S'arrêter à la PREMIÈRE action dont l'effet manque (pas 10 étapes plus loin). */
    detectFirstDivergence: z.boolean().default(true),
    /** La cible de l'étape suivante, absente avant l'action, doit apparaître après. */
    verifyNextActionPrecondition: z.boolean().default(true),
    /** Vérifier, avant de cliquer, que l'élément trouvé est celui enregistré (empreinte). */
    targetFingerprintMatching: z.boolean().default(true),
    /** Retrouver le même élément par son empreinte (rôle + nom, test id, texte) si le localisateur échoue. */
    locatorHealing: z.boolean().default(true),
    /** Interrupteur de la synchronisation des transitions (réglages : `synchronization`). */
    uiStabilization: z.boolean().default(true),
    /**
     * REPLAY TRANSITION SYNCHRONIZATION : ACTION_EXECUTED ≠ TRANSITION_COMPLETED ≠ UI_STABLE ≠
     * EFFECT_CONFIRMED. Après l'exécution technique, attendre des CONDITIONS observables (mutations,
     * route, dialogues, chargements, réseau corrélé, effets enregistrés, cible de l'action suivante
     * résolue sur le DOM frais), puis une courte fenêtre de stabilité. Les délais sont des bornes.
     */
    synchronization: z
      .object({
        enabled: z.boolean().default(true),
        /** Borne maximale de l'attente d'une transition (jamais la condition de succès). */
        transitionTimeoutMs: z.number().int().min(200).max(120_000).default(10_000),
        /** Aucune mutation pertinente pendant ce temps (et ni chargement ni requête corrélée) : stable. */
        stabilityWindowMs: z.number().int().min(50).max(5000).default(400),
        /** Une action dont aucune transition n'est attendue (saisie) : borne de l'attente de stabilité. */
        noTransitionCapMs: z.number().int().min(100).max(30_000).default(1500),
        /** Rien observé, rien de précis attendu : au-delà, l'attente conclut (sans attendre la borne). */
        graceMs: z.number().int().min(100).max(30_000).default(1000),
        /** Sans aucun progrès depuis ce délai (interface stable, ni mutation, ni requête) : conclure sans attendre la borne. */
        noProgressTimeoutMs: z.number().int().min(500).max(60_000).optional(),
        /** Une requête partie dans ce délai après l'action lui est corrélée (une interrogation plus tardive, non). */
        networkCorrelationMs: z.number().int().min(0).max(30_000).default(1500),
        /** Une requête corrélée encore en attente au-delà ne bloque plus la stabilité (connexion persistante). */
        networkPendingCapMs: z.number().int().min(100).max(60_000).default(5000),
        observeDomChanges: z.boolean().default(true),
        observeRouteChanges: z.boolean().default(true),
        observeNetwork: z.boolean().default(true),
        observeDialogs: z.boolean().default(true),
        observeLoaders: z.boolean().default(true),
        /** Les effets enregistrés de l'action (ActionExpectedEffects) servent de point de contrôle. */
        useExpectedEffects: z.boolean().default(true),
        /** La cible de l'action suivante (résolue sur le DOM frais, empreinte vérifiée) sert de point de contrôle. */
        useNextActionAsCheckpoint: z.boolean().default(true),
        /** Une cible dont l'empreinte ne correspond pas est relue après stabilisation (re-rendu) avant tout mismatch. */
        reacquireAfterRerender: z.boolean().default(true),
      })
      .strict()
      .default({}),
    /** Attente bornée d'un effet attendu (attente sur condition, jamais un sommeil fixe). */
    effectTimeoutMs: z.number().int().min(100).max(60_000).default(8000),
    recovery: z
      .object({
        enabled: z.boolean().default(true),
        /** Un onglet, une section, un menu : peut être retenté (une fois). */
        retrySafeActions: z.boolean().default(true),
        /** Un envoi, une création : jamais retenté automatiquement (pas de double envoi). */
        retryMutations: z.boolean().default(false),
      })
      .strict()
      .default({}),
    locator: z
      .object({
        preferSemantic: z.boolean().default(true),
        structuralCssFallback: z.boolean().default(true),
        rejectFingerprintMismatch: z.boolean().default(true),
      })
      .strict()
      .default({}),
    /**
     * RÉSOLUTION FONCTIONNELLE DE CIBLE : un TARGET_FINGERPRINT_MISMATCH n'est plus terminal. Les
     * candidats de l'écran sont comparés par leur FONCTION dans le contexte du parcours (section,
     * fenêtre, choix précédents, action suivante, localisateur enregistré comme simple preuve) ;
     * ambigu → le conseiller (ai.*) si actif ; l'effet observé au runtime tranche toujours.
     */
    functionalTargetResolution: z
      .object({
        enabled: z.boolean().default(true),
        /** Score minimal du meilleur candidat (0..1). */
        minScore: z.number().min(0).max(1).default(0.6),
        /** Écart minimal avec le deuxième : sinon AMBIGUOUS (jamais le premier par hasard). */
        ambiguityMargin: z.number().min(0).max(1).default(0.15),
        maxCandidates: z.number().int().min(2).max(40).default(12),
        /** Une saisie résolue fonctionnellement doit être PROUVÉE par la valeur lue ensuite. */
        verifyFillValue: z.boolean().default(true),
        /**
         * VALUE_RESTORED_AFTER_APPLICATION_RESET : une saisie vidée, écrasée ou re-rendue par l'application
         * juste après (initialisation tardive du formulaire, champ dépendant réinitialisé) est refaite UNE
         * fois, après stabilisation de l'écran et sur le même champ (empreinte vérifiée) — jamais plus.
         */
        restoreValueAfterApplicationReset: z.boolean().default(true),
        /**
         * Avant une étape qui écrit (allow MUTATION), relire les champs remplis sur cet écran : une valeur
         * perdue entre-temps est SIGNALÉE (FILLED_VALUE_LOST_BEFORE_SUBMIT), jamais refaite en silence.
         */
        checkFilledValuesBeforeSubmit: z.boolean().default(true),
        /**
         * LOCATOR ≠ TARGET IDENTITY : un localisateur qui désigne plusieurs éléments (#valueInput ×4)
         * n'est qu'un générateur de candidats ; le contexte départage, jamais « le premier qui correspond ».
         */
        resolveNonUniqueLocators: z.boolean().default(true),
      })
      .strict()
      .default({}),
    /**
     * WORKFLOW SELF-HEALING : quand une action n'est plus rejouable telle quelle, comprendre
     * POURQUOI (DivergenceAnalyzer), ce qu'elle devait accomplir (objectif fonctionnel, déduit
     * des effets appris et des étapes suivantes), et l'atteindre par un chemin SÛR, vérifié au
     * runtime. Ne s'exécute qu'en cas de divergence : un rejeu sans écart n'en paie rien.
     */
    intelligentRecovery: z
      .object({
        enabled: z.boolean().default(true),
        analyzeDivergence: z.boolean().default(true),
        useWorkflowContext: z.boolean().default(true),
        inferFunctionalGoals: z.boolean().default(true),
        goalBasedRecovery: z.boolean().default(true),
        useStaticKnowledge: z.boolean().default(true),
        useHistoricalRecovery: z.boolean().default(true),
        learnSuccessfulRecovery: z.boolean().default(true),
        detectFlowDrift: z.boolean().default(true),
        suggestFlowUpdates: z.boolean().default(true),
        /** Jamais : le flow d'origine n'est jamais réécrit (seulement suggested.flow.yaml). */
        autoUpdateFlow: z.literal(false).default(false),
        /** Deux candidats aussi plausibles : s'arrêter (AMBIGUOUS_RECOVERY), ou essayer le moins coûteux (SAFE). */
        onAmbiguity: z.enum(['stop', 'experiment']).default('stop'),
        budgets: z
          .object({
            maxRecoveryActions: z.number().int().min(1).max(50).default(5),
            maxRecoveryDepth: z.number().int().min(1).max(5).default(3),
            maxCandidates: z.number().int().min(1).max(50).default(10),
            maxRecoveryDurationMs: z.number().int().min(500).max(300_000).default(15_000),
            maxSafeExperiments: z.number().int().min(1).max(50).default(8),
          })
          .strict()
          .default({}),
      })
      .strict()
      .default({}),
  })
  .strict();

/**
 * AI REASONING ADVISOR (GitHub Copilot SDK) : une intelligence OPTIONNELLE. OFF par défaut :
 * aucun client créé, aucun appel, aucun changement de décision. ASSIST : analyse et mesure sans
 * influencer l'exécution (shadow). HYBRID : une proposition validée (schéma, actions, preuves),
 * autorisée par la SafetyPolicy et plus sûre que le déterministe peut être retenue — puis
 * exécutée par l'exécuteur existant et vérifiée au runtime. Le fournisseur ne clique jamais.
 * (`intelligence:` reste l'intelligence historique déterministe.)
 */
const reasoningLevel = z.enum(['LOW', 'MEDIUM', 'HIGH']);
const modelProfileSchema = (autoTier: 'efficiency' | 'balance' | 'intelligence') =>
  z
    .object({
      /** Modèles candidats (identifiants découverts), essayés dans l'ordre ; vide : routage officiel. */
      models: z.array(nonEmpty).default([]),
      autoTier: z.enum(['efficiency', 'balance', 'intelligence', 'fast']).default(autoTier),
    })
    .strict()
    .default({});

const aiSchema = z
  .object({
    enabled: z.boolean().default(false),
    mode: z.enum(['OFF', 'ASSIST', 'HYBRID']).default('OFF'),
    /** `copilot` : GitHub Copilot SDK ; `deterministic` : la même chaîne, sans réseau. */
    provider: z.enum(['copilot', 'deterministic']).default('copilot'),
    /** Un fournisseur indisponible arrête le run (par défaut : repli déterministe et AI_UNAVAILABLE). */
    failOnUnavailable: z.boolean().default(false),
    copilot: z
      .object({
        /**
         * MODEL SELECTION : AUTO (routage officiel de Copilot), EXPLICIT (ce modèle, vérifié avant la
         * session), ADAPTIVE (complexité → profil FAST / BALANCED / INTELLIGENCE → un modèle
         * candidat découvert, sinon le routage officiel avec la préférence du profil).
         */
        modelSelection: z
          .object({
            mode: z.enum(['AUTO', 'EXPLICIT', 'ADAPTIVE']).default('ADAPTIVE'),
            model: nonEmpty.optional(),
            /** Le profil de la complexité MEDIUM (le cas ordinaire). */
            defaultProfile: z.enum(['FAST', 'BALANCED', 'INTELLIGENCE']).default('BALANCED'),
            profiles: z
              .object({
                FAST: modelProfileSchema('efficiency'),
                BALANCED: modelProfileSchema('balance'),
                INTELLIGENCE: modelProfileSchema('intelligence'),
              })
              .strict()
              .default({}),
          })
          .strict()
          .default({}),
        /** REASONING EFFORT : envoyé seulement si le modèle choisi le déclare (sinon ajusté ou omis). */
        reasoning: z
          .object({
            mode: z.enum(['AUTO', 'FIXED', 'ADAPTIVE']).default('ADAPTIVE'),
            default: reasoningLevel.default('MEDIUM'),
            lowComplexity: reasoningLevel.default('LOW'),
            mediumComplexity: reasoningLevel.default('MEDIUM'),
            highComplexity: reasoningLevel.default('HIGH'),
            veryHighComplexity: reasoningLevel.default('HIGH'),
          })
          .strict()
          .default({}),
        /** Modèle demandé inutilisable : AUTO (routage officiel), ALTERNATIVE (autre modèle découvert, sinon AUTO), DETERMINISTIC (pas d'IA). */
        fallback: z
          .object({
            enabled: z.boolean().default(true),
            strategy: z.enum(['AUTO', 'ALTERNATIVE', 'DETERMINISTIC']).default('AUTO'),
          })
          .strict()
          .default({}),
        /** Découverte des modèles (client.listModels()) : en cache, rafraîchie si un modèle est refusé. */
        discovery: z
          .object({
            cache: z.boolean().default(true),
            ttlMs: z.number().int().min(1000).max(86_400_000).default(600_000),
            refreshOnUnavailableModel: z.boolean().default(true),
          })
          .strict()
          .default({}),
        timeoutMs: z.number().int().min(1000).max(600_000).default(30_000),
        maxRetries: z.number().int().min(0).max(3).default(1),
        sessionReuse: z.boolean().default(true),
        /** Outils de LECTURE exposés au modèle (aucun outil d'exécution n'existe). */
        tools: z.boolean().default(true),
        /** Données du runtime Copilot (sessions) : hors du dépôt. */
        baseDirectory: nonEmpty.default('.qa-crawler/copilot'),
        /** Nom de la variable d'environnement d'un jeton ; absent : l'utilisateur connecté (mécanisme officiel du SDK). */
        tokenEnv: nonEmpty.optional(),
      })
      .strict()
      .default({}),
    triggers: z
      .object({
        ambiguousTarget: z.boolean().default(true),
        unknownScreen: z.boolean().default(true),
        flowDivergence: z.boolean().default(true),
        recoveryFailed: z.boolean().default(true),
        multiplePlans: z.boolean().default(true),
        unresolvedHypothesis: z.boolean().default(true),
        unknownBusinessError: z.boolean().default(true),
        lowConfidence: z.boolean().default(true),
        knowledgeContradiction: z.boolean().default(true),
        /** Objectif bloqué sans précondition connue (submission READY, objectif toujours bloqué…). */
        unknownBlockingPrecondition: z.boolean().default(true),
        /** Hypothèse contredite sans alternative : demander une explication ou une investigation SÛRE. */
        hypothesisAnalysis: z.boolean().default(true),
        /** Après un enregistrement : objectifs, phases, préconditions proposés (jamais le flow modifié). */
        recordingEnrichment: z.boolean().default(true),
      })
      .strict()
      .default({}),
    thresholds: z
      .object({
        /** Au-dessus : FAST PATH déterministe, aucun appel. */
        deterministicConfidence: z.number().min(0).max(1).default(0.85),
        minProposalConfidence: z.number().min(0).max(1).default(0.6),
        /** Écart de confiance exigé pour préférer une proposition à une décision déterministe. */
        overrideMargin: z.number().min(0).max(1).default(0.15),
      })
      .strict()
      .default({}),
    budgets: z
      .object({
        maxCallsPerRun: z.number().int().min(0).max(1000).default(10),
        maxCallsPerAction: z.number().int().min(0).max(10).default(1),
        maxCallsPerDivergence: z.number().int().min(0).max(10).default(1),
        maxToolCallsPerRequest: z.number().int().min(0).max(50).default(6),
        maxReasoningDurationMs: z.number().int().min(1000).max(600_000).default(60_000),
      })
      .strict()
      .default({}),
    context: z
      .object({
        maxActions: z.number().int().min(1).max(100).default(25),
        maxEvidence: z.number().int().min(0).max(100).default(15),
        maxHypotheses: z.number().int().min(0).max(50).default(8),
        /** Libellés de champs dont aucune valeur ne doit partir (en plus des règles intégrées). */
        sensitiveFields: z.array(nonEmpty).default([]),
      })
      .strict()
      .default({}),
    audit: z
      .object({
        enabled: z.boolean().default(true),
      })
      .strict()
      .default({}),
  })
  .strict()
  .superRefine((ai, context) => {
    const selection = ai.copilot.modelSelection;
    if (selection.mode === 'EXPLICIT' && !selection.model)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['copilot', 'modelSelection', 'model'],
        message:
          'modelSelection.mode EXPLICIT needs modelSelection.model (an id discovered for this account)',
      });
  });

/**
 * QA COGNITIVE ENGINE : preuves, modèle fonctionnel, état métier, hypothèses et graphe
 * causal. Observe et apprend à chaque action, sans rien exécuter lui-même ; une observation
 * n'est jamais une vérité (HYPOTHESIS → SUPPORTED → RUNTIME_CONFIRMED).
 */
const cognitiveSchema = z
  .object({
    enabled: z.boolean().default(true),
    /** Les effets des actions deviennent des hypothèses causales (REVEALS, ENABLES, NAVIGATES_TO…). */
    learnCausality: z.boolean().default(true),
    /** L'état métier de chaque écran (phase, faits, champs manquants, envoi bloqué). */
    businessState: z.boolean().default(true),
    /** Observations runtime distinctes exigées (avec une source indépendante) pour RUNTIME_CONFIRMED. */
    runtimeObservationsToConfirm: z.number().int().min(1).max(20).default(2),
    /** reports/cognitive/*.json : knowledge-graph, causal-graph, hypotheses, functional-model, business-state. */
    writeArtifacts: z.boolean().default(true),
    /** Une régularité devient un invariant progressivement : observations ET runs distincts. */
    invariants: z
      .object({
        multiple: z.number().int().min(1).default(3),
        supported: z.number().int().min(1).default(5),
        confirmed: z.number().int().min(1).default(10),
        runsForSupported: z.number().int().min(1).default(2),
        runsForConfirmed: z.number().int().min(1).default(3),
      })
      .strict()
      .default({}),
    /**
     * QA REASONING ENGINE : une décision raisonnée par écran (but, préconditions, couverture,
     * hypothèses), donnée au moteur de décision existant comme un signal. Il ne clique jamais.
     */
    reasoning: z
      .object({
        enabled: z.boolean().default(true),
        influenceDecisionEngine: z.boolean().default(true),
        decisionWeight: z.number().min(0).max(5).default(1),
        /** Conseiller : `deterministic` (défaut) ou `none`. Un conseiller LLM ne s'injecte que par programme. */
        advisor: z.enum(['deterministic', 'none']).default('deterministic'),
        maxAdvisorCalls: z.number().int().min(0).max(100).default(5),
      })
      .strict()
      .default({}),
    budgets: z
      .object({
        maxHypotheses: z.number().int().min(10).max(10_000).default(500),
        maxPlanningDepth: z.number().int().min(1).max(20).default(8),
        maxExperiments: z.number().int().min(0).max(50).default(3),
        maxPlanCandidates: z.number().int().min(1).max(200).default(30),
        maxReasoningDurationMs: z.number().int().min(10).max(60_000).default(250),
      })
      .strict()
      .default({}),
  })
  .strict();

const functionalIntelligenceSchema = z
  .object({
    enabled: z.boolean().default(false),
    stateMachines: toggle.default({}),
    invariants: toggle.default({}),
    workflows: toggle.default({}),
    sideEffects: toggle.default({}),
    errorPaths: toggle.default({}),
    runtimeContracts: toggle.default({}),
    /**
     * Apprendre du réseau à chaque run : écritures acceptées → workflows, codes d'état →
     * états et transitions, gardés comme historique pour les runs suivants (jamais une preuve).
     */
    runtimeLearning: toggle.default({}),
    testGoals: z
      .object({
        enabled: z.boolean().default(true),
        /** Le moteur de décision reçoit le signal `functional` (progression d'objectif, couverture). */
        influenceDecisionEngine: z.boolean().default(true),
        /** Poids de ce signal dans le score des actions. */
        decisionWeight: z.number().nonnegative().default(1),
        budgets: z
          .object({
            maxGoalsPerRun: z.number().int().positive().default(50),
            /** Actions au plus pendant qu'un objectif est en cours, avant INCONCLUSIVE. */
            maxGoalActions: z.number().int().positive().default(20),
            maxGoalDurationMs: z.number().int().positive().default(60_000),
          })
          .strict()
          .default({}),
      })
      .strict()
      .default({}),
  })
  .strict();

const testDataSchema = z
  .object({
    /**
     * Valeur par champ, par libellé, name ou placeholder (majuscules et accents
     * ignorés). Pour une liste ou un groupe de radios : l'option à choisir. Les champs
     * sensibles (mots de passe, cartes, secrets) ne sont jamais remplis, même listés ici.
     */
    fields: z
      .record(nonEmpty, z.union([z.string(), z.object({ value: z.string() }).strict()]))
      .default({})
      .transform((fields) =>
        Object.fromEntries(
          Object.entries(fields).map(([key, value]) => [
            key,
            typeof value === 'string' ? value : value.value,
          ]),
        ),
      ),
    /**
     * Valeurs par sens, pour chaque champ qui a ce sens : firstName, lastName,
     * name, email, phone, company, address, city, postalCode, country, url, text.
     */
    defaults: z
      .object({
        firstName: z.string(),
        lastName: z.string(),
        name: z.string(),
        email: z.string(),
        phone: z.string(),
        company: z.string(),
        address: z.string(),
        city: z.string(),
        postalCode: z.string(),
        country: z.string(),
        url: z.string(),
        text: z.string(),
      })
      .partial()
      .strict()
      .default({}),
    /** Id du run dans les données créées (QA-CRAWLER-<runId>) ; par défaut : généré à chaque run. */
    runId: z
      .string()
      .regex(/^[A-Za-z0-9-]{1,24}$/, 'letters, digits and dashes (24 max)')
      .optional(),
    /**
     * Jeux de données (TestDataSet) pour `{ testData: clé }` : fichiers (test-data.yaml d'un
     * enregistrement, relatifs à la mission), puis `values` (même forme que le `values:` d'un
     * fichier). Le jeu propre à un flow (`testData:` du flow) l'emporte, puis celui-ci.
     */
    include: z.array(nonEmpty).default([]),
    values: z.record(z.unknown()).optional(),
  })
  .strict()
  .transform((data, ctx) => {
    let set: TestDataSet | undefined;
    try {
      set = mergeTestDataSets(
        [
          ...data.include.map((file) => loadTestDataSetFile(file, process.cwd())),
          ...(data.values ? [parseTestDataSet({ values: data.values }, 'testData.values')] : []),
        ],
        'testData',
      );
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['include'],
        message: error instanceof TestDataSetError ? error.message : String(error),
      });
      return z.NEVER;
    }
    return { ...data, ...(set ? { set } : {}) };
  });

export const scenarioSchema = z
  .object({
    mission: z
      .object({
        name: nonEmpty.default('explore-application'),
        description: z.string().optional(),
        /** explore (défaut), learn (construire la baseline) ou verify (vérifier par rapport à elle). La commande de la CLI l'emporte. */
        mode: z.enum(MISSION_MODES).default('explore'),
      })
      .strict()
      .default({}),
    target: z
      .object({
        baseUrl: z
          .string()
          .url()
          .refine((value) => /^https?:\/\//i.test(value), 'baseUrl must use http or https'),
        startAt: z.string().default('/'),
      })
      .strict(),
    browser: browserSchema.default({}),
    exploration: explorationSchema.default({}),
    goals: goalsSchema.default({}),
    checks: checksSchema.default({}),
    http: httpSchema.default({}),
    safety: safetySchema.default({}),
    auth: authSchema.default({ type: 'none' }),
    output: outputSchema.default({}),
    memory: memorySchema.default({}),
    persistence: persistenceSchema.default({}),
    regression: regressionSchema.default({}),
    report: reportSchema.default({}),
    /** Flows de test imposés, exécutés avant l'exploration autonome. */
    flows: flowsSchema,
    /** Phrases Gherkin propres à l'équipe (en plus des phrases intégrées) pour `flows: - gherkin: …`. */
    gherkin: z
      .object({
        /**
         * Mode automatique : une phrase inconnue n'est plus une erreur ; elle est interprétée sur
         * l'écran à l'exécution (noms cités, libellés de champs, valeurs), ou notée « À VÉRIFIER ».
         */
        auto: z.boolean().default(false),
        /**
         * RÉSOLUTION SÉMANTIQUE : des phrases qui nomment un champ, une page ou une action par
         * ce qu'ils signifient (« je renseigne le prénom avec "X" », « je valide le formulaire »).
         * La cible est trouvée à l'écran (libellé, alias FR/EN, attributs, type, valeur, historique),
         * choisie seulement avec une confiance suffisante, et exécutée après la SafetyPolicy.
         * Désactivée par défaut : les scénarios existants se traduisent exactement comme avant.
         */
        semanticResolution: z
          .object({
            enabled: z.boolean().default(false),
            /** Score minimal pour agir seul (0..1). */
            autoResolveThreshold: z.number().min(0.5).max(1).default(0.85),
            /** Écart minimal avec le deuxième candidat : sinon AMBIGUOUS. */
            ambiguityMargin: z.number().min(0).max(0.5).default(0.15),
            /** En dessous : pas un candidat. */
            minCandidateScore: z.number().min(0).max(0.8).default(0.25),
            /** Les résolutions réussies des runs précédents départagent (signal borné, jamais une vérité). */
            historicalKnowledge: z.boolean().default(true),
            /** L'explication de chaque résolution dans le rapport et le journal du moteur. */
            explain: z.boolean().default(true),
            /** Vocabulaire ajouté : alias de champs par concept, mots d'action. */
            vocabulary: z
              .object({
                fields: z.record(z.array(nonEmpty)).default({}),
                actions: z
                  .object({
                    submit: z.array(nonEmpty).default([]),
                    cancel: z.array(nonEmpty).default([]),
                    next: z.array(nonEmpty).default([]),
                    previous: z.array(nonEmpty).default([]),
                  })
                  .strict()
                  .default({}),
              })
              .strict()
              .default({}),
          })
          .strict()
          .default({}),
        steps: z
          .array(
            z
              .object({
                pattern: nonEmpty,
                step: z.record(z.unknown()).optional(),
                steps: z.array(z.record(z.unknown())).min(1).optional(),
                manual: z.literal(true).optional(),
                allow: z.union([z.string(), z.array(z.string())]).optional(),
              })
              .strict()
              .refine(
                (entry) =>
                  [entry.step, entry.steps, entry.manual].filter((value) => value !== undefined).length === 1,
                'a gherkin step needs exactly one of step, steps, manual',
              ),
          )
          .default([]),
      })
      .strict()
      .default({}),
    /**
     * DRY RUN (`qa-crawler dry-run <scénario>`) : le scénario du développeur est confronté à
     * l'application — exploration guidée quand une étape ne correspond pas, puis une seule
     * réconciliation et un flow suggéré. Le fichier d'origine n'est jamais modifié.
     */
    dryRun: z
      .object({
        /** Explorer pour retrouver les intentions suivantes après un écart (sinon : arrêt au premier). */
        continueAfterMismatch: z.boolean().default(true),
        /** Chemins connus (graphe mémorisé, KnowledgeBase) essayés avant d'explorer ; jamais crus sans confirmation. */
        useHistoricalKnowledge: z.boolean().default(true),
        /** Actions au plus entre deux intentions retrouvées. */
        maxDepth: z.number().int().min(1).max(50).default(15),
        /** Actions de l'exploration guidée au plus, sur tout le Dry Run. */
        maxActions: z.number().int().min(1).max(10_000).default(100),
        maxDurationMs: z.number().int().min(1000).default(120_000),
        /** Actions essayées au plus depuis un même écran (les mieux notées), et chemins connus rejoués. */
        maxAlternativePaths: z.number().int().min(1).max(20).default(5),
        suggestion: z
          .object({
            generateGherkin: z.boolean().default(true),
            generateYaml: z.boolean().default(true),
          })
          .strict()
          .default({}),
      })
      .strict()
      .default({}),
    recording: recordingSchema.default({}),
    replay: replaySchema.default({}),
    cognitive: cognitiveSchema.default({}),
    ai: aiSchema.default({}),
    credentials: credentialsSchema,
    browserInteractions: browserInteractionsSchema.default({}),
    forms: formsSchema.default({}),
    scoring: scoringSchema.default({}),
    network: networkSchema.default({}),
    oracles: oraclesSchema.default({}),
    recovery: recoverySchema.default({}),
    accessibility: accessibilitySchema.default({}),
    logging: loggingSchema.default({}),
    performance: performanceSchema.default({}),
    flowGeneration: flowGenerationSchema.default({}),
    actors: z.array(actorSchema).default([]),
    authorization: authorizationSchema.default({}),
    openapi: openApiSchema.default({}),
    staticAnalysis: staticAnalysisSchema.default({}),
    baseline: baselineSchema.default({}),
    verify: verifySchema.default({}),
    testData: testDataSchema.default({}),
    rules: rulesSchema.default({}),
    functionalIntelligence: functionalIntelligenceSchema.default({}),
    semantics: semanticsSchema.default({}),
    /** Packs de domaine (vocabulaire, synonymes, invariants, indices de score) : nom intégré (generic, ecommerce, administration) ou chemin d'un fichier YAML. */
    domainPacks: z.array(nonEmpty).default(['generic']),
    knowledge: knowledgeSchema.default({}),
    intelligence: intelligenceSchema.default({}),
    /** Invariants explicites : règles vérifiées sur chaque action, expliquées dans le rapport. */
    invariants: z.array(invariantSchema).default([]),
    propertyTesting: propertyTestingSchema.default({}),
  })
  .strict();

/** Scénario tel qu'écrit en YAML (valeurs par défaut pas encore appliquées). */
export type ScenarioInput = z.input<typeof scenarioSchema>;
/** Scénario complet, valeurs par défaut appliquées. */
export type ScenarioConfig = z.output<typeof scenarioSchema>;
export type PersistenceConfig = ScenarioConfig['persistence'];
export type RulesConfig = ScenarioConfig['rules'];
export type RecordingConfig = ScenarioConfig['recording'];
export type IntelligenceConfig = ScenarioConfig['intelligence'];
export type AiConfig = ScenarioConfig['ai'];
export type MemoryConfig = ScenarioConfig['memory'];
export type FormAuthConfig = z.output<typeof formAuthSchema>;
export type HttpAuthConfig = z.output<typeof httpAuthSchema>;
export type BrowserInteractionsConfig = z.output<typeof browserInteractionsSchema>;
export type AuthConfig = ScenarioConfig['auth'];
export type ActorConfig = ScenarioConfig['actors'][number];
export type AuthorizationConfig = ScenarioConfig['authorization'];
export type QueryParamMode = ScenarioConfig['exploration']['queryParams']['mode'];
export type InvariantConfig = ScenarioConfig['invariants'][number];
export type GoalTargetConfig = ScenarioConfig['goals']['targets'][number];
export type KnowledgeConfig = ScenarioConfig['knowledge'];
export type StaticAnalysisConfig = ScenarioConfig['staticAnalysis'];
