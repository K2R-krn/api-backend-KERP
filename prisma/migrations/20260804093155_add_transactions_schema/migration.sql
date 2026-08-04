-- CreateTable
CREATE TABLE "sales" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "branch_id" UUID NOT NULL,
    "customer_id" UUID,
    "customer_name" TEXT NOT NULL,
    "customer_village" TEXT NOT NULL,
    "voucher_date" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "invoice_number" TEXT,
    "financial_year" TEXT,
    "place_of_supply_state_code" TEXT,
    "document_type" TEXT,
    "total_taxable" BIGINT NOT NULL DEFAULT 0,
    "total_discount" BIGINT NOT NULL DEFAULT 0,
    "total_cgst" BIGINT NOT NULL DEFAULT 0,
    "total_sgst" BIGINT NOT NULL DEFAULT 0,
    "total_igst" BIGINT NOT NULL DEFAULT 0,
    "round_off" BIGINT NOT NULL DEFAULT 0,
    "grand_total" BIGINT NOT NULL DEFAULT 0,
    "paid_cash" BIGINT NOT NULL DEFAULT 0,
    "paid_bank" BIGINT NOT NULL DEFAULT 0,
    "credit_udhar" BIGINT NOT NULL DEFAULT 0,
    "bank_ledger_id" UUID,
    "notes" TEXT,
    "cancel_reason" TEXT,
    "cancelled_at" TIMESTAMPTZ,
    "cancelled_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ,
    "created_by" UUID,
    "updated_by" UUID,

    CONSTRAINT "sales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale_line_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sale_id" UUID NOT NULL,
    "line_number" INTEGER NOT NULL,
    "product_id" UUID NOT NULL,
    "customer_id" UUID,
    "branch_id" UUID NOT NULL,
    "sale_date" DATE NOT NULL,
    "unit_rate" BIGINT NOT NULL,
    "billed_qty" DECIMAL(12,3) NOT NULL,
    "free_qty" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "discount" BIGINT NOT NULL DEFAULT 0,
    "gst_rate" DECIMAL(5,2) NOT NULL,
    "price_includes_gst" BOOLEAN NOT NULL,
    "tax_classification" TEXT NOT NULL,
    "hsn_code" TEXT,
    "product_name" TEXT,
    "unit_symbol" TEXT,
    "taxable_value" BIGINT NOT NULL,
    "cgst_amount" BIGINT NOT NULL DEFAULT 0,
    "sgst_amount" BIGINT NOT NULL DEFAULT 0,
    "igst_amount" BIGINT NOT NULL DEFAULT 0,
    "line_total" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sale_line_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchases" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "branch_id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "voucher_date" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "voucher_number" TEXT,
    "financial_year" TEXT,
    "supplier_invoice_number" TEXT,
    "supplier_invoice_date" DATE,
    "total_taxable" BIGINT NOT NULL DEFAULT 0,
    "total_discount" BIGINT NOT NULL DEFAULT 0,
    "total_cgst" BIGINT NOT NULL DEFAULT 0,
    "total_sgst" BIGINT NOT NULL DEFAULT 0,
    "total_igst" BIGINT NOT NULL DEFAULT 0,
    "round_off" BIGINT NOT NULL DEFAULT 0,
    "grand_total" BIGINT NOT NULL DEFAULT 0,
    "paid_cash" BIGINT NOT NULL DEFAULT 0,
    "paid_bank" BIGINT NOT NULL DEFAULT 0,
    "credit_to_supplier" BIGINT NOT NULL DEFAULT 0,
    "bank_ledger_id" UUID,
    "notes" TEXT,
    "cancel_reason" TEXT,
    "cancelled_at" TIMESTAMPTZ,
    "cancelled_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ,
    "created_by" UUID,
    "updated_by" UUID,

    CONSTRAINT "purchases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_line_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "purchase_id" UUID NOT NULL,
    "line_number" INTEGER NOT NULL,
    "product_id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "purchase_date" DATE NOT NULL,
    "unit_rate" BIGINT NOT NULL,
    "billed_qty" DECIMAL(12,3) NOT NULL,
    "free_qty" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "discount" BIGINT NOT NULL DEFAULT 0,
    "gst_rate" DECIMAL(5,2) NOT NULL,
    "price_includes_gst" BOOLEAN NOT NULL,
    "tax_classification" TEXT NOT NULL,
    "hsn_code" TEXT,
    "product_name" TEXT,
    "unit_symbol" TEXT,
    "taxable_value" BIGINT NOT NULL,
    "cgst_amount" BIGINT NOT NULL DEFAULT 0,
    "sgst_amount" BIGINT NOT NULL DEFAULT 0,
    "igst_amount" BIGINT NOT NULL DEFAULT 0,
    "line_total" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_line_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "branch_id" UUID NOT NULL,
    "voucher_date" DATE NOT NULL,
    "voucher_number" TEXT,
    "financial_year" TEXT,
    "direction" TEXT NOT NULL,
    "party_id" UUID,
    "cash_bank_ledger_id" UUID NOT NULL,
    "counter_ledger_id" UUID,
    "amount" BIGINT NOT NULL,
    "reference" TEXT,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'confirmed',
    "cancel_reason" TEXT,
    "cancelled_at" TIMESTAMPTZ,
    "cancelled_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ,
    "created_by" UUID,
    "updated_by" UUID,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_allocations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "payment_id" UUID NOT NULL,
    "sale_id" UUID,
    "purchase_id" UUID,
    "amount" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_postings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "ledger_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "amount" BIGINT NOT NULL,
    "voucher_type" TEXT NOT NULL,
    "voucher_id" UUID NOT NULL,
    "voucher_date" DATE NOT NULL,
    "narration" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "ledger_postings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_movements" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "product_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "quantity_delta" DECIMAL(12,3) NOT NULL,
    "movement_type" TEXT NOT NULL,
    "rate" BIGINT NOT NULL,
    "value" BIGINT NOT NULL,
    "voucher_type" TEXT NOT NULL,
    "voucher_id" UUID NOT NULL,
    "voucher_date" DATE NOT NULL,
    "reason" TEXT,
    "reference_movement_id" UUID,
    "avg_cost_after" BIGINT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sales_branch_id_voucher_date_idx" ON "sales"("branch_id", "voucher_date");

