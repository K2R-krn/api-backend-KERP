# Fertilizer Shop Management System — Project Roadmap & Handoff

> **Purpose of this document:** a self-contained handoff so the project can continue in a new chat with nothing lost. It captures how we work, every decision already locked, exactly what each remaining iteration must contain (no points missed), where to start building, and how to resume. Read alongside the two authoritative documents below.

---

## 0. The three documents

| Document | What it is | Status |
|---|---|---|
| **`BLUEPRINT.md`** (rev 4) | *What & why.* Product/functional spec — features, modules, workflows, confirmed decisions. | Complete & locked. |
| **`TECHNICAL_DESIGN.md`** (TDD) | *How.* Engineering spec, built iteration by iteration. Iterations 1–4 done. | Iterations 1–4 locked; 5–7 to write. |
| **`PROJECT_ROADMAP.md`** (this) | *The plan & handoff.* Methodology + full roadmap for iterations 3–7 + where to start. | This doc. |

The Blueprint and TDD are authoritative. This roadmap points into them; if anything ever conflicts, those two win.

---

## 1. The project in one page

A custom, multi-branch business-management platform to **replace TallyPrime** for a family fertilizer shop's daily operations. Built solo. The whole reason it exists: **better, simpler UI that works equally well on PC (web) and mobile** — easier than Tally for everyday shop staff.

- **Architecture:** one shared **API backend** holds all business logic; **web** and **mobile** are separate thin clients that only talk to the API.
- **Model:** mirrors Tally's proven three layers — **Masters → Transactions → Reports** — but wins on UX (e.g. merging Sales+Receipt and Purchase+Payment into one screen).
- **Scope:** multi-branch with per-branch stock/ledgers; a Super Admin sees every shop individually and consolidated.

---

## 2. How we work (methodology — keep doing this)

1. **Design-then-build, one iteration at a time.** We write an iteration's technical design, review it, lock it, then build that phase — *then* write the next iteration. We do **not** design everything up front, because building each phase teaches us things the next design should reflect.
2. **One exception — cross-iteration data contracts are NOT iterative.** Anything defining the shape of stored financial data (posting sign conventions, stock costing, edit-vs-day-close, voucher dates) was locked *before* the first row exists, in the **TDD Data-Contract Addendum (§18–22)**. Iterations 3+ implement those contracts; they never re-decide them.
3. **Iterations map to build phases** (see §4). TDD Iteration *n* ≈ Blueprint Phase.
4. **Review before lock.** Each iteration is checked for expensive-to-fix-later issues before it's called done.
5. **Definition of done — "built" means:** endpoints implemented and validated; **service-layer tests pass** (including the golden invoice-math cases wherever money is touched — TDD §22.1); audit rows verified; docs updated to match reality. Design "locked" ≠ phase "done".
6. **Now-vs-later discipline.** Anything that would be painful to change after code/data exists gets decided now and flagged `⚠️ Now-vs-later` in the TDD.
7. **Nothing is ever hard-deleted; everything is branch-aware and audit-logged from line one.**
8. **The docs stay in lockstep with reality** — update them as decisions change.
9. **Docs serve the code, not the reverse.** The foundation is now designed; the priority is a running Phase 0/1, not more documents. Don't write Iterations 4–7 in detail until their build is near.

---

## 3. Consolidated locked decisions (full context in one place)

