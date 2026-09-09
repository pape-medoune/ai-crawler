// ============================================================
//  tests/universal-crawler.spec.js
// ------------------------------------------------------------
//  Crawler E2E universel propulse par Claude (configurable).
//
//  Comportement :
//    1. Ouvre TARGET_URL (defaut : http://host.docker.internal:3000)
//    2. Jusqu'a CRAWLER_MAX_STEPS iterations :
//         a. Capture l'etat de la page (URL, titre, texte nettoye)
//         b. Appelle Claude avec le goal + historique + etat
//         c. Recoit une action JSON (tool use)
//         d. Execute l'action
//         e. Si goal atteint -> exit 0
//    3. Si goal non atteint apres N etapes -> exit 1
//    4. Envoie un email HTML (Tailwind inline) avec lien vers artefacts
//
//  MODE BASIQUE (sans IA) :
//    Si ANTHROPIC_API_KEY est absent, le test ne fait PAS de skip silencieux.
//    Il execute a la place une serie de verifications Playwright deterministes
//    (navigation, code HTTP, titre, contenu visible, liens, page d'erreur) qui
//    produisent les memes rapports (HTML/JUnit/JSON) et le meme exit code 0/1.
//    Cela permet d'utiliser le pipeline utilement avant d'avoir configure une
//    cle API Claude. Des que ANTHROPIC_API_KEY est fourni, le mode IA prend
//    automatiquement le relais, sans changement de configuration ailleurs.
//
//  Modele : configurable via env CLAUDE_MODEL (defaut claude-sonnet-4-5).
//  Source de verite : claude-sonnet-4-5 surpasse 3.5 Sonnet sur le
//    raisonnement JSON structure, sans surcout significatif.
//
//  Variables d'environnement :
//    ANTHROPIC_API_KEY          -> cle d'API Claude (optionnelle : sans elle,
//                                  bascule automatiquement en mode basique)
//    CLAUDE_MODEL               -> nom du modele (defaut ci-dessus)
//    TARGET_URL                 -> URL de depart
//    CRAWLER_GOAL               -> objectif en langage naturel (mode IA)
//    CRAWLER_MAX_STEPS          -> nombre max d'iterations (defaut 10)
//    SMTP_*                     -> configuration du rapport par mail
//    ARTIFACT_BASE_URL          -> URL publique des artefacts CI
//    CI_PIPELINE_ID             -> id du pipeline (pour le lien)
//    CI_JOB_ID                  -> id du job (pour le lien)
// ============================================================

'use strict';

const { test, expect } = require('@playwright/test');
const Anthropic = require('@anthropic-ai/sdk');
const nodemailer = require('nodemailer');
const fs = require('node:fs');
const path = require('node:path');

// ============================================================
//  CONFIGURATION (lue depuis les variables d'environnement)
// ============================================================

const CONFIG = {
  targetUrl: process.env.TARGET_URL || 'http://host.docker.internal:3000',
  goal: process.env.CRAWLER_GOAL || "Verifier que la page d'accueil se charge et que la navigation principale fonctionne",
  maxSteps: Number(process.env.CRAWLER_MAX_STEPS || 10),
  claudeModel: process.env.CLAUDE_MODEL || 'claude-sonnet-4-5',
  claudeMaxTokens: Number(process.env.CLAUDE_MAX_TOKENS || 2048),
  apiKey: process.env.ANTHROPIC_API_KEY || '',
  artifactBaseUrl: process.env.ARTIFACT_BASE_URL || 'https://gitlab.com/-/artifacts',
  pipelineId: process.env.CI_PIPELINE_ID || 'local',
  jobId: process.env.CI_JOB_ID || 'local',
  resultsDir: process.env.PLAYWRIGHT_RESULTS_DIR || path.resolve(__dirname, '..', 'results'),
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || 'false') === 'true',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || '',
    to: process.env.SMTP_TO || '',
  },
};

// ============================================================
//  SCHEMA D'ACTION (force Claude a repondre en JSON strict via tool use)
// ============================================================

const NEXT_ACTION_TOOL = {
  name: 'next_action',
  description:
    "Decide de la prochaine action a effectuer sur la page pour atteindre l'objectif.",
  input_schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['click', 'fill', 'select', 'press', 'navigate', 'wait', 'scroll', 'assert', 'finish'],
        description: 'Verbe d action a executer.',
      },
      selector: {
        type: 'string',
        description:
          'Selecteur CSS cible (pour click/fill/assert). Vide si action != DOM.',
      },
      value: {
        type: 'string',
        description: 'Valeur a saisir (fill) ou URL (navigate) ou texte a presser (press).',
      },
      goal_achieved: {
        type: 'boolean',
        description: 'Vrai si l objectif est atteint apres cette action.',
      },
      confidence: {
        type: 'number',
        minimum: 0,
        maximum: 1,
        description: 'Confiance dans le succes (0 a 1).',
      },
      reasoning: {
        type: 'string',
        description: 'Explication courte en francais.',
      },
    },
    required: ['action', 'goal_achieved', 'reasoning'],
  },
};