-- CreateIndex
CREATE INDEX "sales_customer_id_voucher_date_idx" ON "sales"("customer_id", "voucher_date");

-- CreateIndex
CREATE INDEX "sales_bank_ledger_id_idx" ON "sales"("bank_ledger_id");

-- CreateIndex
CREATE INDEX "sale_line_items_sale_id_idx" ON "sale_line_items"("sale_id");

-- CreateIndex
CREATE INDEX "sale_line_items_product_id_idx" ON "sale_line_items"("product_id");

-- CreateIndex
CREATE INDEX "sale_line_items_branch_id_idx" ON "sale_line_items"("branch_id");

-- CreateIndex
CREATE INDEX "sale_line_items_customer_id_product_id_sale_date_idx" ON "sale_line_items"("customer_id", "product_id", "sale_date" DESC);

-- CreateIndex
CREATE INDEX "purchases_branch_id_voucher_date_idx" ON "purchases"("branch_id", "voucher_date");

-- CreateIndex
CREATE INDEX "purchases_supplier_id_voucher_date_idx" ON "purchases"("supplier_id", "voucher_date");

-- CreateIndex
CREATE INDEX "purchases_bank_ledger_id_idx" ON "purchases"("bank_ledger_id");

-- CreateIndex
CREATE INDEX "purchase_line_items_purchase_id_idx" ON "purchase_line_items"("purchase_id");

-- CreateIndex
CREATE INDEX "purchase_line_items_product_id_idx" ON "purchase_line_items"("product_id");

-- CreateIndex
CREATE INDEX "purchase_line_items_branch_id_idx" ON "purchase_line_items"("branch_id");

-- CreateIndex
CREATE INDEX "purchase_line_items_supplier_id_product_id_purchase_date_idx" ON "purchase_line_items"("supplier_id", "product_id", "purchase_date" DESC);

-- CreateIndex
CREATE INDEX "payments_branch_id_voucher_date_idx" ON "payments"("branch_id", "voucher_date");

-- CreateIndex
CREATE INDEX "payments_party_id_idx" ON "payments"("party_id");

-- CreateIndex
CREATE INDEX "payments_cash_bank_ledger_id_idx" ON "payments"("cash_bank_ledger_id");

-- CreateIndex
CREATE INDEX "payments_counter_ledger_id_idx" ON "payments"("counter_ledger_id");

-- CreateIndex
CREATE INDEX "payment_allocations_payment_id_idx" ON "payment_allocations"("payment_id");

-- CreateIndex
CREATE INDEX "payment_allocations_sale_id_idx" ON "payment_allocations"("sale_id");

-- CreateIndex
CREATE INDEX "payment_allocations_purchase_id_idx" ON "payment_allocations"("purchase_id");

-- CreateIndex
CREATE INDEX "ledger_postings_ledger_id_voucher_date_idx" ON "ledger_postings"("ledger_id", "voucher_date");

-- CreateIndex
CREATE INDEX "ledger_postings_branch_id_voucher_date_idx" ON "ledger_postings"("branch_id", "voucher_date");

-- CreateIndex
CREATE INDEX "ledger_postings_voucher_type_voucher_id_idx" ON "ledger_postings"("voucher_type", "voucher_id");

