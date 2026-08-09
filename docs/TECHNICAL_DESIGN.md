# Fertilizer Shop Management System — Technical Design Document (TDD)

> The engineering companion to the Blueprint. This is the document you (solo dev) open every day to know *how* to build each thing. The Blueprint says *what* and *why*; this says *how*, in build order.

**Status:** Living document, built iteration by iteration.
**Companion to:** `BLUEPRINT.md` (revision 4).

---

## 0. How to read this document & the iteration plan

This doc grows in the same order you'll build. Each iteration is reviewed and locked before the next begins. We do **not** run ahead of what's been reviewed.

| Iteration | Covers | Status |
|---|---|---|
| **1** | Locked stack, repo structure, core conventions, **Phase 0 + Phase 1 data model & schema** (auth, branches, masters) | ✅ locked |
| **2** | Backend architecture: layered pattern, custom auth, auth/permission/branch middleware, audit logging, idempotency, validation, error handling | ✅ locked |
| **DC** | **Data-contract addendum (§18–22):** ledger posting sign convention + posting map, weighted-average costing + cost on stock movements, edit-vs-day-close rule, voucher_date/day boundaries, testing strategy | ✅ locked — binds Iterations 3+ |
| 3 | Transactions: sales/purchases schema + line items, ledger_postings, stock_movements, the atomic Sale/Purchase services, bill edit/cancel, hold/park, last-price recall, printable-invoice payload | ✅ locked |
| 4 | Payments, ledgers, outstanding, cash reconciliation | ✅ locked |
| 5 | Returns, adjustments, contra, journal | planned |
| 6 | Reports & GST exports | planned |
| 7 | Multi-branch consolidation, deployment, Docker, backups | planned |

Whenever a decision now would save a painful migration later, it's called out as a **⚠️ Now-vs-later** note.

---

## 1. Locked Technology Stack

| Layer | Choice | Notes |
|---|---|---|
| Language | **TypeScript** | Strict mode on. Worth it on a solo project of this size. |
| API runtime | **Node.js + Express** | All business logic lives here. |
| Database | **PostgreSQL via Supabase** | Used purely as managed Postgres (+ Storage later). Not used for auth. |
| ORM / migrations | **Prisma + Prisma Migrate** | Type-safe client, mature migrations (mandatory, version-controlled). Needs Supabase pooled + direct URLs (see §1.2). |
| Auth (authentication) | **Custom, in our API** | Admin-provisioned users, password hashing, JWT (access + refresh). No Supabase Auth, no self-signup. |
| Authorization | **Custom, in our API** | 4 global roles + branch access list. |
| File storage | **Supabase Storage** | For invoice PDFs later (optional; the only Supabase feature beyond Postgres we may use). |
| IDs | **UUID v4** (`gen_random_uuid()`) | Friendly to web+mobile and idempotency. |
| Money | **Integer paise, stored as `bigint`** | Never floats. ₹1 = 100 paise. Format to rupees only at display. |
| Quantity | **`numeric(12,3)`** | Supports fractional units (loose kg). |
| Containerization | **None yet** | Develop against a cloud Supabase project. Docker added at deployment. |
| Web client | React | Talks only to our API. |
| Mobile client | *Deferred* | Framework chosen later; does not affect the API. |

### 1.1 How Supabase is used (read this once, internalize it)

Supabase is **just our managed Postgres** (and, later, optional file storage). All identity, authentication, authorization, roles, and branches live in our own backend and our own tables.

```
   Web / Mobile
       │   (only ever talk to OUR API)
       ▼
  Express API   ← authentication (login, password, JWT) AND
  (all logic)     authorization (roles + branches) both here
       │
       ▼
  Supabase Postgres   (our schema, accessed via Prisma, server-side only)
```

- Clients **never** query the Supabase database directly. No client-side `supabase-js` data calls, no PostgREST for business data. The only thing that touches the database is our API, via Prisma.
- **We do our own auth.** Users are created by a Super Admin (no self-signup). We store the password hash, verify credentials on login, and issue our own JWTs (access + refresh). Full design in §7.
- Because we don't use Supabase Auth or PostgREST, we don't need the Supabase anon/service keys for normal operation — Prisma connects with the Postgres connection string. (Supabase Storage, if/when used for invoice PDFs, is the only thing that would need a Supabase key.)

⚠️ **Now-vs-later:** never leak the database connection string or JWT signing secrets to any client. They live only in the API's server environment.

### 1.2 Prisma + Supabase connection setup (the one gotcha)

Supabase exposes **two** connection strings, and Prisma needs both. This is the single thing that trips people up; set it once and forget it.

| Use | Connection | Prisma field | Env var |
|---|---|---|---|
| **App runtime** | Pooled (Supavisor/PgBouncer, port `6543`), append `?pgbouncer=true` | `url` | `DATABASE_URL` |
| **Migrations** | Direct (port `5432`) — migrations can't run through the pooler | `directUrl` | `DIRECT_URL` |

```prisma
datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")   // pooled, ?pgbouncer=true — used by the app
  directUrl = env("DIRECT_URL")     // direct 5432 — used by prisma migrate
}
```

Rule of thumb: **the app uses the pooled URL, migrations use the direct URL.** Both URLs come from the Supabase dashboard (Project → Database → Connection string). Get this right and migrations + runtime both just work.

⚠️ **Now-vs-later:** set both URLs from day one. Running migrations against the pooled URL fails confusingly; wiring `directUrl` now avoids that entirely.

---

## 2. Repository & Project Structure

Three repos (per Blueprint §3.2). This iteration only details the API.

```
api-backend/
├── src/
│   ├── config/          # env loading, constants
│   ├── db/
│   │   └── client.ts            # Prisma client singleton
│   ├── modules/          # feature modules (vertical slices)
│   │   ├── auth/
│   │   ├── branches/
│   │   ├── users/
│   │   ├── products/
│   │   ├── parties/
│   │   └── ...            # sales, purchases... added in later iterations
│   ├── middleware/       # auth, branch-context, error handler, audit
│   ├── shared/           # types, response envelope, errors, utils (money, dates)
│   ├── app.ts            # express app wiring
│   └── server.ts         # entry point
├── prisma/
│   ├── schema.prisma     # Prisma schema (models = tables) — single location
│   └── migrations/        # Prisma Migrate SQL migrations (committed)
├── .env                  # NEVER committed
├── .env.example          # committed
└── package.json
```

**Module shape (vertical slices).** Each feature folder holds its own `routes`, `controller`, `service`, and `validation`. Business logic lives in **services**; controllers only translate HTTP ↔ service calls. (Full layering rules in Iteration 2.)

⚠️ **Now-vs-later:** keep all SQL/data access inside services (or a thin repository layer they call). Never let a controller touch the database directly — it makes transactions and testing painful later.

---

## 3. Core Conventions (apply everywhere, from the first table)

### 3.1 Common columns on every table
Every table carries these, applied uniformly:

| Column | Type | Purpose |
|---|---|---|
| `id` | `uuid` PK, default `gen_random_uuid()` | Primary key. |
| `created_at` | `timestamptz` not null default `now()` | Creation time. |
| `updated_at` | `timestamptz` not null default `now()` | Updated by app/trigger on change. |
| `deleted_at` | `timestamptz` nullable | **Soft delete.** Non-null = deleted. Never hard-delete business data. |
| `created_by` | `uuid` nullable | Who created it (audit). References `users.id` by convention — **no DB-level FK constraint** (see note). |
| `updated_by` | `uuid` nullable | Who last changed it. Same convention, no FK constraint. |

- **`created_by` / `updated_by` are plain `uuid` columns, not foreign keys.** They hold a `users.id` value by convention but carry no FK constraint: declaring real FKs would add a back-relation on `users` for every table in the schema for no query benefit, and these are audit breadcrumbs on rows whose referenced user is never hard-deleted. Referential integrity here is a convention enforced by the service layer, not the database.

- **Soft delete rule:** all reads filter `deleted_at IS NULL` by default. Deleting sets the timestamp.
- For tables below, these common columns are implied and not repeated; only domain columns are listed.

### 3.2 Money
- Stored as **`bigint` paise**. `₹1,250.50` → `125050`.
- All arithmetic in integer paise in the API. Convert to rupees **only** at the display/print boundary.
- Never use `float`/`double` for money, ever.
- **JSON serialization (locked):** Prisma returns `bigint` columns as JS `BigInt`, which `JSON.stringify` throws on. Convention: **serialize paise as a JSON `number`** at the envelope boundary (a shared serializer converts `BigInt → Number`). Safe: `Number.MAX_SAFE_INTEGER` ≈ 9.0×10¹⁵ paise ≈ ₹90 trillion — far beyond shop money. Inputs are validated as integers (§10).

### 3.3 Quantity
- `numeric(12,3)` — supports fractional units (e.g. 12.500 kg). Avoids float drift.

### 3.4 Identifiers & references
- UUID PKs everywhere. Foreign keys named `<entity>_id`.
- All FKs indexed.

### 3.5 API response envelope
Every endpoint returns the same shape so web + mobile parse identically:
```ts
// success
{ "data": <payload>, "meta": { ...pagination etc } | null, "error": null }
// failure
{ "data": null, "meta": null, "error": { "code": "STRING_CODE", "message": "human readable", "details"?: any } }
```

### 3.6 List endpoint conventions
Every list endpoint supports: `branch_id` (where applicable, server-validated), `page` + `limit` (pagination), `search`, and date range filters where relevant.

### 3.7 Naming
- Tables & columns: `snake_case`, tables plural (`products`, `branch_stock`).
- API routes: `/api/v1/<plural-resource>`.
- TypeScript: `camelCase` vars, `PascalCase` types. In Prisma, model fields are `camelCase` and mapped to `snake_case` columns via `@map`/`@@map` (keeps DB tidy and TS idiomatic).

### 3.8 State codes
- GST state codes are the 2-digit numeric codes (e.g. `09` for UP, `24` for Gujarat). Stored as `text` (preserve leading zero), validated against a known list. Used for intra- vs inter-state tax (Blueprint §6.1).

### 3.9 Uniqueness with soft-delete (important)
Because we soft-delete (rows stay with `deleted_at` set), a plain `UNIQUE` constraint would block reusing a value from a deleted row (e.g. recreating a user `ramesh` after the old one was removed). So every "unique" business column uses a **partial unique index** instead:

```sql
CREATE UNIQUE INDEX ux_users_username_active
  ON users (username) WHERE deleted_at IS NULL;
```

Apply this pattern to: `users.username`, `users.email`, `branches.code`, `products.sku` — and any future "unique" field. (In Prisma this is a partial unique index defined in the schema.)

### 3.10 Indexes
Beyond the partial-unique indexes above and all FKs (§3.4), add search/lookup indexes where the UI filters:
- `parties (name, village)` — the primary customer lookup at the counter.
- `products (name)` and `products (hsn_code)` — product search.
- `audit_logs (entity_type, entity_id)` and `(branch_id, created_at)` — trail lookups.
- Transaction-table indexes are defined in Iteration 3 (e.g. the last-price-recall composite from Blueprint §6.14).

