# Fertilizer Shop Management System — Complete Project Blueprint

> A custom, multi-branch business management platform built to replace TallyPrime for daily shop operations, with a focus on an easy, modern UI that works equally well on PC (web) and mobile.

**Document status:** Planning / Blueprint (no implementation)
**Revision:** 4 — renamed debtor/creditor groups to Customer/Supplier-friendly names (with Tally equivalents noted), fleshed out Purchase (stock + GST inclusive/exclusive), added returns stock-checks and original-document linking, defined the partially-paid bill edit rule (auto ledger adjustment), removed customer credit limit
**Stack:** Node.js + Express (API), PostgreSQL (DB), React (web), React Native or equivalent (mobile)
**Architecture:** One shared API backend repository, two separate frontends (web + mobile) consuming the same API.

---

## 1. Project Goals & Guiding Principles

### Why we are building our own software
Tally is powerful but its UI is dense, keyboard-driven, desktop-only, and intimidating for everyday shop staff. Our entire reason to exist is **better UX and ease of use across PC and mobile**. Every design decision should be measured against one question: *Is this easier and faster than doing it in Tally?* If the answer is no, rethink it.

### Core principles
1. **One backend, two faces.** The API holds all business logic. Web and mobile are thin clients. No business rule should live only in a frontend.
2. **Branch-aware from day one.** Every transaction, every stock figure, every ledger entry belongs to a branch. Retrofitting this later is extremely painful — bake it in from the first table.
3. **Super admin sees everything; branch users see their branch.** Data isolation is enforced at the API layer, never trusted from the client.
4. **Nothing is ever hard-deleted.** Financial data uses soft-deletes and an immutable audit log. This matters for GST and for trust.
5. **Combine where Tally separates.** Tally splits Sales and Receipt, Purchase and Payment. We merge them into single screens so one action records both the transaction and the money — that's our biggest UX win (detailed in Section 6).
6. **Masters first, then transactions, then reports.** This is also the build order.

---

## 2. The Mental Model (Tally → Our App)

Tally organizes everything into three layers. We keep the same mental model because it is correct and battle-tested:

```
MASTERS        →  setup data, created once, changes rarely
TRANSACTIONS   →  daily entries (vouchers), the actual work
REPORTS        →  outputs derived from transactions
```

Plus three cross-cutting concerns that wrap around all three:
- **Authentication & Roles** (who can do what)
- **Multi-branch context** (which shop am I acting on)
- **Audit log** (what happened, when, by whom)

Everything in this document fits into one of those buckets.

---

## 3. System Architecture

### 3.1 High-level shape
```
        ┌──────────────┐         ┌──────────────┐
        │  Web (React) │         │ Mobile (RN)  │
        └──────┬───────┘         └──────┬───────┘
               │      REST/JSON         │
               └───────────┬────────────┘
                           │
                   ┌───────▼────────┐
                   │  API Backend   │   ← all business logic, validation,
                   │ (Node/Express) │     auth, RBAC, branch isolation
                   └───────┬────────┘
                           │
                   ┌───────▼────────┐
                   │  PostgreSQL    │   ← single source of truth
                   └────────────────┘
```

### 3.2 Repository strategy
- **`api-backend`** — Express app, database migrations, business logic, auth. The brain.
- **`web-frontend`** — React app for PC/desktop use (billing counter, admin).
- **`mobile-frontend`** — mobile app for on-the-go viewing, quick billing, stock checks.

Consider a shared package (or just a shared folder/published types) for **API contract types** so web and mobile never drift from the backend's expectations.

### 3.3 API design conventions (decide these early, follow them everywhere)
- Consistent resource naming: `/api/v1/products`, `/api/v1/sales`, etc.
- Every list endpoint supports `branch_id`, pagination, search, and date filters.
- Standard response envelope (e.g. `{ data, meta, error }`) so both clients parse identically.
- Branch context passed and **validated server-side** on every request — never trust a `branch_id` from the client without checking the user is allowed to touch it.
- Versioned API (`/v1/`) so you can evolve without breaking the mobile app already in someone's hand.

---

## 4. Users, Roles & Permissions (RBAC)

Roles, from most to least powerful. Exact permissions are tunable, but this is the starting matrix:

| Capability | Super Admin | Branch Admin | Billing Operator | Viewer |
|---|---|---|---|---|
| See all branches | ✅ | ❌ (own only) | ❌ (own only) | depends |
| Create/edit masters (products, parties) | ✅ | ✅ | partial | ❌ |
| Create sales / billing | ✅ | ✅ | ✅ | ❌ |
| Create purchases | ✅ | ✅ | partial | ❌ |
| Record payments/receipts | ✅ | ✅ | ✅ | ❌ |
| Vouchers (contra, journal, notes) | ✅ | ✅ | ❌ | ❌ |
| Stock adjustment / write-off | ✅ | ✅ | ❌ | ❌ |
| View reports & ledgers | ✅ (all) | ✅ (own) | limited | ✅ (read) |
| Manage users & roles | ✅ | partial | ❌ | ❌ |
| **Edit / cancel a confirmed bill** | ✅ | ✅ | ❌ (must escalate) | ❌ |
| Day-end cash reconciliation | ✅ | ✅ | enter count only | ❌ |
| View audit log | ✅ | ✅ (own branch) | ❌ | ❌ |