-- CreateIndex
CREATE INDEX "stock_movements_branch_id_product_id_voucher_date_idx" ON "stock_movements"("branch_id", "product_id", "voucher_date");

-- CreateIndex
CREATE INDEX "stock_movements_voucher_type_voucher_id_idx" ON "stock_movements"("voucher_type", "voucher_id");

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "parties"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_bank_ledger_id_fkey" FOREIGN KEY ("bank_ledger_id") REFERENCES "ledgers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_line_items" ADD CONSTRAINT "sale_line_items_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "sales"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_line_items" ADD CONSTRAINT "sale_line_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_line_items" ADD CONSTRAINT "sale_line_items_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "parties"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_line_items" ADD CONSTRAINT "sale_line_items_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "parties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_bank_ledger_id_fkey" FOREIGN KEY ("bank_ledger_id") REFERENCES "ledgers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_line_items" ADD CONSTRAINT "purchase_line_items_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "purchases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_line_items" ADD CONSTRAINT "purchase_line_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_line_items" ADD CONSTRAINT "purchase_line_items_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "parties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_line_items" ADD CONSTRAINT "purchase_line_items_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_cash_bank_ledger_id_fkey" FOREIGN KEY ("cash_bank_ledger_id") REFERENCES "ledgers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_counter_ledger_id_fkey" FOREIGN KEY ("counter_ledger_id") REFERENCES "ledgers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "sales"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "purchases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_postings" ADD CONSTRAINT "ledger_postings_ledger_id_fkey" FOREIGN KEY ("ledger_id") REFERENCES "ledgers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_postings" ADD CONSTRAINT "ledger_postings_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_reference_movement_id_fkey" FOREIGN KEY ("reference_movement_id") REFERENCES "stock_movements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================================
-- Partial unique indexes (soft-delete-safe uniqueness, TDD §3.9 / §25.1)
-- ============================================================================

CREATE UNIQUE INDEX ux_sales_invoice_number_active
  ON sales (branch_id, financial_year, invoice_number) WHERE invoice_number IS NOT NULL AND deleted_at IS NULL;

CREATE UNIQUE INDEX ux_purchases_voucher_number_active
  ON purchases (branch_id, financial_year, voucher_number) WHERE voucher_number IS NOT NULL AND deleted_at IS NULL;

-- ============================================================================
-- CHECK constraints
-- ============================================================================

ALTER TABLE sales
  ADD CONSTRAINT chk_sales_status CHECK (status IN ('draft','confirmed','cancelled'));

ALTER TABLE sales
  ADD CONSTRAINT chk_sales_document_type
  CHECK (document_type IN ('tax_invoice','bill_of_supply','invoice_cum_bos'));

ALTER TABLE sales
  ADD CONSTRAINT chk_sales_payment_split
  CHECK (paid_cash + paid_bank + credit_udhar = grand_total);

ALTER TABLE sale_line_items
  ADD CONSTRAINT chk_sale_line_items_tax_classification
  CHECK (tax_classification IN ('taxable','exempt','nil_rated','non_gst'));

ALTER TABLE purchases
  ADD CONSTRAINT chk_purchases_status CHECK (status IN ('draft','confirmed','cancelled'));

ALTER TABLE purchases
  ADD CONSTRAINT chk_purchases_payment_split
  CHECK (paid_cash + paid_bank + credit_to_supplier = grand_total);

ALTER TABLE purchase_line_items
  ADD CONSTRAINT chk_purchase_line_items_tax_classification
  CHECK (tax_classification IN ('taxable','exempt','nil_rated','non_gst'));

ALTER TABLE payments
  ADD CONSTRAINT chk_payments_direction CHECK (direction IN ('receipt','payment'));

ALTER TABLE payments
  ADD CONSTRAINT chk_payments_status CHECK (status IN ('confirmed','cancelled'));

ALTER TABLE payments
  ADD CONSTRAINT chk_payments_party_or_counter_ledger
  CHECK ((party_id IS NOT NULL) <> (counter_ledger_id IS NOT NULL));

ALTER TABLE payment_allocations
  ADD CONSTRAINT chk_payment_allocations_sale_or_purchase
  CHECK ((sale_id IS NOT NULL) <> (purchase_id IS NOT NULL));

ALTER TABLE stock_movements
  ADD CONSTRAINT chk_stock_movements_movement_type
  CHECK (movement_type IN ('purchase_in','sale_out','sales_return_in','purchase_return_out','adjustment_up','adjustment_down','transfer_out','transfer_in','sale_reversal_in'));

ALTER TABLE payments
  ADD CONSTRAINT chk_payments_amount_positive CHECK (amount > 0);

ALTER TABLE stock_movements
  ADD CONSTRAINT chk_stock_movements_quantity_delta_nonzero CHECK (quantity_delta <> 0);