### 3.11 GST & money rounding (locked rule)
Applies to every invoice/bill so totals always reconcile with GST returns:
1. **Per line:** compute taxable value, then tax. **Round each line's tax to the paise** (2 decimals). For inclusive-priced lines, back-calculate taxable = rate ÷ (1 + gst_rate), then tax = rate − taxable, rounded to paise.
2. **Split:** CGST and SGST are each **half of the rounded line tax** (intra-state); IGST is the full line tax (inter-state).
3. **Invoice totals:** sum the rounded line values — never re-round the total from raw figures (that's what causes invoice-vs-return mismatches).
4. **Round-off (optional, per `company_profile.rounding_mode`):** if enabled, round the invoice grand total to the nearest rupee and post the difference (a few paise) to a dedicated **Round Off** ledger, so the books stay balanced to the paise.
- All intermediate math stays in integer paise; rounding means rounding to whole paise, never to a float.

---

## 4. Data Model Overview

Phase 0 (foundation) + Phase 1 (masters) entities and how they relate:

```mermaid
erDiagram
    branches ||--o{ user_branches : "accessible by"
    users ||--o{ user_branches : "can access"
    users ||--o{ audit_logs : "acts"
    branches ||--o{ audit_logs : "in"
    branches ||--o{ number_series : "has"
    branches ||--o{ branch_stock : "holds"
    products ||--o{ branch_stock : "stocked as"
    account_groups ||--o{ account_groups : "parent of"
    account_groups ||--o{ ledgers : "groups"
    branches ||--o{ ledgers : "(branch-scoped ledgers)"
    parties ||--|| ledgers : "has one"
    units ||--o{ products : "measured in"
    categories ||--o{ products : "categorizes"
    categories ||--o{ categories : "parent of"
    branches ||--o{ parties : "owns relationship"

    branches {
        uuid id PK
        text name
        text code
        text gstin
        text state_code
        text address
        text phone
        boolean is_active
    }
    users {
        uuid id PK
        text username "unique login id"
        text password_hash
        text name
        text role "super_admin|admin|employee|accountant"
        boolean is_active
    }
    user_branches {
        uuid user_id PK,FK
        uuid branch_id PK,FK
    }
    audit_logs {
        uuid id PK
        uuid user_id FK
        uuid branch_id FK
        text action
        text entity_type
        uuid entity_id
        jsonb before
        jsonb after
        timestamptz created_at
    }
    number_series {
        uuid id PK
        uuid branch_id FK
        text voucher_type
        text financial_year
        text prefix
        integer current_number
    }
    account_groups {
        uuid id PK
        text name
        text tally_equivalent
        text nature
        uuid parent_group_id FK
        boolean is_system
    }
    ledgers {
        uuid id PK
        uuid account_group_id FK
        uuid branch_id FK "nullable = shared"
        text name
        bigint opening_balance
    }
    units {
        uuid id PK
        text name
        text symbol
        uuid base_unit_id FK "nullable"
        numeric conversion_factor
    }
    categories {
        uuid id PK
        text name
        uuid parent_id FK "nullable"
    }
    products {
        uuid id PK
        text name
        text hsn_code
        text sku
        uuid category_id FK
        uuid unit_id FK
        numeric gst_rate
        boolean price_includes_gst
        text tax_classification
        bigint purchase_price
        bigint sale_price
        bigint mrp "nullable"
        boolean is_active
    }
    branch_stock {
        uuid branch_id PK,FK
        uuid product_id PK,FK
        numeric quantity
        numeric low_stock_threshold
    }
    parties {
        uuid id PK
        text type "customer|supplier|both"
        text name
        text village
        text mobile "nullable"
        text email "nullable"
        text gstin "nullable"
        text state_code
        text address "nullable"
        uuid ledger_id FK
        uuid owning_branch_id FK
        boolean is_active
    }
    company_profile {
        uuid id PK
        text business_name
        text legal_name
        text logo_url "nullable"
        text invoice_terms "nullable"
        text invoice_footer "nullable"
        text rounding_mode
        integer fy_start_month
    }
```

---

## 5. Schema — Phase 0 (Foundation)

### 5.1 `users`
The application user — an internal staff account, **created by a Super Admin** (no self-signup). Holds both identity and credentials, since we do our own authentication.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | uuid | PK, default `gen_random_uuid()` | Our own id. |
| `username` | text | not null, unique | The "user id" used to log in. |
| `password_hash` | text | not null | Argon2id (preferred) or bcrypt hash. **Never** store the plain password. |
| `name` | text | not null | Display name. |
| `role` | text | not null, check in (`super_admin`,`admin`,`employee`,`accountant`) | Global role. See §7.2. |
| `email` | text | nullable, unique (where not null) | Optional, for future password-reset/notifications. |
| `is_active` | boolean | not null default true | Deactivate without deleting (revokes access immediately). |
| `must_change_password` | boolean | not null default true | New users set their own password on first login. |
| `last_login_at` | timestamptz | nullable | For audit/security. |

+ common columns (§3.1).

**Notes**
- Login identity and password live **here**, in our database — there is no external auth provider.
- Passwords are hashed with **Argon2id** (or bcrypt) at creation and on change; we only ever compare hashes.
- Only a Super Admin can create users and set their initial password (§7.3). New users are flagged `must_change_password` so the admin's initial password is replaced on first login.
- Deactivating (`is_active = false`) blocks login immediately; we soft-delete rather than hard-delete for audit history.

⚠️ **Now-vs-later:** `username` is the stable login id. If you later want email-based login too, the optional `email` column is already here — non-breaking.

### 5.2 `branches`
Root of multi-branch (Blueprint §5.1).

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `name` | text | not null | |
| `code` | text | not null, unique | Short code, used in invoice numbering (e.g. `MAIN`, `BR2`). |
| `gstin` | text | nullable | Each branch its own GSTIN. |
| `state_code` | text | not null | 2-digit GST state code; drives intra/inter-state tax. |
| `address` | text | nullable | Printed on invoices. |
| `phone` | text | nullable | |
| `is_active` | boolean | not null default true | |

+ common columns.

### 5.3 `user_branches`
Which branches a user may access. Super admins bypass this (access all).

| Column | Type | Constraints |
|---|---|---|
| `user_id` | uuid | FK → users.id, PK part |
| `branch_id` | uuid | FK → branches.id, PK part |

- Composite PK `(user_id, branch_id)`.
- No common columns needed (pure join); keep `created_at` for traceability.
- **Authorization rule:** a non-super-admin can act only on branches present here. Enforced in middleware (Iteration 2).

### 5.4 `audit_logs` (Blueprint §10.1)
Immutable record of meaningful actions.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | uuid | PK | |
| `user_id` | uuid | FK → users.id, nullable | Who acted (null for system). |
| `branch_id` | uuid | FK → branches.id, nullable | Context branch. |
| `action` | text | not null | e.g. `create`,`update`,`cancel`,`login`. |
| `entity_type` | text | not null | e.g. `product`,`sale`,`party`. |
| `entity_id` | uuid | nullable | Affected row. |
| `before` | jsonb | nullable | Prior values (for edits). |
| `after` | jsonb | nullable | New values. |
| `created_at` | timestamptz | not null default now() | |

- **Append-only.** No `updated_at`/`deleted_at`; never edited or deleted.
- Index on `(entity_type, entity_id)` and `(branch_id, created_at)`.

**Audit-log strategy**
- **One generic table, same database — not one table per entity.** The generic columns (`entity_type`, `entity_id`, `action`, `before`/`after` jsonb) let this single table record an action on *any* entity regardless of its shape. One row = one logged action.
- **What is logged:** all state-changing actions — transaction create/edit/cancel, master create/edit/deactivate, and user/auth events (user created, role/branch changed, deactivated, login, password reset). **Reads/report-views are NOT logged** (no value, huge volume).
- **Written centrally, inside the same DB transaction as the change** — via one shared audit helper called by the service layer, never scattered `insert` statements. So the change and its audit row commit or roll back together; the trail can't drift from reality.
- ⚠️ **Lean rule (drives storage runway):** for an **edit**, store only the **changed fields** in `before`/`after`; for a **create**, store `after` only (no `before`). Never log reads. This is the main lever that stretches the free-tier storage life (§8.1). Full helper/middleware mechanics in Iteration 2.

### 5.5 `number_series` (Blueprint §10.5)
Per-branch, per-voucher-type, per-financial-year sequential numbering. GST requires unbroken series.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | uuid | PK | |
| `branch_id` | uuid | FK → branches.id, not null | |
| `voucher_type` | text | not null | `sale`,`purchase`,`receipt`,`payment`,`credit_note`, etc. |
| `financial_year` | text | not null | e.g. `2025-26`. |
| `prefix` | text | nullable | e.g. `INV/MAIN/2025-26/`. |
| `current_number` | integer | not null default 0 | Last issued number. |

- Unique constraint `(branch_id, voucher_type, financial_year)`.
- **Financial year** is derived from the voucher's business date by a shared helper that reads **`company_profile.fy_start_month`** (default 4 = April, i.e. the Indian FY 1 Apr–31 Mar): a date before the start month belongs to the FY that began the previous year (e.g. 15 Feb 2026 → FY `2025-26`). One source of truth — the helper, driven by the setting; never hardcode the boundary elsewhere, and it's not user-entered.
- **Concurrency — the first-allocation race (LOCKED pattern).** Numbers are allocated inside the voucher's DB transaction with a row lock, but `SELECT ... FOR UPDATE` **alone is not sufficient**: `FOR UPDATE` can only lock a row that already exists, and the very first allocation for a given `(branch_id, voucher_type, financial_year)` combination — a branch's first sale ever, or *any* branch's first sale of a new financial year — hits a row that doesn't exist yet. Two concurrent transactions can both observe "no row" and both attempt to create one. This is not a rare edge case: it recurs at **every branch, every 1 April**, and on day one of any new branch. **Required pattern:** run `INSERT ... ON CONFLICT (branch_id, voucher_type, financial_year) DO NOTHING` unconditionally first — whether or not this is actually the first allocation — followed by `SELECT ... FOR UPDATE`, so a matching row is guaranteed to exist before the lock attempt, with no window where "row doesn't exist" is possible. Every voucher-issuing service that allocates from `number_series` — `confirmSale`/`confirmPurchase` now (§26 step 7 / §27), Iteration 4's receipt/payment service included — must use this exact `INSERT ... ON CONFLICT` + `SELECT ... FOR UPDATE` pattern, not a bare `SELECT ... FOR UPDATE`.

⚠️ **Now-vs-later:** model numbering as its own table now. Deriving invoice numbers by counting rows later is unsafe (gaps/duplicates on cancellation and concurrency).

### 5.6 `company_profile` (business-wide settings)
A **single-row** table holding business-level identity, invoice branding, and global config that isn't per-branch. There's no home for these otherwise, and the printable invoice (Blueprint §9) needs them.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | uuid | PK | Single row (enforced — see note). |
| `business_name` | text | not null | Trade name shown on invoices. |
| `legal_name` | text | nullable | Registered legal entity name. |
| `logo_url` | text | nullable | Reference to logo (Supabase Storage) for invoices. |
| `invoice_terms` | text | nullable | Standard terms printed on invoices. |
| `invoice_footer` | text | nullable | Footer/notes on invoices. |
| `rounding_mode` | text | not null default `none`, check in (`none`,`nearest_rupee`) | Drives the invoice round-off rule (§3.11). |
| `fy_start_month` | integer | not null default 4 | Financial-year start month (4 = April, Indian FY). |

+ common columns.

**Notes**
- **Enforced single row** (e.g. a fixed known id, or a one-row check). It's global config, not a list.
- Per-branch identity (GSTIN, address, phone) stays on `branches` (§5.2); this table is only the business-wide bits above them.
- Room to grow: as more global preferences appear, add columns here rather than scattering constants in code. Keep it structured (not a loose key-value bag) while the settings are known.

⚠️ **Now-vs-later:** give global settings a home now. Hardcoding business name / rounding / FY-start in code and hunting them down later is exactly the pain this avoids.

---

## 6. Schema — Phase 1 (Masters)

### 6.1 `account_groups` (Blueprint §5.3)
Friendly-named accounting groups mapping to Tally groups.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `name` | text | not null | Display name, e.g. `Customers / Receivables`. |
| `tally_equivalent` | text | nullable | e.g. `Sundry Debtors`. For reference/reporting. |
| `nature` | text | not null, check in (`asset`,`liability`,`income`,`expense`,`equity`) | Drives P&L vs Balance Sheet placement. |
| `parent_group_id` | uuid | FK → account_groups.id, nullable | Hierarchy. |
| `is_system` | boolean | not null default false | Pre-seeded groups can't be deleted. |

+ common columns.

**Seed set** (created at setup): Customers/Receivables (Sundry Debtors, asset), Suppliers/Payables (Sundry Creditors, liability), Bank Accounts (asset), Cash-in-Hand (asset), Sales Accounts (income), Purchase Accounts (expense), Direct/Indirect Expenses (expense), Direct/Indirect Income (income), Duties & Taxes (liability), Capital (equity), Loans (liability), Fixed Assets (asset).

> **Deferred:** the `nature` enum (`asset/liability/income/expense/equity`) is intentionally coarse for now. Tally splits income/expense into *direct* vs *indirect* to compute gross-vs-net profit on the P&L. If the P&L needs that split, we'll add a `sub_nature` (or use the group hierarchy via `parent_group_id`) in the Reports iteration — a conscious choice, revisited then, not a blocker now.

### 6.2 `ledgers` (Blueprint §5.4)
Every entity money flows to/from. Sits under a group.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `name` | text | not null | |
| `account_group_id` | uuid | FK → account_groups.id, not null | |
| `branch_id` | uuid | FK → branches.id, **nullable** | Null = shared/global (e.g. Sales, GST). Set = branch-specific (e.g. each branch's Cash). |
| `opening_balance` | bigint | not null default 0 | Paise, signed per the posting contract (**§18.1**: debit balance positive). |

+ common columns.

**Notes**
- **Party ↔ ledger link is one-directional to avoid a circular FK.** The link lives **only** on `parties.ledger_id` (a party has exactly one ledger). The `ledgers` table does **not** carry a `party_id`. To find the party that owns a ledger, query `parties` by `ledger_id` (indexed). This means a ledger can be created first, then the party created referencing it — no chicken-and-egg, no nullable-then-backfill hack.
- Cash and Bank ledgers are branch-scoped (`branch_id` set). Sales, Purchase, GST ledgers are typically shared (`branch_id` null).
- Each customer/supplier auto-gets one ledger. The running balance is **computed from transactions**, not stored as a mutable field — balance = opening_balance + SUM(posting amounts), per the posting contract (**§18.1**). Statement/outstanding features built in Iteration 4.

### 6.3 `units` (Blueprint §5.8)

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `name` | text | not null | e.g. `Kilogram`, `Bag`. |
| `symbol` | text | not null | e.g. `kg`, `bag`. |
| `base_unit_id` | uuid | FK → units.id, nullable | For conversions (e.g. Bag → kg). |
| `conversion_factor` | numeric(12,4) | nullable | e.g. 1 bag = 50.0000 kg. |

+ common columns.

### 6.4 `categories` (Blueprint §5.9)

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `name` | text | not null | e.g. Fertilizer, Pesticide, Seed, Tools. |
| `parent_id` | uuid | FK → categories.id, nullable | Sub-categories. |
| `default_gst_rate` | numeric(5,2) | nullable | **Pre-fill only.** New products in this category default to this rate; always editable per product. |
| `default_tax_classification` | text | nullable, check in (`taxable`,`exempt`,`nil_rated`,`non_gst`) | Pre-fill only, same rule. |

+ common columns.

> **The rate lives on the product; the category only supplies a default.** Exceptions exist inside every category at this shop (chemical pesticide 18% vs neem bio-pesticide 5% in the same "Pesticides" category; branded organic manure 5% vs loose 0% under "Fertilizers"), so category-level rates are a convenience, never the source of truth.

### 6.5 `products` (Blueprint §5.7)

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `name` | text | not null | |
| `hsn_code` | text | nullable | GST HSN. |
| `sku` | text | nullable, unique (where not null) | Internal code. |
| `category_id` | uuid | FK → categories.id, nullable | |
| `unit_id` | uuid | FK → units.id, not null | |
| `gst_rate` | numeric(5,2) | not null default 0 | e.g. 5.00, 18.00. |
| `price_includes_gst` | boolean | not null default false | Default exclusive (Blueprint §5.7/6.1). |
| `tax_classification` | text | not null default `taxable`, check in (`taxable`,`exempt`,`nil_rated`,`non_gst`) | Drives GST reporting. |
| `purchase_price` | bigint | not null default 0 | Paise. |
| `sale_price` | bigint | not null default 0 | Paise. Single price (no price lists). |
| `mrp` | bigint | nullable | Paise. |
| `is_active` | boolean | not null default true | |

+ common columns.

**Notes**
- No batch/expiry (confirmed not needed).
- Low-stock threshold is **per branch**, so it lives in `branch_stock`, not here.

### 6.6 `branch_stock` (Blueprint §5.7 — per-branch stock)
The same product has independent stock per branch.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `branch_id` | uuid | FK → branches.id, PK part | |
| `product_id` | uuid | FK → products.id, PK part | |
| `quantity` | numeric(12,3) | not null default 0, **CHECK (quantity >= 0)** | Current on-hand. Service enforces the block (Blueprint §6.1); the DB CHECK is defense-in-depth that catches any future bug forever. (Prisma can't declare CHECKs — add via raw SQL in the migration.) |
| `avg_cost` | bigint | not null default 0 | **Weighted-average cost per unit (paise)** at this branch — the costing cache (see §19). Updated inside the same transaction as inbound stock movements. |
| `low_stock_threshold` | numeric(12,3) | nullable | Prompted at product/stock add; drives low-stock alert. |

- Composite PK `(branch_id, product_id)`.
- Keep `updated_at` for "last movement" reference.
- **Stock is mutated only inside transaction services** (sale/purchase/adjustment/transfer), never by direct edits. Detailed in Iteration 3.

⚠️ **Now-vs-later:** stock as a per-(branch,product) row is the single source of truth for "on hand." Don't put a `quantity` column on `products` — that breaks the moment you have two branches.

### 6.7 `parties` (Blueprint §5.5 / §5.6)
Unified customer/supplier model with segregated UI (Blueprint §5.5–5.6).

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `type` | text | not null, check in (`customer`,`supplier`,`both`) | Drives which section(s) it appears in. |
| `name` | text | not null | Primary identifier (with village). |
| `village` | text | not null | Primary identifier. |
| `mobile` | text | nullable | Optional. Phone-as-identity deferred. |
| `email` | text | nullable | Optional. |
| `gstin` | text | nullable | For B2B invoices. |
| `state_code` | text | not null | Defaults to owning branch's state; drives inter-state tax. |
| `address` | text | nullable | |
| `ledger_id` | uuid | FK → ledgers.id, not null | Each party has exactly one ledger. |
| `owning_branch_id` | uuid | FK → branches.id, not null | Which branch "owns" the relationship. |
| `is_active` | boolean | not null default true | |

+ common columns.

**Notes**
- **Opening balance is NOT stored here** — it lives on the party's ledger (`ledgers.opening_balance`), the single source of truth for money. The party row is identity; the ledger holds the balance. This avoids two conflicting copies of the same number.
- No credit limit (confirmed not wanted).
- A `both`-type party shows in both Customer and Supplier sections but has one ledger, so its balance nets correctly (Blueprint discussion).
- **Creation order (atomic, in the party service):** create the ledger first (under Customers/Receivables or Suppliers/Payables), then create the party with `ledger_id` pointing to it. Both happen in one transaction. This works cleanly because the link is one-directional (§6.2) — no circular dependency.

---

## 7. Auth & Authorization Design (custom, in our API)

We do **both** authentication and authorization ourselves. No external auth provider.

### 7.1 Authentication (who you are)
- **Provisioning:** only a **Super Admin** creates users — sets `username` + an initial password and assigns role + branches. No public signup endpoint exists.
- **Password storage:** hashed with **Argon2id** (or bcrypt). Plain passwords are never stored or logged.
- **Login:** `POST /api/v1/auth/login` with username + password → verify hash → on success issue a short-lived **access token (JWT)** and a longer-lived **refresh token**. `must_change_password` users are forced to set a new password before normal access.
- **Tokens:** access token carries `{ userId, role }` (signed with our secret); refresh token rotates to get a new access token. Inactive (`is_active = false`) users are rejected at login and token-refresh.
- (Detailed token lifetimes, refresh rotation, and middleware in Iteration 2.)

### 7.2 Authorization (what you can do) — the four roles
Global roles (no per-branch roles). Scope is controlled by the `user_branches` access list.

| Role | Branch scope | What they can do |
|---|---|---|
| **Super Admin** | All branches | Everything: creates/manages all users (sets ids & passwords), assigns branches, all operations, edit/cancel, consolidated cross-branch views, audit log. |
| **Admin** | Assigned branch(es) | Full operations within their branch(es): billing, purchases, receipts/payments, expenses, **bill edit/cancel**, stock adjustment, cash-close resolution. Cannot manage users. |
| **Employee** | Assigned branch(es) | Day-to-day operations: billing, receipts/payments, expenses, enters cash count. **Cannot** edit/cancel confirmed bills (must escalate) or do stock adjustments. |
| **Accountant** | Assigned branch(es) | **Read-only, reports only.** Sees branch-wise reports and financial/ledger views for assigned branches. No transaction creation, no edits, no operations. |

**Authorization rules:**
- **Super Admin** bypasses the branch list (implicit access to all branches).
- **Admin / Employee / Accountant** can act only on branches present in their `user_branches` rows (assigned by the Super Admin).
- Every request resolves an **acting branch** (from `branch_id` param/header); middleware checks the user's role permits the action *and* the user may access that branch.
- (Per-action enforcement and the permission middleware are detailed in Iteration 2.)

### 7.3 User provisioning flow (Super Admin only)
1. Super Admin calls `POST /api/v1/users` with username, name, role, initial password, and (for non-super-admin roles) the list of assigned branch ids.
2. API hashes the password, creates the `users` row (`must_change_password = true`), and inserts `user_branches` rows.
3. On first login the user is required to set their own password.
4. Super Admin can deactivate (`is_active = false`), reset a password, or change role/branch assignments later. All such actions are audit-logged.

**Password reset model:** admin-reset for now — the Super Admin sets a temporary password and the user changes it on next login (`must_change_password = true`). No email infrastructure required. **Email-based self-service reset is a planned future option** (the optional `email` column already supports it); deferred, not built now.

⚠️ **Now-vs-later:** roles are **global + branch access list**. If a user ever needs a different role per branch, that's a future change (add a `role` column to `user_branches`). Not built now.

### 7.4 Environment secrets (API server only)
`.env` (never committed) holds: **`DATABASE_URL`** (pooled, `?pgbouncer=true`, for the app), **`DIRECT_URL`** (direct 5432, for Prisma migrations), **`JWT_ACCESS_SECRET`** and **`JWT_REFRESH_SECRET`** (for signing our own tokens), and token lifetimes. *(Supabase Storage keys are added only if/when we use Storage for invoice PDFs — not needed for the database.)* `.env.example` documents the keys without values.

---

## 8. What Iteration 1 Locks, and What's Next

**Locked this iteration:** stack (Supabase as managed Postgres only, **Prisma** ORM, **custom auth** in our API), repo structure, conventions (money/qty/ids/soft-delete/envelope), the Phase 0 + Phase 1 schema, the **four-role model** (Super Admin / Admin / Employee / Accountant) with a branch access list, and admin-provisioned users (no self-signup).

### 8.1 Hosting & backups (decided)
- **Host:** Supabase. **Free tier** for development and early production; upgrade to **Pro ($25/mo)** when database storage approaches the 500 MB ceiling.
- **Storage runway:** at ~30 orders/day × 2 shops, expect to approach 500 MB in **roughly 9–14 months**, driven mainly by the audit log. Archiving old audit logs to cold storage can extend this well into a second year before upgrading.
- **Auto-pause:** not a concern for this use case (a daily keep-alive query trivially avoids it if ever needed).
- **Backups (mandatory, our responsibility, and a GO-LIVE PREREQUISITE):** a scheduled job runs `pg_dump` every evening and keeps a **rolling 7-day window** (delete day-8), exported to separate storage. This mirrors Pro's 7-day backup safety net at zero cost and is the real protection for the shop's books. **The cron must be running BEFORE the first real transaction is recorded** — it's a ~20-line script; sequence it with go-live, not with the deployment iteration.
- **Environments:** **two Supabase projects — `dev` and `prod`** (both can start on free tier). Prod secrets live only in the prod host environment; seeds differ (dev gets fixture data, prod gets only the clean seed: account groups, units, Super Admin, company profile).
- **Error monitoring (before first live use, not Iteration 7):** wire **Sentry (free tier)** into the API — uncaught exceptions and failed money-transaction alerts. A crashed sale at the counter must reach you within minutes from day one of live use.
- ⚠️ **Design constraint for Iteration 2:** **keep the audit log lean** (store only changed fields / avoid logging reads) — it's the main driver of storage growth and therefore of how long the free tier lasts.

### 8.2 All Iteration-1 decisions are now locked
Nothing left open — roles (four global roles + branch list), ORM (Prisma), and auth (custom, admin-provisioned) are all decided. Ready for Iteration 2.

**Iteration 2 will cover:** the backend architecture in code terms — the route→controller→service layering; the **custom auth implementation** (Argon2id hashing, login, access/refresh tokens, refresh rotation); the auth/branch-context/permission/audit/error middleware; the idempotency mechanism; validation strategy; the lean audit-log design; and the connection-resilience contract — so that when we hit transactions in Iteration 3, the skeleton is fully specified.

---

# Iteration 2 — Backend Architecture

> How the API is wired: the layers a request flows through, custom auth, the middleware stack, audit logging, idempotency, validation, and error handling. With Iteration 1's schema and this skeleton in place, Iteration 3 (transactions) can focus purely on business logic.

---

## 9. Layered Architecture

Every request flows through the same layers. Each layer has one job; keeping them separate is what makes transactions, testing, and auditing sane.

```
HTTP request
   │
   ▼
[ middleware stack ]   request-id → json parse → CORS → rate-limit
   │                   → authenticate → authorize → branch-context
   │                   → idempotency (writes) → validation
   ▼
controller   thin: reads req, calls one service method, returns its result
   │
   ▼
service      ALL business logic. Owns DB transactions. Calls the audit helper.
   │
   ▼
Prisma       data access only. No business rules here.
   │
   ▼
[ error handler ]   catches anything thrown, maps to the response envelope
```

**Layer responsibilities**

| Layer | Does | Never does |
|---|---|---|
| **Route** | Maps URL+method to controller; attaches the right middleware. | Logic. |
| **Controller** | Translates HTTP ↔ service. Pulls `req.auth`, body, params; calls one service method; shapes the response envelope. | Touch Prisma; contain business rules. |
| **Service** | All business logic. Opens DB transactions. Enforces invariants (stock ≥ 0, etc.). Writes audit rows inside the transaction. | Know about HTTP (no `req`/`res`). |
| **Prisma** | Reads/writes rows. | Decide anything. |

⚠️ **Now-vs-later:** services must be HTTP-agnostic (no `req`/`res`). When the mobile app or a background job needs the same logic, it calls the service directly. Leaking HTTP into services forces duplication later.

---

## 10. Validation Strategy

- **Library: Zod.** Define a schema per endpoint input; validate at the controller boundary *before* the service runs.
- Validation produces a typed, trusted object the service can rely on. Services assume their inputs are already validated.
- Validation failures throw a `ValidationError` (→ 422 via the error handler) with field details.

```ts
// modules/products/product.validation.ts
export const createProductSchema = z.object({
  name: z.string().min(1),
  hsnCode: z.string().optional(),
  unitId: z.string().uuid(),
  gstRate: z.number().min(0).max(28),
  priceIncludesGst: z.boolean().default(false),
  taxClassification: z.enum(['taxable','exempt','nil_rated','non_gst']).default('taxable'),
  salePrice: z.number().int().nonnegative(),   // paise
  purchasePrice: z.number().int().nonnegative(),
});
```

- **Money arrives as integer paise** from clients and is validated as a non-negative integer. **Quantities** as numeric strings/decimals (validate range, precision ≤ 3).

---

## 11. Authentication Implementation (custom)

### 11.1 Password hashing
- **Argon2id** (via the `argon2` package). Hash on user creation and on password change; only ever compare hashes. Never log or store plaintext.

### 11.2 Tokens: short access + rotating refresh
- **Access token** — JWT, short-lived (**15 min**), signed with `JWT_ACCESS_SECRET`. Payload: `{ userId, role }`. Sent on every request as `Authorization: Bearer <token>`. Stateless — verified by signature, no DB hit for the token itself (the user lookup in the auth middleware enforces active status).
- **Refresh token** — opaque random token, long-lived (**e.g. 14 days**), **stored hashed** in `refresh_tokens` and **rotated** on every use. Used only to mint a new access token.

### 11.3 New table — `refresh_tokens`
| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | uuid | PK | |
| `user_id` | uuid | FK → users.id, not null | |
| `token_hash` | text | not null | Hash of the refresh token (never store raw). |
| `expires_at` | timestamptz | not null | |
| `revoked_at` | timestamptz | nullable | Set on rotation, logout, or deactivation. |
| `user_agent` | text | nullable | Traceability of the session/device. |
| `rotated_from_id` | uuid | nullable, FK → refresh_tokens.id | Set at creation to the id of the row this one rotated from. Multiple rows may share the same `rotated_from_id` (concurrent grace-window rotations off the same parent, see §11.4) — it's a lineage/forensics pointer, not a uniqueness constraint. |
| `created_at` | timestamptz | not null default now() | |

- Index `(user_id)`, `(token_hash)`, and `(rotated_from_id)`.

### 11.4 Flows
- **Login** `POST /auth/login` `{ username, password }` → verify hash → if `must_change_password`, respond with a "must change password" state (limited token) → else issue access + refresh, write the refresh row, set `last_login_at`.
- **Refresh** `POST /auth/refresh` `{ refreshToken }` → look up by hash → if valid, unexpired, not revoked, and user still active: **revoke the old row, issue a new pair** (rotation; the new row's `rotated_from_id` points at the old row), return them.
  **Grace window (30s), corrected:** raw refresh tokens are never stored (only their hash, above) — so a retry can never literally be handed back the exact same raw token another request already received; that value only ever existed in the first response. Instead: if the presented token's row is **already revoked** and that revocation happened **less than 30 seconds ago**, treat it as a legitimate concurrent rotation (e.g. two open tabs racing), not theft — mint the requester their **own** independent new pair (also pointing `rotated_from_id` at the same old row) and do **not** revoke any sibling pair already issued off that row. Both callers end up with their own valid pair; neither breaks the other.
  **Reuse ≥30 seconds** after revocation → theft detection: **revoke every refresh token belonging to that user** (same blast radius as change-password's revoke-all below, not just the one lineage — a suspected-compromised session shouldn't leave other sessions on trust).
- **Change password** `POST /auth/change-password` → verify current (or the must-change token), hash new, set `must_change_password = false`, **revoke all** the user's refresh tokens (force re-login elsewhere).
- **Logout** `POST /auth/logout` → revoke the presented refresh token.
- **Deactivation** (admin) → set `is_active = false` and revoke all the user's refresh tokens. Their access token dies within 15 min; refresh is dead immediately.

⚠️ **Now-vs-later:** storing refresh tokens (vs fully stateless JWT refresh) is what lets a Super Admin instantly cut off a user. For an internal business app that control is worth the one extra table.

---

## 12. Authorization & Branch Isolation (middleware)

Three small middlewares run in order on protected routes: **authenticate → authorize → branch-context.**

### 12.1 `authenticate` — who are you
```ts
export async function authenticate(req, _res, next) {
  const token = bearer(req);                       // throws 401 if missing
  const { userId, role } = verifyAccessToken(token); // throws 401 if bad/expired
  const user = await prisma.user.findFirst({
    where: { id: userId, deletedAt: null },
  });
  if (!user || !user.isActive) throw new UnauthorizedError('USER_INACTIVE');
  req.auth = { userId: user.id, role: user.role };
  next();
}
```

### 12.2 `authorize` — are you allowed this action
A central **capability map** ties each action to the roles allowed, so permissions live in one readable place (mirrors Blueprint §4 + the four-role table §7.2):

```ts
const CAN: Record<string, Role[]> = {
  'product:write'      : ['super_admin','admin'],
  'sale:create'        : ['super_admin','admin','employee'],
  'sale:editCancel'    : ['super_admin','admin'],
  'stock:adjust'       : ['super_admin','admin'],
  'report:view'        : ['super_admin','admin','employee','accountant'],
  'user:manage'        : ['super_admin'],
  // ...
};
export const requireCap = (cap: string) =>
  (req, _res, next) => {
    if (!CAN[cap].includes(req.auth.role)) throw new ForbiddenError('INSUFFICIENT_ROLE');
    next();
  };
```

### 12.3 `branchContext` — which branch, and may you touch it
```ts
export async function branchContext(req, _res, next) {
  const branchId = req.header('x-branch-id') ?? req.body.branchId ?? req.query.branch_id;
  if (!branchId) throw new BadRequestError('BRANCH_REQUIRED');
  if (req.auth.role !== 'super_admin') {
    const ok = await prisma.userBranch.findUnique({
      where: { userId_branchId: { userId: req.auth.userId, branchId } },
    });
    if (!ok) throw new ForbiddenError('BRANCH_NOT_ALLOWED');
  }
  req.auth.branchId = branchId;   // services read context from here
  next();
}
```

- **Super Admin** skips the branch-membership check (sees all).
- Every service receives `ctx = { userId, role, branchId }` and scopes its queries by `branchId`. **Branch isolation is enforced server-side on every request — never trusted from the client.**
- **Accountant** passes `authenticate` + `branchContext` but the capability map limits them to `report:view`, so they can read reports for their assigned branches and nothing else.

---

## 13. Audit Logging (mechanics)

Implements the strategy from §5.4. One shared helper, always called **inside the service's DB transaction**.

```ts
// shared/audit.ts
export async function writeAudit(tx: Tx, ctx: Ctx, e: {
  action: 'create'|'update'|'cancel'|'login'|'deactivate'|...,
  entityType: string,
  entityId?: string,
  before?: object,
  after?: object,
}) {
  const { before, after } = leanDiff(e.before, e.after); // changed-fields only on update
  await tx.auditLog.create({
    data: {
      userId: ctx.userId, branchId: ctx.branchId,
      action: e.action, entityType: e.entityType, entityId: e.entityId,
      before, after,
    },
  });
}
```

- **`leanDiff`**: for an update, keep only keys whose value changed; for a create, `before = null` and `after = the row`; never log reads. **Exception for immutable transaction entities** (sales, purchases, payments, postings): storing the full `after` blob duplicates the row itself, which already can't change silently. For creates of these, log **reference-only** — entity id + a one-line summary (e.g. voucher number, party, total). Full snapshots are reserved for *edits/cancels*, where before/after genuinely differ. This is the biggest storage lever after the changed-fields rule (§8.1).
- Because `writeAudit(tx, ...)` uses the *same* transaction handle as the change, the change and its audit row commit or roll back together — the trail can never drift.
- Auth events (login, password reset, deactivate) are logged from the auth service the same way.

---

## 14. Idempotency

Protects every state-changing (POST/PUT/PATCH) endpoint so a network retry or double-tap can't create duplicates (Blueprint §10.9). Foundational for safe retries under the connection-resilience contract (§16).

### 14.1 New table — `idempotency_keys`
| Column | Type | Constraints | Notes |
|---|---|---|---|
| `key` | text | PK | Client-generated UUID (one per intended action). |
| `user_id` | uuid | FK → users.id, not null | Who issued it. |
| `scope` | text | not null | e.g. `sale:create` — guards against cross-endpoint reuse. |
| `request_hash` | text | not null | Hash of the request body; detects a reused key with different data. |
| `status` | text | not null | `in_progress` \| `completed`. |
| `response` | jsonb | nullable | Stored success response to replay. |
| `created_at` | timestamptz | not null default now() | |
| `expires_at` | timestamptz | not null | Prune after, e.g., 48h. |

### 14.2 Mechanism
1. Write endpoints require an `Idempotency-Key` header (a UUID the client generates once per action and reuses on retries).
2. On arrival: try to **insert** the key as `in_progress` (atomic). 
   - **Insert succeeds** → first time: process normally. **The flip to `completed` (with the stored response) executes INSIDE the same DB transaction as the business write** — never after it. If they were separate, a crash between commit and flip would leave a committed bill behind an `in_progress` key, and the stale takeover would reprocess it: a double bill. Inside one transaction, key-state and business-state can never disagree. (The stored `response` can be minimal — the created voucher id — and reconstructed on replay.)
   - **Insert conflicts** → seen before:
     - `completed` → **replay the stored response** (no reprocessing).
     - `in_progress` **and fresh** (< 60s old) → a retry arrived mid-flight → return `409 IN_PROGRESS`; client retries shortly.
     - `in_progress` **and stale** (≥ 60s old) → the original attempt is presumed dead (server crash mid-processing) → **take over**: delete the stale row, re-insert, process normally. **This is safe only because of a paired guarantee: a statement/transaction timeout (~10s) on the API's DB connections ensures no transaction can still be alive at 60s** — takeover-while-still-running is impossible by construction.
   - If the same key arrives with a **different `request_hash`** → `422` (programming/client error).
3. **Failure path (critical):** if processing throws a handled error *after* the key was inserted, the key row is **deleted in the error path** (try/catch–finally around the service call) — so the operator can fix the input and retry with the same key. A key must never be left `in_progress` by a failed request; only a crash can do that, and the staleness takeover (above) covers it.
4. Keys expire and are pruned after a short window (they only guard against near-term retries).

⚠️ **Now-vs-later:** wire idempotency into the generic write path now, before any transaction endpoints exist. Then every Iteration-3 endpoint inherits safe-retry for free.

---

## 15. Error Handling

### 15.1 Error classes
A small hierarchy; services/middleware `throw`, the central handler formats.

```ts
class AppError extends Error {
  constructor(public code: string, message: string,
              public status: number, public details?: unknown) { super(message); }
}
class ValidationError  extends AppError { constructor(d?){ super('VALIDATION', 'Invalid input', 422, d); } }
class UnauthorizedError extends AppError { constructor(c='UNAUTHORIZED'){ super(c, 'Unauthorized', 401); } }
class ForbiddenError    extends AppError { constructor(c='FORBIDDEN'){ super(c, 'Forbidden', 403); } }
class NotFoundError     extends AppError { constructor(c='NOT_FOUND'){ super(c, 'Not found', 404); } }
class ConflictError     extends AppError { constructor(c){ super(c, 'Conflict', 409); } }
class BadRequestError   extends AppError { constructor(c){ super(c, 'Bad request', 400); } }
// domain-specific, thrown by services:
class InsufficientStockError extends AppError { constructor(d){ super('INSUFFICIENT_STOCK','Not enough stock',409,d); } }
```

### 15.2 Central handler (last middleware)
```ts
export function errorHandler(err, _req, res, _next) {
  if (err instanceof AppError) {
    return res.status(err.status).json({
      data: null, meta: null,
      error: { code: err.code, message: err.message, details: err.details },
    });
  }
  logger.error(err);                       // unknown → log, don't leak internals
  return res.status(500).json({
    data: null, meta: null,
    error: { code: 'INTERNAL', message: 'Something went wrong' },
  });
}
```

- Every error becomes the standard envelope (§3.5) with a stable `code` the clients can switch on (e.g. show "Not enough stock" for `INSUFFICIENT_STOCK`).
- Stable error codes are part of the API contract — clients (web + mobile) branch on `code`, never on message text.

---

## 16. Connection-Resilience Contract (server side)

The server-side half of Blueprint §10.10 (clients don't lose data on a blip; the server makes retries safe).

- **All writes are idempotent** (§14): the client may safely resend a failed request with the same `Idempotency-Key`; the server either completes it once or replays the stored result.
- **All multi-step writes are atomic** (one DB transaction): a dropped connection mid-write leaves no half-applied state — it either fully committed or fully rolled back.
- **Reads are safe to retry** (no side effects).
- Together these let a client retry confidently after a power flicker or wifi drop without creating duplicate bills or corrupt state. No server-side session state is assumed.

---

## 17. What Iteration 2 Locks, and What's Next

**Locked this iteration:** the layered request lifecycle; custom auth (Argon2id, access+refresh with rotation, the `refresh_tokens` table, all auth flows); the authenticate/authorize(capability map)/branch-context middleware and server-side branch isolation; the in-transaction audit helper with lean diffing; the idempotency mechanism and `idempotency_keys` table; the validation strategy (Zod at the boundary); and the error hierarchy + central handler + stable error codes.

**Schema added this iteration:** `refresh_tokens` (§11.3), `idempotency_keys` (§14.1).

**Iteration 3 will cover:** the **transactions schema** (sales, purchases, their line items with the Blueprint §6.14 columns, payments, ledger postings) and the **atomic Sale/Purchase service** — stock check + decrement, ledger postings, payment split, invoice-number allocation, and the audit row, all in one transaction — which is where every piece of this skeleton (transactions, idempotency, audit, branch context, error types) finally comes together.

### 17.1 Carried into Iteration 3 (design notes to resolve there)
These were raised in review and deferred to the transactions iteration by design:
1. **Stock decrement must be row-locked.** The negative-stock hard-block (Blueprint §6.1) is only safe if the read + decrement of the `branch_stock` row happens under `SELECT ... FOR UPDATE` inside the sale transaction. Otherwise two simultaneous sales of the last unit could both pass the check and oversell. Specify the locking explicitly in the atomic Sale service.
2. **"Both"-type party ledger group.** A party who is both customer and supplier has one ledger under one group. Default it to Customers/Receivables (like Tally) and let the balance net; confirm when modelling party ledgers.
3. **Opening balance lives on the ledger only** (fixed in §6.7) — carry this through when designing ledger postings and balance computation.
4. **GST rounding rule (§3.11)** governs all invoice/bill tax math — apply it in the Sale/Purchase services.

---

# Pre-Iteration-3 Addendum — Cross-Iteration Data Contracts

> **Why this exists:** the iterate-as-we-go methodology has one exception — anything that defines the *shape of stored financial data* must be locked before the first row is written, even if the feature that uses it comes later. Iteration 3 writes ledger postings and stock movements; their contracts are defined **here, now**, so Iteration 4+ formalizes nothing retroactively and no financial data ever needs migrating to a new convention.

---

## 18. Ledger Posting Contract (sign convention + posting map)

### 18.1 Representation: signed amount
Every money movement writes rows into `ledger_postings` (table fully defined in Iteration 3; its **contract** is fixed here):

- Each posting row has a **signed `amount` (bigint paise)**: **positive = debit, negative = credit.**
- **A ledger's balance = `opening_balance` + SUM(amount)** of its postings. Nothing else. (Opening balance uses the same convention: debit balance positive — e.g. a customer who owes us has a positive balance on their ledger.)
- **Double-entry invariant:** the postings of any single voucher **must sum to exactly zero**. Enforced in the service on every write (and re-checkable at any time as an integrity audit).
- **Display sign by ledger nature:** asset/expense ledgers display their (debit-positive) balance as-is; liability/income/equity ledgers flip the sign for display (a credit balance shows positive). Storage never flips — only presentation.

### 18.2 Every posting carries `branch_id` (non-negotiable)
`ledger_postings.branch_id` is **NOT NULL** and is always **the branch of the source voucher** — even when the ledger itself is shared (`ledgers.branch_id` null, e.g. Sales, GST). This is what makes **per-branch GSTIN filing** and per-branch P&L work off shared ledgers: GSTR-1/3B for a branch = postings to GST ledgers filtered by the posting's `branch_id`. Without this, shared GST ledgers and per-GSTIN returns are irreconcilable.

Each posting also carries: `ledger_id`, `voucher_type`, `voucher_id` (source document), `voucher_date` (§21), and `created_at`.

### 18.3 Posting map per voucher type
(Dr = positive, Cr = negative. All amounts follow the §3.11 rounding rule.)

| Voucher | Postings |
|---|---|
| **Sale** (intra-state) | Dr Cash/Bank (paid portion) · Dr Customer ledger (udhar portion) · Cr Sales · Cr CGST output · Cr SGST output |
| **Sale** (inter-state) | same, but Cr IGST output instead of CGST+SGST |
| **Purchase** | Dr Purchases · Dr GST input (CGST+SGST or IGST) · Cr Cash/Bank (paid) · Cr Supplier ledger (unpaid) |
| **Receipt** (collect udhar) | Dr Cash/Bank · Cr Customer ledger |
| **Payment** (pay supplier / expense) | Dr Supplier ledger *or* Dr Expense ledger · Cr Cash/Bank |
| **Contra** | Dr destination (Bank/Cash) · Cr source (Cash/Bank) |
| **Credit Note** (sales return) | exact reverse of the sale's postings for the returned lines |
| **Debit Note** (purchase return) | exact reverse of the purchase's postings for the returned lines |
| **Journal** | user-entered Dr/Cr lines (must sum to zero) |
| **Stock Adjustment** (write-down) | Dr Stock Loss/Adjustment ledger · **Cr Purchases** — the written-off goods are removed from the purchases cost pool, valued per §19 |
| **Round-off** (if enabled) | the ± few paise difference posts to the **Round Off** ledger so every voucher still sums to zero |

**Worked example** — intra-state sale ₹1,000 + 5% GST = ₹1,050; customer pays ₹500 cash, ₹550 udhar:
`+50000 Cash · +55000 Customer · −100000 Sales · −2500 CGST · −2500 SGST` → sum = 0 ✓

### 18.4 Inventory accounting model (locked: Tally-style, NOT perpetual ledger inventory)
**Inventory is never a ledger-tracked asset.** Stock quantity and value live *only* in `stock_movements` / `branch_stock` (the §19 valuation engine); there is **no Inventory/Stock ledger** in the chart of accounts, and no posting ever debits or credits one.
- Purchases post to the **Purchases** expense ledger (as in §18.3) — the periodic model.
- Sales post revenue only — **no Dr COGS · Cr Inventory posting per sale.**
- Stock write-offs post **Dr Stock Loss · Cr Purchases** (removing the written-off goods from the purchases cost pool), so the Stock Loss ledger is genuinely balanced by something — it never one-sidedly drifts.
- The eventual **P&L (Iteration 6) is periodic:** Sales − (opening stock + purchases − closing stock) ± write-offs, where the opening/closing stock figures come from the §19 valuation engine — this is exactly how Tally computes it.
- The Σ-of-sale-movement COGS (§19.3) is the **valuation engine's per-sale cost figure** — used for margin analytics and as a cross-check on the periodic P&L, never *added on top of* Purchases in the same statement (that would double-count cost of goods).

---

## 19. Inventory Costing Contract (weighted average)

### 19.1 Method: per-branch weighted average cost
**Locked: weighted average cost, maintained per `(branch, product)`.** (FIFO layers are needless complexity for a fertilizer shop; last-purchase-price misstates COGS. Weighted average is simple, stable, and what the P&L and Stock Valuation reports will use.)

- The current average lives in **`branch_stock.avg_cost`** (bigint paise per unit — §6.6), updated **inside the same transaction** as any inbound movement.
- **Inbound update formula:** `new_avg = (old_qty × old_avg + in_qty × in_rate) / (old_qty + in_qty)`, rounded to the paise. (If `old_qty` = 0, `new_avg = in_rate`.)

### 19.2 `stock_movements` carries cost — contract
Every `stock_movements` row (table defined in Iteration 3) carries, in addition to (product, branch, ±qty, reason, source doc):
- **`rate`** — bigint paise per unit at which this movement is valued
- **`value`** — bigint paise, `rate × qty` rounded to the paise

Without cost on movements, weighted-average/COGS could never be recomputed or audited later. This is the schema decision that had to happen before the first movement row.

### 19.3 Valuation rules per movement type
| Movement | Valued at (`rate`) | Effect on `avg_cost` |
|---|---|---|
| **Purchase (in)** | net purchase cost per unit from the line | recompute (§19.1) |
| **Sale (out)** | current `avg_cost` at that branch — this **is** COGS (never the sale price) | unchanged |
| **Sales return (in)** | the `rate` of the original outbound movement (linked via the credit note → original invoice); fallback: current `avg_cost` | recompute |
| **Purchase return (out)** | current `avg_cost` | unchanged |
| **Adjustment down** (damage/theft/…) | current `avg_cost` — this value posts to the Stock Loss ledger (§18.3) | unchanged |
| **Adjustment up** (count correction) | current `avg_cost` (or an explicitly entered cost if genuinely known) | recompute if entered cost differs |
| **Transfer out** (source branch) | source branch's current `avg_cost` | unchanged at source |
| **Transfer in** (destination branch) | the transfer-out `rate` | recompute at destination |

- **Stock Valuation report** = Σ (`branch_stock.quantity × avg_cost`) — and is always re-derivable from movements as a cross-check.
- **Per-sale COGS** = the sale-outbound movement's `value` — the valuation engine's cost figure, used for margin analytics and to cross-check the periodic P&L (**§18.4**: the ledger P&L itself is periodic — Sales − (opening + purchases − closing) ± write-offs — never movement-COGS *plus* Purchases together).

---

## 20. Bill Edit vs Day-Close Interaction (locked rule)

The gap: day-close (§10.11 Blueprint) locks in a day's cash record; bill edit/cancel (§6.11 Blueprint) reverses cash postings. Editing yesterday's cash bill after yesterday closed would silently falsify the closed reconciliation. The rule:

1. **A bill whose `voucher_date` falls on or before the branch's last closed day cannot be edited or cancelled directly.** The edit service checks this before anything else.
2. **Preferred correction path: a Credit Note dated today** (or a new bill dated today) — the closed day stays intact; today's books carry the correction. This is also the GST-clean approach.
3. **Escalation path: an Admin/Super Admin may explicitly REOPEN a day-close** (a dedicated, audit-logged action with a mandatory reason). While reopened, bills of that day can be edited; the day must then be **re-closed**, which recomputes expected cash and records the new short/over. The audit log holds both closes.
4. **GST-filed periods: credit-note path only** — no reopening a day inside a period whose GSTR has been filed (Blueprint §6.11 guardrail becomes mandatory here).

This constrains the Iteration-3 edit service (check #1 is part of its contract) and the Iteration-4 day-close design (reopen/re-close states).

---

## 21. Voucher Date & Day Boundaries

- Every transaction has a **`voucher_date` of SQL type `date`** — a **user-entered business date** (defaulting to "today"), separate from `created_at` (timestamptz, machine time, audit-only).
- **Day Book, day-close, number-series FY derivation, and all report date filters operate on `voucher_date`** — never on `created_at`.
- The **"today" default is computed in IST (Asia/Kolkata)** — the business's timezone — so a bill entered at 11:58 PM lands on the correct business day regardless of server timezone. This is deliberately narrow: one `date` column + one default-computation rule; no app-wide timezone framework.
- FY derivation (§5.5) reads `voucher_date` through the `fy_start_month` helper.

---

## 22. Testing, Contracts & Build Notes

### 22.1 Testing strategy (minimum bar for financial software)
- **Service-layer tests for every money-touching service** (sale create, edit/cancel, purchase, payments, postings) against a **real test database** (a dedicated schema or the dev Supabase project) — not mocks; the transactions and locks are the thing under test.
- **Golden invoice-math suite:** a fixed set of input→expected-output cases covering: exclusive & inclusive GST, mixed tax classifications on one bill, free/scheme qty, discount toggle, CGST/SGST vs IGST by state, partial payment splits, and the §3.11 rounding edge cases (odd paise, round-off ledger). The rounding rule is exactly the kind of thing that regresses silently — these cases run on every change.
- **Double-entry invariant check** (postings sum to zero) asserted in every transaction test.
- Definition of done for a phase includes these tests passing (see Roadmap §2).

### 22.2 API contract artifact
The Zod schemas (§10) are the single source of truth for request/response shapes. **Export their inferred TypeScript types from a shared package** (or generate OpenAPI from them) so web — and later mobile — consume the exact same contract. Decide the package mechanics before the web frontend starts; never hand-duplicate types in a client.

**Decimal fields serialize as plain JS numbers, trailing zeros stripped.** Postgres `numeric(p,s)` columns (`products.gst_rate`, `units.conversion_factor`, `categories.default_gst_rate`, and any future `numeric` column, e.g. `branch_stock.quantity`/`low_stock_threshold`) come out of Prisma as `Decimal` instances; the API's shared serializer (`serializeBigInt`, `src/shared/serialize.ts`) converts every `Decimal` it finds — by type, not by field name — to a plain `number` via `.toNumber()`. `18.00` becomes the JS number `18`, `5.50` becomes `5.5`. This is exact for the *value* (no rounding — `numeric(5,2)` magnitudes are well within float precision), but the API never returns pre-formatted decimal-place strings. **The frontend must format to the appropriate decimal places at display time** (e.g. `18 → "18.00%"`), the same "convert only at display" discipline as money-in-paise (CLAUDE.md), never assume the response already carries fixed precision.

### 22.3 Prisma build notes (so Iteration 3 doesn't stall)
- **`SELECT ... FOR UPDATE` is not expressible in the Prisma query API.** The stock-row lock and number-series lock are done with **`$queryRaw` inside `prisma.$transaction`**. Pattern: `await tx.$queryRaw\`SELECT ... FROM branch_stock WHERE ... FOR UPDATE\`` then proceed with normal Prisma calls on the same `tx`. **The `branch_stock` lock applies to EVERY movement type, not just sales:** inbound movements (purchase, transfer-in, sales return) do a read-modify-write on the same row for the §19.1 avg-cost recompute, so the purchase/transfer/return services take the identical lock — skipping it there corrupts `avg_cost` under concurrency just as surely as overselling.
- **CHECK constraints** (e.g. `branch_stock.quantity >= 0`, §6.6) aren't declarable in the Prisma schema — add them via raw SQL in a migration file.

---

## 23. GST Compliance Contract (researched July 2026 — binds the invoice layer)

### 23.1 Document-type rule (derived, never user-chosen)
The printable document's legal title is computed from the bill's line classifications + the buyer's registration status (full rule in Blueprint §9):

| Lines on the bill | Buyer | Document |
|---|---|---|
| All `taxable` | any | **Tax Invoice** |
| All `exempt`/`nil_rated` | any | **Bill of Supply** (no tax columns, no tax collected) |
| Mixed | unregistered (no GSTIN) | **Invoice-cum-Bill of Supply** — single document |
| Mixed | registered (GSTIN) | Tax Invoice for taxable lines; exempt lines strictly on a separate Bill of Supply (rare case — split the documents) |

The per-line `tax_classification` (§6.14) already carries everything needed; this is a titling/layout rule in the invoice payload, not new data. The everyday seeds+fertilizer bill to a farmer is the Invoice-cum-Bill-of-Supply case.

### 23.2 Rates are data, not code
- Current landscape (GST 2.0, effective 22 Sep 2025, two slabs): fertilizers **5%** (HSN 3102–3105), unbranded organic manure/bio-fertilizer **0%** (HSN 3101; branded → 5%), chemical pesticides/fungicides/herbicides **18%** (HSN 3808), specified bio-pesticides **5%**, FCO-listed micronutrients **5%**, seeds **0% exempt**, sprayers/farm tools **5%**. So this shop needs only **0 / 5 / 18** today.
- **Never hardcode the slab set** (no enum of rates): rates changed in Sept 2025 and will change again. `gst_rate` is a free numeric on the product; the per-line snapshot (§6.14) keeps historical bills correct through any future change. Category defaults (§6.4) are pre-fill convenience only.
- The 5% fertilizer rate applies to goods *intended for use as fertilizer* — misclassified items attract 18%; classification is the shop's responsibility, the system just stores what's set.

### 23.3 HSN discipline
- **Store the full 6-digit HSN on every product** regardless of turnover; **print at least 4 digits** on invoices. (Current rule: ≤ ₹5 crore AATO → 4-digit HSN mandatory on B2B invoices, optional B2C; > ₹5 crore → 6-digit everywhere. Storing 6 now means never revisiting.) GSTN validates HSN codes at return filing since April 2025, so garbage HSNs surface as filing errors.

### 23.4 Turnover & threshold notes
- **Exempt sales count toward aggregate turnover** (registration, HSN-digit, and e-invoice thresholds) — seed sales are turnover even at 0% tax. Reports must expose the taxable-vs-exempt outward split (the §6.14 classification bucketing already provides it); the accountant uses it for the GSTR-3B proportional ITC reversal on exempt supplies (Rule 42) — the system only supplies the split, never computes the reversal.
- **E-invoicing (IRN/QR)** becomes mandatory above ₹5 crore AATO — not applicable at this shop's scale; a future feature triggered by growth, not a launch requirement.
- Gujarat's GST state code is **24** (GSTIN starts with 24) — the value for `branches.state_code`. (RTO codes like "GJ-16" are vehicle registration districts, unrelated to GST.)

---

# Iteration 3 — Transactions

---

## 24. Cross-Cutting Decisions

- **CC-1 — In-sale payment folded into the sale voucher (Model A).** The cash/online/udhar split lives in the sale's own `ledger_postings` (per the locked §18.3 map). No separate `payments` row is created for money taken during a sale. Consequence: **`payments`/`payment_allocations` have no writer in Iteration 3** — their schema is defined now, first written by the Iteration 4 standalone receipt/payment service.
- **CC-2 — Two immutability regimes (documented §3.1 exceptions):**
  - `ledger_postings`, `stock_movements` are **append-only** like `audit_logs`: reversal = new rows. Columns: `id`, `created_at`, `created_by` only — no `updated_at`, `deleted_at`, `updated_by`.
  - `sales`, `purchases`, `payments` keep full common columns but **`deleted_at` is never set** — removal is a `status` transition (cancellation), never a soft-delete.
  - Line items carry `id` + `created_at` only, **no `deleted_at`** (resolved in §28.3 / T-1: edit replaces the line set rather than soft-deleting, history via the §13 audit snapshot).
- **CC-3 — Store computed money on headers and lines.** Confirmed invoices are immutable/filed; `taxable`, GST amounts, `discount`, `round_off`, `grand_total` are stored, not recomputed on read. Service is sole writer; golden-math suite (§22.1) guards the stored values.
- **CC-4 — Polymorphic `(voucher_type, voucher_id)` on both backbones**, no FK — identical to `audit_logs.(entity_type, entity_id)`. Integrity is service-enforced.
- **CC-5 — `status` lifecycle drives draft/confirm/cancel.** `draft` (parked/held: no invoice number, no postings, no movements, no series increment) → `confirmed` (number allocated + all financial effects) → `cancelled` (number retained, not reused, not deleted; mandatory reason). `invoice_number` is nullable (null while draft).
- **CC-6 — Project-wide `branch_stock` lock order (deadlock-avoidance invariant).** Every service that locks `branch_stock` rows `FOR UPDATE` — sale, purchase, return, adjustment, transfer, now and future — **must acquire the locks in ascending `product_id` order within the transaction.** This is not a §26-local rule: two different voucher types touching overlapping products with *different* lock orders will deadlock under concurrency. Stated once here so every service inherits the identical ordering rather than re-deriving it.
- **CC-7 — System-ledger resolution: explicit nullable FK columns, never a name-based lookup.** A service that needs to post to a shared ledger — branch Cash, or the company-wide Sales/CGST/SGST/IGST/Round Off/Purchases ledgers — resolves it via an explicit nullable FK column (`branches.cash_ledger_id`; `company_profile.sales_ledger_id`/`cgst_ledger_id`/`sgst_ledger_id`/`igst_ledger_id`/`round_off_ledger_id`/`purchases_ledger_id`), never by looking the ledger up by name. Resolution happens per-transaction, and **only the ledgers actually needed for that specific transaction are required non-null** — e.g. `igst_ledger_id` only matters on an inter-state transaction; an intra-state sale never touches it, so it doesn't need to be configured to unblock intra-state sales. A needed-but-unconfigured ledger throws a clear `SYSTEM_LEDGER_NOT_CONFIGURED` error rather than posting to nothing or silently failing. This is the required pattern for **every** future money-posting service, not just Sale/Purchase — Iteration 4's standalone Receipt/Payment service included; do not invent a name-based lookup instead.

---

## 25. Schema — Transaction Tables

### 25.1 `sales` (header) — Blueprint §6.1

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | uuid | PK | |
| `branch_id` | uuid | FK → branches.id, not null | Drives GSTIN, number series, tax state. |
| `customer_id` | uuid | FK → parties.id, **nullable** | Null = anonymous walk-in. Service rule: **any udhar portion > 0 ⇒ `customer_id` required**. |
| `customer_name` | text | not null | **Snapshot** — populated even for anonymous sales (quick-add name). Required on every printed invoice (Blueprint §9). |
| `customer_village` | text | not null | **Snapshot** — same rule. |
| `voucher_date` | date | not null, default today-in-IST | §21 business date; all reports/day-close filter on this. |
| `status` | text | not null default `draft`, check in (`draft`,`confirmed`,`cancelled`) | CC-5. |
| `invoice_number` | text | nullable | Allocated from `number_series` on confirm only. |
| `financial_year` | text | nullable | Snapshot at confirm (via `fy_start_month` helper on `voucher_date`). |
| `place_of_supply_state_code` | text | nullable | Snapshot at confirm; GSTR-1 place of supply, protects filed bill if party state later edited. |
| `document_type` | text | nullable, check in (`tax_invoice`,`bill_of_supply`,`invoice_cum_bos`) | §23.1 derived + **stored on confirm**. |
| `total_taxable` | bigint | not null default 0 | Stored total, paise. |
| `total_discount` | bigint | not null default 0 | |
| `total_cgst` | bigint | not null default 0 | |
| `total_sgst` | bigint | not null default 0 | |
| `total_igst` | bigint | not null default 0 | |
| `round_off` | bigint | not null default 0 | Signed few-paise per §3.11 → Round Off ledger. |
| `grand_total` | bigint | not null default 0 | `taxable + tax − discount + round_off`. |
| `paid_cash` | bigint | not null default 0 | |
| `paid_bank` | bigint | not null default 0 | |
| `credit_udhar` | bigint | not null default 0 | |
| `bank_ledger_id` | uuid | FK → ledgers.id, nullable | Required when `paid_bank > 0` (names which bank/UPI ledger). |
| `notes` | text | nullable | |
| `cancel_reason` | text | nullable | Required when `status = cancelled`. |
| `cancelled_at` | timestamptz | nullable | |
| `cancelled_by` | uuid | nullable | |

+ common columns (§3.1); `deleted_at` present but never set (CC-2).

**CHECK constraints (raw SQL in migration, per the `branch_stock.quantity >= 0` precedent):**
- `paid_cash + paid_bank + credit_udhar = grand_total`.

**Indexes:**
- Partial unique `(branch_id, financial_year, invoice_number) WHERE invoice_number IS NOT NULL AND deleted_at IS NULL` — unique per branch-FY, tolerates many draft nulls, still covers `cancelled` rows so a number can never be reissued.
- `(branch_id, voucher_date)` — Day Book / registers.
- `(customer_id, voucher_date)` — customer history.

### 25.2 `sale_line_items` — Blueprint §6.14

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | uuid | PK | |
| `sale_id` | uuid | FK → sales.id, not null | |
| `line_number` | int | not null | Print/display order. |
| `product_id` | uuid | FK → products.id, not null | |
| `customer_id` | uuid | nullable, denormalized | = `sales.customer_id`. Recall key. Null on anonymous sales. |
| `branch_id` | uuid | not null, denormalized | = `sales.branch_id`. |
| `sale_date` | date | not null, denormalized | = `sales.voucher_date`. |
| `unit_rate` | bigint | not null | Per-unit rate as entered (recall basis, §6.1.1). |
| `billed_qty` | numeric(12,3) | not null | |
| `free_qty` | numeric(12,3) | not null default 0 | Scheme qty: moves stock, zero taxable value. |
| `discount` | bigint | not null default 0 | Absolute paise, applied pre-GST-split → taxable is net of discount. |
| `gst_rate` | numeric(5,2) | not null | Snapshot from product (§23.2). |
| `price_includes_gst` | boolean | not null | Snapshot of effective inclusive/exclusive flag. |
| `tax_classification` | text | not null, check in (`taxable`,`exempt`,`nil_rated`,`non_gst`) | Snapshot; drives §23.1 + GSTR bucketing. |
| `hsn_code` | text | nullable | Snapshot (§23.3 + reprint fidelity). |
| `product_name` | text | nullable | Snapshot for exact reprint if product renamed. |
| `unit_symbol` | text | nullable | Snapshot. |
| `taxable_value` | bigint | not null | Computed per §3.11, stored. |
| `cgst_amount` | bigint | not null default 0 | Computed per §3.11, rounded per line. |
| `sgst_amount` | bigint | not null default 0 | |
| `igst_amount` | bigint | not null default 0 | |
| `line_total` | bigint | not null | `taxable_value + line tax` (free_qty contributes 0). |

Common-columns exception (CC-2): `id`, `created_at` only; **no `deleted_at`** (T-1 — edit replaces the line set, history via §13 audit).

**Index (last-price recall, §6.14):** `(customer_id, product_id, sale_date DESC)`. Recall query additionally joins `sales` and filters `status = 'confirmed'` (excludes drafts/cancelled/returns per §6.1.1). Exact query in §28.1.

**Discount semantics (LOCKED accounting principle):** `discount` stored as absolute paise per line, applied to the line amount **before** the GST split / inclusive back-calc, so stored `taxable_value` is net of trade discount (GSTR-1 consistent). 🅿️ **PARKED (roadmap §9):** the UI mental model (% vs ₹ entry) — resolved at frontend time, storage is the resolved paise amount either way.

### 25.3 `purchases` (header) + `purchase_line_items` — mirror of sales

Identical shape, with these deltas:

- `supplier_id` — **not null** (asymmetry with sales' nullable customer; a payable posting needs the supplier ledger, no anonymous-purchase analogue).
- No `customer_name`/`customer_village` snapshot; no anonymous case.
- `supplier_invoice_number` (text, nullable) + `supplier_invoice_date` (date, nullable) — the supplier's own bill identity, distinct from our internal `number_series` voucher number. 🅿️ **PARKED (roadmap §9):** exact GSTR-2B matching field requirements — do not guess; verify with accountant before locking the ITC/purchase-return path.
- Our own internally-allocated reference number is stored as **`voucher_number`**, deliberately **not** `invoice_number` — distinct from `sales.invoice_number`, which is the actual GST-filed document number (GSTR-1). This avoids two differently-meaning "invoice number" columns on this table: `voucher_number` (ours, purely internal — never filed under our GSTIN) sits alongside `supplier_invoice_number` (theirs, as-entered) without the naming implying either one is the GST-significant number that `sales.invoice_number` is.
- **No negative-stock block** (purchases only add stock, Blueprint §6.2). `branch_stock` row still locked `FOR UPDATE` for the avg-cost recompute (§22.3), just no `quantity ≥ 0` gate.
- Purchase line `unit_rate` = net purchase cost per unit → feeds §19.1 avg-cost recompute.
- Purchase line carries `free_qty` (symmetry — a distributor "10+1 free" adds 11 to stock at lower effective cost).
- Denormalized on lines: `supplier_id`, `branch_id`, `purchase_date`.
- Recall index: `(supplier_id, product_id, purchase_date DESC)` — last-cost recall.

### 25.4 `payments` (header) — Blueprint §6.3/6.4 (schema now; first writer Iteration 4)

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | uuid | PK | |
| `branch_id` | uuid | FK → branches.id, not null | |
| `voucher_date` | date | not null, default today-IST | §21. |
| `voucher_number` | text | nullable | From `number_series`, `voucher_type ∈ {receipt, payment}`. |
| `financial_year` | text | nullable | Snapshot at post. |
| `direction` | text | not null, check in (`receipt`,`payment`) | Receipt = in; Payment = out. |
| `party_id` | uuid | FK → parties.id, nullable | Null for pure expense payment. |
| `cash_bank_ledger_id` | uuid | FK → ledgers.id, not null | The money side (branch Cash/Bank ledger). |
| `counter_ledger_id` | uuid | FK → ledgers.id, nullable | Non-money side when not a party (e.g. expense ledger, §6.12). |
| `amount` | bigint | not null | Paise. |
| `reference` | text | nullable | Cheque/UPI ref. |
| `notes` | text | nullable | |
| `status` | text | not null default `confirmed`, check in (`confirmed`,`cancelled`) | No draft/park state for payments. |
| `cancel_reason` | text | nullable | |
| `cancelled_at` | timestamptz | nullable | |
| `cancelled_by` | uuid | nullable | |

+ common columns; `deleted_at` never set (CC-2).

**CHECK constraint:** exactly one of `party_id` / `counter_ledger_id` is non-null
(`(party_id IS NOT NULL) <> (counter_ledger_id IS NOT NULL)`).

### 25.5 `payment_allocations`

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | uuid | PK | |
| `payment_id` | uuid | FK → payments.id, not null | |
| `sale_id` | uuid | FK → sales.id, nullable | |
| `purchase_id` | uuid | FK → purchases.id, nullable | |
| `amount` | bigint | not null | Paise applied to this target. |

`id`, `created_at` only (immutable). Two nullable FKs (not polymorphic) — target set is small/closed and benefits from real FKs.

**CHECK constraint:** exactly one of `sale_id` / `purchase_id` is non-null
(`(sale_id IS NOT NULL) <> (purchase_id IS NOT NULL)`).

Unallocated remainder (`amount` − Σ allocations) = on-account advance, resolved in Iteration 4; no column here.

### 25.6 `ledger_postings` — §18.1–18.3

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | uuid | PK | |
| `ledger_id` | uuid | FK → ledgers.id, not null | |
| `branch_id` | uuid | FK → branches.id, **not null** | §18.2 — always the source voucher's branch, even for shared ledgers. |
| `amount` | bigint | not null | Signed: **+ debit, − credit** (§18.1). |
| `voucher_type` | text | not null | `sale`/`purchase`/`receipt`/`payment`/`contra`/`credit_note`/`debit_note`/`journal`/`stock_adjustment`. |
| `voucher_id` | uuid | not null | Polymorphic, no FK (CC-4). |
| `voucher_date` | date | not null | §18.2/§21 — report filtering without joining source. |
| `narration` | text | nullable | Optional per-posting note. |
| `created_at` | timestamptz | not null default now() | |
| `created_by` | uuid | nullable | |

Append-only (CC-2): no `updated_at`/`deleted_at`/`updated_by`.

**Service invariants (not columns):**
- Postings of one voucher sum to exactly zero (§18.1).
- Zero-amount postings are never written (e.g. no udhar → no customer posting).
- Posting granularity is **voucher-level aggregate** (one Cr Sales for total taxable, one Cr CGST for total, etc.) — rate-wise/line detail lives in line items, not here.
- **Postings are written FROM the sale/purchase header's stored `total_*` / payment-split columns, never independently recomputed.** Cr Sales = `−total_taxable`, Cr CGST = `−total_cgst`, Dr Cash = `+paid_cash`, Dr Customer = `+credit_udhar`, etc. This guarantees header totals and posting amounts can never drift — CC-3's stored values are the single source of truth for the postings too, not a parallel computation of them.

**Indexes:** `(ledger_id, voucher_date)` — statements/balances · `(branch_id, voucher_date)` — Day Book / per-branch P&L / per-GSTIN GST · `(voucher_type, voucher_id)` — a voucher's postings.

### 25.7 `stock_movements` — §19.2–19.3

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | uuid | PK | |
| `product_id` | uuid | FK → products.id, not null | |
| `branch_id` | uuid | FK → branches.id, not null | |
| `quantity_delta` | numeric(12,3) | not null | Signed: + in, − out. |
| `movement_type` | text | not null, check in (`purchase_in`,`sale_out`,`sales_return_in`,`purchase_return_out`,`adjustment_up`,`adjustment_down`,`transfer_out`,`transfer_in`,`sale_reversal_in`) | §19.3, plus `sale_reversal_in` (§28.4) for sale edit/cancel reversal — a forward-addition, not a contradiction of §19.3. |
| `rate` | bigint | not null | Paise/unit, valuation rate for THIS movement (§19.2). |
| `value` | bigint | not null | `rate × |qty|` rounded to paise (§19.2). |
| `voucher_type` | text | not null | Polymorphic source (CC-4). |
| `voucher_id` | uuid | not null | No FK (CC-4). |
| `voucher_date` | date | not null | §21. |
| `reason` | text | nullable | Required for adjustments (Damage/Spillage/Theft/Expiry/Count-Correction/Other); null otherwise. |
| `reference_movement_id` | uuid | FK → stock_movements.id, nullable | ⚠️ Self-FK for `sales_return_in` → original outbound movement (§19.3 rate linkage). |
| `avg_cost_after` | bigint | nullable | ⚠️ Snapshot of `branch_stock.avg_cost` after applying this movement — audit trail for the weighted-average engine (§19). |
| `created_at` | timestamptz | not null default now() | |
| `created_by` | uuid | nullable | |

Append-only (CC-2): no `updated_at`/`deleted_at`/`updated_by`.

**Notes (not columns):** `branch_stock.quantity` and `avg_cost` are caches updated in the **same transaction** as the movement, under the §22.3 `FOR UPDATE` row lock (every movement type, not just sales). Sale-out quantity = `billed_qty + free_qty`; the sale-out `value` at `avg_cost` **is** COGS (§19.3), even for the free units (scheme margin hit). Stock Valuation = Σ(`quantity × avg_cost`), re-derivable from movements as a cross-check.

**Indexes:** `(branch_id, product_id, voucher_date)` — movement report + valuation · `(voucher_type, voucher_id)` — a voucher's movements.

**Deferred CHECK (do not forget — Iteration 5):** `reason` must become a real CHECK constraint requiring non-null when `movement_type IN (adjustment_up, adjustment_down)`, added when Stock Adjustment (Iteration 5) is designed. Not needed in Iteration 3 — no code here writes adjustment movements — but the constraint belongs with that feature, not silently omitted.

---

## 26. Atomic Sale Service (`confirmSale`)

Applies to the `draft → confirmed` transition (a fresh confirm, or confirming a parked draft — §28.2 covers park mechanics). Everything below runs inside **one** `runTransaction(tx)` with a generous timeout (remote-DB latency; the seed's 20s precedent — this transaction is heavier than any master write). If anything throws, the whole transaction rolls back: no number consumed, no stock moved, no postings, no partial bill. The idempotency key completion is flipped to `completed` **inside this same `tx`** (§14.2), and the failure path deletes the key so the operator can fix input and retry with the same key.

**Inputs** (already Zod-validated at the controller boundary): `branchId`, optional `customerId` + `customerName`/`customerVillage`, `voucherDate`, line array (`productId`, `unitRate`, `billedQty`, `freeQty`, `discount`, and the effective `priceIncludesGst` per line), and the payment split (`paidCash`, `paidBank`, `bankLedgerId?`, `creditUdhar`). Money arrives as integer paise.

### Step order (all in one transaction)

1. **Pre-flight validation (no DB writes yet).**
   - If `creditUdhar > 0` then `customerId` is required (CC-1 / §25.1 rule) → else `ValidationError`.
   - If `paidBank > 0` then `bankLedgerId` required.
   - When `customerId` is provided, confirm the referenced party exists and its `type` is `customer` or `both` — **reject supplier-only parties** (same FK-validation class as the existing `assertUnitExists`/`assertCategoryExists` pattern).
   - `customerName` + `customerVillage` present (snapshot columns are NOT NULL) — for a chosen party, default them from the party row; for anonymous, they come from quick-add input.
   - At least one line. Free-only lines (`billedQty = 0, freeQty > 0`) are allowed **within** a sale, but **at least one line must have `billedQty > 0`** — reject a wholly-giveaway sale. A sale where every posting would be skipped as zero-amount, yet still consumes a real GST invoice number, is not a sale; pure samples/giveaways belong in a stock-adjustment or dedicated giveaway flow (not this path).
   - **Fail fast, before locking anything.**

2. **Lock stock rows — `SELECT … FOR UPDATE`, deterministic order.**
   - For every distinct `productId` in the lines, `tx.$queryRaw` a `SELECT quantity, avg_cost FROM branch_stock WHERE branch_id = ? AND product_id = ? FOR UPDATE` (§22.3 — Prisma can't express `FOR UPDATE`).
   - **Lock in ascending `product_id` order (CC-6)** to prevent deadlock between concurrent transactions touching overlapping products.
   - If a product has **no `branch_stock` row** at this branch, treat as quantity 0 → the negative-stock block will reject it (you can't sell what was never stocked here). Do **not** auto-create the row.

3. **Negative-stock hard-block (Blueprint §6.1).**
   - For each product, required out-qty = Σ over its lines of (`billedQty + freeQty`). If `required > locked quantity` → `InsufficientStockError` with `{ productId, available, requested }`. Rolls back (nothing written yet anyway). This is safe against oversell precisely because the check reads the row **under the lock** taken in step 2.

4. **GST computation per line (§3.11 rounding, in integer paise).**
   - **Line gross** = `billedQty × unitRate` (free_qty excluded — zero taxable). Then subtract `discount` → **discounted line amount**.
   - **Exclusive line:** `taxableValue = discounted line amount`; `lineTax = round(taxableValue × gstRate)`.
   - **Inclusive line:** `taxableValue = round(discountedLineAmount ÷ (1 + gstRate))`; `lineTax = discountedLineAmount − taxableValue`.
   - **Round each line's tax to whole paise** (§3.11 step 1). Then split: intra-state → `cgst = sgst = lineTax / 2` (⚠️ **OPEN S-3**: odd-paise halving — see below); inter-state → `igst = lineTax`, cgst = sgst = 0.
   - **Intra vs inter** decided once per bill: compare `branch.state_code` vs the sale's place-of-supply state (party state, defaulting to branch state for anonymous/local). Snapshot into `sales.place_of_supply_state_code`.
   - `exempt`/`nil_rated`/`non_gst` lines: tax = 0 regardless of rate.
   - `lineTotal = taxableValue + lineTax`.

5. **Header totals (sum the rounded line values — never re-round, §3.11 step 3).**
   - `total_taxable = Σ taxableValue`; `total_cgst = Σ cgst`; `total_sgst = Σ sgst`; `total_igst = Σ igst`; `total_discount = Σ discount`.
   - **Round-off (§3.11 step 4, only if `company_profile.rounding_mode = nearest_rupee`):** `pre = total_taxable + total_cgst + total_sgst + total_igst`; `grand_total = round to nearest rupee`; `round_off = grand_total − pre` (signed, a few paise).
   - **Payment-split integrity:** assert `paidCash + paidBank + creditUdhar = grand_total` (the same equality the DB CHECK enforces — checked here to fail with a clean domain error rather than a raw constraint violation). ⚠️ **OPEN S-4**: does the operator enter the split against the pre- or post-round-off total? See below.

6. **Derive `document_type` (§23.1)** from the line classifications + buyer registration (has GSTIN?) and snapshot onto the header.

7. **Allocate invoice number (row-locked, §5.5).**
   - Derive `financial_year` from `voucherDate` via the `fy_start_month` helper.
   - `SELECT … FOR UPDATE` the `number_series` row for `(branchId, 'sale', financialYear)`; if none, create it (prefix from config). Increment `current_number`; format `invoice_number`. Snapshot `financial_year` onto the sale.
   - Under the row lock, two concurrent sales serialize here — no gap/duplicate. **Number is consumed only now, at confirm** — a parked draft never reached this step.

8. **Write the sale header + line items** with all stored computed columns (CC-3) and snapshots (`customer_name/village`, per-line `gst_rate`, `price_includes_gst`, `tax_classification`, `hsn_code`, `product_name`, `unit_symbol`). Status → `confirmed`.

9. **Decrement stock + write `stock_movements` (per §19).**
   - For each product line: `quantity_delta = −(billedQty + freeQty)`; `movement_type = sale_out`; **`rate = branch_stock.avg_cost`** (COGS, never sale price, §19.3); `value = rate × |qty|` rounded; `avg_cost` **unchanged** on out-movements.
   - Update `branch_stock.quantity` (the locked row) by the delta; write `avg_cost_after = avg_cost` (unchanged) onto the movement.
   - ⚠️ **OPEN S-5**: two lines, same product — one merged `sale_out` movement vs one per line. See below.

10. **Write `ledger_postings` (per §18.3 map, FROM the stored header columns — §25.6 rule).**
    - `+paid_cash` Dr Cash ledger (branch cash) · `+paid_bank` Dr `bank_ledger_id` · `+credit_udhar` Dr customer ledger · `−total_taxable` Cr Sales · then Cr GST: intra `−total_cgst` / `−total_sgst`, inter `−total_igst` · `round_off` → Round Off ledger (sign per §18.3 so the voucher still sums to zero).
    - **Skip any zero-amount posting.** Every posting carries `branch_id` = sale's branch (§18.2) and `voucher_date`.
    - **Assert Σ amounts = 0** before leaving the step (§18.1 invariant, also asserted in every transaction test §22.1).

11. **Audit + idempotency, inside the same `tx`.**
    - `writeAudit(tx, ctx, { action: 'create', entityType: 'sale', entityId })` — **reference-only** for this immutable create (voucher number, party, grand_total) per §13's transaction-entity rule, not a full row snapshot.
    - Flip the idempotency key to `completed` with the minimal stored response (the sale id) **in this `tx`** (§14.2).

12. **Commit.** Serializer converts BigInt→number at the envelope; response is the created sale (id, invoice_number, totals, payment split).

### Failure / rollback behaviour
- Any throw at any step → full `tx` rollback: no number consumed (the `number_series` increment rolls back with everything else — **this is why numbering must be inside the transaction, not a side call**), no stock delta, no postings, no audit row, no key completion.
- Handled error after key insert → error path deletes the idempotency key (§14.2) so a corrected retry reuses it; a mid-flight crash leaves the key `in_progress` and the staleness-takeover path (§14.2, guarded by the ~10s statement timeout) reclaims it.
- `InsufficientStockError` and `ValidationError` surface as clean domain codes the client branches on; the DB CHECKs (`paid+…=grand_total`) are defense-in-depth that should never fire if step 5 did its job.

### Resolved Decisions (LOCKED)
- **S-1** — free-only lines allowed within a sale; **≥1 line must have `billedQty > 0`** (wholly-giveaway sales rejected). Enforced in step 1.
- **S-2** — `branch_stock` locked in ascending `product_id` order — promoted to project-wide invariant **CC-6**.
- **S-3** — odd-paise split: `cgst = floor(lineTax/2)`, `sgst = lineTax − cgst` (sum exact). Golden-math §22.1 case.
- **S-4** — payment split is entered against the **post-round-off** grand total; `paid_cash + paid_bank + credit_udhar = grand_total` (locked consequence, matches the DB CHECK).
- **S-5** — same product across multiple lines → **one merged `sale_out` movement** per (product) per sale; line items stay separate.

---

## 27. Atomic Purchase Service (`confirmPurchase`)

Mirror of `confirmSale`, one `runTransaction`, same failure/rollback discipline, same audit + idempotency-inside-the-transaction pattern. Only the deltas from §26 are stated here — everything unstated is identical.

**Inputs:** `branchId`, `supplierId` (**required** — no anonymous purchase), `voucherDate`, optional `supplierInvoiceNumber` + `supplierInvoiceDate`, line array (`productId`, `unitRate` = net purchase cost/unit, `billedQty`, `freeQty`, `discount`, `priceIncludesGst`), payment split (`paidCash`, `paidBank`, `bankLedgerId?`, `creditToSupplier`).

### Deltas from the Sale service

1. **Pre-flight:**
   - `supplierId` required; confirm the party exists and `type ∈ {supplier, both}` — **reject customer-only parties** (mirror of the Sale supplier-check, opposite direction).
   - If `creditToSupplier > 0`, that's the unpaid payable — no extra party requirement beyond `supplierId` (already mandatory).
   - No "wholly-free" rejection (unlike sales). **Reason for the asymmetry:** a sales invoice number is GST-significant and externally filed (GSTR-1), so burning one on a zero-posting giveaway is wrong (the S-1 restriction); a purchase voucher number is **purely internal** (our own Day Book/audit sequence, never filed under our GSTIN), so an all-free inward consuming one is harmless. An all-free purchase still adds stock and posts nothing to Purchases/GST for the free units.

2. **Lock stock rows — ascending `product_id` order (CC-6).** Same lock, **but no negative-stock block** — purchases only add. The lock is still mandatory: it guards the `avg_cost` read-modify-write against concurrency (§22.3). A missing `branch_stock` row here is **created** (first-ever stock of this product at this branch), unlike sales where its absence is a reject.

3. **GST computation per line:** identical math (inclusive/exclusive, per-line rounding, intra/inter by state), but this is **input GST** (ITC) not output — it changes only which ledgers the postings hit (§27 step 6), not the arithmetic.

4. **Header totals + payment-split integrity:** identical; `paid_cash + paid_bank + credit_to_supplier = grand_total` (same CHECK shape as sales).

5. **Invoice number:** allocate from `number_series` with `voucher_type = 'purchase'` (our internal voucher number — distinct from `supplier_invoice_number`, which is the supplier's own and is stored as-entered, never generated). No `document_type` derivation (that's a sales/GST-invoice concept).

6. **Stock increment + `stock_movements` (§19) — this is where purchases genuinely differ:**
   - `quantity_delta = +(billedQty + freeQty)`; `movement_type = purchase_in`.
   - **Free-unit valuation (LOCKED):** total line cost is spread across all inward units (billed + free), so free stock correctly lowers avg cost. Algebraically identical to valuing billed units at cost and free units at zero, since the weighted-average formula depends only on total cost and total quantity added.
   - **⚠️ Precision / computation-ordering rule (LOCKED — this is the paisa-drift guard):**
     - `value` is **authoritative and exact**, and it is the line's already-computed `taxableValue` from step 3 above — **not** the raw `billed_qty × unit_rate`. It must be net of the line's `discount` and net of embedded GST for inclusive-priced lines: inventory cost must reflect what was actually paid (net of trade discount), and GST paid on a purchase is recoverable ITC, never part of the goods' cost — feeding the gross or GST-inclusive figure into `value` would double-count that GST (once as ITC, once as inventory cost). Free units cost nothing, so they don't enter `value` either way. This is the figure that feeds everything.
     - `rate` is **derived, display/reference only**: `rate = round(value ÷ (billed_qty + free_qty))`, computed **after** `value`.
     - **`rate` must NEVER be multiplied back** (`rate × qty`) to recompute `value` or to feed the avg-cost formula — that reintroduces the exact rounding drift this rule exists to prevent.
     - The **avg-cost recompute uses `value` directly**: `new_avg = round( (old_qty × old_avg + value) ÷ (old_qty + in_qty) )`, where `in_qty = billed_qty + free_qty`; `old_qty = 0 ⇒ new_avg = round(value ÷ in_qty)`.
     - *Worked drift example:* 10 billed + 1 free at ₹100, no discount, exclusive pricing (so `taxableValue = value` here) → `value = 100000` paise exact; `rate = round(100000 ÷ 11) = 9091` paise; `9091 × 11 = 100001 ≠ 100000` — a 1-paisa drift **if the wrong figure fed the formula**. Using `value` directly, there is no drift.
     - Netting discount and embedded GST out of `value` **composes cleanly with the drift guard above and introduces no new rounding risk**: both are exact integer operations already performed once in step 3 (discount is stored as absolute paise; the inclusive-line GST back-calc is an integer division), so `value = taxableValue` is exact by construction, not a second approximation stacked on the first.
   - Write `avg_cost_after` onto the movement (the post-recompute value — genuinely changes here, unlike sales).
   - **§22.1 golden-math requirement:** include a `purchase_in` case with a **fractional remainder** (e.g. the 10+1@₹100 case above, or any qty that doesn't divide evenly), specifically so this drift is caught if the ordering is ever reintroduced. A round-number-only test would not catch it.

7. **`ledger_postings` (§18.3 purchase map, FROM stored header columns):**
   - `+total_taxable` Dr Purchases · `+total input GST` Dr GST-input (intra `+total_cgst`/`+total_sgst`, inter `+total_igst`) · `−paid_cash` Cr Cash · `−paid_bank` Cr `bank_ledger_id` · `−credit_to_supplier` Cr supplier ledger · round-off → Round Off ledger.
   - Skip zero-amount postings; every posting carries the purchase's `branch_id` and `voucher_date`; assert Σ = 0.

8. **Audit + idempotency:** identical (`entityType: 'purchase'`, reference-only create audit, key completion in-transaction).

### Resolved Decisions (LOCKED)
- **P-1** — wholly-free purchases allowed. Reason: purchase voucher numbers are internal-only (never GST-filed), unlike GST-significant sales invoice numbers — so no S-1-style restriction is warranted.
- **P-2** — free-unit valuation spreads total line cost across (billed + free) units, correctly lowering avg cost. Precision rule locked: `value` exact and authoritative, `rate` derived-after and never multiplied back, avg-cost formula consumes `value` directly. Golden-math §22.1 case with a fractional-remainder line required.

---

## 28. Secondary Features

Everything roadmap §5 requires beyond the two atomic services. Several of these carry the genuine open decisions of the whole iteration, flagged **T-1 … T-8**.

### 28.1 Last-Price / Last-Cost Recall

- **Endpoints:** `GET /customers/:id/products/:productId/last-price?branch_id=` → `{ rate, effectiveRate, date, quantity } | null`; purchase mirror `GET /suppliers/:id/products/:productId/last-cost?branch_id=`.
- **Query:** seek the `(customer_id, product_id, sale_date DESC)` index (§25.2), join `sales`, filter `sales.status = 'confirmed'` and `sales.deleted_at IS NULL` — **excludes drafts and cancelled** (§6.1.1 "actual sales only, never reversals"). No line-level filter is needed: edited-away lines are physically removed (T-1), so only current lines exist.
- **Fallback:** none found → return `null`; the client falls back to `product.sale_price`. Endpoint stays pure (no product-price fallback baked in).
- ⚠️ **T-7a — branch scope.** §6.1.1 says recall is per-branch, but the locked §6.14 index is `(customer_id, product_id, sale_date DESC)` with no `branch_id`. My read: **filter `branch_id = :branch_id` as an extra predicate after the index seek** — cheap, because the (customer, product) seek already narrows to a handful of rows; the locked index stays unchanged. Alternative is promoting `branch_id` into the index (changes a locked Blueprint spec). Recommend the post-seek filter.
- ⚠️ **T-7b — rate vs net.** §6.1.1 explicitly defers "recall list rate or net-after-discount." My read: prefill the **`unit_rate` as entered** (that field *is* the rate field being pre-filled; discount is a separate off-by-default toggle), and **also** return `effectiveRate = round(line_total ÷ billed_qty)` as display context ("last sold ₹520, effective ₹495 after discount"). So: prefill `rate`, surface `effectiveRate`, don't conflate them.
- **Prefetch (optional, now-vs-later):** a batch `GET /customers/:id/last-prices?branch_id=` returning a `{productId: rate}` map for the customer's recent items, so selecting a customer pre-loads prices without per-line lag (§6.1.1). Recommend defining the endpoint, deferring implementation until the billing screen needs it.

### 28.2 Hold / Park a Bill

- A parked bill is a `sales` row with `status = 'draft'` + its `sale_line_items`. **Nothing else** — no `invoice_number`, no `number_series` increment, no `ledger_postings`, no `stock_movements`, no stock lock (CC-5).
- **Park = a plain insert** of the draft header + lines (still carries an `Idempotency-Key` for double-tap safety, but there are no financial effects to protect). Resume/edit-draft = update the draft rows.
- **Drafts do NOT reserve stock.** The negative-stock block runs only at confirm (§26 step 3), so a draft can become unconfirmable if stock sold out meanwhile — correct behaviour, stated explicitly.
- **Confirm** = the §26 `confirmSale` algorithm run against an existing draft id (the `draft → confirmed` transition). `confirmSale` therefore accepts **two entry modes**: fresh create-and-confirm, or confirm-existing-draft. Both converge on the same locked step order.
- ⚠️ **T-2 — draft discard (CC-2 refinement).** Discarding a draft = **soft-delete** (`deleted_at` set) — this is the *one* legitimate use of `deleted_at` on `sales`, and it is **gated to `status = 'draft'`**. A `confirmed` sale is never soft-deleted; its only removal path is cancellation (`status = 'cancelled'`). Recommend as the precise CC-2 refinement.

### 28.3 Line-Item History Model (resolving the CC-2 deferral)

**Line items do NOT get `deleted_at`.** On edit, the line set is **replaced** — superseded rows are deleted and revised rows inserted under the same `sale_id`, in the transaction — and history is preserved by the §13 full-snapshot-on-edit audit, exactly as Blueprint §6.11 states ("preserved in the audit log").

Why not the soft-delete+insert alternative:
- **`leanDiff` cannot per-line-diff a line array.** §13 defines it as a top-level changed-fields diff; PROJECT_STATUS §7 bug #5 is direct evidence that an array-valued key (`branchIds`) is compared *wholesale*, not element-wise. So a sale edit logs the **entire** before/after line array regardless of storage approach — and §13 already keeps the **full** snapshot on transaction-entity edits (only creates are reference-only). The audit granularity is identical either way; soft-delete buys nothing on history.
- **Soft-delete would impose a permanent tax:** every future line-reading query (recall, reports, print, anything written months from now) must remember `deleted_at IS NULL` forever or silently double-count — a compounding footgun with no offsetting benefit here.
- **Principled distinction:** `ledger_postings`/`stock_movements` are append-only *because they are summed to produce balances/valuation* — a forgotten filter there corrupts money. Line items are voucher detail; the money truth lives in postings, so the line set can be replaced safely, with the audit log holding prior versions. The sale **header** is of course never hard-deleted (retains its invoice number and status); only its detail lines are replaced.

### 28.4 Bill Edit / Cancel Workflow

Permission: `sale:editCancel` — super_admin / admin only (already in the capability map). Both run in **one `runTransaction`**: **append-only for postings/movements** (reversal is new rows, originals untouched); **superseded lines are replaced** — deleted and reinserted under the same `sale_id` (T-1) — with history living in the §13 audit snapshot, not in the transactional rows themselves.

**Shared step 1 — the §20 day-close guard:**
- Reject a direct edit/cancel when the sale's `voucher_date` falls on or before the branch's **last closed day** → caller must use a Credit Note (Iteration 5) or an Admin day-reopen (Iteration 4). GST-filed period → credit-note only.
- ⚠️ **T-6 — sequencing.** The day-close *state* is built in Iteration 4. In the Iteration-3-only window nothing is closed, so this guard is **present but vacuously permissive** (last-closed-day = none ⇒ every bill editable). Safe, because (a) there's no cash-close to falsify yet and (b) the shop can't go live on Iteration 3 alone (MVP is Phase 0–3, so day-close lands before cutover). Recommend: ship the guard now reading the (initially absent) day-close state; it activates automatically once Iteration 4 populates it.

**Edit (`editSale`):**
1. §20 guard.
2. Lock `branch_stock` rows for the **union of old and new line products**, ascending `product_id` (CC-6).
3. Negative-stock block against the **new** required quantities (net of what the reversal restores).
4. **Reverse original effects (append-only):** write compensating `stock_movements` restoring the original out-quantities **at the original out-rate** (so avg_cost is neutrally undone), and compensating `ledger_postings` negating every original posting (voucher_type stays `sale`, same `voucher_id` — no enum change needed on postings).
5. **Re-apply** the revised lines exactly as `confirmSale` steps 4–10 (GST recompute, new stored totals, new `stock_movements`, new `ledger_postings`).
6. **Replace lines:** delete the superseded `sale_line_items`, insert the revised ones under the same `sale_id` (T-1 — history is in the audit snapshot, not soft-deleted rows).
7. **Invoice number is retained** (this is an amendment, not a new document); header marked amended (see below); audit stores full before/after (§13 — edits are the case where full snapshots are kept).
- **`movement_type` enum (T-3, resolved):** the reversal in step 4 uses **`sale_reversal_in`** (added to the §25.7 enum) — `+qty` at the original out-rate, one type serving both edit and cancel. **Purchase edit/cancel is explicitly OUT of Iteration 3 scope** — roadmap §5 lists bill (sale) edit/cancel for Iteration 3 but not a purchase equivalent, and purchase-entry errors are corrected at leisure, not at a live counter. So no `purchaseReversalOut`/`editPurchase`/`cancelPurchase` ships here; `purchase_reversal_out` is deferred to whenever purchase-edit is actually designed. *Consequence to note: until then, a mis-entered purchase has no in-app edit/cancel path in Iteration 3 — an accepted scope call, not a silent gap.*
- **Partially-paid auto-adjust (T-5, resolved):** on edit, **`paid_cash` / `paid_bank` stay exactly as-is** (real money already moved). `credit_udhar = new_grand_total − paid_cash − paid_bank`, **which may go negative** — a negative udhar is a customer advance and falls straight out of the customer-ledger posting math (a net credit balance on their ledger). The `paid + … = grand_total` CHECK holds by construction. **Allow negative `credit_udhar`** (no non-negativity CHECK); the advance lives as a customer-ledger credit — the single source of truth for balances — rather than a floored-udhar-plus-separate-refund-record. *Worked (§6.11): orig ₹3000 = ₹1000 cash + ₹2000 udhar; remove item → ₹2500 ⇒ udhar 2000→1500. New total ₹800 ⇒ udhar = 800−1000 = −200 ⇒ ₹200 customer advance.*
- **Customer reassignment (T-9, resolved):** edit **CAN** change the customer — §6.11's own motivating example names "wrong customer" as a mistake edit must be able to correct, resolved as **yes**. The reversal in step 4 credits back the **old** customer using the sale's own prior stored `customer_id` reference, never re-derived from the incoming request; that lookup must succeed even if the old party has since been deactivated (undoing an already-applied ledger hit is not the same as validating eligibility for a new one). A newly assigned customer goes through the same live validation `confirmSale` step 1 already applies (party exists, `type ∈ {customer, both}`, not supplier-only).
- **`voucher_date` is immutable on edit (T-10, resolved):** edit **CANNOT** change `voucher_date` — it stays fixed to the value set at original confirm. Allowing it would let `voucher_date` drift across a financial-year boundary while `financial_year`/`invoice_number` (never reallocated on edit, per the retained-number rule above) stay anchored to the original — the same frozen-field-vs-drifted-related-field contradiction as the customer-GSTIN case in §28.6. It is also a real GST-filing-period risk, not just cosmetic: `voucher_date` drives period assignment (§21).

**Cancel (`cancelSale`):**
1. §20 guard.
2. Lock the sale's product rows (CC-6); write compensating `stock_movements` (`sale_reversal_in`, restoring billed+free at original out-rate) and compensating `ledger_postings` (negate all originals).
3. `status → cancelled`, mandatory `cancel_reason`, `cancelled_at/by`. **Invoice number retained in series — not reused, not deleted** (§6.11 / GST). Reports filter out `cancelled` from totals but the number stays accounted for.
4. Audit before/after.

### 28.5 Billing Product Search

- `GET /products/search?branch_id=&q=` → products **stocked at this branch** via **INNER JOIN `branch_stock`**, returning product identity + `branch_stock.quantity` (live) + `sale_price`, `gst_rate`, `unit`, `tax_classification` (§6.1). Inner join is deliberate: a product with no stock row at this branch doesn't appear — matching the sale rule that unstocked items can't be billed. Excludes `is_active = false` and soft-deleted products. Uses `products(name)` / `products(hsn_code)` indexes.

### 28.6 Printable-Invoice Payload

- **Read-only, computed at print time** from stored immutable data — no recomputation of money (CC-3), no re-derivation of `document_type` (stored on confirm).
- **Assembled from:** `company_profile` (business/legal name, logo, terms, footer, rounding mode) + `branch` (name, GSTIN, address, `state_code`) + `sales` header (`invoice_number`, `voucher_date`, customer snapshot `name`/`village`, `place_of_supply_state_code`, `document_type`, stored totals, payment split, `round_off`) + its `sale_line_items` (the current set — edited-away lines are physically gone, T-1) with snapshotted `hsn_code`/`product_name`/`unit_symbol`, qty, `free_qty`, `unit_rate`, `discount`, `taxable_value`, `cgst`/`sgst`/`igst`, `line_total`, `tax_classification` + **amount-in-words** (paise→words helper, computed not stored) + the **derived title** from `document_type` (§23.1: `tax_invoice`→"Tax Invoice", `bill_of_supply`→"Bill of Supply", `invoice_cum_bos`→"Invoice-cum-Bill of Supply").
- **Amended reprint:** an edited sale reprints its current (revised) lines and is marked **amended**; the original values remain in the audit log (§6.11). ⚠️ minor: an `amended` marker — a boolean/flag on the header set on first edit, or derived from "an edit audit row exists"? My read: derive from audit (no new column) — flag if you'd rather store a flag.
- ⚠️ **Customer GSTIN is NOT currently a stored/frozen field.** `sales` has no `customer_gstin` column — only `customer_name`/`customer_village` are snapshotted (§25.1). The payload must return `gstin: null` rather than live-joining the party's current GSTIN, for the identical reason `document_type` is frozen at confirm rather than re-derived: a live join can contradict an already-frozen `document_type` on reprint (e.g. a buyer registers for GST after their sale confirms as `bill_of_supply`; a later reprint live-joining their now-real GSTIN would visibly contradict a document type that was specifically computed because they had none at the time). A proper fix requires a frozen `customer_gstin` snapshot column mirroring `customer_name`/`customer_village` — flagged as a future schema addition, not built yet.
- ⚠️ **T-8 — registered-buyer mixed case (§23.1 row 4).** For a registered (GSTIN) buyer with mixed taxable+exempt lines, §23.1 strictly wants a Tax Invoice (taxable lines) + a *separate* Bill of Supply (exempt lines) — "rare … acceptable to split." My read: **out of Iteration 3 scope to auto-generate the split document.** Store `document_type` and surface a flag/warning for this rare combination; full split-document generation deferred (near-nonexistent at a farmer counter, and the everyday mixed sale is to *unregistered* buyers → the single `invoice_cum_bos` path already handled). Confirm defer.

### Resolved Decisions (LOCKED)
- **T-1** — line items get **no `deleted_at`**; edit replaces the line set (delete superseded + insert revised), history via the §13 audit snapshot (matches §6.11). `leanDiff` logs the line array wholesale either way, so soft-delete added no audit value and only a permanent filter tax.
- **T-2** — draft discard = soft-delete gated to `status='draft'`; confirmed sales never soft-deleted (CC-2 refinement).
- **T-3** — add `sale_reversal_in` to the §25.7 `movement_type` enum. **Purchase edit/cancel is out of Iteration 3 scope**; `purchase_reversal_out` deferred to when purchase-edit is designed.
- **T-4** — edit/cancel = append-only reverse-and-reapply (compensating + new postings/movements; originals untouched), same `sale_id`, invoice number retained; lines replaced per T-1.
- **T-5** — partially-paid edit: `paid_cash`/`paid_bank` fixed; `credit_udhar` may go negative (= customer advance via ledger credit); no non-negativity CHECK.
- **T-6** — edit/cancel ship in Iteration 3 with the §20 day-close guard present but inert until Iteration 4 populates day-close state.
- **T-7** — recall: (a) per-branch scope via post-seek `branch_id` filter, locked index unchanged; (b) prefill `unit_rate`, surface `effectiveRate` as context.
- **T-8** — registered-buyer mixed split-document generation deferred; store `document_type` + surface a flag only.
- **T-9** — edit can reassign the sale's customer; the reversal credits the old customer via the sale's own stored reference (survives that party's later deactivation); a new customer is revalidated live exactly as `confirmSale` step 1 would.
- **T-10** — `voucher_date` is immutable on edit (fixed to the value at original confirm); prevents FY-boundary drift against the anchored `financial_year`/`invoice_number`, and protects the GST filing period (§21).

---

## 29. What Iteration 3 Locks, and What's Next

**Locked this iteration:** the seven cross-cutting decisions (CC-1…CC-7) governing payment-in-sale, immutability regimes, stored-vs-recomputed money, polymorphic voucher references, the draft/confirm/cancel lifecycle, the project-wide `branch_stock` lock order, and the system-ledger resolution pattern; the full transaction schema (`sales`, `sale_line_items`, `purchases`/`purchase_line_items`, `payments`, `payment_allocations`, `ledger_postings`, `stock_movements`); the atomic `confirmSale` and `confirmPurchase` services — stock locking and negative-stock enforcement, GST computation and rounding, invoice-number allocation, ledger postings derived from stored totals, and in-transaction audit + idempotency (S-1…S-5, P-1…P-2); and the secondary features — last-price/last-cost recall, hold/park, the line-item replace-on-edit history model, the bill edit/cancel workflow (append-only reverse-and-reapply), billing product search, and the printable-invoice payload (T-1…T-10).

**Schema added this iteration:** `sales`, `sale_line_items`, `purchases`, `purchase_line_items`, `payments`, `payment_allocations`, `ledger_postings`, `stock_movements` (§25.1–25.7).

**Iteration 4 will cover:** payments, ledgers, outstanding, and cash reconciliation — this is where `payments`/`payment_allocations` get their first writer (the standalone receipt/payment service, CC-1), where the §20 day-close state that §28.4's edit/cancel guard already reads gets populated, and where ledger balance/statement/outstanding views are built on top of the `ledger_postings` written from Iteration 3 onward.

### 29.1 Carried into Iteration 4 (not resolved this iteration)
1. **`payments`/`payment_allocations` first writer** is Iteration 4's standalone receipt/payment service (CC-1) — schema is locked now, unused until then.
2. **Day-close state** (§20) — Iteration 4 populates it; §28.4's guard is already wired to read it.
3. **`purchase_reversal_out` / purchase edit-cancel** — deferred to whenever purchase-edit is designed (T-3); no in-app correction path for a mis-entered purchase until then.
4. **Iteration-5 `reason` CHECK** on `stock_movements` (§25.7) — add the non-null-for-adjustments constraint when Stock Adjustment (Iteration 5) is designed.

Open questions needing an actual conversation with the business (not a technical decision) are tracked in `PROJECT_ROADMAP.md` §9, not duplicated here.

---

# Iteration 4 — Payments, Ledgers, Outstanding, Cash Reconciliation

---

## 30. Cross-Cutting Decision CC-8 — Cancelled Vouchers Are Historical, Never Live Outstanding

A cancelled sale/purchase retains its historical stored totals (`credit_udhar` included) for audit
purposes only — `cancelSale` never touches them. **No consumer may treat those figures as live
receivable/payable.** Every consumer of `credit_udhar`-as-outstanding — `confirmPayment`'s
allocation validation, the ageing report, anything built later — must filter
`status = 'confirmed'` before reading `credit_udhar` as real debt.

**This filter is not needed everywhere `credit_udhar` intuitively feels relevant.** The ledger
statement view (§33) reads `ledger_postings`, not sale/purchase headers — and `ledger_postings` is
already append-only, with `cancelSale`'s reversal writing offsetting rows that net a cancelled
sale to zero automatically. CC-8 exists specifically because the **header field** `credit_udhar`
is deliberately left stale on cancellation (§28.4), a different data shape with a different
safety mechanism. Two distinct guarantees for two distinct representations of the same underlying
fact — don't add CC-8's filter where the append-only design already makes it redundant, and don't
skip it where a header field is being read directly.

---

## 31. Atomic Payment Service (`confirmPayment`)

Applies to both standalone Receipt and Payment vouchers (`voucher_type = 'receipt' | 'payment'`),
posted against the `payments`/`payment_allocations` schema locked in §25.5. Runs in one
`runTransaction`, same idempotency/atomicity contract as `confirmSale`/`confirmPurchase`.

### 31.1 `cash_bank_ledger_id` resolution

The frontend resolves and passes `cash_bank_ledger_id` directly — it fetches the branch's
`cash_ledger_id` (via the branch's own CC-7 FK) plus the branch's configured bank ledgers, and
sends a resolved id straight into `confirmPayment`. No symbolic `{ type: 'cash' }` flag for the
service to resolve — that would open a second, name/type-based resolution path alongside CC-7 for
no reason. This keeps "never a name-based lookup" honest at the API boundary, not just inside the
service.

**Server-side validation (locked, corrected from an earlier looser draft):** the ledger must
exist, must belong to this branch (or be a null-branch shared ledger — shouldn't apply here in
practice), and its `account_group_id` must map to **specifically the Cash-in-Hand or Bank
Accounts seeded groups** (§6.1) — not merely `nature = 'asset'` generally. `nature = 'asset'` also
matches Fixed Assets and the Customers/Receivables group; a loose asset-nature check would
silently accept a payment posted against a customer's own receivable ledger as if it were a cash
account. The check resolves the ledger's `account_group_id` and compares it against the two
specific seeded group ids, not the coarser `nature` enum.

### 31.2 `voucher_number`

Adding `'receipt'`/`'payment'` to `number_series.voucher_type` is a new row per
`(branch, voucher_type, financial_year)` — no collision with `sale`/`purchase` by construction.

> ⚠️ **Unconfirmed against the live schema.** If `number_series.voucher_type` (or any related
> column) carries an enum-style `CHECK` constraint restricting allowed values, widening it is a
> migration, not a design decision. Verify against the real dev DB before this ships.

### 31.3 Ledger posting shape

Two lines per payment, sign per §18.1 (Dr+, Cr−):

| Voucher type | Dr (+) | Cr (−) |
|---|---|---|
| `receipt` | `cash_bank_ledger_id` | `party_id`'s ledger, or `counter_ledger_id` if unlinked |
| `payment` | `party_id`'s ledger, or `counter_ledger_id` if unlinked | `cash_bank_ledger_id` |

`branch_id` = the payment's branch, `voucher_type` = `receipt`/`payment`, `voucher_id` = payment
id, `voucher_date` = payment date. Direct application of the already-locked §18 contract — nothing
new to decide.

### 31.4 Idempotency & audit

Same shape as `confirmSale`/`confirmPurchase`: `Idempotency-Key` on the endpoint,
`writeAudit` snapshot inside the same transaction. No open questions.

### 31.5 Fast Expense Entry

Not a separate service — a thin wrapper over `confirmPayment`. The schema already supports it
exactly (`counter_ledger_id` = expense ledger, `party_id` = null). Simplified input (amount,
expense ledger, optional note); `cash_bank_ledger_id` defaults to the branch's cash ledger via the
CC-7 FK (no picker); `direction` fixed to `payment`. One posting/idempotency/audit code path
underneath, not two to keep in sync.

> ⚠️ **Open business question, not resolved here.** Do expense categories map 1:1 to ledgers
> already (e.g. "Electricity," "Staff Tea" each as their own ledger under Direct/Indirect
> Expenses), or is a lighter category tag — separate from the chart of accounts — wanted? If 1:1,
> Fast Expense Entry's picker is just a filtered ledger dropdown and there's nothing else to
> design. If not, that's new modeling scoped separately. Needs an actual answer from Karan before
> Fast Expense Entry's picker UI is built; track alongside the other `PROJECT_ROADMAP.md` §9
> parked business items (invoice-number prefix, discount UI convention, GSTR-2B fields,
> composition-scheme GSTIN).

### 31.6 Payment allocation — input shape and direction pairing

```
allocations?: Array<{ sale_id?: uuid, purchase_id?: uuid, amount: bigint }>
```

Exactly-one-of `sale_id`/`purchase_id` per entry, matching the `payment_allocations` table's own
CHECK. `sum(allocations.amount) ≤ payment.amount`; the remainder is implicitly on-account/advance
— no flag needed, matching the schema note that unallocated remainder isn't a stored column.

**Direction pairing — locked as a service-level check, not left open:** `receipt` may only
allocate against `sale_id`s; `payment` may only allocate against `purchase_id`s. The unconstrained
pairing would otherwise allow a wrong-direction posting to slip through — money out applied
against a sale, or money in applied against a purchase — easy to post backwards by mistake at a
counter. The gap this closes off is refunds (a customer refund is money *out* against a *sale*; a
supplier refund is money *in* against a *purchase*) — but refunds have no real use case yet: the
refund-generating feature (Credit Note / returns) is Iteration 5 scope, and `editSale`'s existing
advance case (§28.4, T-5) is already fully handled by direct ledger math with no allocation
involved. Cross-pairing is explicitly deferred to Iteration 5's design, not left unconstrained in
the meantime.

### 31.7 Allocation validation — full check ordering

For each allocation entry, in order:

1. **Target row doesn't exist** → `NotFoundError` (`ALLOCATION_TARGET_NOT_FOUND`) — detected as a
   side effect of the lock query itself (§32.3): diff the requested id set against the ids
   actually returned by the batched `FOR UPDATE`, since a missing row simply returns fewer rows.
2. **Status guard** → reject if target `status ≠ 'confirmed'` (CC-8).
3. **Branch guard** → reject if target `branch_id ≠ payment.branch_id`.
4. **`remainingBalance ≤ 0`** → reject, nothing owed (§32.2).
5. **`allocation.amount > remainingBalance`** → reject, over-allocation.
6. **Proceed** — insert the allocation row.

---

## 32. `remainingBalance` Helper

The figure `confirmPayment`'s allocation validation needs: how much of a specific invoice's
credit portion is still unpaid.

### 32.1 Formula

- `remainingBalance(saleId)` = `sale.credit_udhar − Σ(payment_allocations.amount WHERE sale_id = saleId)`
- `remainingBalance(purchaseId)` = `purchase.credit_udhar − Σ(payment_allocations.amount WHERE purchase_id = purchaseId)`

Both pull from the header's stored `credit_udhar` — never independently recomputed from line
items — consistent with CC-3. Bill-wise, not ledger-wide: this answers "how much is still owed on
*this invoice*," a different question from the party's overall ledger balance (§33).

### 32.2 Guards

- **Status guard (CC-8):** only `status = 'confirmed'` targets are valid. A cancelled sale's
  `credit_udhar` is stale by design (§28.4 never updates it on cancellation) — without this guard,
  `remainingBalance` on a cancelled sale would return its pre-cancellation figure and silently
  allow a payment to allocate against a void bill.
- **Branch guard:** target's `branch_id` must equal the payment's `branch_id`. Party ledgers are
  branch-scoped (§6.2); a receipt in Branch A crediting Branch A's copy of a party ledger has no
  coherent relationship to an invoice recorded in Branch B. A hard boundary check, the same
  posture CC-7 takes toward name-based ledger lookups.
- **Zero/negative handling:** `remainingBalance` must be `> 0` to be a valid allocation target. A
  sale sitting on a negative `credit_udhar` (a customer advance from billing time, §28.4 T-5) has
  nothing outstanding to collect against — allocating there is a modeling error, not a valid
  partial payment. Checked before the over-allocation comparison (§31.7 steps 4–5), so the
  rejection reads as "nothing owed" rather than a confusing negative-headroom failure.

### 32.3 Locking discipline

Extends CC-6, not a new pattern. `confirmPayment` may reference multiple sales/purchases in one
payment — lock every referenced row before computing, using the same `$queryRaw ... FOR UPDATE`
shape already used for `branch_stock` (Prisma's ordinary client has no `FOR UPDATE` support).
**Fixed global order:** lock `sales` rows first (ascending `id`), then `purchases` rows (ascending
`id`) — an arbitrary but fixed choice, followed by every call, so two concurrent multi-target
payments can't deadlock against each other.

Compute the `Σ(payment_allocations.amount)` fresh **after** the lock is acquired, inside the same
transaction. Since `confirmPayment` is the sole writer of `payment_allocations`, a second
concurrent payment targeting the same invoice blocks on the row lock until the first commits, then
correctly sees the first payment's allocation in its own sum.

**Interaction with a concurrent `editSale`/`cancelSale` on the same row — verified safe, no
special-casing needed on their side.** Postgres's implicit row lock on an `UPDATE` is the same
lock class `SELECT ... FOR UPDATE` takes:

```
// Lock discipline note (parallel to assertNotPastDayClose's forward-dependency comment):
// This SELECT ... FOR UPDATE is the only defense against a concurrent editSale/cancelSale
// racing this function's remainingBalance computation on the same sale/purchase row. No
// special-casing needed in editSale/cancelSale themselves — Postgres's ordinary implicit
// row lock on UPDATE (the same lock class SELECT ... FOR UPDATE takes) already serializes
// against them:
//   - If this transaction locks the row first, editSale/cancelSale's own UPDATE blocks on
//     that row until this transaction commits or rolls back, then proceeds against the
//     post-commit row. Their writes never need to re-read credit_udhar/status themselves
//     (editSale recomputes credit_udhar from values already read earlier in its own tx;
//     cancelSale just sets status), so blocking mid-transaction costs nothing correctness-wise.
//   - If editSale/cancelSale's UPDATE runs first, it holds the row lock until its own commit;
//     this SELECT ... FOR UPDATE then blocks until that commit, and reads the POST-edit/
//     post-cancel row — exactly the fresh state remainingBalance needs.
// No deadlock risk: editSale/cancelSale each touch at most one row in this lock's table
// (plus branch_stock, a disjoint table this function never locks), so they can never hold
// one row this function needs while waiting on a second row this function also holds — the
// two-resource cycle a deadlock requires can't form on this pairing.
```

### 32.4 Function shape

One plain formula function, no lock-taking inside it: `remainingBalance(tx, { saleId } | { purchaseId })`
runs the guarded sum and returns a `bigint`. Locking is the caller's responsibility, taken
explicitly at the top of `confirmPayment` before any `remainingBalance` calls — the same
separation CC-6 already uses (stock lock lives at the call site, not buried in a shared helper).
This also makes the function directly reusable later for a read-only "outstanding invoices" view
with no lock semantics dragged into a read path.

### 32.5 Known, expected non-bug: negative `remainingBalance` after an edit

An `editSale` that shrinks a bill below what's already been collected against it (via a later
receipt) produces a negative `remainingBalance` for that invoice. This is not an error state — the
ageing report's `> 0` filter (§34) excludes it cleanly, and it correctly reads as a
settled-with-credit invoice. No special handling needed; noted here so it isn't rediscovered as a
bug later.

---

## 33. Ledger Statement View

Per-ledger chronological statement with a running balance (Blueprint §7). Read-only report, no
lock needed.

**Base balance for a ranged query:** `ledger.opening_balance + SUM(postings WHERE voucher_date < from)`
— computed once, only when a `from` date is supplied. With no range, the base is
`ledger.opening_balance` directly (§6.2, §18.1).

**Running balance — one SQL pass with a window function:**

```sql
SELECT lp.*,
       :baseBalance + SUM(lp.amount) OVER (
         ORDER BY lp.voucher_date, lp.created_at, lp.id
       ) AS running_balance
FROM ledger_postings lp
WHERE lp.ledger_id = :ledgerId
  [AND lp.voucher_date BETWEEN :from AND :to]
ORDER BY lp.voucher_date, lp.created_at, lp.id
```

`voucher_date, created_at, id` as the sort key, in that order — `voucher_date` alone isn't unique
per day; `id` breaks any remaining tie deterministically, so the same query always reproduces the
same running balance. Display sign flips by ledger nature at the presentation layer only (§18.1);
storage and computation here are always debit-positive.

**No CC-8 filter needed here** — see §30. `ledger_postings` is append-only and already
self-correcting for cancellations via the reversal rows `cancelSale` writes.

---

## 34. Outstanding / Ageing Report

Bill-wise, not ledger-wise — built from `sales`/`purchases` headers joined against
`payment_allocations`, because bill-level granularity only exists there; the ledger balance alone
can't say which specific invoice is how old.

```sql
SELECT s.id, s.customer_id, s.branch_id, s.voucher_date, s.invoice_number,
       s.credit_udhar - COALESCE(SUM(pa.amount), 0) AS remaining_balance
FROM sales s
LEFT JOIN payment_allocations pa ON pa.sale_id = s.id
WHERE s.status = 'confirmed'          -- CC-8
  AND s.credit_udhar > 0              -- pure-cash sales never need to appear
  [AND s.branch_id = :branchId]       -- per-branch mode; omitted = consolidated
GROUP BY s.id
HAVING s.credit_udhar - COALESCE(SUM(pa.amount), 0) > 0
ORDER BY s.voucher_date ASC
```

Mirrored for `purchases`/payables. Roll up per party for the summary line, with drill-down to
individual invoice rows (Blueprint §7).

**Ageing buckets:** `0–30 / 31–60 / 61+` days from `voucher_date`, non-overlapping cutoffs.

> ⚠️ **Business-convention flag, same category as the invoice-prefix and discount-UI-convention
> items already parked in `PROJECT_ROADMAP.md` §9.** These edges are a reasonable engineering
> default, not a confirmed accounting convention. If the accountant has an existing way of
> thinking about "how overdue," it may not match these exact cutoffs. Not required to resolve
> before building the report; don't treat it as fully settled without a chance to check.

**Two non-bugs worth stating here, not rediscovering later:**

- **The ageing total will not equal the party's ledger balance, by design.** The ageing report is
  per-bill outstanding for collection follow-up; the ledger balance is the true net, inclusive of
  on-account amounts and advances not tied to any specific invoice. Don't wire a "these should
  match" assertion between them.
- **A negative `remainingBalance` from an edit (§32.5) is absorbed silently by the `> 0` filter**
  — it just stops appearing on the list, correctly, as settled-with-credit.

---

## 35. Day-End Cash Reconciliation

Blueprint §10.11 / roadmap Iteration 4. The one piece of this iteration that is **retroactively
binding on already-shipped Iteration 3 code** (§35.4).

### 35.1 Schema — `day_closes`

One row per `(branch_id, close_date)`. Status-machine on a single mutable row, not append-only —
closer in kind to `sales.status` than to `ledger_postings`: it isn't itself summed into anything,
so there's no CC-2-style corruption risk in mutating it, and reopen/reclose history lives in the
audit snapshot on each transition, same treatment as `editSale`.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | uuid | PK | |
| `branch_id` | uuid | FK → branches.id, not null | |
| `close_date` | date | not null | Business date this close covers (§21 semantics). |
| `status` | text | not null, check in (`closed`,`reopened`) | |
| `opening_cash` | bigint | not null | Paise. §35.3. |
| `expected_closing_cash` | bigint | not null | Paise. Computed at close time (§35.2), frozen. |
| `actual_counted_cash` | bigint | not null | Paise. Operator-entered. |
| `short_over` | bigint | not null | Paise. `actual_counted_cash − expected_closing_cash`; positive = over, negative = short. |
| `note` | text | nullable | Optional short/over note. |
| `reopen_reason` | text | nullable | Required when `status = 'reopened'`, null otherwise. |
| `closed_at` | timestamptz | not null | |
| `closed_by` | uuid | nullable | |
| `reopened_at` | timestamptz | nullable | |
| `reopened_by` | uuid | nullable | |

+ common columns (`created_at`/`updated_at`). No `deleted_at` — this row is never deleted, only
status-transitioned. Unique on `(branch_id, close_date)` — plain unique index, no partial
condition needed.

### 35.2 Expected-cash computation

```
expected_closing_cash = opening_cash + SUM(
  ledger_postings.amount
  WHERE ledger_id = branch.cashLedgerId
    AND branch_id = branchId
    AND voucher_date = closeDate
)
```

One signed sum, not four separately-queried categories added and subtracted by hand. This is the
same append-only self-correction argument as the statement view (§33, §30) — a same-day cancelled
cash sale nets to zero automatically via its reversal posting. Re-deriving "cash sales," "cash
receipts," etc. from `sales`/`payments` header fields directly would reintroduce the exact
staleness risk CC-8 exists to prevent, into a brand-new feature. The category breakdown for the
printable summary comes from grouping the same query on `voucher_type` — display only, the total
doesn't depend on it.

**Forward-compatible with Iteration 5 for free:** a contra (cash→bank deposit) voucher, once it
exists, is just another posting hitting this same cash ledger — automatically included in this
formula with zero changes to day-close code.

### 35.3 Opening-cash sourcing

`opening_cash` for a given close = the **previous closed day's `actual_counted_cash`**, not its
`expected_closing_cash`. If yesterday was short ₹200, that ₹200 is genuinely missing from the
drawer — today's reconciliation starts from what's physically there, not from the theoretical
figure. Sourcing from `expected` instead would let the day-close silently absorb yesterday's gap
every day, defeating its purpose as a cumulative-drift check.

For a branch's very first close ever (no prior `day_closes` row), there is no prior actual to pull
from — `opening_cash` is a one-time manually-entered starting float, supplied explicitly on that
first call only.

### 35.4 Guard extension to voucher creation — retroactive change

**Answering the question carried forward from Iteration 3's `assertNotPastDayClose`:** the day-close
guard must also block a *new* sale, purchase, or payment being dated onto an already-closed day —
not just edits/cancels of existing transactions. Nothing in Iteration 3 stops `confirmSale` or
`confirmPurchase` from writing a `voucher_date` on/before the branch's last closed day, which
invalidates the frozen expected-cash figure the same way an unguarded edit would.

**Locked: block, not flag — blanket scope, matching §20's existing edit/cancel scope exactly.**
Any new sale, purchase, or payment dated onto a closed day is blocked regardless of cash
involvement, consistent with how edit/cancel already applies unconditionally. Direct mutation is
blocked; Admin/Super Admin reopen (§35.6) is the sanctioned escape hatch — the same two-path shape
§20 already established for edits, extended to creates rather than inventing a third
"flagged-but-allowed" state.

> ⚠️ **Retroactive to shipped code.** `confirmSale` and `confirmPurchase` are live. Both — plus the
> new `confirmPayment` — must call `assertNotPastDayClose` near the top, mirroring
> `editSale`/`cancelSale`'s existing call. Costs nothing today (the guard is still a no-op until
> `day_closes` rows exist) but must land as part of this iteration's work, or the day day-close
> ships, `confirmSale`/`confirmPurchase` are silently unprotected while `editSale`/`cancelSale`
> are — the exact doc/implementation drift this project's standing review discipline exists to
> catch.

### 35.5 Concurrency — advisory lock mechanism

A plain row-check can't solve the race between closing a day and confirming a new voucher for that
same day: before the first close, no `day_closes` row exists yet to `FOR UPDATE` lock — the same
class of problem `number_series`'s first-row race solved with `INSERT ... ON CONFLICT DO NOTHING`,
requiring a different fix here since there's no row we want to pre-create as a placeholder.

**`pg_advisory_xact_lock`, keyed on `(branch_id, voucher_date)`**, taken by every operation that
touches anything day-close-sensitive for that date: `confirmSale`, `confirmPurchase`,
`confirmPayment`, `editSale`, `cancelSale`, `closeDay`, `reopenDay`, `recloseDay`. Transaction-scoped
(auto-released on commit/rollback), requires no existing row.

**Key derivation and namespace:**

```
pg_advisory_xact_lock(DAY_CLOSE_LOCK_NAMESPACE, hashtext(`${branchId}|${voucherDateISO}`))
```

- `DAY_CLOSE_LOCK_NAMESPACE` — a fixed `int4` constant, private to this lock's purpose, isolating
  it from any other feature that may reach for advisory locks in the future.
- `voucherDateISO` — the already-IST-resolved `date` (§21), rendered as plain `YYYY-MM-DD`.
  `branchId` the raw UUID string. `|` separator, appears in neither component.
- `hashtext()` — Postgres builtin `text → int4`, deterministic, feeds the two-key overload's
  second slot.

**Collision case — named explicitly, bounded to a latency cost, not a correctness risk.**
`hashtext()`'s output space is 32 bits; realistic cardinality (a handful of branches × thousands
of calendar days) puts collision probability at a small fraction of a percent over the system's
lifetime. More importantly: `hashtext()` is deterministic, so the *same* `(branch_id, voucher_date)`
always maps to the same key — real contention is never at risk. A collision only means two
*unrelated* branch/date pairs occasionally share a lock key, causing an unnecessary wait
(milliseconds, for these transaction sizes) before proceeding normally. Advisory locks are pure
mutual exclusion — a collision can only add unwanted exclusion, never remove exclusion where it
was needed, so this can never manifest as a correctness bug.

**One code path, not one shared formula feeding independent call sites.** The helper owns the
actual lock call, not just the key derivation:

```typescript
// Sole entry point for the day-close advisory lock. No other code may call
// pg_advisory_xact_lock for this purpose, and the namespace constant is not
// exported — there is no raw key for a future call site to reimplement
// against, only this function.
async function acquireDayLock(tx: Tx, branchId: string, voucherDate: Date): Promise<void> {
  const key = `${branchId}|${formatISODate(voucherDate)}`;
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(${DAY_CLOSE_LOCK_NAMESPACE}, hashtext(${key}))`;
}
```

`assertNotPastDayClose`'s real implementation (replacing the Iteration-3 no-op stub) calls
`acquireDayLock(tx, branchId, voucherDate)` first, then queries `day_closes` for
`MAX(close_date) WHERE branch_id = X AND status = 'closed'` and rejects if `voucherDate` falls
on/before it. Every caller — old and new — still only ever calls `assertNotPastDayClose`; zero
shape change at those call sites. `closeDay`/`reopenDay`/`recloseDay` call `acquireDayLock`
directly, since they're not checking a voucher, they *are* the day-close operation — but resolve
through the same single function, so the key-derivation formula cannot drift between the two use
sites.

`pg_advisory_xact_lock`'s lifetime is tied to the enclosing Postgres transaction; `tx.$queryRaw`
runs on that same transaction/connection inside `runTransaction`, so acquire/release is correct
with no special handling needed from `runTransaction` itself.

**Throughput note, not a blocker:** this serializes mutations for a given `(branch, date)` only
during the narrow window a close/reopen/reclose is actually running — negligible given closes are
rare, brief, once-a-day events, and serializing sales around the exact moment of a close is the
correct behavior, not a cost to avoid.

### 35.6 Close / reopen / reclose ordering

**`closeDay(branchId, closeDate, actualCash, note, idempotencyKey)`:**

1. `acquireDayLock(tx, branchId, closeDate)`.
2. Load existing `day_closes` row for this key, if any:
   - `status = 'closed'` already → reject (`DAY_ALREADY_CLOSED`; must reopen first).
   - `status = 'reopened'` → this is a reclose.
   - No row → first close for this date.
3. Resolve `opening_cash` (§35.3).
4. Compute `expected_closing_cash` (§35.2).
5. `short_over = actualCash − expected_closing_cash`.
6. Upsert the row, `status → 'closed'`.
7. Audit + idempotency, same shape as every other transactional service.

**`reopenDay(branchId, closeDate, reason, actor)`** — Admin/Super Admin only (Blueprint §10.11):

1. `acquireDayLock(tx, branchId, closeDate)`.
2. Load row; must exist and be `status = 'closed'` (else Not Found/Conflict).
3. GST-filed-period check (§35.7).
4. `status → 'reopened'`, `reopen_reason` mandatory, `reopened_at`/`reopened_by`.
5. Audit before/after.

Reclose runs `closeDay` again against the same key, recomputing `expected_closing_cash` and
`short_over` fresh — both the original close and the reclose are preserved via the audit
before/after snapshot on each transition, the same pattern `editSale`/`cancelSale` already use.

### 35.7 New forward dependency — GST-filed-period check (mirrors T-6)

§20 point 4 requires blocking reopen inside a period whose GSTR has been filed. That state doesn't
exist yet — GSTR export/filing tracking is Iteration 6 scope. Same sequencing shape as
`assertNotPastDayClose` was for Iteration 3: ship the check now, reading state that doesn't
populate until Iteration 6 lands it, vacuously permissive in the meantime, activates automatically
once that state exists. Tracked deliberately here, the same way T-6 was tracked, rather than left
as an implicit gap to rediscover later.

### 35.8 Permissions

Blueprint §10.11: "the operator enters the count" but "only Admin/Super Admin resolve
discrepancies." Read: Employee-level roles can perform the close itself (enter count; the system
computes and stores `short_over` automatically as part of that action). Reopen is Admin/Super
Admin only (§20 point 3, and independently stated in Blueprint §10.11) — "resolving a
discrepancy" beyond simply recording it is understood to mean the reopen path, not a separate
resolution mechanism the spec doesn't otherwise describe.

---

## 36. What Iteration 4 Locks, and What's Next

**Locked this iteration:** CC-8 (cancelled-voucher historical-only rule, extending CC-1…CC-7); the
atomic `confirmPayment` service — `cash_bank_ledger_id` resolution and its Cash-in-Hand/Bank
Accounts-specific validation, the two-line posting shape, Fast Expense Entry as a thin wrapper,
payment allocation input shape and locked direction pairing (receipt→sale, payment→purchase); the
`remainingBalance` helper and its full guard/lock/check-ordering discipline; the ledger statement
view (window-function running balance); the bill-wise outstanding/ageing report; and day-end cash
reconciliation in full — the `day_closes` schema, the `ledger_postings`-sourced expected-cash
formula, the opening-cash-from-actual sourcing rule, the retroactive extension of the day-close
guard to voucher creation, and the `pg_advisory_xact_lock` concurrency mechanism.

**Schema added this iteration:** `day_closes` (§35.1). `payments`/`payment_allocations` get their
first writer (`confirmPayment`) against the schema already locked in §25.5.

**Retroactive changes to already-shipped Iteration 3 code:** `confirmSale` and `confirmPurchase`
must add a call to `assertNotPastDayClose` (§35.4); `assertNotPastDayClose` itself moves from a
no-op stub to a real implementation that also acquires the advisory lock (§35.5).

### 36.1 Carried into Iteration 5 / Iteration 6 (not resolved this iteration)

1. **Refund cross-pairing** (receipt→purchase, payment→sale) — deferred to Iteration 5's Credit
   Note / returns design, which is what actually generates refunds (§31.6).
2. **GST-filed-period state** for the reopen guard (§35.7) — populated in Iteration 6.
3. **`number_series.voucher_type` CHECK constraint** — unconfirmed against the live schema
   (§31.2); verify before `confirmPayment` ships, migrate if needed.
4. **Expense category modeling** (§31.5) — open business question, needs an answer from Karan
   before Fast Expense Entry's picker UI is built.
5. **Ageing bucket edges** (§34) — provisional engineering default; worth a check against the
   accountant's actual convention before treated as final. Add to the `PROJECT_ROADMAP.md` §9
   parked list alongside the existing business-conversation items.
