# Exemples d'intégration CI/CD — `ai-test-platform`

Ce document présente **deux configurations prêtes à l'emploi** pour intégrer `ai-test-platform` dans vos pipelines CI/CD.

Les deux services Docker définis dans `docker-compose.yml` :

| Service        | Image                                       | But                                                | Exit code  |
|----------------|---------------------------------------------|-----------------------------------------------------|------------|
| `ai-tester`    | `mcr.microsoft.com/playwright:v1.49.0-jammy` | Crawler E2E IA (Playwright + Claude)               | `0` / `1`  |
| `load-tester`  | `grafana/k6:latest`                          | Test de charge & scalabilité (K6)                  | `0` / `1`  |

Les deux respectent les conventions CI modernes :
- Sortie **JUnit.xml** ou **JSON** dans le dossier d'artefacts.
- Archivage des rapports HTML, vidéos, traces.
- **Exit code 0/1 standard** : le pipeline bloque ou valide automatiquement.
- Notification email ou webhook en cas d'échec.

---

## 📌 Variables d'environnement à configurer

Toutes ces variables sont **à protéger** (GitLab : `Protected` + `Masked` ; GitHub : `Secrets`).

| Variable                  | Sens                                    | Exemple                                                         |
|---------------------------|-----------------------------------------|-----------------------------------------------------------------|
| `ANTHROPIC_API_KEY`       | Clé API Claude                          | `sk-ant-…`                                                      |
| `CLAUDE_MODEL`            | Nom du modèle                           | `claude-sonnet-4-5` (par défaut)                                |
| `TARGET_URL`              | URL à tester                            | `https://staging.example.com`                                   |
| `CRAWLER_GOAL`            | Objectif en langage naturel             | `Vérifier la page de login + redirection après auth`            |
| `SMTP_HOST` / `SMTP_PORT` | Serveur mail                            | `smtp.gmail.com` / `587`                                        |
| `SMTP_USER` / `SMTP_PASS` | Credentials SMTP (mot de passe d'appli) | Gmail App Password conseillé                                    |
| `SMTP_FROM` / `SMTP_TO`   | Expéditeur / destinataires               | `noreply@example.com` / `qa@example.com,dev@example.com`         |
| `ARTIFACT_BASE_URL`       | URL publique des artefacts              | GitLab : auto ; GitHub : `https://github.com/<org>/<repo>/actions/runs/<id>/artifacts/<N>` |
| `K6_P95_THRESHOLD_MS`     | Seuil latence P95 (ms)                  | `2000` (par défaut)                                             |
| `K6_ERROR_RATE_THRESHOLD` | Seuil taux d'erreur                     | `0.01` (1 %) par défaut                                         |

---

## 1. GitLab CI — `.gitlab-ci.yml`

```yaml
# ==========================================================
#  GitLab CI : AI Test Platform
#  - Stage 1 : E2E IA (ai-tester)
#  - Stage 2 : Charge (load-tester)
#  Les deux tournent en parallele, puis merge-results consolide
#  les rapports JUnit pour le test summary GitLab.
# ==========================================================

stages:
  - test
  - report

# ---------- Variables (a surcharger dans Settings > CI/CD > Variables) ----------
variables:
  DOCKER_HOST: ""
  ANTHROPIC_API_KEY: "$ANTHROPIC_API_KEY"
  CLAUDE_MODEL: "claude-sonnet-4-5"
  TARGET_URL: "$TARGET_URL"
  CRAWLER_GOAL: "$CRAWLER_GOAL"
  SMTP_HOST: "$SMTP_HOST"
  SMTP_PORT: "587"
  SMTP_USER: "$SMTP_USER"
  SMTP_PASS: "$SMTP_PASS"
  SMTP_FROM: "$SMTP_FROM"
  SMTP_TO: "$SMTP_TO"
  ARTIFACT_BASE_URL: "$CI_PROJECT_URL/-/jobs/$CI_JOB_ID/artifacts/raw"
  CI_PIPELINE_ID: "$CI_PIPELINE_ID"
  CI_JOB_ID: "$CI_JOB_ID"
  K6_P95_THRESHOLD_MS: "2000"
  K6_ERROR_RATE_THRESHOLD: "0.01"

# ==========================================================
#  1. Tests E2E IA (Playwright + Claude)
# ==========================================================
e2e-ai:
  stage: test
  image: docker:24
  services:
    - docker:24-dind
  variables:
    DOCKER_TLS_CERTDIR: ""
  before_script:
    - apk add --no-cache docker-compose
    - docker compose version
  script:
    - docker compose pull
    # Lance le crawler IA. exit 0 = OK, exit 1 = KO.
    - docker compose run --rm ai-tester
    # Deplace les artefacts dans un dossier public
    - docker compose down --remove-orphans || true
  artifacts:
    when: always
    expire_in: 14 days
    paths:
      - results/html-report/
      - results/junit.xml
      - results/output/video.webm
      - results/screenshots/
      - results/traces/
      - results/report.json
    reports:
      junit: results/junit.xml
  retry:
    max: 1
    when: runner_system_failure
  tags:
    - docker
  # Notification Slack/Teams optionnelle (webhook)
  after_script:
    - |
      if [ "$CI_JOB_STATUS" == "failed" ]; then
        apk add --no-cache curl
        curl -X POST -H 'Content-type: application/json' \
          --data '{"text":"❌ AI E2E failed on '$CI_PROJECT_URL'/pipelines/'$CI_PIPELINE_ID'"}' \
          "$SLACK_WEBHOOK_URL" || true
      fi

# ==========================================================
#  2. Tests de charge (K6)
# ==========================================================
load-test:
  stage: test
  image: docker:24
  services:
    - docker:24-dind
  variables:
    DOCKER_TLS_CERTDIR: ""
  before_script:
    - apk add --no-cache docker-compose
  script:
    # Lance le test de charge K6. exit 0/1 gere par les seuils.
    - docker compose run --rm load-tester run /tests/stress-test.js
    # Copie le JSON
    - cp -r results ./results-load || true
  artifacts:
    when: always
    expire_in: 30 days
    paths:
      - results-load/
    reports:
      # GitLab interprete le JSON K6 comme un artefact, pas un JUnit
      junit: results-load/stress-summary.json
  retry:
    max: 0
  tags:
    - docker
  after_script:
    - |
      if [ "$CI_JOB_STATUS" == "failed" ]; then
        curl -X POST -H 'Content-type: application/json' \
          --data '{"text":"📊 K6 load test failed (seuil P95 ou erreurs depasses)"}' \
          "$SLACK_WEBHOOK_URL" || true
      fi

# ==========================================================
#  3. Bloc declencheur manuel (option)
# ==========================================================
e2e-only-manual:
  stage: test
  when: manual
  allow_failure: true
  script:
    - docker compose run --rm ai-tester
  artifacts:
    expire_in: 7 days
    paths:
      - results/
    reports:
      junit: results/junit.xml
```

---

## 2. GitHub Actions — `.github/workflows/e2e-load-tests.yml`

```yaml
# ==========================================================
#  GitHub Actions : AI Test Platform
# ==========================================================
name: AI Test Platform (E2E + Load)

on:
  workflow_dispatch:        # declenchement manuel
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]
  schedule:
    # Chaque nuit a 2h UTC, sur main
    - cron: "0 2 * * *"

# Bloque les jobs suivants si E2E ou Load echouent
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

env:
  TARGET_URL: ${{ secrets.TARGET_URL }}
  CRAWLER_GOAL: ${{ vars.CRAWLER_GOAL || 'Verifier que la page d accueil fonctionne' }}
  CLAUDE_MODEL: claude-sonnet-4-5
  K6_P95_THRESHOLD_MS: "2000"
  K6_ERROR_RATE_THRESHOLD: "0.01"
  # Le SMTP est optionnel : si absent, seul l artefact CI est genere.
  SMTP_HOST: ${{ secrets.SMTP_HOST || '' }}
  SMTP_PORT: "587"
  SMTP_USER: ${{ secrets.SMTP_USER || '' }}
  SMTP_PASS: ${{ secrets.SMTP_PASS || '' }}
  SMTP_FROM: ${{ secrets.SMTP_FROM || '' }}
  SMTP_TO: ${{ secrets.SMTP_TO || '' }}

jobs:
  # ------------------------------------------------
  # Job 1 : E2E IA (Playwright + Claude)
  # ------------------------------------------------
  e2e-ai:
    name: E2E IA (Playwright + Claude)
    runs-on: ubuntu-24.04
    timeout-minutes: 30
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup variables pour artefacts
        id: vars
        run: |
          echo "CI_PIPELINE_ID=${{ github.run_id }}" >> $GITHUB_OUTPUT
          echo "CI_JOB_ID=${{ github.run_attempt }}" >> $GITHUB_OUTPUT
          echo "ARTIFACT_BASE_URL=${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}/artifacts" >> $GITHUB_OUTPUT

      - name: Create .env from secrets
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          {
            echo "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY"
            echo "TARGET_URL=$TARGET_URL"
            echo "CRAWLER_GOAL=$CRAWLER_GOAL"
            echo "CLAUDE_MODEL=$CLAUDE_MODEL"
            echo "SMTP_HOST=$SMTP_HOST"
            echo "SMTP_PORT=$SMTP_PORT"
            echo "SMTP_USER=$SMTP_USER"
            echo "SMTP_PASS=$SMTP_PASS"
            echo "SMTP_FROM=$SMTP_FROM"
            echo "SMTP_TO=$SMTP_TO"
            echo "ARTIFACT_BASE_URL=$ARTIFACT_BASE_URL"
            echo "CI_PIPELINE_ID=$CI_PIPELINE_ID"
            echo "CI_JOB_ID=$CI_JOB_ID"
          } >> $GITHUB_ENV

      - name: Lancer le crawler IA
        run: |
          docker compose run --rm ai-tester
        # exit code propage : 0 = OK, 1 = KO (et bloque les jobs suivants)

      - name: Upload artefacts (mem si echec)
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: e2e-ai-report
          path: |
            results/html-report/
            results/junit.xml
            results/output/
            results/screenshots/
            results/traces/
            results/report.json
          retention-days: 14
          if-no-files-found: warn

      - name: Publier le rapport JUnit sur l UI GitHub
        if: always()
        uses: mikepenz/action-junit-report@v4
        with:
          report_paths: "results/junit.xml"
          fail_on_failure: true
          require_tests: true

  # ------------------------------------------------
  # Job 2 : Test de charge (K6)
  # Necessite : e2e-ai reussi (optionnel, decommenter 'needs' si desire)
  # ------------------------------------------------
  load-test:
    name: Load & Scale (K6)
    runs-on: ubuntu-24.04
    # needs: e2e-ai           # decommente pour enchainer
    timeout-minutes: 45
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Run K6
        env:
          K6_P95_THRESHOLD_MS: ${{ env.K6_P95_THRESHOLD_MS }}
          K6_ERROR_RATE_THRESHOLD: ${{ env.K6_ERROR_RATE_THRESHOLD }}
        run: |
          docker compose run --rm load-tester run /tests/stress-test.js
        # exit code 1 si les seuils sont franchis

      - name: Upload artefacts K6
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: k6-load-report
          path: results/stress-summary.json
          retention-days: 30
          if-no-files-found: warn

      - name: Commentaire PR avec resume K6
        if: github.event_name == 'pull_request' && always()
        uses: marocchino/sticky-pull-request-comment@v2
        with:
          header: k6-load-summary
          message: |
            ### 📊 Résumé K6
            - **VUs max** : ${{ env.K6_MAX_VUS || 200 }}
            - **Seuil P95** : < ${{ env.K6_P95_THRESHOLD_MS }} ms
            - **Seuil erreurs** : < ${{ env.K6_ERROR_RATE_THRESHOLD * 100 }} %
            - Voir l'artifact `k6-load-report` pour le détail.

  # ------------------------------------------------
  # Job 3 : Notification d'echec globale (exemple)
  # ------------------------------------------------
  notify-failure:
    name: Notify on failure
    if: failure()
    needs: [e2e-ai, load-test]
    runs-on: ubuntu-24.04
    steps:
      - name: Slack notification
        env:
          SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK_URL }}
        run: |
          curl -X POST -H 'Content-type: application/json' \
            --data '{
              "text": "❌ AI Test Platform a échoué sur `${{ github.ref_name }}`\n↳ ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}"
            }' \
            "$SLACK_WEBHOOK_URL" || true
```

---

## 🚀 Guide de démarrage rapide

### Prérequis
- Docker 24+ et Docker Compose v2+ installés.
- Une clé API Claude (`ANTHROPIC_API_KEY`).

### Étape 1 — Configurer l'environnement
```bash
cp .env.sample .env
# Editer .env (au minimum : ANTHROPIC_API_KEY, TARGET_URL)
```

### Étape 2 — Lancer les tests en local
```bash
# Tests E2E IA uniquement
docker compose run --rm ai-tester

# Tests de charge uniquement
docker compose run --rm load-tester

# Les deux à la suite
docker compose run --rm ai-tester && docker compose run --rm load-tester
```

### Étape 3 — Consulter les rapports
```bash
# Rapport HTML Playwright (ouvrir dans un navigateur)
open results/html-report/index.html        # macOS
xdg-open results/html-report/index.html    # Linux

# JUnit XML (lu par la CI)
cat results/junit.xml

# Résumé K6 JSON
cat results/stress-summary.json
```

### Étape 4 — Brancher à votre CI/CD
1. Copier le bloc correspondant à votre plateforme (GitLab ou GitHub).
2. Configurer les **secrets** (`ANTHROPIC_API_KEY`, `SMTP_*`, `TARGET_URL`).
3. Pousser sur `main` ou déclencher manuellement (`workflow_dispatch`).
4. Vérifier l'onglet **Tests / Artifacts** de l'UI CI.

---

## 🔒 Bonnes pratiques sécurité

- **Ne jamais commit** le fichier `.env` (déjà dans `.gitignore`).
- Utiliser un **mot de passe d'application** Gmail (pas votre mot de passe principal).
- En production, configurer **Slack/Teams** via webhook et non email direct.
- Pinner les versions Docker (`mcr.microsoft.com/playwright:v1.49.0-jammy`, `grafana/k6:latest` devenant `grafana/k6:0.51.0`).
- Configurer la **rétention d'artefacts** (GitLab : `expire_in` ; GitHub : `retention-days`).
- Isoler les **VUs K6** en staging avec un quota réseau pour éviter un DDoS accidentel.

---

## 📚 Personnalisation avancée

| Besoin                              | Levier                                                       |
|-------------------------------------|--------------------------------------------------------------|
| Changer de modèle Claude            | `CLAUDE_MODEL=claude-opus-5`                                 |
| Plus d'étapes crawler               | `CRAWLER_MAX_STEPS=20`                                       |
| P95 plus strict                     | `K6_P95_THRESHOLD_MS=1000`                                   |
| Test sur plusieurs pages            | Modifier `TARGET_URL` ou ajouter des requêtes dans K6        |
| Reporter JUnit custom               | Adapter `playwright.config.js` (`reporter:`)                 |
| Authentification avant crawl        | Ajouter `await page.fill('#email', ...)` en step 1 codé en dur |
| Multi-régions K6                    | Déployer le job load-test sur plusieurs runners simultanément |

---

**Auteur** : AI Test Platform · **Licence** : UNLICENSED · **Compatibilité** : Node 20+, Docker 24+