// ============================================================
//  HELPERS
// ============================================================

/**
 * Nettoie le HTML de la page : retire scripts, styles, SVG, comments,
 * collapse les espaces et tronque a `maxChars` caracteres.
 * But : reduire la consommation de tokens tout en preservant le contexte visible.
 */
function cleanPageHtml(html, maxChars = 12_000) {
  if (!html || typeof html !== 'string') return '';
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars);
}

/**
 * Construit le prompt systeme : on demande a Claude de jouer le role
 * d'un testeur QA autonome qui raisonne pas a pas.
 */
function buildSystemPrompt(goal) {
  return [
    'Tu es un testeur QA autonome. Tu piloter un navigateur pour atteindre un objectif utilisateur.',
    'Tu recois apres chaque action : URL courante, titre de la page, et contenu nettoye.',
    'Tu DOIS repondre en appelant l outil next_action avec une action atomique.',
    "Si l'objectif est atteint, mets goal_achieved=true et action='finish'.",
    "Si tu es bloque (page d'erreur, popup bloquante, action impossible), explique pourquoi dans reasoning.",
    "Sois conservateur : si tu n es pas sur, prefere 'wait' ou 'assert'.",
    'Objectif : ' + goal,
  ].join('\n');
}

/**
 * Construit le prompt utilisateur : snapshot de la page + historique recent.
 */
function buildUserPrompt(step, snapshot, history) {
  const recentHistory = history.slice(-3).map((h, i) => {
    return `[step ${h.step}] action=${h.action} selector=${h.selector || '-'} value=${h.value || '-'} => ${h.observation}`;
  }).join('\n');

  return [
    `Step courant : ${step}/${CONFIG.maxSteps}`,
    `URL : ${snapshot.url}`,
    `Titre : ${snapshot.title}`,
    '--- Contenu visible (tronque) ---',
    snapshot.cleanedBody,
    '--- Historique recent ---',
    recentHistory || '(aucune action precedente)',
    'Decide la prochaine action.',
  ].join('\n');
}

/**
 * Capture l'etat courant de la page (cote test runner).
 */
async function captureSnapshot(page) {
  const [url, title, bodyHtml] = await Promise.all([
    page.url(),
    page.title().catch(() => ''),
    page.content().catch(() => ''),
  ]);
  return {
    url,
    title,
    cleanedBody: cleanPageHtml(bodyHtml),
    timestamp: new Date().toISOString(),
  };
}

/**
 * Execute l'action decidee par Claude. Renvoie une observation textuelle
 * (succes / echec) qui sera injectee dans l'historique au prochain tour.
 */
async function executeAction(page, decision) {
  const { action, selector, value } = decision;
  try {
    switch (action) {
      case 'click':
        await page.locator(selector).first().click({ timeout: 10_000 });
        return `click ${selector} OK`;
      case 'fill':
        await page.locator(selector).first().fill(value || '');
        return `fill ${selector}=${value} OK`;
      case 'select':
        await page.locator(selector).first().selectOption(value || '');
        return `select ${selector}=${value} OK`;
      case 'press':
        await page.keyboard.press(value || 'Enter');
        return `press ${value} OK`;
      case 'navigate':
        await page.goto(value, { waitUntil: 'domcontentloaded', timeout: 20_000 });
        return `navigate ${value} OK`;
      case 'wait':
        await page.waitForTimeout(Number(value || 1000));
        return `wait ${value}ms OK`;
      case 'scroll':
        await page.evaluate(() => window.scrollBy(0, Number(value || 300)));
        return `scroll ${value}px OK`;
      case 'assert': {
        const count = await page.locator(selector).count();
        return `assert ${selector} => ${count} occurrences`;
      }
      case 'finish':
        return 'finish declare par Claude';
      default:
        return `action inconnue: ${action}`;
    }
  } catch (err) {
    return `ERREUR action=${action} selector=${selector}: ${err.message}`.slice(0, 500);
  }
}

