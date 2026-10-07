# PULSE: one command per job. Ports: web 8461, API 8460, Postgres/PostGIS 55460, mail sink 8462.
.PHONY: dev seed test e2e load-test reset build typecheck openapi record

dev:        ## full stack in Docker: web, API, PostGIS, mail sink, OpenTelemetry collector, generator
	docker compose up --build -d --wait
	@echo "web http://localhost:8461  api http://localhost:8460/openapi.json  mail http://localhost:8462"

seed:       ## regenerate the synthetic world and pipeline outputs, then load them (owner connection)
	node data/simulators/generate.ts
	node apps/api/src/migrate.ts && node apps/api/src/seed.ts --reset

test:       ## unit tests (coverage >= 85% of domain logic) + API contract tests against a throwaway PostGIS
	docker compose --profile test run --rm --build test

e2e:        ## Playwright against the static export (needs Google Chrome)
	node scripts/copy-fixtures.ts && npm run build -w @pulse/web
	npx playwright test

load-test:  ## reads + ingestion against an API started with RATE_LIMIT=1000000 PORT=8463 node apps/api/src/main.ts
	node tests/performance/load.ts http://127.0.0.1:8463 32 10 4 15

reset:      ## drop all data and reseed
	docker compose down -v
	docker compose up --build -d --wait

build:      ## static export for GitHub Pages (base path = the projects site)
	NEXT_PUBLIC_BASE_PATH=/projects/pulse-economic-activity/demo npm run build -w @pulse/web

typecheck:
	npx tsc -p . && (cd apps/web && npx tsc --noEmit -p .)

openapi:    ## write docs/openapi.json from the route schemas (needs the seeded database)
	node -e "import('./apps/api/src/server.ts').then(async (m) => { const app = await m.build({ logger: false, mail: null }); await app.ready(); require('fs').writeFileSync('docs/openapi.json', JSON.stringify(app.swagger(), null, 1)); await app.close(); process.exit(0); })"

record:     ## 2-4 minute captioned demo recording (Playwright video -> docs/video/demo.mp4)
	node scripts/record-demo.ts