**Key rule:** the super admin is the only role that can switch between branches and see consolidated, shop-by-shop figures. Every other user is locked to their assigned branch(es).

---

## 5. Data Model — The Masters

These are created once and changed rarely. Build the master-management screens before any transactions.

### 5.1 Branch / Shop
The root of multi-branch. Almost every other table references it.
- Name, code, address, **GSTIN (each branch has its own — confirmed)**, contact, active flag.
- **State / state code (confirmed required)** — this is what drives the inter-state vs intra-state tax decision on every invoice. Capture it even though most sales are local today.
- Per-branch invoice number series (GST requires an unbroken series per GSTIN).

### 5.2 User
- Name, login credentials, role, assigned branch(es), active flag.

### 5.3 Account Groups
Grouping that makes the ledgers and reports work. We use plain Customer/Supplier-friendly names instead of Tally's accounting jargon, but they map 1:1 to the standard Tally groups (noted in brackets) so the accounting stays correct. Pre-seed the standard ones:
- **Customers / Receivables** *(= TallyPrime's "Sundry Debtors")* — customers who owe us
- **Suppliers / Payables** *(= TallyPrime's "Sundry Creditors")* — suppliers we owe
- Bank Accounts
- Cash-in-Hand
- Sales Accounts, Purchase Accounts
- Direct/Indirect Expenses, Direct/Indirect Income
- Duties & Taxes (GST ledgers)
- Capital, Loans, Fixed Assets

> **Naming principle:** internally/in reports these map to the standard Tally groups, but the UI shows the friendly names. Compliance-meaningful terms (GST, HSN, Invoice, P&L) are kept as-is; only the confusing accounting-group jargon is renamed.

> You don't need the full Tally chart of accounts on day one, but having the group layer means your Balance Sheet and P&L "just work" later instead of being bolted on.

### 5.4 Ledgers
Every entity that money flows to/from is a ledger, sitting under a group:
- Customer ledgers (under **Customers / Receivables**)
- Supplier ledgers (under **Suppliers / Payables**)
- Bank account ledgers
- Cash ledger(s) — typically one per branch
- Expense/income ledgers (rent, salary, electricity, transport…)
- GST ledgers (CGST, SGST, IGST payable/receivable)

### 5.5 Customers / Parties
The customer master you specifically asked for:
- **Required:** Name, Village
- **Optional:** Mobile, Email, GSTIN (needed for B2B invoices), address, opening balance
- **State / state code** — needed for the inter-state tax decision (compared against the branch's state). Defaults to the branch's own state, so for local customers nobody has to think about it.
- Auto-linked to a customer ledger so outstanding ("kitna baaki") is always live.
- Branch tagging: which branch "owns" the relationship (but allow cross-branch lookup for super admin).

### 5.6 Suppliers
Same shape as customers, under **Suppliers / Payables**. Often the same screen with a "type" toggle.

### 5.7 Products / Stock Items
The heart of inventory:
- Name, **HSN code**, product code/SKU
- Category (product group)
- **Unit of Measure** (kg, bag/50kg, litre, piece…)
- **GST rate** (0 / 5 / 12 / 18 / 28) stored on the product itself
- Purchase price, **single sale price (confirmed — no multiple price lists, no per-customer rates)**. MRP optional.
- **"Price includes GST?" flag (default: No / exclusive)** — mirrors how TallyPrime works. By default the sale price is the pre-GST (taxable) value and tax is added on top. If this flag is on, the stored price is treated as GST-inclusive and the billing screen back-calculates the taxable value and tax out of it. Useful for the counter habit of quoting round all-in prices to farmers. *(See 6.1 for how billing uses it.)*
- **Low-stock threshold** — prompted while adding/editing the product ("alert me when stock for this item at this branch falls to ___")
- **Per-branch stock quantity** — the same product has independent stock at each branch (this is a separate stock-by-branch table, not a single number on the product)
- Active flag.
- **No batch/expiry tracking (confirmed not needed)** — keeps the product model simple. If a specific line ever needs it, it's a future addition, not a rewrite.

### 5.8 Units of Measure
Master list of units, with conversion where relevant (1 bag = 50 kg). Critical that the unit flows correctly from product → invoice → stock.

### 5.9 Categories / Product Groups
For organizing the catalog and category-wise reporting (fertilizers vs pesticides vs seeds vs tools).

### 5.10 Business / Company Profile
Business-wide settings that sit *above* branches: the trade/legal name, logo, and invoice terms/footer for the printable invoice (§9), plus global preferences like the rounding rule and financial-year start. A single record, not a list. Per-branch identity (GSTIN, address) stays on the branch; this holds only the business-wide bits. (Schema: TDD §5.6.)

---

## 6. Data Model — The Transactions (Vouchers)

This is where the daily work happens. **The big design decision is merging Sales+Receipt and Purchase+Payment** — your explicit question, and yes, it's the right call.

### 6.1 The unified Sales / Billing voucher ⭐ (the crown jewel)
This is the single most-used screen and the strongest reason to build your own software. One screen does what Tally splits across two vouchers.

**What it captures:**
- Branch, date, customer (pick existing or quick-add by name + village)
- Line items: each row = product, quantity, rate, **discount (confirmed: a toggle on the billing screen — off by default; tick it to reveal a discount field, otherwise it never appears)**, **optional GST** (auto-pulled from the product, with a toggle to include/exclude)
- **Tax engine (build the logic now, even though sales are local today):** the invoice compares the branch's state code against the customer's state code. Same state → CGST + SGST. Different state → IGST. Because the comparison is built in from day one, enabling inter-state sales later needs no rework — you just start adding out-of-state customers.
- **GST inclusive vs exclusive (mirrors TallyPrime):** each line reads the product's "price includes GST?" flag. **Exclusive (default):** the rate is the taxable value and GST is added on top. **Inclusive:** the rate already contains GST, so the engine back-calculates taxable value and tax out of it (e.g. ₹1,500 incl. 12% → ₹1,339.29 taxable + ₹160.71 tax). The operator can also flip inclusive/exclusive on the bill itself, not just rely on the product default.
- Auto-calculation: taxable value → CGST+SGST (intra-state) or IGST (inter-state) → grand total.
- **Negative-stock check BEFORE the bill is confirmed (confirmed decision):** as each line is added and again at save, the system validates that the branch has enough stock. If a line exceeds available stock, billing is **blocked** with a clear message ("Only 8 bags in stock, you entered 10"). This prevents the system stock from ever going negative. An explicit admin-only override can be allowed later if a real need appears, but the default is hard-block. *(See also 6.10 — stock adjustment is the correct way to fix genuine physical discrepancies, not overselling.)*
- **Payment section in the same screen:**
  - Fully cash
  - Fully online (bank/UPI)
  - Fully **udhar** (credit — goes to the customer's outstanding)
  - **Any partial mix** — e.g. ₹2,000 cash + ₹1,000 online + ₹500 udhar, as long as the splits sum to the bill total (or less, with remainder becoming udhar)
- **Hold / Park a bill:** a half-finished bill can be parked (saved as a draft that does NOT touch stock, ledgers, or the invoice number series) so the operator can serve the next customer and resume later. Only on final confirmation does it become a real invoice. Essential for a busy counter.
- **Trade schemes / free quantity:** a line can carry a free/scheme quantity (e.g. "buy 10 bags, get 1 free") that **moves stock but is not charged**. The free units reduce inventory like any sale but contribute ₹0 to the taxable value. This is common in fertilizer/pesticide trade and must be modelled explicitly (a `free_qty` alongside `billed_qty` on the line), not faked with a 100% discount, so stock and GST both stay correct.
- On save, the system simultaneously:
  1. Creates the sale (revenue + GST ledgers)
  2. Reduces stock at that branch (billed qty + free qty)
  3. Records the receipt portion against cash/bank
  4. Pushes the unpaid portion to the customer's outstanding ledger
- Carries an **idempotency key** (see Section 10.9) so a network retry can never create the same bill twice.
- **Prints a clean GST invoice** (see Section 9).

> Under the hood you can still store this as a linked Sale + Receipt pair (cleaner for accounting), but the *user* sees one screen and one action. That's the whole point.

#### 6.1.1 Last-price recall (customer + product price memory) ⭐
When the operator selects a customer and adds a product line, the rate field is **pre-filled with the price this same customer last paid for this same product**, with context shown (e.g. *"Last sold to Ramesh: ₹520 on 12 Jun"*). If there's no prior sale, it falls back to the product's standard sale price.

**Important — this does not break the single-price decision.** There is still exactly one canonical sale price per product in the master. This is a *suggestion / recall layer* on top: the prefill is a starting point and the field stays **freely editable**. It is recall of history, not a per-customer price list.

**Why it's cheap:** the data already exists. Every sale line already records customer (via the sale header), product, rate, and date. "Last price" is just a query over history we already capture — no new core entity, no new pricing model.

**What it needs:**
- **Three denormalized columns on the line-item table** (see 6.14): `customer_id`, `branch_id`, `sale_date`. These let the lookup be a single indexed seek instead of a multi-table join. Cheap to add now, annoying to retrofit later.
- **A composite index** on `(customer_id, product_id, sale_date DESC)` so "most recent rate for this customer + product" is instant.
- **One read endpoint**, e.g. `GET /customers/:id/products/:productId/last-price` → `{ rate, date, quantity }`. Better still, prefetch last prices for the customer's frequently-bought items the moment the customer is selected, so there's no per-line lag.
- **(Optional, only if it ever gets slow)** a tiny cache table keyed `(customer_id, product_id) → last_rate, last_date`, updated on each sale. Premature for a single shop — the indexed query is plenty — but it's the escape hatch if volume grows.

**Decisions to lock for this feature:**
- **Recall list rate or net-after-discount?** Customers remember the *effective* price they paid, so recalling the net per-unit rate often matches expectations better. Store the actual per-unit rate as entered on the line and decide explicitly how discount factors in.
- **Scope per-branch** (consistent with per-branch GSTIN and branch isolation everywhere else), not global.
- **Ignore returns / credit notes** — base recall on actual sales only, never on reversals.

### 6.2 The unified Purchase / Payment voucher
Mirror image of sales:
- Branch, date, supplier, line items (product, qty, rate, GST from product/HSN).
- **Stock direction:** a purchase only ever **adds** stock at that branch, so unlike sales it can never drive stock negative — no pre-save stock block is needed here. (The only stock-decreasing purchase-side action is a purchase *return* / Debit Note — that one IS stock-checked, see 6.7.)
- **GST inclusive/exclusive:** same handling as sales (6.1). Supplier bills are often quoted inclusive of tax, so each line can be entered inclusive (engine back-calculates the taxable value) or exclusive. Defaults from the product flag, overridable on the bill.
- **Last-cost recall (optional, mirrors 6.1.1):** when a supplier + product is chosen, pre-fill the rate with the last cost paid to that supplier for that item. Same cheap query pattern as sales-side recall; same denormalized columns apply on the purchase line.
- Payment section: fully paid (cash/online), fully credit (we owe supplier), or partial mix.
- Unpaid portion → supplier's outstanding (payable).
- Carries an idempotency key (10.9) like every other transaction.

### 6.3 Standalone Receipt voucher
For collecting **old udhar** — when a customer who bought on credit last week comes in and pays. Not tied to a new sale. Reduces their outstanding, increases cash/bank.

### 6.4 Standalone Payment voucher
For paying suppliers' old dues, or paying expenses (rent, salary, electricity, transport). Reduces cash/bank.

### 6.5 Contra voucher
Cash ↔ Bank movements within the business. Example: depositing the day's cash collection into the bank. No customer/supplier involved.

### 6.6 Credit Note (Sales Return)
Customer returns goods (damaged bags, wrong grade — common in agri). Reverses part of a sale, with GST, and puts stock back. Reduces customer outstanding or creates a refund/credit balance.
- **Links to the original invoice** and cannot return more than was sold on it (per-line quantity cap). This keeps stock, GST, and the customer ledger honest, and prevents fake returns. A return without an original bill is possible but should be the exception, flagged and Admin-approved.
- **Adds stock back** at the branch — so it never hits the negative-stock block.

### 6.7 Debit Note (Purchase Return)
We return goods to a supplier. Reverses part of a purchase, with GST, and **removes** the stock.
- **Stock-checked like a sale:** because it decreases inventory, the system blocks a return for more than is currently in stock at that branch (you can't send back 10 bags if only 6 remain). Same hard-block rule as billing (6.1).
- **Links to the original purchase** and cannot return more than was purchased on it (per-line quantity cap). Reduces what we owe the supplier (payable) or creates a receivable from them.

### 6.8 Journal voucher
Pure accounting adjustments with no cash/stock movement: depreciation, write-offs, opening-balance corrections, inter-ledger transfers. Used occasionally, mostly by admin/accountant.

### 6.9 Stock Transfer (Stock Journal)
Move stock from one branch to another. Decreases source branch stock, increases destination branch stock. No money changes hands. **Essential for multi-branch.**

### 6.10 Stock Adjustment / Write-off ⭐ (daily-ops essential)
A way to change stock **without a sale or purchase**, for the routine physical realities of a shop: torn or burst bags, spillage, moisture damage, expired/caked stock, theft, or simply correcting a count after physical verification.
- Adjustment can be **down** (damage/spillage/theft/shrinkage — the common case) or **up** (found stock, count correction).
- Every adjustment **requires a reason/category** (Damage, Spillage, Theft, Expiry, Count Correction, Other) and optionally a note — this is what keeps the audit trail meaningful.
- Adjusts the branch's stock quantity and posts the value to an appropriate loss/adjustment ledger so the books stay balanced.
- Without this, damaged goods stay "in stock" forever and the stock report silently drifts from physical reality. This is the legitimate channel for discrepancies — **not** overselling through billing (which is hard-blocked, see 6.1).
- **Permissions:** restricted to Branch Admin and Super Admin (not billing operators), since it directly writes down inventory value.

### 6.11 Editing & Cancelling transactions (bill edit / cancel workflow) ⭐
A defined, safe workflow for fixing mistakes on a saved bill (wrong quantity, wrong customer, wrong rate) — which happens many times a day at a counter.
- **Permission: Super Admin and Branch Admin only.** Billing operators cannot edit or cancel a confirmed bill; they must escalate. (Reflected in the RBAC matrix, Section 4.)
- **Edit** = fully reverse the original transaction's effects (stock movement, ledger postings, payment allocation) and re-apply the new values atomically, so balances and stock are always consistent. The original and the change are both preserved in the audit log (who, when, before → after).
- **Cancel/void** = reverse all effects and mark the transaction cancelled with a mandatory reason. It is never physically deleted (consistent with the no-hard-delete principle).
- **GST invoice numbering rule:** a cancelled invoice number is **not reused and not removed from the series** — it remains as a cancelled entry so the per-GSTIN sequence stays unbroken (a GST requirement). Reports exclude cancelled bills from totals but the number is still accounted for.
- **Editing a partially-paid bill (the important case):** when items are added or removed (or quantities/rates change), the bill total recomputes and the customer's ledger **auto-adjusts** — money already received is never silently touched. The rule:
  - **Payments already received stay as-is** (the cash/online actually changed hands).
  - **New outstanding (udhar) = new bill total − payments already received**, and the customer's ledger is updated to that figure automatically.
  - **If the new total drops below what was already paid**, the excess becomes a **customer credit/advance** (or a flagged refund-due), not a silent loss.
  - *Worked example:* original bill ₹3,000 — paid ₹1,000 cash, ₹2,000 udhar. You remove an item; new total ₹2,500. The ₹1,000 cash stays; udhar auto-adjusts from ₹2,000 → ₹1,500. If instead the new total were ₹800, the ₹200 overpaid becomes a customer advance/refund-due.
  - Stock is reversed and re-applied for the changed lines (with the same negative-stock guard as billing), and the whole edit is one atomic operation so the ledger, stock, and payments never end up half-updated.
  - The revised invoice can be re-printed and is marked as amended; the original values remain in the audit log.
- Optional guardrail: edits/cancels to bills from a closed financial period or a filed GST period should be blocked or require a credit note instead.

### 6.12 Fast Expense Entry ⭐ (first-class daily flow)
Daily petty-cash outflows — tea, labour, loading, transport, fuel, small repairs — are technically Payment vouchers, but burying them under "vouchers" makes a constant daily action slow. Provide a **dedicated one-tap "Add Expense" flow**: pick an expense category, enter amount, choose cash or bank, optional note, done. Under the hood it creates a standard Payment voucher against the right expense ledger, so accounting stays clean while the UX stays fast. Pre-seed common expense categories so staff just tap.

### 6.13 (Optional, later) Order vouchers
Sales Order / Purchase Order for tracking confirmed-but-not-yet-fulfilled orders. Nice-to-have, not MVP.

### 6.14 Line-item table — design note
Sale and purchase line items each link to their parent voucher (which holds customer/supplier, branch, date). For performance of features like **last-price recall (6.1.1)**, denormalize a few header fields directly onto the sale line-item row:
- `customer_id`, `branch_id`, `sale_date` copied onto each sale line.
- Composite index `(customer_id, product_id, sale_date DESC)` for instant "last rate" lookups.

These are write-time copies of data that never changes after the sale is saved, so there's no consistency risk — and adding them now avoids a painful migration later. The **purchase line-item table mirrors this** with `supplier_id`, `branch_id`, `purchase_date` and the matching index, to power last-cost recall (6.2).

**Each line stores:**
- The **actual per-unit rate as entered** (the basis for price recall), quantity, free/scheme quantity, discount, GST rate, and computed taxable value + tax + total.
- An **inclusive/exclusive flag** so the line knows whether its rate already contained GST.
- A **tax-classification field** — `taxable` / `exempt` / `nil-rated` / `non-GST` — derived from the product. This is how TallyPrime keeps GST and non-GST entries in one register yet reports them correctly: there are **no separate GST vs non-GST tables or voucher types**, just this classification on each line. It's essential here because a single fertilizer-shop bill genuinely mixes classifications (seeds often exempt/0%, fertilizer 5%, pesticide 18%), and GSTR-1/3B buckets each line by this field.

---

## 7. Ledger Management

Every party, bank, and cash account has a **running ledger** — a chronological list of debits/credits with a live closing balance. This is what powers:
- "How much does this customer owe?" (receivables)
- "How much do we owe this supplier?" (payables)
- "What's the cash balance at this branch right now?"
- "What's the bank balance?"

**Requirements:**
- Per-ledger statement view (date-filtered), with running balance.
- Branch-wise: cash and bank balances are per-branch; customer/supplier outstanding can be viewed per-branch and consolidated.
- Outstanding summary screens: all receivables (who owes us, sorted by amount/age) and all payables.
- Drill-down: click any ledger entry → open the source voucher.

---

## 8. Reports

Reports are derived, never stored as primary data — they're always computed from transactions. Build the high-value ones first (marked ⭐).

**Daily operations**
- ⭐ Day Book — every transaction for a day at a branch
- ⭐ Sales Register — all sales, filterable by date/customer/product
- ⭐ Purchase Register
- ⭐ Cash Book & Bank Book — per branch
- ⭐ Outstanding Receivables / Payables (with ageing: 0–30, 30–60, 60+ days)

**Inventory**
- ⭐ Stock Summary — current stock per product, **branch-wise**
- ⭐ Low Stock Report — items at/below threshold (drives the alert)
- Stock Movement — ins/outs for a product over time
- Stock Valuation — value of stock on hand

**Financial**
- Profit & Loss (per branch + consolidated)
- Balance Sheet (per branch + consolidated)
- ⭐ Branch-wise financial dashboard for super admin (revenue, profit, cash, stock value side by side per shop)

**GST / Compliance**
- ⭐ GSTR-1 friendly export (outward sales, B2B/B2C split)
- GSTR-3B summary
- HSN-wise summary
- Tax collected vs paid

**Super admin consolidated views**
- ⭐ All-branches dashboard: each shop's sales, stock value, cash position, top products, outstanding — viewable individually and combined.

---

## 9. Printable Sales Invoice

A first-class feature, not an afterthought.
- **Document title is derived automatically from the bill's lines (GST rule, not a user choice):**
  - All lines taxable → **"Tax Invoice"** (normal layout with tax columns).
  - All lines exempt/nil (e.g. a seeds-only sale) → **"Bill of Supply"** — no tax columns, no tax collected.
  - Mixed taxable + exempt lines to an **unregistered** buyer (the everyday seeds + fertilizer bill) → **"Invoice-cum-Bill of Supply"** — one document, taxable lines show tax, exempt lines show none.
  - Mixed lines to a **registered** (GSTIN) buyer → Tax Invoice for the taxable lines; strictly the exempt lines belong on a separate Bill of Supply (rare at this counter; acceptable to split the documents in that case).
- GST-compliant layout: shop name + GSTIN + branch address, invoice number (per-branch series), date, customer name + village + GSTIN.
- Line items with HSN, qty, unit, rate, discount, taxable value, CGST/SGST (or IGST); exempt lines marked as such.
- Totals, amount in words, payment breakdown (cash/online/udhar), balance due.
- Print to A4 and to thermal/receipt printer (for fast counter billing).
- Re-printable from the sale record; downloadable as PDF; shareable (WhatsApp the bill is a huge convenience for shop owners).

---

## 10. Cross-Cutting Requirements

### 10.1 Audit Log (complete action log)
Immutable record of every meaningful action: who, what, when, from which branch, before/after values for edits. Covers logins, master changes, every voucher create/edit/cancel. Never editable, never deletable. This is both a trust feature and a GST-defense feature.

### 10.2 Soft deletes & cancellation
Transactions are never physically removed. They're cancelled/voided with a reason and remain in the audit trail. Reports exclude cancelled entries but they're recoverable.

### 10.3 Low-stock alerting
Threshold captured per product per branch at add-time. The system surfaces alerts on the dashboard and in a dedicated report when stock hits/falls below the level. Optionally push a notification (ties into your Telegram-style notification interest later).

### 10.4 Opening balances & Tally migration
When the shop switches mid-year, you must import: current stock quantities per branch, customer/supplier outstanding balances, cash/bank balances. **Plan this early** — it's easy to forget and painful to fix after go-live. Provide an import screen (CSV/Excel) for stock and party balances.

### 10.5 Number series
Per-branch, per-voucher-type sequential numbering (Sales/Branch-A/2025-26/0001…). GST requires unbroken series.

### 10.6 Financial year handling
Transactions tagged to a financial year; year-end close and carry-forward of balances.

### 10.7 Backups
Automated DB backups. Non-negotiable for financial software. **Must be running before the first real transaction is recorded** (a go-live prerequisite, not a deployment-phase task): nightly `pg_dump` with rolling 7-day retention to separate storage.

### 10.8 Security
- Strong auth (hashed passwords, session/token management).
- Server-side branch & role enforcement on every endpoint.
- Input validation and rate limiting.
- Sensitive fields (GSTIN, contact) handled carefully.

### 10.9 Idempotency keys (cheap insurance — add from day one)
Every transaction-create request (sale, purchase, receipt, payment, etc.) carries a client-generated unique key (UUID). The server records which keys it has already processed and refuses to create a duplicate for a repeated key. This costs almost nothing to add now and:
- Stops a network retry or double-tap from creating the same bill twice (a real bug even when fully online).
- Is the exact foundation any future offline-sync effort would need — so the door stays open for free without committing to offline now.

### 10.10 Connection resilience (NOT offline mode)
**Decision: full offline is explicitly not being built.** A fertilizer shop is a fixed location on wifi/broadband. True offline-first would mean a local database on every device, a sync queue, and conflict resolution for invoice numbers and stock counts — a large, app-wide architectural commitment we are deliberately avoiding. The app is server-authoritative: PostgreSQL is the single source of truth.

What we *do* build is a light resilience layer to survive a brief power fluctuation or a few-second wifi drop mid-bill, at a fraction of the cost:
- **Never lose in-progress form data** — the half-typed bill lives in local component state and isn't wiped by a failed request; submitting retries automatically.
- **Connection-status indicator** — a clear "reconnecting…" signal so staff know what's happening.
- **Cache read-only lists** (products, customers) so browsing/searching still works during a momentary blip.
- Combined with idempotency keys (10.9), a retry after reconnection is always safe.

This handles the realistic failure (a flicker), not the unrealistic one (a counter genuinely offline for hours). Revisit true offline only if the shop's internet proves unreliable in practice.

### 10.11 Day-end cash reconciliation (cash closing) ⭐
The daily closing ritual: at end of day the operator counts the physical cash in the drawer and the system compares it against what the books say cash should be.
- System computes **expected closing cash** = opening cash + cash receipts + cash sales − cash payments/expenses − cash deposited to bank (contra), for that branch and day.
- Operator enters the **actual counted cash**; the system shows the **difference** (short/over).
- A short/over is recorded with an optional note and locked into the day's record — this is the main everyday check against cash leakage and entry errors.
- **Interaction with bill edits (locked):** bills dated on/before the last closed day can't be edited directly — corrections go through a Credit Note dated today, or an Admin explicitly reopens the day-close (audited action) and must re-close it, recomputing the short/over. See Confirmed Decision #10 and TDD §20.
- Produces a simple, printable day-close summary (sales, collections, expenses, cash position) — the number the owner actually wants each evening.
- Per-branch and per-day. Super Admin can see every branch's closing; the operator enters the count but only Admin/Super Admin resolve discrepancies.

---

## 11. Logical Build Order (Implementation Phases)

This is the recommended sequence. Each phase depends on the one before it. Do **not** start transactions before masters, or reports before transactions.

### Phase 0 — Foundation (skeleton)
- Repo setup (api / web / mobile), database, migrations tooling.
- **Auth + RBAC + Branch model** — build this first; everything else assumes it.
- API conventions, response envelope, branch-isolation middleware.
- A bare app shell on web + mobile that can log in and switch branch (super admin).
- Audit-log infrastructure (start logging from the very first feature).
- Idempotency-key handling on write endpoints (Section 10.9) and the connection-resilience pattern (Section 10.10) — set the convention here so every later feature inherits it.

*Why first:* branch-awareness and roles touch every table and endpoint. Retrofitting them is the #1 cause of rewrites.

### Phase 1 — Masters
- Branches, Users.
- Account Groups (seed standard set), Ledgers.
- Units, Categories.
- **Products** (HSN, GST, unit, prices, low-stock threshold, per-branch stock).
- **Parties** (customers with name+village+state+optional fields, suppliers).
- Opening-balance / import capability.

*Why now:* you can't bill without products and customers.

### Phase 2 — Core transactions (the MVP heart)
- ⭐ Unified Sales / Billing screen (discount toggle, GST toggle, **inclusive/exclusive handling**, **free/scheme quantity**, partial payment mix).
- **Negative-stock check before billing** (hard-block).
- **Hold / park a bill** (resumable draft).
- Stock auto-decrement on sale (billed + free qty).
- Unified Purchase screen + stock auto-increment.
- ⭐ Printable invoice.
- ⭐ **Bill edit / cancel workflow** (Admin/Super Admin only) — build alongside billing, not after, since mistakes happen from day one.

*Why now:* this alone makes the app usable for daily operations. Ship this and the shop can run.

### Phase 3 — Payments & Ledgers
- Standalone Receipt and Payment vouchers.
- ⭐ **Fast Expense Entry** flow (daily petty cash).
- Running ledgers for customers, suppliers, cash, bank.
- Outstanding receivables/payables with ageing.
- ⭐ **Day-end cash reconciliation** (cash closing) — needs cash receipts/payments in place, which land here.

*Why now:* udhar tracking and "kitna baaki" is the second-most-asked thing after billing.

### Phase 4 — Remaining vouchers
- Contra (cash↔bank).
- Credit Note / Debit Note (returns).
- Journal.
- Stock Transfer between branches.
- **Stock Adjustment / write-off** (damage, spillage, theft, count correction).

### Phase 5 — Reports
- Day Book, Sales/Purchase registers, Cash/Bank books.
- Stock Summary (branch-wise), Low Stock report + alerts.
- P&L, Balance Sheet.
- GST exports (GSTR-1/3B).

### Phase 6 — Multi-branch consolidation & Super Admin
- Branch-wise financial dashboard.
- Consolidated, shop-by-shop super-admin views.
- Cross-branch stock and outstanding visibility.

### Phase 7 — Polish & mobile-first refinements
- Mobile-optimized billing & stock-check flows.
- Receipt-printer support, PDF/WhatsApp invoice sharing.
- Notifications (low stock, daily summary).
- Performance, UX refinement, the "easier than Tally" final pass.

---

## 12. MVP Definition (your first shippable milestone)

To get the shop genuinely running on your software, you need **Phase 0 → 1 → 2 → 3** plus minimal reports:
- Login, roles, one or more branches.
- Products + customers + suppliers.
- Sales billing with partial payments, GST inclusive/exclusive, free/scheme qty, pre-billing stock check, hold/park + printable invoice.
- Bill edit / cancel (Admin only).
- Purchases.
- Stock auto-update.
- Receipts/payments + fast expense entry + outstanding view.
- Day-end cash reconciliation.
- Day Book + Stock Summary + Low Stock.

Everything in Phases 4–7 is real and important, but the above is the line where the shop can stop using Tally for daily work. **Stock Adjustment (6.10) sits in Phase 4** but pull it into the MVP if damage/spillage write-offs turn out to be frequent — otherwise stock drifts from physical reality.

---

## 13. Confirmed Decisions (locked)

These were open questions; they are now decided and reflected throughout the document above.

1. **Batch/expiry tracking — NOT needed.** Product model stays simple. Future addition only if a specific line ever requires it; not a rewrite. *(See 5.7)*
2. **Per-branch GSTIN — YES.** Each branch has its own GSTIN, its own invoice number series, and files GST per its own GSTIN. State code captured on the branch. *(See 5.1)*
3. **Inter-state sales — logic built now, used later.** State code lives on both branch and customer; the tax engine compares them (same state → CGST+SGST, different → IGST). Enabling cross-state sales later requires no rework — just adding out-of-state customers. *(See 5.1, 5.5, 6.1)*
4. **Pricing — single sale price per product. No price lists, no per-customer rates.** Discount is a toggle on the billing screen: off by default, tick to reveal a discount field. *(See 5.7, 6.1)*
5. **Offline capability — NOT being built.** App is server-authoritative. Instead we add a light resilience layer (no data loss on a dropped request, connection indicator, cached read-only lists) plus idempotency keys, to survive a power flicker or brief disconnect without the cost of a full sync engine. *(See 10.9, 10.10)*
6. **GST inclusive/exclusive — supported, default exclusive (mirrors TallyPrime).** Each product carries a "price includes GST?" flag (default off = price is pre-GST, tax added on top); when on, billing back-calculates tax out of the price. Operator can also flip it on the bill. GST and non-GST entries share one register, classified per-line (taxable/exempt/nil/non-GST), never separate tables. *(See 5.7, 6.1, 6.14)*
7. **Negative stock — hard-blocked at billing.** Stock is checked as lines are added and at save; a bill cannot be confirmed for more than available stock. Genuine physical discrepancies are fixed via Stock Adjustment (6.10), not by overselling. Admin-only override may be added later if needed. *(See 6.1, 6.10)*
8. **Customer credit limit — NOT wanted.** No credit-limit field or enforcement. Udhar is tracked without a cap.
9. **Inventory costing — weighted average cost, per branch per product.** Stock movements carry cost (`rate`/`value`); sales consume stock at average cost (COGS); Stock Valuation and P&L derive from it. Full contract in the TDD (§19).
10. **Bill edit vs day-close — locked rule.** Bills dated on or before a branch's last closed day cannot be edited directly: correct via a Credit Note dated today (preferred), or an Admin explicitly reopens the day-close (audited, must re-close). GST-filed periods are credit-note-only. Full rule in the TDD (§20).

### Still worth deciding before/during Phase 2 (minor, schema-light)
- **Rounding rules — DECIDED.** Tax is computed per line and rounded to the paise, then summed (never re-round the total from raw figures). Optional invoice-level round-off to the nearest rupee posts the difference to a Round Off ledger, controlled by a business setting. Full rule in the TDD (§3.11).
- **Customer identity / deduplication** — *deferred by decision.* For now the primary identifiers are **name + village**; mobile/email stay optional. Whether to make phone number a primary identifier (and dedupe on it) will be decided later. The schema already stores mobile, so enabling this later is non-breaking.
- **Mobile framework** — *deferred by decision.* The mobile client (React Native vs Flutter vs other) will be chosen later. It doesn't affect the API/backend design, so it can wait without blocking anything.

---

## 14. One-Paragraph Summary

We're building a multi-branch shop management platform on a single Node/Express + PostgreSQL API with separate React web and mobile clients. It mirrors Tally's proven three-layer model — **Masters → Transactions → Reports** — but wins on UX by merging Sales+Receipt and Purchase+Payment into single screens with flexible cash/online/udhar payment splits, and by being genuinely usable on both PC and phone. Confirmed scope: no batch/expiry, per-branch GSTIN, inter-state tax logic built in (used later), single sale price with a billing-time discount toggle, GST inclusive/exclusive support (default exclusive, per-line tax classification, no separate GST/non-GST tables), hard-blocked negative stock, and no offline mode — instead a server-authoritative design with idempotency keys and a light resilience layer. Daily-operations features are first-class: bill edit/cancel (Admin only, GST-safe numbering), pre-billing stock check, hold/park a bill, trade schemes/free quantity, stock adjustment for damage/spillage/theft, fast expense entry, and day-end cash reconciliation. Build in strict order: foundation (auth, roles, branches, audit, idempotency) → masters (products with HSN/GST/low-stock, parties with name+village+state) → core billing + purchase + stock + bill edit → payments + ledgers + expenses + cash close → remaining vouchers + stock adjustment → reports → multi-branch consolidation → polish. Everything is branch-aware and audit-logged from line one, nothing is ever hard-deleted, and the super admin sees every shop individually and combined.