/**
 * Mode basique (sans IA) : execute une serie de verifications Playwright
 * deterministes quand ANTHROPIC_API_KEY est absent. Chaque etape produit un
 * enregistrement compatible avec le format utilise par le mode IA, afin que
 * le rapport HTML/JUnit reste identique dans les deux modes.
 *
 * Checks effectues :
 *   1. Navigation vers TARGET_URL + code de reponse HTTP 2xx/3xx
 *   2. Titre de page non vide
 *   3. Contenu visible (body) non vide
 *   4. Presence d'au moins un lien de navigation (a[href])
 *   5. Absence de texte evoquant une page d'erreur (500, 404, etc.)
 */
async function runBasicSmokeChecks(page) {
  const steps = [];
  let allOk = true;

  function record(action, selector, reasoning, success) {
    steps.push({
      step: steps.length + 1,
      action,
      selector: selector || '',
      value: '',
      reasoning,
      observation: success ? 'OK' : 'ECHEC',
      success,
      confidence: null,
    });
    if (!success) allOk = false;
  }

  // 1. Navigation + code de reponse HTTP
  let response;
  try {
    response = await page.goto(CONFIG.targetUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    const status = response ? response.status() : 0;
    record('navigate', CONFIG.targetUrl, `Reponse HTTP ${status}`, status >= 200 && status < 400);
  } catch (err) {
    record('navigate', CONFIG.targetUrl, `Echec de navigation: ${String(err.message || err)}`.slice(0, 300), false);
    return { steps, goalAchieved: false };
  }

  // 2. Titre de page non vide
  const title = await page.title().catch(() => '');
  record('assert', 'title', `Titre de la page : "${title}"`, Boolean(title && title.trim().length > 0));

  // 3. Contenu visible present
  const bodyText = await page.locator('body').innerText().catch(() => '');
  record('assert', 'body', `Longueur du contenu visible : ${bodyText.length} caracteres`, bodyText.trim().length > 0);

  // 4. Au moins un lien de navigation
  const linkCount = await page.locator('a[href]').count().catch(() => 0);
  record('assert', 'a[href]', `${linkCount} lien(s) detecte(s)`, linkCount > 0);

  // 5. Absence de page d'erreur evidente
  const hasErrorText = /erreur 500|internal server error|cannot get|404 not found|application error/i.test(bodyText);
  record(
    'assert',
    'body',
    hasErrorText ? "Texte evoquant une page d'erreur detecte" : "Aucun texte d'erreur evident detecte",
    !hasErrorText,
  );

  return { steps, goalAchieved: allOk };
}

/**
 * Appelle Claude avec la conversation courante. Utilise `tool use` pour
 * garantir une reponse JSON conforme au schema NEXT_ACTION_TOOL.
 */
async function callClaude(client, systemPrompt, messages) {
  const response = await client.messages.create({
    model: CONFIG.claudeModel,
    max_tokens: CONFIG.claudeMaxTokens,
    system: systemPrompt,
    tools: [NEXT_ACTION_TOOL],
    // Force Claude a utiliser notre outil = sortie strictement JSON
    tool_choice: { type: 'tool', name: 'next_action' },
    messages,
  });

  // Anthropic SDK >=0.30 : tool_use est dans response.content[]
  const toolBlock = response.content.find((b) => b.type === 'tool_use');
  if (!toolBlock || !toolBlock.input) {
    throw new Error('Claude n a pas renvoye d action conforme au schema.');
  }
  return toolBlock.input;
}

/**
 * Construit le rapport HTML inline (Tailwind via classes) pour l'email.
 * Version inline : pas de dependance externe, classes Tailwind compilees a la main.
 */
function buildHtmlReport({ finalStatus, steps, artifactLinks, durationMs, mode }) {
  const stepRows = steps
    .map(
      (s) => `
      <tr>
        <td class="border px-2 py-1 text-xs">${s.step}</td>
        <td class="border px-2 py-1 text-xs font-mono">${escape(s.action)}</td>
        <td class="border px-2 py-1 text-xs font-mono">${escape(s.selector || '-')}</td>
        <td class="border px-2 py-1 text-xs">${escape(s.reasoning || '')}</td>
        <td class="border px-2 py-1 text-xs ${s.success ? 'text-green-700' : 'text-red-700'}">
          ${s.success ? 'OK' : 'KO'}
        </td>
      </tr>`,
    )
    .join('');

  return `
  <!doctype html><html><head><meta charset="utf-8">
  <style>
    body { font-family: system-ui, sans-serif; }
    .container { max-width: 900px; margin: auto; padding: 16px; }
    table { border-collapse: collapse; width: 100%; }
    th { background: #f3f4f6; text-align: left; }
    .badge-pass { background:#dcfce7;color:#166534;padding:4px 8px;border-radius:6px;font-weight:600; }
    .badge-fail { background:#fee2e2;color:#991b1b;padding:4px 8px;border-radius:6px;font-weight:600; }
  </style></head>
  <body><div class="container">
    <h1>Rapport AI Crawler</h1>
    <p>Status final :
      <span class="${finalStatus === 0 ? 'badge-pass' : 'badge-fail'}">
        ${finalStatus === 0 ? 'OBJECTIF ATTEINT' : 'OBJECTIF NON ATTEINT'}
      </span>
    </p>
    <ul>
      <li><strong>Mode</strong> : ${mode === 'ia' ? `IA (${escape(CONFIG.claudeModel)})` : 'Basique (sans IA - checks deterministes)'}</li>
      <li><strong>Pipeline</strong> : #${escape(CONFIG.pipelineId)} / job #${escape(CONFIG.jobId)}</li>
      <li><strong>Duree</strong> : ${(durationMs / 1000).toFixed(1)} s</li>
      <li><strong>Steps executes</strong> : ${steps.length}</li>
    </ul>
    <h2>Artefacts</h2>
    <ul>
      <li><a href="${escape(artifactLinks.html)}">Rapport HTML Playwright</a></li>
      <li><a href="${escape(artifactLinks.junit)}">JUnit XML</a></li>
      <li><a href="${escape(artifactLinks.video)}">Video de la session</a></li>
      <li><a href="${escape(artifactLinks.json)}">Report JSON</a></li>
    </ul>
    <h2>Trace des etapes</h2>
    <table>
      <thead><tr><th>Step</th><th>Action</th><th>Selector</th><th>Reasoning</th><th>Resultat</th></tr></thead>
      <tbody>${stepRows || '<tr><td colspan="5" class="text-center py-4">Aucune action executee.</td></tr>'}</tbody>
    </table>
  </div></body></html>
  `;
}

function escape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Genere les URLs publiques d'artefacts (GitLab par defaut, adaptable GitHub).
 */
function buildArtifactLinks() {
  // Format GitLab : ${ARTIFACT_BASE_URL}/${CI_PIPELINE_ID}/raw/${CI_JOB_ID}/artifacts/path
  const base = CONFIG.artifactBaseUrl.replace(/\/$/, '');
  const prefix = `${base}/${CONFIG.pipelineId}/raw/${CONFIG.jobId}/artifacts`;
  return {
    html:   `${prefix}/test-results/html-report/index.html`,
    junit:  `${prefix}/test-results/junit.xml`,
    video:  `${prefix}/test-results/output/video.webm`,
    json:   `${prefix}/test-results/report.json`,
  };
}

/**
 * Envoie l'email de rapport avec HTML Tailwind inline + lien vers artefacts.
 * Si SMTP non configure, logge un warning et continue (le pipeline reste fonctionnel).
 */
async function sendReport({ finalStatus, steps, durationMs, mode }) {
  if (!CONFIG.smtp.host || !CONFIG.smtp.user || !CONFIG.smtp.to) {
    console.warn('[mail] SMTP non configure -> email non envoye (pipeline OK).');
    return { sent: false };
  }

  const transporter = nodemailer.createTransport({
    host: CONFIG.smtp.host,
    port: CONFIG.smtp.port,
    secure: CONFIG.smtp.secure,
    auth: { user: CONFIG.smtp.user, pass: CONFIG.smtp.pass },
  });

  const artifactLinks = buildArtifactLinks();
  const html = buildHtmlReport({ finalStatus, steps, artifactLinks, durationMs, mode });
  const modeLabel = mode === 'ia' ? 'IA' : 'basique';
  const subject = finalStatus === 0
    ? `[OK] AI Crawler (mode ${modeLabel}) - ${CONFIG.targetUrl}`
    : `[KO] AI Crawler (mode ${modeLabel}) - ${CONFIG.targetUrl}`;

  await transporter.sendMail({
    from: CONFIG.smtp.from || CONFIG.smtp.user,
    to: CONFIG.smtp.to,
    subject,
    html,
    // Aucune piece jointe lourde : les artefacts sont dans le lien CI.
    // (Les videos peuvent peser 5-50 Mo -> SMTP le plus souvent refuse.)
  });

  return { sent: true };
}

// ============================================================
//  ETAT PARTAGE (histoire du run, expose a l'email final)
// ============================================================

const runState = {
  startedAt: Date.now(),
  steps: [],
  artifacts: {},
  // Rempli juste avant le expect() final ; sert de source de verite unique
  // pour le hook afterAll (evite de deviner l'issue depuis le contenu des steps).
  finalStatus: null,
};

// ============================================================
//  TEST PRINCIPAL
// ============================================================

test('AI Crawler Universal', async ({ page }) => {
  test.setTimeout(CONFIG.maxSteps * 60_000); // ~60s/etape max

  const mode = CONFIG.apiKey ? 'ia' : 'basique';

  // ----------------------------------------------------------
  // MODE BASIQUE (sans IA) : ANTHROPIC_API_KEY absent.
  // On execute des checks deterministes au lieu de sauter le test,
  // pour que le pipeline reste utile en attendant la cle API.
  // ----------------------------------------------------------
  if (mode === 'basique') {
    console.warn('[ai-crawler] ANTHROPIC_API_KEY absent -> mode basique (checks deterministes, sans IA).');
    const { steps, goalAchieved } = await runBasicSmokeChecks(page);
    runState.steps.push(...steps);

    const finalStatus = goalAchieved ? 0 : 1;
    runState.finalStatus = finalStatus;

    await sendReport({
      finalStatus,
      steps: runState.steps,
      durationMs: Date.now() - runState.startedAt,
      mode,
    });

    expect(goalAchieved, `Checks basiques echoues apres ${runState.steps.length} etapes (mode sans IA).`).toBe(true);
    return;
  }

  // ----------------------------------------------------------
  // MODE IA : ANTHROPIC_API_KEY present.
  // ----------------------------------------------------------
  const client = new Anthropic({ apiKey: CONFIG.apiKey });
  const systemPrompt = buildSystemPrompt(CONFIG.goal);

  // 3. Boucle principale : navigation ciblee par l IA
  await page.goto(CONFIG.targetUrl, { waitUntil: 'domcontentloaded' });

  let decision = null;
  for (let step = 1; step <= CONFIG.maxSteps; step++) {
    const snapshot = await captureSnapshot(page);
    const messages = [
      {
        role: 'user',
        content: buildUserPrompt(step, snapshot, runState.steps),
      },
    ];

    try {
      decision = await callClaude(client, systemPrompt, messages);
    } catch (err) {
      console.error(`[step ${step}] appel Claude KO: ${err.message}`);
      // Erreur critique = exit 1 (le pipeline CI doit bloquer)
      runState.finalStatus = 1;
      await sendReport({
        finalStatus: 1,
        steps: runState.steps,
        durationMs: Date.now() - runState.startedAt,
        mode,
      });
      process.exit(1);
    }

    // Action de fin dclarative par Claude
    if (decision.action === 'finish' || decision.goal_achieved) {
      runState.steps.push({
        step,
        action: decision.action,
        selector: decision.selector || '',
        value: decision.value || '',
        reasoning: decision.reasoning,
        observation: 'goal_achieved',
        success: true,
        confidence: decision.confidence,
      });
      console.log(`[step ${step}] Objectif atteint (confidence=${decision.confidence})`);
      break;
    }

    // Executer l action et observer
    const observation = await executeAction(page, decision);
    runState.steps.push({
      step,
      action: decision.action,
      selector: decision.selector || '',
      value: decision.value || '',
      reasoning: decision.reasoning,
      observation,
      success: !/^ERREUR/.test(observation),
      confidence: decision.confidence,
    });

    // Petite pause entre iterations (laisse le DOM se stabiliser)
    await page.waitForTimeout(500);
  }

  // 4. Decision finale : on a-t-on atteint l'objectif ?
  const finalGoal = runState.steps.some((s) => s.observation === 'goal_achieved');
  const finalStatus = finalGoal ? 0 : 1;
  runState.finalStatus = finalStatus;

  // 5. Envoi du rapport mail
  await sendReport({
    finalStatus,
    steps: runState.steps,
    durationMs: Date.now() - runState.startedAt,
    mode,
  });

  // 6. Assertion finale -> process.exit gere par Playwright via expect
  // Si expect echoue : code 1, sinon code 0.
  expect(finalGoal, `Objectif non atteint apres ${runState.steps.length} etapes.`).toBe(true);
});

// Hook : a la fin du run, on force le exit-code meme en cas d'erreur non capturee.
// (Playwright termine naturellement, mais ce filet de securite garantit le code CI.)
// runState.finalStatus est la source de verite (posee explicitement par les deux
// modes avant le expect() final) ; par defaut 1 (echec) si jamais rien ne l'a fixe.
test.afterAll(async () => {
  process.exit(runState.finalStatus === 0 ? 0 : 1);
});
