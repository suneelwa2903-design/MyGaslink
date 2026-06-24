-- Buyer's PO number on Orders (source of truth) + Invoices (snapshot for
-- reissue + GSTR-1 alignment). Both nullable, no unique constraint — the
-- same PO can legitimately appear on multiple orders from the same buyer.
-- Max 16 chars enforced at the Zod boundary to match NIC PoDtls.PoNo cap.
ALTER TABLE "orders" ADD COLUMN "po_number" TEXT;
ALTER TABLE "invoices" ADD COLUMN "po_number" TEXT;
