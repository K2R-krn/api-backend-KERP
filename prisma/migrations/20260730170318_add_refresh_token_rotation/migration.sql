-- AlterTable
ALTER TABLE "refresh_tokens" ADD COLUMN "rotated_from_id" UUID;

-- CreateIndex
CREATE INDEX "refresh_tokens_rotated_from_id_idx" ON "refresh_tokens"("rotated_from_id");

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_rotated_from_id_fkey" FOREIGN KEY ("rotated_from_id") REFERENCES "refresh_tokens"("id") ON DELETE SET NULL ON UPDATE CASCADE;
