# KrushiSeva ERP — Project Status & Build Log

> **Purpose of this document:** a complete, narrative record of what's been built, the decisions made along the way (including the ones not explicit in BLUEPRINT.md/TECHNICAL_DESIGN.md/PROJECT_ROADMAP.md and had to be resolved during implementation), the real bugs found and fixed, and the current state of the dev environment.
>
> **⚠️ Verification note:** this document was compiled from a chat conversation's record of the build process, not from direct inspection of the repository. Before treating anything here as authoritative, verify factual claims (file paths, exact table/column names, test counts, migration filenames) against the actual repo. Where this document and the actual code disagree, the code and the three locked docs (BLUEPRINT.md, TECHNICAL_DESIGN.md, PROJECT_ROADMAP.md) win.

---

## 1. Where the project stands

**Phase 0 (Foundation) and Phase 1 (Masters) are complete.** Every master entity in the data model has a full, tested, working CRUD API: Parties, Products, Branches, Categories, Units, and Users. Full custom authentication (login, refresh with rotation, change-password, logout) and the middleware stack (authenticate → authorize, plus branch-context where applicable) are built and battle-tested across all six modules. The audit-logging system and the idempotency-key mechanism are wired into every write path.

> **Correction:** `branch-context` does **not** run on all six modules — it's deliberately absent from Branches and Users routes (`src/modules/branches/branch.routes.ts`, `src/modules/users/user.routes.ts`), by design: Branches is "the root of multi-branch config" with no acting branch to resolve yet, and Users' `user:manage` capability is super-admin-only end to end with no branch scoping. It runs on Parties, Products, Categories, and Units only (4 of 6 modules). The original wording implied it was universal; it isn't.

This corresponds to `PROJECT_ROADMAP.md` §4, all steps (1 through 8), fully done. The repo should carry a git tag `phase0-1-complete` marking this boundary.

**What is NOT yet started:** TDD Iteration 3 (Transactions) — the actual `sales`, `purchases`, `ledger_postings`, `stock_movements` schema and the atomic Sale/Purchase services. Per the project's own "design-then-build" methodology, this must be designed and locked as TDD text *before* any code is written for it — that design work is the planned next step, separate from this build log.

---

## 2. Stack & foundational setup

- **Language/runtime:** Node.js 22 LTS, TypeScript (strict mode + `noUncheckedIndexedAccess` + `noImplicitOverride`, deliberately without `exactOptionalPropertyTypes`).
- **API framework:** Express 5 (chosen specifically for native async-error propagation to the central error handler, avoiding `express-async-handler` boilerplate).
- **Database:** PostgreSQL via Supabase, used purely as managed Postgres (no Supabase Auth, no client-side Data API — deliberately disabled at project creation). Dev project: `krushiseva-erp-dev`, Mumbai region (`ap-south-1`).
- **ORM:** Prisma + Prisma Migrate, with the pooled/direct URL split (`DATABASE_URL` for app runtime via PgBouncer, `DIRECT_URL` for migrations).
- **Validation:** Zod, with a custom shared boundary helper (see §5, bug #1).
- **Testing:** Vitest — deliberately configured to run against the **real dev database**, no mocks, per TDD §22.1's requirement that transaction/locking logic be tested against reality.
- **Package manager:** npm.
- **Repo:** private GitHub repo, owned by the developer's personal account (not the client's), with a documented rationale around daily-driver access vs. eventual handover planning.
- **Branching strategy:** solo dev, `main`-only, no feature-branch ceremony; milestone tags used instead (e.g. `phase0-1-complete`).

---

## 3. Schema — Phase 0 + Phase 1 (15 models)

Migrated and verified live against the dev database.

**Phase 0:** `users`, `branches`, `user_branches`, `audit_logs`, `number_series`, `company_profile`.
**Phase 1:** `account_groups`, `ledgers`, `units`, `categories`, `products`, `branch_stock`, `parties`.
**Iteration 2 additions:** `refresh_tokens`, `idempotency_keys`.

> **Correction:** there are only **two** migrations in `prisma/migrations/`, not one per phase grouping above:
> - `20260721174206_init` — creates **all 15 models** in one migration, including `refresh_tokens` and `idempotency_keys` (the "Iteration 2 additions" were part of the initial migration, not added later), plus all 5 partial unique indexes, all 8 CHECK constraints, and the `company_profile` singleton index.
> - `20260730170318_add_refresh_token_rotation` — the only actual follow-up migration; it adds a single column (`refresh_tokens.rotated_from_id`), its index, and its self-referencing FK. This is the piece that was genuinely added in Iteration 2, not the `refresh_tokens`/`idempotency_keys` tables themselves.

