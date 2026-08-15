-- CreateTable
CREATE TABLE "day_closes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "branch_id" UUID NOT NULL,
    "close_date" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'closed',
    "opening_cash" BIGINT NOT NULL,
    "expected_closing_cash" BIGINT NOT NULL,
    "actual_counted_cash" BIGINT NOT NULL,
    "short_over" BIGINT NOT NULL,
    "note" TEXT,
    "reopen_reason" TEXT,
    "closed_at" TIMESTAMPTZ NOT NULL,
    "closed_by" UUID,
    "reopened_at" TIMESTAMPTZ,
    "reopened_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "day_closes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "day_closes_branch_id_status_close_date_idx" ON "day_closes"("branch_id", "status", "close_date");

-- CreateIndex
CREATE UNIQUE INDEX "day_closes_branch_id_close_date_key" ON "day_closes"("branch_id", "close_date");

-- AddForeignKey
ALTER TABLE "day_closes" ADD CONSTRAINT "day_closes_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- CHECK constraints
-- ============================================================================

ALTER TABLE day_closes
  ADD CONSTRAINT chk_day_closes_status CHECK (status IN ('closed','reopened'));

ALTER TABLE day_closes
  ADD CONSTRAINT chk_day_closes_reopen_reason
  CHECK (status != 'reopened' OR reopen_reason IS NOT NULL);
