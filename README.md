# AI Test Platform

Plateforme universelle de tests E2E propulsés par l'IA (Playwright + Claude) et de tests de charge (Grafana K6), intégrable dans tout pipeline CI/CD.

## ✨ Fonctionnalités

- **Crawler IA autonome** — jusqu'à 10 étapes de raisonnement, décision JSON stricte via `tool_use`, configurable avec n'importe quel modèle Claude
- **Test de charge K6** — ramp-up configurable, seuils P95 et taux d'erreur, sortie JSON
- **CI/CD ready** — exit codes `0/1`, rapports `junit.xml` + `html` + `json`, artefacts archivés
- **Rapport email HTML** avec lien vers les artefacts CI (jamais de pièce jointe lourde)
- **Dockerisé** — pas de dépendances locales, isolation totale

## 📦 Stack

| Composant | Version | Rôle |
|---|---|---|
| Node.js | 20+ | Runtime du crawler |
| `@playwright/test` | 1.49+ | Exécution navigateur |
| `@anthropic-ai/sdk` | 0.40+ | Appels Claude |
| `nodemailer` | 6.9+ | Rapport email |
| Grafana K6 | latest | Test de charge |
| Docker | 24+ | Isolation & CI |

## 🚀 Démarrage rapide

### Prérequis
- Docker 24+ et Docker Compose v2+
- Une clé API Anthropic ([console](https://console.anthropic.com/))

### Étape 1 — Configuration
```bash
cp .env.sample .env
# Editer .env : remplir au moins ANTHROPIC_API_KEY et TARGET_URL
```

### Étape 2 — Lancer en local
```bash
# Tests E2E IA
docker compose run --rm ai-tester

# Tests de charge K6
docker compose run --rm load-tester

# Les deux à la suite
docker compose run --rm ai-tester && docker compose run --rm load-tester
```

### Étape 3 — Consulter les rapports
```bash
# HTML (lecture humaine)
open results/html-report/index.html          # macOS
xdg-open results/html-report/index.html      # Linux

# XML JUnit (lu par GitLab, GitHub, Jenkins)
cat results/junit.xml

# JSON K6 (résumé machine)
cat results/stress-summary.json
```

## ⚙️ Configuration

Toutes les options sont pilotées par variables d'environnement. Voir [`.env.sample`](.env.sample) pour la liste complète.

| Variable                  | Défaut                            | Description                                    |
|---------------------------|-----------------------------------|------------------------------------------------|
| `ANTHROPIC_API_KEY`       | *(obligatoire)*                   | Clé API Claude                                 |
| `CLAUDE_MODEL`            | `claude-sonnet-4-5`               | Modèle à utiliser                              |
| `TARGET_URL`              | `http://host.docker.internal:3000`| URL à tester                                   |
| `CRAWLER_GOAL`            | *Voir .env.sample*                | Objectif en langage naturel                     |
| `CRAWLER_MAX_STEPS`       | `10`                              | Nombre max d'étapes du crawler                 |
| `K6_MAX_VUS`              | `200`                             | Pic d'utilisateurs virtuels                     |
| `K6_P95_THRESHOLD_MS`     | `2000`                            | Seuil de latence P95 (ms)                      |
| `K6_ERROR_RATE_THRESHOLD` | `0.01`                            | Seuil de taux d'erreur (1%)                    |

## 🏗️ Intégration CI/CD

Exemples prêts à l'emploi pour **GitLab CI**, **GitHub Actions** et autres : voir [`ci-pipeline-examples.md`](ci-pipeline-examples.md).

### Jenkins (extrait)
```groovy
stage('AI Crawler') {
  steps {
    withCredentials([string(credentialsId: 'anthropic-api-key', variable: 'ANTHROPIC_API_KEY')]) {
      sh 'docker compose run --rm ai-tester'
    }
  }
}

stage('Load Test K6') {
  steps {
    sh 'docker compose run --rm load-tester run /tests/stress-test.js'
  }
}
```

## 🏛️ Architecture

```
                ┌───────────────────────────┐
                │  CI/CD (GitLab/GH/Jenkins)│
                └──────────────┬────────────┘
                               │
            ┌──────────────────┴──────────────────┐
            │                                     │
   ┌────────▼────────┐                  ┌────────▼────────┐
   │   ai-tester     │                  │   load-tester   │
   │  Playwright +   │                  │   Grafana K6    │
   │   Claude SDK    │                  │                 │
   └────────┬────────┘                  └────────┬────────┘
            │                                    │
            ▼                                    ▼
   artifacts/junit.xml                artifacts/stress-summary.json
   artifacts/html-report/             results/stress-summary.json
   artifacts/output/video.webm
   artifacts/report.json
```

## 📁 Structure du projet

```
ai-test-platform/
├── package.json                  # Dépendances Node
├── docker-compose.yml            # Services Docker (ai-tester + load-tester)
├── playwright.config.js          # Config Playwright (reporters, video, trace)
├── .env.sample                   # Template variables d'environnement
├── .gitignore
├── README.md                     # Ce fichier
├── ci-pipeline-examples.md       # Exemples GitLab CI / GitHub Actions
└── tests/
    ├── universal-crawler.spec.js # Crawler IA (Claude tool use)
    └── stress-test.js            # Test de charge K6
```

## 🔒 Sécurité

- **Ne jamais commit** `.env` — déjà listé dans `.gitignore`
- **Mot de passe d'application Gmail** recommandé (pas le mot de passe principal)
- **Pinner les images Docker** en production (`grafana/k6:0.51.0` au lieu de `latest`)
- **Limiter le nombre de VUs** K6 pour éviter un DDoS accidentel
- **Rate limiting Claude** : ajuster `CLAUDE_MAX_TOKENS` pour contrôler les coûts

## 📊 Métriques par défaut

| Métrique                  | Seuil par défaut | Sévérité |
|---------------------------|------------------|----------|
| Latence P95 (K6)          | < 2000 ms        | Élevée   |
| Taux d'erreur HTTP (K6)   | < 1 %            | Critique |
| Étapes crawler IA         | ≤ 10             | Informatif |
| Exit code                 | `0` (OK) / `1` (KO) | Natif CI |

## 📝 Licence

UNLICENSED — usage interne.

## 🤝 Contribution

1. Fork & branch (`feature/...`, `fix/...`)
2. Commits atomiques et explicites en français (sans `Co-authored-by`)
3. Tests : `docker compose run --rm ai-tester`
4. PR avec description détaillée de l'impact

---

**Compatibilité** : Node 20+ · Docker 24+ · Anthropic Claude Sonnet 4.5 / Opus 5 / Haiku 4.5
