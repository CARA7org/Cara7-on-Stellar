.PHONY: help setup check dev-docs dev-tranching dev-defi dev-spv contracts-test contracts-build

help: ## List available targets
	@grep -E '^[a-z-]+:.*##' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "}; {printf "  %-16s %s\n", $$1, $$2}'

setup: ## Install everything and apply both APIs' migrations
	pnpm install
	pnpm --filter docs-api exec prisma migrate deploy
	pnpm --filter tranching-api exec prisma migrate deploy

check: ## Typecheck + tests for every app (definition of done)
	pnpm --filter docs-api check
	pnpm --filter tranching-api check
	pnpm --filter defi-web check
	pnpm --filter spv-backend check

dev-docs: ## Docs API + docs front (port 3333)
	pnpm --filter docs-api dev

dev-tranching: ## Tranche indexer + registry (port 8080)
	pnpm --filter tranching-api dev

dev-defi: ## TrueABS DeFi front (port 3001)
	pnpm --filter defi-web dev

dev-spv: ## SPV backend - Data Spec Book map, pool, tokens, waterfall (port 8090)
	pnpm --filter spv-backend dev

contracts-test: ## Rust tests for the Soroban contracts (cargo required)
	cargo test --workspace

contracts-build: ## Wasm build of the contracts (stellar-cli required)
	stellar contract build
