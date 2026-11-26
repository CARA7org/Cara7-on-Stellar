.PHONY: help setup check dev-docs dev-tranching dev-defi dev-spv dev-custody dev-checker contracts-test contracts-build contracts-vectors

help: ## List available targets
	@grep -E '^[a-z-]+:.*##' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "}; {printf "  %-16s %s\n", $$1, $$2}'

setup: ## Install everything and apply the migrations of the three APIs
	pnpm install
	pnpm --filter docs-api exec prisma migrate deploy
	pnpm --filter tranching-api exec prisma migrate deploy
	pnpm --filter custody-api exec prisma migrate deploy

check: ## Typecheck + tests for every app (definition of done)
	pnpm --filter docs-api check
	pnpm --filter tranching-api check
	pnpm --filter custody-api check
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

dev-custody: ## Investor custody service - passkeys, Dfns policy wallets (port 8091)
	pnpm --filter custody-api dev

dev-checker: ## Dfns checker - votes on investor approvals (own credentials)
	pnpm --filter custody-api checker

# The rustup toolchain of rust-toolchain.toml must come first: another cargo
# in the PATH (for example Homebrew) has no wasm32v1-none target.
contracts-test: ## Rust tests for the Soroban contracts (cargo required)
	PATH="$(HOME)/.cargo/bin:$(PATH)" cargo test --workspace

contracts-build: ## Wasm build of the contracts (stellar-cli required)
	PATH="$(HOME)/.cargo/bin:$(PATH)" stellar contract build

contracts-vectors: ## Write the test vectors of the rank engine again
	PATH="$(HOME)/.cargo/bin:$(PATH)" cargo test -p abs-deal vectors_write -- --ignored
