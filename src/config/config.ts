import { z } from 'zod';
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
    /** États distincts explorés par modèle de route (/users/:id → seulement N utilisateurs). */
    maxStatesPerRoute: z.number().int().positive().default(3),
    queryParams: queryParamsSchema.default({}),
    /**
     * Les contrôles semblables d'un écran (jours d'un calendrier, numéros de page,
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
  })
  .strict();

/**
 * PERSISTANCE : OÙ les runs, états, transitions et connaissances sont stockés. Désactivée
 * par défaut ; QA-CRAWLER n'exige jamais de base de données.
 */
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
  })
  .strict();

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
    credentials: credentialsSchema,
    browserInteractions: browserInteractionsSchema.default({}),
    forms: formsSchema.default({}),
    scoring: scoringSchema.default({}),
    network: networkSchema.default({}),
    oracles: oraclesSchema.default({}),
    recovery: recoverySchema.default({}),
    accessibility: accessibilitySchema.default({}),
    logging: loggingSchema.default({}),
    flowGeneration: flowGenerationSchema.default({}),
    actors: z.array(actorSchema).default([]),
    authorization: authorizationSchema.default({}),
    openapi: openApiSchema.default({}),
    baseline: baselineSchema.default({}),
    verify: verifySchema.default({}),
    testData: testDataSchema.default({}),
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
export type IntelligenceConfig = ScenarioConfig['intelligence'];
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
