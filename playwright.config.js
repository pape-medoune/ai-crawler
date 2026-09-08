// ============================================================
//  Playwright Config - AI Test Platform
// ------------------------------------------------------------
//  - Reporters : HTML (lecture humaine) + JUnit XML (CI native)
//  - Videos / Screenshots / Traces actives (conservation en cas d'echec)
//  - Mode headless par defaut (compatible conteneurs CI)
//  - Workers=1 pour le crawler IA (chaque etape depend de la precedente)
// ============================================================

const { defineConfig, devices } = require('@playwright/test');
const path = require('node:path');

/**
 * Resolution dynamique du chemin de sortie pour le rapport JUnit.
 * - En local : ./results/junit.xml
 * - En CI :   /app/results/junit.xml (volume partage du docker-compose)
 */
const RESULTS_DIR = process.env.RESULTS_DIR || path.resolve(__dirname, 'results');
process.env.PLAYWRIGHT_RESULTS_DIR = RESULTS_DIR;

// Conversion "1/true/yes" -> bool, defaut true en CI, true en local aussi
function envFlag(name, defaultValue) {
  const v = String(process.env[name] ?? '').toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return defaultValue;
}

module.exports = defineConfig({
  // Dossier de sortie (HTML report, traces, videos, junit)
  outputDir: path.join(RESULTS_DIR, 'output'),

  // Timeout global d'un test (les appels Claude peuvent prendre 10-30s)
  timeout: process.env.PLAYWRIGHT_TIMEOUT_MS
    ? Number(process.env.PLAYWRIGHT_TIMEOUT_MS)
    : 120_000,

  // Un seul worker : le crawler IA raisonne sequentiellement (boucle d'etats)
  workers: 1,
  fullyParallel: false,

  // Strategie de retry : 1 essai supplementaire en CI seulement
  retries: process.env.CI ? 1 : 0,

  // Reporter multi-format pour CI + lecture humaine
  // JUnit.xml est lu nativement par GitLab, GitHub, Jenkins, CircleCI, etc.
  reporter: [
    ['list'],
    ['html', { outputFolder: path.join(RESULTS_DIR, 'html-report'), open: 'never' }],
    [
      'junit',
      {
        outputFile: path.join(RESULTS_DIR, 'junit.xml'),
        // Le schema standard inclut les steps et les stderr pour debug CI
        embedAttachmentsAsResources: true,
        suiteTitle: 'ai-crawler',
      },
    ],
    ['json', { outputFile: path.join(RESULTS_DIR, 'report.json') }],
  ],

  // Configuration des captures / traces / videos
  use: {
    // URL de base resolue via variable d'env, fallback host.docker.internal (dev)
    baseURL: process.env.TARGET_URL || 'http://host.docker.internal:3000',

    // Mode headless obligatoire en CI ; en local, peut etre force a false
    headless: process.env.HEADLESS === '0' ? false : true,

    // Conserver TOUTES les videos (taille importante mais utile pour AI debug).
    // En prod on peut basculer sur 'retain-on-failure' via env VIDEO_MODE.
    video: process.env.VIDEO_MODE || 'on', // 'on' | 'retain-on-failure' | 'off'
    // Captures : uniquement sur echec par defaut (gain d'espace)
    screenshot: process.env.SCREENSHOT_MODE || 'only-on-failure',
    // Traces : conservées sur echec (Playwright Trace Viewer)
    trace: process.env.TRACE_MODE || 'retain-on-failure',

    // Action timeout (click / fill / etc.) : adapte aux SFA lents
    actionTimeout: 15_000,
    // Navigation timeout (load + domcontentloaded)
    navigationTimeout: 30_000,

    // Chemins absolus vers les artefacts (lus par le mailer ensuite)
    tracePath: path.join(RESULTS_DIR, 'traces'),
    screenshotPath: path.join(RESULTS_DIR, 'screenshots'),
    videoPath: path.join(RESULTS_DIR, 'videos'),

    // Bloc par defaut si Playwright tente de partager des infos de contexte
    extraHTTPHeaders: process.env.NO_EXTRA_HEADERS
      ? undefined
      : { 'x-test-runner': 'ai-test-platform' },
  },

  // Projet navigateur principal : Chromium (couverture ~70% des cas)
  // Pour ajouter Firefox / WebKit : decommenter et adapter.
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Channel 'chrome' utilise le navigateur systeme si present (sinon bundled)
        channel: process.env.BROWSER_CHANNEL || undefined,
        // Permissions par defaut
        permissions: ['clipboard-read', 'clipboard-write'],
        viewport: { width: 1366, height: 768 },
      },
    },
  ],

  // Web server : si on lance un `yarn dev` en parallele (utile en local)
  webServer: process.env.NO_WEBSERVER
    ? undefined
    : {
        command: process.env.WEBSERVER_CMD || 'echo "No webServer configured"',
        url: process.env.TARGET_URL || 'http://host.docker.internal:3000',
        timeout: 120_000,
        reuseExistingServer: envFlag('REUSE_SERVER', !process.env.CI),
        stdout: 'pipe',
        stderr: 'pipe',
      },
});
