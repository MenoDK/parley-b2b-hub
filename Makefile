.DEFAULT_GOAL := help
SHELL := /bin/bash
COMPOSE := docker compose
# The browser container runs as you, so what it writes (node_modules, screenshots) is yours to delete.
E2E_USER := --user $$(id -u):$$(id -g) -e HOME=/tmp
export DATABASE_URL ?= postgresql://postgres:postgres@localhost:15433/app

.PHONY: help env demo down reset logs install lint typecheck test check mutate transcripts e2e screenshots

help: ## list the targets
	@grep -E '^[a-z-]+:.*##' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-12s %s\n", $$1, $$2}'

env: ## write .env with fresh random secrets (never overwrites an existing one)
	@if [ -f .env ]; then echo ".env already exists, leaving it alone"; else \
	  { echo "DB_PASSWORD=$$(openssl rand -hex 16)"; echo "API_KEY=change-me"; \
	    echo "ORIGIN_TO_PARTNER_SECRET=$$(openssl rand -hex 24)"; echo "PARTNER_TO_ORIGIN_SECRET=$$(openssl rand -hex 24)"; \
	    echo "VAULT_KEY=$$(openssl rand -hex 32)"; echo "VAULT_KEY_PARTNER=$$(openssl rand -hex 32)"; \
	    echo "BLIND_INDEX_KEY=$$(openssl rand -hex 16)"; echo "BLIND_INDEX_KEY_PARTNER=$$(openssl rand -hex 16)"; } > .env; \
	  echo "wrote .env with fresh random secrets"; fi

demo: env ## build and start the shop, the partner and PostgreSQL (http://localhost:8000)
	$(COMPOSE) up --build --wait -d
	@echo; echo "  shop + this site:  http://localhost:8000   (press 'Enter the lab')"; echo "  partner API:       http://localhost:8001"; echo "  stop with:         make down"

down: ## stop everything and keep the data
	$(COMPOSE) down

reset: ## stop everything and delete the databases
	$(COMPOSE) down -v

logs: ## follow the logs
	$(COMPOSE) logs -f origin partner

install: ## install dependencies for local development
	pnpm install --frozen-lockfile

lint: ## biome
	pnpm lint

typecheck: ## tsc --strict
	pnpm typecheck

test: ## unit and integration tests (needs PostgreSQL: docker compose -f compose.dev.yml up -d)
	pnpm test

check: lint typecheck test ## everything the CI checks except the browser tests

mutate: ## break each critical rule on purpose and confirm a test notices
	node scripts/mutation-check.mjs

transcripts: ## re-record the tour on the landing page from the running code
	pnpm transcripts

e2e: env ## browser tests (Playwright + axe) against the Compose stack
	$(COMPOSE) up --build --wait -d
	$(COMPOSE) --profile e2e run --rm $(E2E_USER) e2e

screenshots: env ## re-take the README screenshots (docs/img) from the running stack
	$(COMPOSE) up --build --wait -d
	$(COMPOSE) --profile e2e run --rm $(E2E_USER) -e SHOTS=1 e2e bash -lc "npm ci --no-audit --no-fund && npx playwright test shots"