### 3.1 Stack
- **Language:** TypeScript (strict).
- **API:** Node.js + Express. All business logic here.
- **DB:** PostgreSQL via **Supabase — used as managed Postgres only** (and Storage later). **Not** Supabase Auth.
- **ORM/migrations:** **Prisma** + Prisma Migrate (migrations mandatory, committed). Needs Supabase pooled `DATABASE_URL` (runtime) + direct `DIRECT_URL` (migrations).
- **Auth:** **custom**, in our API (authentication *and* authorization). Admin-provisioned users, no self-signup.
- **IDs:** UUID (`gen_random_uuid()`). **Money:** integer **paise as `bigint`**. **Quantity:** `numeric(12,3)`.
- **Docker:** not yet (added at deployment, Iteration 7).
- **Clients:** web (React) now; **mobile deferred** (framework chosen later; doesn't affect API).

### 3.2 Roles (4 global roles + branch access list)
- **Super Admin** — all branches; creates/manages all users (sets ids + passwords), assigns branches; everything.
- **Admin** — full operations within assigned branch(es), incl. bill edit/cancel, stock adjustment; no user management.
- **Employee** — daily billing/receipts/payments/expenses within assigned branches; cannot edit/cancel confirmed bills.
- **Accountant** — read-only, **reports only**, for assigned branches.
- Branch scope via `user_branches`; Super Admin bypasses it. **Password reset:** admin-reset now; **email self-service reset is a future option** (optional `email` column already present).

### 3.3 Hosting & backups
- **Supabase free tier** for dev and early production → upgrade to **Pro ($25/mo)** when DB nears **500 MB** (~9–14 months at ~30 orders/day × 2 shops; audit log is the main driver).
- **Backups (our responsibility, GO-LIVE PREREQUISITE):** nightly `pg_dump`, **rolling 7-day retention**, to separate storage — **must be running before the first real transaction**, not deferred to the deployment iteration.
- **Environments:** two Supabase projects — **dev + prod** (both can start free). Prod secrets only in the prod host env; dev gets fixtures, prod only the clean seed.
- **Error monitoring:** **Sentry free tier wired into the API before first live use** — uncaught exceptions + failed money-transaction alerts must reach you within minutes from day one live.
- Auto-pause not a concern (optional keep-alive ping if ever needed).
- **Keep the audit log lean** — main lever for storage runway.

### 3.4 Product / functional decisions (from Blueprint)
- **No batch/expiry tracking.**
- **Per-branch GSTIN**, per-branch invoice number series, **state code on branch + customer** → intra vs inter-state tax (CGST+SGST vs IGST), **logic built now, used later**.
- **Single sale price per product** (no price lists, no per-customer rates); **discount is a billing-time toggle** (off by default).
- **GST inclusive/exclusive supported, default exclusive** (mirrors Tally); flippable per product / per bill.
- **Per-line tax classification** (taxable/exempt/nil/non-GST); **one register, classified — no separate GST/non-GST tables.**
- **Negative stock hard-blocked at billing** (checked as lines added + at save); genuine discrepancies fixed via Stock Adjustment.
- **No customer credit limit.**
- **No offline mode** — server-authoritative + idempotency keys + light resilience (no data loss on dropped request, connection indicator, cached read-only lists).
- **Customer identity = name + village** (mobile/email optional; phone-as-identifier deferred).
- **GST rounding — decided:** per-line tax rounded to paise, summed (never re-round the total); optional nearest-rupee invoice round-off to a Round Off ledger (controlled by `company_profile.rounding_mode`).
- **Combine Sales+Receipt and Purchase+Payment** into single screens with cash/online/udhar (and partial mixes).
- **Segregated Customer/Supplier UI** over a **unified `parties` model**; a `both`-type party has one ledger.
- **Friendly account-group names** (Customers/Receivables, Suppliers/Payables) mapping to Tally's Sundry Debtors/Creditors.

### 3.5 Data-model principles (from TDD)
- **One shared `products` catalog + per-`(branch, product)` `branch_stock`** (quantity + low-stock threshold per branch). Never per-branch product tables.
- **One shared `parties` table**, tagged with `owning_branch_id`. Balances stay whole across branches.
- **Opening balance lives on the ledger only** (`ledgers.opening_balance`); not on parties.
- **Balances are computed** (opening + sum of postings), never stored as a mutable field.
- **Party→ledger link is one-directional** (`parties.ledger_id`); ledgers carry no `party_id` (avoids circular FK).
- **Soft-delete everywhere** (`deleted_at`) + **partial unique indexes** (`WHERE deleted_at IS NULL`) for unique business columns.
- **Audit log = one generic table**, lean (changed-fields-only on edits), written inside the same transaction as the change.
- **Number series** per `(branch, voucher_type, financial_year)`; allocated under a row lock; cancelled numbers retained (GST).
- **`company_profile`** = single-row business-wide settings (name, logo, invoice terms, rounding mode, FY start month).

### 3.6 Financial data contracts (locked in TDD §18–22 — bind all future iterations)
- **Ledger postings:** signed `amount` (debit positive, credit negative); every voucher's postings sum to zero; balance = opening + SUM(amount); **every posting carries the source voucher's `branch_id`** (this is what makes per-branch GSTIN reports work off shared GST ledgers). Full posting map per voucher type in TDD §18.3.
- **Inventory costing: weighted average per (branch, product)**, cached in `branch_stock.avg_cost`; **every `stock_movements` row carries `rate` + `value` (paise)**; sales move out at avg cost (= COGS), transfers at source avg, adjustments at current avg. Valuation table in TDD §19.3.
- **Bill edit vs day-close:** bills dated on/before the branch's last closed day cannot be edited directly — correct via Credit Note dated today (preferred), or Admin explicitly **reopens** the day-close (audited) and must re-close; **GST-filed periods are credit-note-only**. TDD §20.
- **Voucher dates:** every transaction has a user-entered `voucher_date` (`date` type, defaults to today **in IST**), separate from `created_at`; Day Book, day-close, FY, and report filters all use `voucher_date`. TDD §21.
- **BigInt paise serialize as JSON numbers** (safe to ₹90 trillion). TDD §3.2.
- **Testing bar:** service tests on a real test DB for all money-touching services + a **golden invoice-math suite** (rounding, inclusive/exclusive, free qty, IGST/CGST) + the sum-to-zero invariant in every transaction test. TDD §22.1.
- **API contract:** Zod schemas are the source of truth; export inferred types via a shared package (or OpenAPI) before the web frontend starts. TDD §22.2.

### 3.6 Backend architecture (from TDD Iteration 2)
- **Layers:** route → controller (thin) → service (all logic + DB transactions + audit) → Prisma. Services are HTTP-agnostic.
- **Auth:** Argon2id hashing; short access JWT (15 min) + rotating refresh token stored hashed in `refresh_tokens`.
- **Middleware order:** authenticate → authorize (**capability map**) → branch-context → idempotency (writes) → validation (**Zod**).
- **Audit:** central `writeAudit(tx, ...)` helper inside each transaction; lean diffing.
- **Idempotency:** `idempotency_keys` table; `Idempotency-Key` header on writes; insert-as-`in_progress` → replay-or-process.
- **Errors:** `AppError` hierarchy → central handler → standard envelope with stable `code`s.
- **Resilience contract:** all writes atomic + idempotent; reads retry-safe.

---

## 4. Where to start building (do this first)

Phase 0 + Phase 1 (foundation + masters) were built from Blueprint + TDD Iterations 1–2. Steps taken, in order:

1. **Init the `api-backend` repo** with the structure in TDD §2 (TypeScript, Express, modules/middleware/shared). - DONE
2. **Create a Supabase project** (free tier). Grab the **pooled** and **direct** connection strings. 
3. **Wire Prisma** (TDD §1.2): `schema.prisma` datasource with `url` (pooled, `?pgbouncer=true`) + `directUrl` (direct 5432). Set `.env` (`DATABASE_URL`, `DIRECT_URL`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`).
4. **Translate the Phase 0/1 schema (TDD §5–6) into `schema.prisma`** — all tables, common columns, soft-delete, partial unique indexes, the FK relationships, `company_profile`. Run the **first migration**.
5. **Seed** the `account_groups` standard set and create the first Super Admin user (script).
6. **Build the backend skeleton (TDD Iteration 2):** error handler + envelope, Zod setup, custom auth (login, refresh, change-password), the authenticate/authorize/branch-context middleware, the audit helper, idempotency middleware.
7. **Build one master end-to-end as a vertical slice** — Products or Parties — full CRUD through route → controller → service → Prisma, with validation, auth, branch scoping, and audit. **This proves the whole architecture works.**
8. Then build the remaining masters (branches, users, units, categories, the other of products/parties) + opening-balance/stock import.

Phase 0 + Phase 1 (foundation + masters) are now fully built. Iteration 3 (Transactions) is now **fully built** — schema, `confirmSale`, `confirmPurchase`, Stage 4's read features, and `editSale`/`cancelSale`, all tested against the real dev DB and committed (see `BUILD_LOG.md` §11). Iteration 4 (Payments, Ledgers, Outstanding, Cash Reconciliation) is designed and locked — see `TECHNICAL_DESIGN.md` §30–36. The next action is **building it**: schema first (`day_closes`, TDD §35.1), then `confirmPayment` (TDD §31), then the statement/ageing views (TDD §33–34), then day-close (TDD §35.6).

---

## 5. Iteration roadmap (3–7) — exhaustive scope

There are **7 iterations total**; 1–2 are done. The count is a guide, not sacred — a heavy iteration may split (e.g. 3a/3b), a light one may merge. Each is written just before it's built.

### Iteration 3 — Transactions (Blueprint Phase 2, the MVP heart)
**Schema (transaction tables):**
- `sales` (header) + `sale_line_items` — lines carry Blueprint §6.14 columns: per-unit rate as entered, `billed_qty`, `free_qty` (scheme), discount, `gst_rate`, `price_includes_gst` flag, `tax_classification`, computed taxable/tax/total, and denormalized `customer_id`/`branch_id`/`sale_date` (for last-price recall).
- `purchases` (header) + `purchase_line_items` — mirror; denormalized `supplier_id`/`branch_id`/`purchase_date`.
- `payments` (+ `payment_allocations`) — unified receipt/payment record with direction; links optionally to a sale/purchase or stands alone.
- **`ledger_postings`** — the double-entry backbone; every money movement writes debit/credit lines against ledgers.
- **`stock_movements`** — the inventory backbone; every quantity change writes an immutable row (product, branch, ±qty, reason, source doc, **and `rate` + `value` in paise per the costing contract, TDD §19**). `branch_stock.quantity` (and `avg_cost`) are fast caches updated in the same transaction.
- Forward-looking ER diagram for the transaction layer.
- Composite indexes incl. last-price-recall `(customer_id, product_id, sale_date DESC)` and the purchase equivalent.

**Services / logic:**
- **Atomic Sale service (crown jewel)** — in ONE DB transaction: lock stock rows (`SELECT … FOR UPDATE`) and enforce the negative-stock hard-block; apply GST rounding (§3.11), inclusive/exclusive, CGST/SGST vs IGST by state comparison; handle discount toggle and free/scheme qty; allocate invoice number from `number_series` (concurrency-safe); decrement `branch_stock` + write `stock_movements`; write `ledger_postings` (sale revenue + GST + receipt/udhar split across cash/online/credit); write audit row; honor idempotency key.
- **Atomic Purchase service** — mirror; adds stock; supplier payable; last-cost recall.
- **Last-price recall** endpoint (sales) + **last-cost recall** (purchase).
- **Hold / park a bill** — draft that does NOT touch stock, ledger, or number series until confirmed.
- **Bill edit / cancel workflow** (Admin/Super Admin only) — reverse & re-apply atomically; **partially-paid ledger auto-adjust** (payments stay, new udhar = new total − paid, overpayment → advance); **cancelled invoice number retained** in series (GST); audit before/after.
- **Billing product search** — branch-stocked items (inner join to `branch_stock`), live quantity shown.
- **Printable invoice data shape** — the payload the print/PDF layer consumes (company_profile branding + branch GSTIN/address + line detail + tax split + payment breakdown + amount in words), **including the derived document title per the GST document-type rule (TDD §23.1): Tax Invoice / Bill of Supply / Invoice-cum-Bill of Supply, computed from line classifications + buyer registration status.**

**Implements the locked contracts (TDD §17.1 + §18–22):** stock row-locking via `$queryRaw ... FOR UPDATE`; the §18 posting map (postings sum to zero, `branch_id` on every posting); §19 weighted-average costing (COGS at avg cost, avg recompute on inbound); the §20 edit-vs-day-close check in the edit service; `voucher_date` per §21; the idempotency failure path (§14.2); `both`-party ledger group default (Customers/Receivables, balance nets); the §3.11 rounding rule; golden invoice-math tests (§22.1).

### Iteration 4 — Payments, Ledgers, Outstanding, Cash Reconciliation (Blueprint Phase 3)
- **Standalone Receipt** voucher (collect old udhar) and **standalone Payment** voucher (pay old dues / expenses).
- **Fast Expense Entry** — dedicated one-tap flow (category + amount + cash/bank) over a Payment voucher; pre-seeded expense categories.
- **Ledger posting sign conventions — already locked in the TDD Data-Contract Addendum (§18)**; Iteration 4 *applies* the contract (statements, balances), it does not define it.
- **Balance computation** — opening balance + sum of postings; running **ledger/account statement** per party/cash/bank (date-filtered, running balance).
- **Payment allocation** — apply a receipt to specific bills, or on-account/advance.
- **Customer credit balance / advance** handling (from over-edits and returns) — how it's shown and applied to a next bill.
- **Outstanding receivables/payables** with **ageing** (0–30 / 30–60 / 60+), per-branch and consolidated.
- **Day-end cash reconciliation (cash closing)** — expected cash (opening + cash receipts + cash sales − cash payments/expenses − bank deposits) vs counted; short/over recorded; printable day-close summary; per-branch/day; operator enters count, Admin resolves discrepancies.

### Iteration 5 — Returns, Adjustments, Contra, Journal (Blueprint Phase 4)
- **Credit Note (Sales Return)** — links to original invoice, per-line qty cap, adds stock back (+ `stock_movements`), reverses GST + ledger; refund/credit-balance handling.
- **Debit Note (Purchase Return)** — links to original purchase, per-line qty cap, removes stock with negative-stock check, reverses GST + ledger.
- **Stock Adjustment / Write-off** — reasons (Damage/Spillage/Theft/Expiry/Count-Correction), up or down, posts to a loss/adjustment ledger, `stock_movements` row, **Admin-only**.
- **Stock Transfer between branches** — source decrement + destination increment, two `stock_movements`, no money.
- **Contra** — cash↔bank transfer within the business.
- **Journal** — pure accounting adjustments (no cash/stock), debit/credit lines to `ledger_postings`.

### Iteration 6 — Reports & GST Exports (Blueprint Phase 5)
- **Daily:** Day Book, Sales Register, Purchase Register.
- **Cash/Bank:** Cash Book & Bank Book (per branch).
- **Inventory:** Stock Summary (branch-wise), Low Stock report + alerts, Stock Movement, Stock Valuation.
- **Party:** Outstanding receivables/payables with ageing; Account/Ledger Statement.
- **Financial:** Profit & Loss (per branch + consolidated), Balance Sheet — **resolve `account_groups` direct/indirect split** (deferred from Iteration 1) for gross-vs-net profit.
- **GST:** GSTR-1 friendly export (B2B/B2C split), GSTR-3B summary, HSN-wise summary, tax collected vs paid.
- **Report architecture:** all reports are **computed views**, never stored; indexing/performance; date filters in business context (FY boundaries).

### Iteration 7 — Multi-branch Consolidation, Deployment & Ops (Blueprint Phases 6 + 7)
- **Super Admin consolidated dashboard** — every shop individually and combined: revenue, profit, cash position, stock value, outstanding, top products, low-stock.
- **Branch-wise financial + stock views**; cross-branch stock and outstanding visibility.
- **Deployment:** API hosting choice (VPS/Render/Railway), **Docker** introduced here; environment/secrets management.
- **Backups:** verify the nightly `pg_dump` rotation (running since go-live — §3.3) plus restore-drill; optional keep-alive ping; independent off-site copy.
- **Financial-year close & carry-forward**; number-series rollover per FY.
- **Monitoring/logging** deepening (Sentry basics already live since go-live — §3.3).

---

## 6. Cross-cutting & go-live tasks (schedule around the iterations)
- **Opening balances & Tally migration import** (Blueprint §10.4) — import current stock quantities per branch (with a cost per product to seed `avg_cost`), party outstanding, cash/bank balances at go-live. Buildable once masters exist (after Phase 1); needed before the shop switches over. CSV/Excel import screen.
- **Go-live / cutover plan (the trust battle is won here, not in code):**
  - **Cutover date:** a clean boundary — ideally 1 April (new FY) or at minimum a month start.
  - **Parallel run:** 1–2 weeks where the shop runs **both** systems; reconcile daily closings (cash, sales totals, stock counts of a few key items) against Tally every evening. Discrepancies are bugs to fix before switching.
  - **Staff training** on the billing + receipt + expense flows before day one; a printed one-page cheat sheet.
  - **Rollback criteria:** if the parallel run shows unresolved money discrepancies, the shop stays on Tally and the switch waits. Defined in advance so it's not an argument later.
  - **Go-live prerequisites:** backup cron running (§3.3), Sentry wired (§3.3), opening balances imported and verified.
- **Financial-year handling** — FY string derived from `voucher_date` via the `fy_start_month` helper (TDD §5.5, §21), used in number series and report boundaries.
- **Seed data** — standard `account_groups`, default units, expense categories, first Super Admin, `company_profile` row (+ a **Round Off** ledger and a **Stock Loss/Adjustment** ledger, needed by the posting map TDD §18.3).

---

## 7. Polish backlog (deferred niceties — after core works)
- **Invoice output:** PDF generation, A4 + **thermal/receipt printer**, **WhatsApp share**, re-print/amended-marking.
- **Notifications:** low-stock alerts, daily summary (possible Telegram/WhatsApp layer).
- **Email-based password reset** (self-service) — the future auth option.
- **Order vouchers** (Sales Order / Purchase Order) — optional, non-MVP.
- **Barcode entry**, **loose-sale-by-kg vs full-bag** workflow, **"today at a glance"** home dashboard as the landing screen.

---

## 8. Frontend & mobile
- The TDD so far specifies the **API/backend**. The **web frontend** (React) is built against each iteration's API — screen work naturally follows each backend phase (masters screens after Phase 1, billing screen after Iteration 3, etc.).
- **Mobile is deferred** — framework (React Native / Flutter / other) chosen later; it consumes the same API, so backend design is unaffected. A dedicated frontend design pass can be its own track once the API surface stabilizes.

---

## 9. Open decisions still pending
- **⚠️ CONFIRM WITH THE FAMILY (one phone call, de-risks the billing screen):** are all branch GSTINs **regular registrations, not composition scheme**? If any branch is composition, the invoice model changes fundamentally (bill of supply, no tax collected, no GSTR-1 B2B). Also be clear with them: subsidized fertilizer moves through the government **DBT/PoS device** regardless — this system records the commercial sale and does **not** replace that device.
- **Confirm the edit-vs-day-close rule** (TDD §20, currently locked as: credit-note preferred, Admin reopen allowed with audit + re-close, GST-filed periods credit-note-only). If a stricter hard-block-only rule is preferred, it's a one-line change — decide before building the edit service.
- **Customer identity / dedup:** whether phone becomes a primary identifier (currently name+village; mobile optional). Deferred — non-breaking to enable later.
- **Mobile framework:** deferred.
- **Email self-service password reset:** planned future option (admin-reset for now).
- **`purchase:create` for the Employee role:** Blueprint and TDD conflict on whether Employees can create purchases. Left restrictive (Employee cannot) pending an actual conversation with the business — not resolved by inference. (Enforced in the capability map, `src/middleware/authorize.ts`.)
- **Discount entry UI: percentage vs absolute-₹.** Storage is already locked (absolute paise per line, TDD §25.2) regardless of the answer — this is a frontend decision, not a backend one.
- **GSTR-2B matching field requirements for `supplier_invoice_number`/`supplier_invoice_date`** (TDD §25.3): don't guess the exact fields the accountant needs for ITC/purchase-return matching — verify with them before locking that path.
- **Invoice/voucher number display format — PROVISIONAL, confirm before go-live:** `{branch.code}/{financialYear}/{sequenceNumber, zero-padded to 4 digits}` (e.g. `BHM/2025-26/0001`), implemented in `formatVoucherNumber` (`src/shared/number-series.ts`). Chosen during Iteration 3's confirmSale build so the service had something concrete to call; not yet run past the actual business for sign-off the way the other open items above are.
- **Per-line GST rounding convention — confirm with whoever handles GST filing.** `confirmSale` (TDD §26 step 4) rounds each line's tax with standard round-half-up (`Math.round`-equivalent, applied via integer basis-point math, never float). TDD §3.11/§26 don't specify half-up vs. banker's rounding vs. any other convention — this was an engineering default chosen to ship the service, not a confirmed accounting decision. Verify against the actual GSTR-1 filing convention before go-live; a mismatch here would only surface as odd-paise drift on real invoices, easy to miss until an audit.
- (Everything else is locked — see §3.)

---

## 10. How to continue in a new chat

1. **Attach all three documents** to the new conversation: `BLUEPRINT.md`, `TECHNICAL_DESIGN.md`, `PROJECT_ROADMAP.md`.
2. **Opening prompt suggestion:**
   > "I'm building the fertilizer-shop management system described in these three docs. Blueprint and TDD are locked through the current iteration (check `TECHNICAL_DESIGN.md` §0 for exactly which). I want to continue per the roadmap's design-then-build methodology (§2: design-then-build, review-then-lock, now-vs-later discipline) and keep the docs in lockstep."
3. **To build first:** ask for help scaffolding the repo, writing `schema.prisma` from TDD §5–6, and the auth + one-master vertical slice (roadmap §4).
4. **To build Iteration 4:** Iteration 4's design is locked (TDD §30–36) — the next step is building it, starting with the `day_closes` schema (TDD §35.1), then `confirmPayment` (TDD §31), then the statement/ageing views (TDD §33–34), then day-close (TDD §35.6).
5. **Keep the loop:** design an iteration → review → lock → build the phase → next iteration.

---

*End of roadmap. With the Blueprint, the TDD, and this document, the project can be picked up and continued end-to-end.*
