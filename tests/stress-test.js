// ============================================================
//  tests/stress-test.js
// ------------------------------------------------------------
//  Test de charge & scalabilite - Grafana K6
//
//  Objectif :
//    Simuler une montee en charge progressive (Spike/Stress)
//    de 0 a TARGET_VUs utilisateurs virtuels, puis descente,
//    pour valider que l'infrastructure tient sous pression.
//
//  Cible :
//    GET ${TARGET_URL} (defaut : racine du frontend/API testee)
//
//  Seuils de performance (Thresholds) :
//    - taux d'erreur HTTP < ${K6_ERROR_RATE_THRESHOLD} (defaut 1 %)
//    - latence P95    < ${K6_P95_THRESHOLD_MS} ms (defaut 2000 ms)
//
//  Personnalisation runtime :
//    K6_MAX_VUS              -> palier max (defaut 200)
//    K6_RAMP_STAGES          -> "30s:50,1m:100,30s:200,30s:0"
//    K6_P95_THRESHOLD_MS     -> seuil P95 (defaut 2000)
//    K6_ERROR_RATE_THRESHOLD -> seuil erreurs (defaut 0.01)
//    TARGET_URL              -> URL cible (defaut http://host.docker.internal:3000)
//
//  Sortie :
//    stdout (texte colore)
//    results/stress-summary.json (parametre K6_OUT dans docker-compose)
//
//  Exit code :
//    0 -> seuils respectes (pipeline OK)
//    1 -> au moins un seuil franchi (pipeline NOK)
// ============================================================

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.3/index.js';

// ============================================================
//  CONFIGURATION (env vars + defauts)
// ============================================================

const TARGET_URL = __ENV.TARGET_URL || 'http://host.docker.internal:3000';

// K6_RAMP_STAGES = "30s:50,1m:100,30s:200,30s:0"
// Format attendu : paires "duree:targetVUs" separees par des virgules.
function parseStages(raw, defaultMaxVUs) {
  if (!raw) {
    return [
      { duration: '30s', target: Math.round(defaultMaxVUs * 0.25) },
      { duration: '1m', target: Math.round(defaultMaxVUs * 0.5) },
      { duration: '30s', target: defaultMaxVUs },
      { duration: '30s', target: 0 },
    ];
  }
  return raw.split(',').map((pair) => {
    const [duration, target] = pair.trim().split(':');
    return { duration: duration.trim(), target: Number(target) };
  });
}

const MAX_VUS = Number(__ENV.K6_MAX_VUS || 200);
const STAGES = parseStages(__ENV.K6_RAMP_STAGES, MAX_VUS);
const P95_THRESHOLD_MS = Number(__ENV.K6_P95_THRESHOLD_MS || 2000);
const ERROR_RATE_THRESHOLD = Number(__ENV.K6_ERROR_RATE_THRESHOLD || 0.01);

// ============================================================
//  METRIQUES PERSONNALISEES
// ============================================================

const pageLoadTime = new Trend('page_load_time', true);
const errorRate = new Rate('http_errors');

// ============================================================
//  OPTIONS K6 - ramp-up + seuils
// ============================================================

export const options = {
  stages: STAGES,
  thresholds: {
    // Latence P95 sous le seuil (configurable)
    http_req_duration: [`p(95)<${P95_THRESHOLD_MS}`],
    // Taux d'erreur sous le seuil (configurable)
    http_req_failed: [`rate<${ERROR_RATE_THRESHOLD}`],
    // Metriques custom : on garde la trace de la tendance
    page_load_time: [`p(95)<${P95_THRESHOLD_MS}`],
    http_errors: [`rate<${ERROR_RATE_THRESHOLD}`],
  },
  // Pas de discardResponseBodies : on a besoin du body pour les checks
  discardResponseBodies: false,
  // User-Agent explicite : utile pour distinguer K6 des autres clients
  userAgent: 'ai-test-platform/k6',
  // Distribution de tags raisonnable
  tags: { testid: 'ai-test-platform-load' },
};

// ============================================================
//  SCENARIO PRINCIPAL (chaque VU execute ce code en boucle)
// ============================================================

export default function () {
  const start = Date.now();

  // Requete principale : GET sur l'URL cible
  const res = http.get(TARGET_URL, {
    headers: {
      Accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
      'Accept-Encoding': 'gzip, deflate',
      'User-Agent': 'ai-test-platform/k6',
    },
    // Tag pour filtrage dans le rapport
    tags: { endpoint: TARGET_URL },
    timeout: '10s',
  });

  const elapsed = Date.now() - start;
  pageLoadTime.add(elapsed);

  // Verification du contenu : on suppose qu'une page "OK" renvoie 2xx/3xx
  const statusOk = res.status >= 200 && res.status < 400;
  const isErrorStatus = res.status >= 500;
  const isNotFound = res.status === 404;

  errorRate.add(!statusOk || isErrorStatus || isNotFound);

  check(res, {
    'status is 2xx/3xx': (r) => r.status >= 200 && r.status < 400,
    'latency under threshold': (r) => r.timings.duration < P95_THRESHOLD_MS,
    'body not empty': (r) => r.body && r.body.length > 0,
  });

  // Petite pause entre iterations (comportement plus realiste)
  sleep(Math.random() * 1.5); // 0-1.5s
}

// ============================================================
//  HANDLESUMMARY - sortie texte + JSON pour CI
// ============================================================
//  Renvoie :
//    - stdout : resume texte colore (lecture humaine)
//    - results/stress-summary.json : sortie machine (GitLab/GitHub)
//
//  K6 ecrit egalement results/stress-summary.json via K6_OUT dans
//  docker-compose.yml ; ici on produit une copie "curated" plus stable.
// ============================================================

export function handleSummary(data) {
  return {
    'stdout': textSummary(data, { indent: '  ', enableColors: true }),
    'results/stress-summary.json': JSON.stringify(data, null, 2),
  };
}