### Things Prisma's schema language can't express, added as raw SQL in the migration:
- **5 partial unique indexes** (soft-delete-safe uniqueness, TDD §3.9): `users.username`, `users.email`, `branches.code`, `products.sku`, and `number_series (branch_id, voucher_type, financial_year)` — all `WHERE deleted_at IS NULL`, so a soft-deleted row never blocks recreating the same value.
- **8 CHECK constraints**: `branch_stock.quantity >= 0` (defense-in-depth behind the service-layer negative-stock block), plus enum-style checks on `users.role`, `account_groups.nature`, `categories.default_tax_classification`, `products.tax_classification`, `parties.type`, `company_profile.rounding_mode`, `idempotency_keys.status`.
- **1 singleton expression index** on `company_profile`, enforcing exactly one row can ever exist.

### A deliberate deviation from the doc's literal wording, since corrected in TDD §3.1:
`created_by`/`updated_by` are plain `uuid` columns with **no DB-level FK constraint** to `users.id` — a real FK would add a back-relation on `users` for every table in the schema for no query benefit, and these are audit breadcrumbs on rows whose referenced user is never hard-deleted. TDD §3.1 was amended to state this explicitly rather than leave the doc describing FKs that don't exist.

---

## 4. Seed data

`prisma/seed.ts` — idempotent (find-or-create pattern per entity), runs inside one transaction (`runTransaction` with an explicit 20s timeout, since it's the heaviest single transaction in the seed/setup path).

Seeds, in dependency order:
1. **12 standard `account_groups`** (TDD §6.1's seed list, `is_system=true`): Customers/Receivables, Suppliers/Payables, Bank Accounts, Cash-in-Hand, Sales Accounts, Purchase Accounts, Direct/Indirect Expenses, Direct/Indirect Income, Duties & Taxes, Capital, Loans, Fixed Assets.
2. **4 default `units`**: Kilogram (kg), Bag, Litre (ltr), Piece (pc) — deliberately seeded as standalone units with no conversion relationship (`base_unit_id`/`conversion_factor` both null), since actual bag weight varies by product at this shop and hardcoding a wrong conversion would silently corrupt future stock math.
3. **`company_profile` singleton row** — business name, `fy_start_month=4`, `rounding_mode='none'`. Fixed constant UUID for idempotent upsert.
4. **First Super Admin user** — Argon2id-hashed password, `must_change_password=true` at seed time (since changed via the real login/change-password flow — see §7).

> **Note (not a confirmed correction):** `prisma/seed.ts` does not hardcode a username — it reads `SEED_SUPER_ADMIN_USERNAME` (and name/password/email) from env vars, failing loudly if unset. `.env.example`'s placeholder is `"superadmin"`, not `"karansuperadmin"`. The real value lives in the developer's actual `.env`, which I did not and will not read (CLAUDE.md secrets policy) — so I can't confirm or deny `karansuperadmin` is actually seeded; I can only confirm the seed script itself doesn't fix that value in code. Same applies to the `karansuperadmin` mention in §9 below.
5. **Round Off** and **Stock Loss/Adjustment** ledgers — both placed under **Direct/Indirect Expenses**, `branch_id=null` (shared). Neither TDD §6.1 nor §18.3 explicitly specified this placement; it was resolved deliberately (confirmed with the project owner) rather than guessed. Note for the future Reports iteration: both are conceptually *indirect* line items once the direct/indirect P&L split (currently deferred, TDD §6.1) gets built.

---

## 5. Backend skeleton (TDD Iteration 2, §9–17)

- **Response envelope**: `{ data, meta, error }` throughout, per TDD §3.5.
- **Error hierarchy**: `AppError` base + subclasses, central error handler, stable `code`s clients can branch on.
- **Zod validation boundary** (`src/shared/validate.ts`) at the controller layer.
- **Custom auth** (`src/modules/auth/`): Argon2id password hashing, JWT access tokens, rotating refresh tokens (hashed at rest), full login/refresh/change-password/logout flow.

> **Correction:** access/refresh token lifetimes are **not fixed values in code** — `ACCESS_TOKEN_TTL`/`REFRESH_TOKEN_TTL` are required env vars (`src/config/env.ts`), read fresh at runtime (`src/modules/auth/auth.service.ts`, `src/shared/tokens.ts`). The doc's "15 min / 14 day" are plausible if that's what's actually set in `.env`, but `.env.example` (the only version visible to me — real `.env` is off-limits per CLAUDE.md) shows `ACCESS_TOKEN_TTL="15m"` and `REFRESH_TOKEN_TTL="7d"`, not 14 day. Worth double-checking your actual `.env` rather than trusting either number blindly. The 30-second refresh grace window and the idempotency thresholds, by contrast, *are* fixed in code (`src/shared/constants.ts`, not env-configurable) — those numbers in this doc are accurate.
- **Middleware stack**, in order: `authenticate` (verifies JWT, re-fetches user row for `is_active` check) → `authorize` (capability map, TDD §12.2) → `branch-context` (resolves and validates acting branch, TDD §12.3).
- **Audit helper** (`src/shared/audit.ts`): `writeAudit` + `leanDiff`, called inside the same DB transaction as every state-changing action, changed-fields-only diffing on edits.
- **Idempotency mechanism** (`src/shared/idempotency.ts`): `idempotency_keys` table, insert-as-`in_progress` → replay-or-process pattern per TDD §14.2, completion happens inside the same transaction as the business write (never after).
- **Capability map** (`src/middleware/authorize.ts`): centralizes all RBAC rules. Reviewed against Blueprint §4's role matrix; one item left deliberately open (`purchase:create` for the Employee role — Blueprint and TDD conflict on this, left restrictive pending an actual conversation with the business, not resolved by inference).

### Refresh-token rotation — a real design gap found and resolved
TDD §11.4's original wording ("returning the same new pair") described behavior that turned out to be **impossible to build** given the "never store raw tokens" rule (the raw new token only ever exists in the first HTTP response; there's nothing server-side to replay). Resolved by:
- Adding `refresh_tokens.rotated_from_id` (nullable, self-referencing FK, many-to-one, `ON DELETE SET NULL`) to track rotation lineage.
- Reinterpreting the 30-second grace window: a concurrent presenter of an already-revoked-but-recently-rotated token gets **their own independent valid pair** (not literal replay), and the sibling pair isn't punished. Both callers end up valid.
- Reuse **≥30 seconds** after revocation → theft detection → revoke **every** refresh token for that user (full-account blast radius, not scoped to one lineage).
- TDD §11.3–11.4 updated with the corrected wording and the reasoning for the reinterpretation, so the doc no longer describes an unbuildable behavior.

---

## 6. Module-by-module build log

### 6.1 Parties (first vertical slice — proved the whole architecture)
Full CRUD. **Atomic** ledger + party creation in one transaction (TDD §6.7) — creating a party first creates its ledger, then the party pointing at it; both commit together or neither does. Rollback verified by deliberately breaking the ledger step and confirming zero orphaned rows.

**Undocumented decision resolved:** party ledgers are **branch-scoped** (`ledgers.branch_id = party.owning_branch_id`), following the Cash/Bank pattern rather than the shared Sales/GST pattern. TDD §6.2 gave examples of both patterns but never explicitly assigned party ledgers to either; resolved based on the conceptual distinction (a party ledger is a distinct per-relationship account, not a company-wide aggregate like Sales/GST) — should be confirmed as documented back into TDD §6.2/§6.7.

**"Both"-type parties** default to the Customers/Receivables ledger group (per TDD §17.1's carried-forward note).

`opening_balance` is written exactly once, at creation, only to `ledgers.opening_balance` — never duplicated onto the `parties` row.

Deactivation uses `is_active=false`; `deleted_at` stays null (deliberately — deactivation is a routine business event, not a "this row shouldn't exist" correction).

### 6.2 Products
Full CRUD. Shared catalog — **not** branch-scoped (unlike Parties), matching Blueprint §5.7's "one shared products catalog."

**Two scope decisions resolved:**
- `gst_rate`/`tax_classification` must be **explicit** on every create/update request — no silent fallback to `categories.default_gst_rate`/`default_tax_classification`. TDD §6.4 states those category fields are "pre-fill only... never the source of truth," read as a client/UI-layer concern, not a service default.
- `branch_stock` is **untouched** by product creation — a new product starts with zero stock rows anywhere; population happens later via import or stock-adjustment flows. Grounded in TDD §6.6's closed list of what's allowed to mutate `branch_stock` (sale/purchase/adjustment/transfer — product creation isn't on that list).

### 6.3 Branches
Full CRUD. `branch:manage` capability (super_admin-only) wired to actually gate the write routes (previously defined in the capability map but unused). Non-super-admin branch listing built fresh via `user_branches` (no prior query existed for "branches this user can see").

### 6.4 Categories & Units
Full CRUD each, including the **first API-triggered use of `deleted_at`** in the whole project (every prior module only ever used it as a read filter).

**Cycle prevention built deliberately** for both self-referencing hierarchies (`categories.parent_id`, `units.base_unit_id`) via a shared `assertNoCycle` helper — decided as "build now" rather than "defer," since a cycle in either would be cheap to prevent but expensive to repair after other rows reference the corrupted tree (and for units specifically, a cycle would corrupt real quantity/conversion math, not just tree display).

**Delete-guard logic**, tightened during review: blocks deletion if **any** referencing row exists — active or deactivated — not just active ones. (A narrower "active-only" guard would let a category/unit be deleted while a *deactivated* product still held a real FK to it, which would then point at an invisible row if that product were ever reactivated.)

### 6.5 Users — most security-sensitive module, built last and most carefully
Full CRUD, but explicitly **not** generic CRUD (TDD §7.1/§7.3):
- Only Super Admin can create users (enforced via the `user:manage` capability).
- User creation is **atomic**: the `users` row and its `user_branches` assignment rows are created in one transaction (mirrors the Parties atomicity pattern).
- Password hashing extracted to a shared `src/shared/password.ts` helper, used by both the auth module and the users module (rather than either duplicating Argon2id logic or violating the service-to-service layering rule).
- Token revocation extracted to a shared helper in `src/shared/tokens.ts`, called on both deactivation and role change.
- **Username is immutable** post-creation (not present in the update schema at all — an explicit omission, not a silently-ignored field).
- `branchIds` validation: required (non-empty) for non-super-admin roles, and **explicitly rejected** (not silently stripped) if provided for a super_admin role, since Super Admin bypasses `user_branches` entirely.
- **`revokeAllRefreshTokens` fires on `is_active` true→false AND on any role change** (not on branch-only reassignment). Reasoning: role is baked into the stateless JWT the same way active-status effectively is (both only get re-validated on next-token-mint or the 15-minute expiry), so leaving role-downgrades "softer" than deactivation would be an inconsistency. Branch changes don't need this, since `branch-context` middleware checks `user_branches` fresh from the DB on every request — no staleness there.
- Update uses a **single general PATCH** endpoint (not a separate `/deactivate` route like Parties/Products) — a deliberate, named deviation from the established pattern, since Users' editable surface (role, branches, active status) is inherently a bundle of related fields.

**A real bug found only by live/manual testing, not the automated suite:** `updateUserSchema`'s Zod validation unconditionally required `branchIds` whenever `role` was set to non-super-admin — even when `branchIds` was simply omitted (meaning "leave as-is"). This made the correctly-implemented service logic ("role change falls back to existing branch rows") **completely unreachable via any real HTTP request**, even though 13 service-layer tests passed — because those tests call the service directly, bypassing the validation layer entirely. Found via the manual smoke test, fixed, regression tests added. This is the strongest argument in the whole build for why live/manual testing remains necessary even with a fully green automated suite.

**Opportunistic fix, in scope by direct consequence of this module's work:** `src/middleware/authenticate.ts` was re-fetching the user's DB row on every request (for the `is_active` check) but discarding its `role` field in favor of the stale JWT claim — meaning a role change previously took up to 15 minutes to take effect (the token's natural expiry), identical to the deactivation staleness window. Fixed to read `role` from the fresh DB row; a role change now takes effect on the very next request. New regression test proves this.

---

## 7. Real bugs found and root-caused (not just patched)

1. **Zod `.default()` + TypeScript inference bug** — `ZodType<T>` shorthand gave TypeScript two places to infer the generic parameter (the schema's `Output` and `Input` types, which diverge whenever `.default()` is used), and TypeScript silently resolved to the wrong one — making fields with defaults appear optional in the inferred type even after validation. Fixed once, at the shared `parseWithSchema` boundary (`ZodType<Output, Def, any>`), not per-schema — every future module using `.default()` inherits the fix automatically. Verified via grep that no `any` leaks into any consuming module.

2. **Prisma `Decimal` serialization** — `Prisma.Decimal` has its own `toJSON()` that runs before custom `JSON.stringify` replacers ever see the value, returning a string (`"18.00"`) instead of a number. First surfaced by Products (`gst_rate`), since no earlier module had a Decimal field in a response payload. Fixed generally in `src/shared/serialize.ts` — a type-based (`instanceof Prisma.Decimal`) pre-pass, not field-specific, verified with a control test (a field named `someRandomDecimalField` correctly converted; a genuine string `"18.00"` correctly left untouched). Documented as a **permanent API contract note** in TDD §22.2: Decimal fields serialize as plain numbers with trailing zeros stripped (`18.00` → `18`); the frontend must format for display, never assume pre-formatted precision.

3. **Prisma's 5-second default `$transaction` timeout**, hit repeatedly (seed script, auth grace-window tests, Parties, Users) against the Mumbai-hosted dev DB from a Nepal-based dev machine — real network latency across ~10-20 sequential round-trips per transaction, not a logic bug. Fixed centrally with a shared `runTransaction` wrapper (`src/db/client.ts`) carrying generous default timeouts (raised over the course of the project as heavier transactions were added), with call-sites able to override explicitly when they need more (e.g. the seed script's 20s). A standing note was added to `CLAUDE.md`: this project talks to a remote DB with real latency baked into its geography — default to generous timeouts on any new test/transaction rather than re-discovering this each time.

4. **A second-order bug the timeout fix surfaced**: raising the transaction timeout meant transactions held DB connections open longer, which caused genuine contention when Vitest ran test files in parallel (fine at 5s, since failures were fast; a real problem at 15-20s). Fixed with `fileParallelism: false` in `vitest.config.ts` — tests run one file at a time, since they share one real, rate-limited external database connection pool, not mocks.

5. **Audit-log symmetry bug in Users' update path** — `serializedBefore` never included `branchIds` while `serializedAfter` always did, meaning the lean-diff audit logic would show `branchIds` as "changed" on every single update, even when untouched. Found while investigating an unrelated timeout, fixed alongside it.

---

## 8. Standing rules and process notes (live in `CLAUDE.md`)

- Any **DELETE** against a real database (dev or prod) requires proposing it and getting explicit approval **before** running — not reporting after the fact. (Established after an earlier session did dev-DB cleanup and reported it after, rather than asking first — low-stakes that time, made into a standing rule going forward.)
- `.env` is never read, written, printed, or committed by Claude Code — secrets are handled exclusively by the developer, in the developer's own shell.
- `CLAUDE.md` itself is **deliberately gitignored** — solo developer, single machine, a conscious choice (not an oversight; a note exists specifically so future sessions don't "fix" this).
- This project talks to a remote database (Mumbai) from a dev machine with real network latency (Nepal) — default to generous timeouts on new tests/transactions.
- A real plaintext password was once caught in a Claude Code context window (correctly refused/untouched per the secrets policy) — the password was rotated as a precaution.

---

## 9. Current dev environment state

- **Supabase project:** `krushiseva-erp-dev`, Mumbai (`ap-south-1`), Data API disabled, RLS enabled (harmless defense-in-depth, irrelevant to normal operation since the API connects as the DB owner via Prisma).
- **Permanent fixtures** (not test-created, not swept by any test cleanup):
  - Branch **"Main Branch"** (code `MAIN`, state code `24`) — created manually since no Branch CRUD endpoint existed yet at the time it was needed.
  - Super Admin **`karansuperadmin`** — real password (rotated at least once after an accidental exposure), `must_change_password=false`.
- **Test/smoke fixtures**: created and cleaned up per-session; the project has a consistent practice of verifying cleanup with a follow-up count query rather than trusting the delete succeeded.

---

## 10. What's next

**TDD Iteration 3 — Transactions** is the next major body of work: the `sales`/`purchases`/`ledger_postings`/`stock_movements` schema, the atomic Sale and Purchase services (row-locking, GST calculation, invoice numbering, ledger posting, stock movement), the bill edit/cancel workflow, hold/park-a-bill, last-price/last-cost recall, and the printable-invoice payload.

Per the project's own methodology (`PROJECT_ROADMAP.md` §2), this must be **designed and locked as TDD text first**, in a dedicated design conversation — not started as a Claude Code build handoff. That design work is intentionally out of scope for this document and is being handled separately.
