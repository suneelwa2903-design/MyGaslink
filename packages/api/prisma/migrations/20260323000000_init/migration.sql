-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('super_admin', 'distributor_admin', 'finance', 'inventory', 'driver', 'customer');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('active', 'inactive', 'suspended');

-- CreateEnum
CREATE TYPE "ProvisioningStatus" AS ENUM ('pending_approval', 'approved', 'provisioning', 'active', 'failed');

-- CreateEnum
CREATE TYPE "DistributorStatus" AS ENUM ('active', 'suspended', 'inactive');

-- CreateEnum
CREATE TYPE "GstMode" AS ENUM ('disabled', 'sandbox', 'live');

-- CreateEnum
CREATE TYPE "CustomerStatus" AS ENUM ('active', 'suspended', 'inactive');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('pending_driver_assignment', 'pending_dispatch', 'pending_delivery', 'delivered', 'modified_delivered', 'cancelled', 'returns_only');

-- CreateEnum
CREATE TYPE "OrderType" AS ENUM ('delivery', 'returns_only');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('draft', 'issued', 'partially_paid', 'paid', 'overdue', 'cancelled');

-- CreateEnum
CREATE TYPE "IrnStatus" AS ENUM ('not_attempted', 'pending', 'success', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "EwbStatus" AS ENUM ('not_attempted', 'pending', 'active', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "GstDocType" AS ENUM ('INV', 'CRN', 'DBN');

-- CreateEnum
CREATE TYPE "DriverStatus" AS ENUM ('active', 'inactive');

-- CreateEnum
CREATE TYPE "VehicleStatus" AS ENUM ('idle', 'dispatched', 'returned', 'inactive');

-- CreateEnum
CREATE TYPE "AssignmentStatus" AS ENUM ('dispatch_ready', 'loaded_and_dispatched', 'returned_inventory', 'reconciled', 'cancelled');

-- CreateEnum
CREATE TYPE "AdjustmentStatus" AS ENUM ('pending', 'approved', 'rejected');

-- CreateEnum
CREATE TYPE "CancelledStockStatus" AS ENUM ('pending', 'on_vehicle', 'returned_to_depot', 'reconciled', 'written_off');

-- CreateEnum
CREATE TYPE "InventoryEventType" AS ENUM ('incoming_fulls', 'outgoing_empties', 'delivery', 'collection', 'manual_adjustment', 'cancellation', 'cancellation_return', 'initial_balance', 'write_off', 'returns_collection');

-- CreateEnum
CREATE TYPE "ReplenishmentStatus" AS ENUM ('pending', 'in_transit', 'completed', 'rejected');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('cash', 'cheque', 'online', 'upi', 'bank_transfer', 'credit');

-- CreateEnum
CREATE TYPE "PaymentAllocationStatus" AS ENUM ('unallocated', 'partially_allocated', 'fully_allocated');

-- CreateEnum
CREATE TYPE "CreditNoteStatus" AS ENUM ('pending', 'approved', 'issued', 'rejected', 'cancelled');

-- CreateEnum
CREATE TYPE "DebitNoteStatus" AS ENUM ('pending', 'approved', 'issued', 'rejected', 'cancelled');

-- CreateEnum
CREATE TYPE "BillingPeriodType" AS ENUM ('monthly', 'quarterly', 'half_yearly', 'yearly');

-- CreateEnum
CREATE TYPE "BillingStatus" AS ENUM ('pending_generation', 'invoice_generated', 'pending_payment', 'paid', 'overdue', 'suspended');

-- CreateEnum
CREATE TYPE "BillingTier" AS ENUM ('tier_1', 'tier_2', 'tier_3', 'tier_4');

-- CreateEnum
CREATE TYPE "BillingItemType" AS ENUM ('base_subscription', 'driver_login', 'other_login', 'custom_addon', 'discount');

-- CreateEnum
CREATE TYPE "PendingActionModule" AS ENUM ('inventory', 'invoice', 'gst_compliance', 'payment', 'customer', 'order', 'driver');

-- CreateEnum
CREATE TYPE "PendingActionStatus" AS ENUM ('open', 'in_progress', 'resolved', 'failed', 'skipped');

-- CreateEnum
CREATE TYPE "PendingActionSeverity" AS ENUM ('low', 'medium', 'high', 'critical');

-- CreateEnum
CREATE TYPE "AccountabilityType" AS ENUM ('lost_cylinder', 'damaged_cylinder', 'missing_cylinder', 'delivery_shortage', 'customer_dispute');

-- CreateEnum
CREATE TYPE "AccountabilityStatus" AS ENUM ('open', 'investigating', 'resolved_recovered', 'resolved_written_off', 'resolved_charged', 'closed');

-- CreateEnum
CREATE TYPE "LedgerEntryType" AS ENUM ('invoice', 'credit_note', 'debit_note', 'payment', 'adjustment');

-- CreateEnum
CREATE TYPE "ModificationType" AS ENUM ('update_info', 'credit_limit_change', 'stop_supply', 'resume_supply');

-- CreateEnum
CREATE TYPE "LicenseType" AS ENUM ('peso', 'gst', 'date_of_incorporation', 'partnership_deed', 'pan', 'bank_account_details', 'cancellation_cheque', 'custom');

-- CreateTable
CREATE TABLE "distributors" (
    "distributor_id" TEXT NOT NULL,
    "business_name" TEXT NOT NULL,
    "legal_name" TEXT NOT NULL,
    "gstin" TEXT,
    "address" TEXT,
    "city" TEXT,
    "state" TEXT,
    "pincode" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "status" "DistributorStatus" NOT NULL DEFAULT 'active',
    "gst_mode" "GstMode" NOT NULL DEFAULT 'disabled',
    "provider_codes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "subscription_plan" TEXT,
    "billing_tier" "BillingTier",
    "billing_suspended" BOOLEAN NOT NULL DEFAULT false,
    "gaslink_billing_enabled" BOOLEAN NOT NULL DEFAULT false,
    "gaslink_billing_start_date" DATE,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "distributors_pkey" PRIMARY KEY ("distributor_id")
);

-- CreateTable
CREATE TABLE "users" (
    "user_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "phone" TEXT,
    "role" "UserRole" NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'active',
    "provisioning_status" "ProvisioningStatus" NOT NULL DEFAULT 'active',
    "distributor_id" TEXT,
    "customer_id" TEXT,
    "requires_password_reset" BOOLEAN NOT NULL DEFAULT true,
    "refresh_token" TEXT,
    "last_login_at" TIMESTAMP(3),
    "login_attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "customers" (
    "customer_id" TEXT NOT NULL,
    "distributor_id" TEXT NOT NULL,
    "customer_name" TEXT NOT NULL,
    "business_name" TEXT,
    "gstin" TEXT,
    "customer_type" TEXT NOT NULL DEFAULT 'B2C',
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "billing_address_line1" TEXT,
    "billing_address_line2" TEXT,
    "billing_city" TEXT,
    "billing_state" TEXT,
    "billing_pincode" TEXT,
    "shipping_address_line1" TEXT,
    "shipping_address_line2" TEXT,
    "shipping_city" TEXT,
    "shipping_state" TEXT,
    "shipping_pincode" TEXT,
    "credit_period_days" INTEGER NOT NULL DEFAULT 30,
    "status" "CustomerStatus" NOT NULL DEFAULT 'active',
    "stop_supply" BOOLEAN NOT NULL DEFAULT false,
    "preferred_driver_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "customers_pkey" PRIMARY KEY ("customer_id")
);

-- CreateTable
CREATE TABLE "customer_contacts" (
    "contact_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "customer_contacts_pkey" PRIMARY KEY ("contact_id")
);

-- CreateTable
CREATE TABLE "customer_cylinder_discounts" (
    "discount_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "cylinder_type_id" TEXT NOT NULL,
    "discount_per_unit" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "customer_cylinder_discounts_pkey" PRIMARY KEY ("discount_id")
);

-- CreateTable
CREATE TABLE "customer_inventory_balances" (
    "balance_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "cylinder_type_id" TEXT NOT NULL,
    "with_customer_qty" INTEGER NOT NULL DEFAULT 0,
    "pending_returns" INTEGER NOT NULL DEFAULT 0,
    "missing_qty" INTEGER NOT NULL DEFAULT 0,
    "last_updated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_inventory_balances_pkey" PRIMARY KEY ("balance_id")
);

-- CreateTable
CREATE TABLE "customer_modification_requests" (
    "request_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "distributor_id" TEXT NOT NULL,
    "modification_type" "ModificationType" NOT NULL,
    "requested_by" TEXT NOT NULL,
    "reviewed_by" TEXT,
    "status" "AdjustmentStatus" NOT NULL DEFAULT 'pending',
    "reason" TEXT,
    "changes" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_modification_requests_pkey" PRIMARY KEY ("request_id")
);

-- CreateTable
CREATE TABLE "customer_audit_trail" (
    "trail_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "distributor_id" TEXT NOT NULL,
    "performed_by" TEXT NOT NULL,
    "action_type" TEXT NOT NULL,
    "field_name" TEXT,
    "old_value" JSONB,
    "new_value" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_audit_trail_pkey" PRIMARY KEY ("trail_id")
);

-- CreateTable
CREATE TABLE "customer_ledger_entries" (
    "id" TEXT NOT NULL,
    "distributor_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "entry_type" "LedgerEntryType" NOT NULL,
    "reference_id" TEXT NOT NULL,
    "invoice_id" TEXT,
    "amount_delta" DOUBLE PRECISION NOT NULL,
    "narration" TEXT,
    "entry_date" DATE NOT NULL,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cylinder_types" (
    "cylinder_type_id" TEXT NOT NULL,
    "distributor_id" TEXT NOT NULL,
    "type_name" TEXT NOT NULL,
    "capacity" DOUBLE PRECISION NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'KG',
    "hsn_code" TEXT NOT NULL DEFAULT '27111900',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cylinder_types_pkey" PRIMARY KEY ("cylinder_type_id")
);

-- CreateTable
CREATE TABLE "cylinder_prices" (
    "price_id" TEXT NOT NULL,
    "distributor_id" TEXT NOT NULL,
    "cylinder_type_id" TEXT NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "effective_date" DATE NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cylinder_prices_pkey" PRIMARY KEY ("price_id")
);

-- CreateTable
CREATE TABLE "empty_cylinder_prices" (
    "empty_price_id" TEXT NOT NULL,
    "distributor_id" TEXT NOT NULL,
    "cylinder_type_id" TEXT NOT NULL,
    "empty_cylinder_price" DOUBLE PRECISION NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "empty_cylinder_prices_pkey" PRIMARY KEY ("empty_price_id")
);

-- CreateTable
CREATE TABLE "cylinder_thresholds" (
    "threshold_id" TEXT NOT NULL,
    "distributor_id" TEXT NOT NULL,
    "cylinder_type_id" TEXT NOT NULL,
    "warning_level" INTEGER NOT NULL,
    "critical_level" INTEGER NOT NULL,
    "alert_enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "cylinder_thresholds_pkey" PRIMARY KEY ("threshold_id")
);

-- CreateTable
CREATE TABLE "orders" (
    "order_id" TEXT NOT NULL,
    "order_number" TEXT NOT NULL,
    "distributor_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "driver_id" TEXT,
    "vehicle_id" TEXT,
    "order_date" DATE NOT NULL,
    "delivery_date" DATE NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'pending_driver_assignment',
    "order_type" "OrderType" NOT NULL DEFAULT 'delivery',
    "total_amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "special_instructions" TEXT,
    "delivery_latitude" DOUBLE PRECISION,
    "delivery_longitude" DOUBLE PRECISION,
    "delivery_notes" TEXT,
    "delivered_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "cancellation_reason" TEXT,
    "customer_confirmed" BOOLEAN,
    "customer_confirmed_at" TIMESTAMP(3),
    "customer_dispute_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "cancelled_stock_event_id" TEXT,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("order_id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "order_item_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "cylinder_type_id" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "delivered_quantity" INTEGER,
    "empties_collected" INTEGER,
    "unit_price" DOUBLE PRECISION NOT NULL,
    "discount_per_unit" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "total_price" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("order_item_id")
);

-- CreateTable
CREATE TABLE "order_status_log" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "old_status" TEXT NOT NULL,
    "new_status" TEXT NOT NULL,
    "changed_by" TEXT NOT NULL,
    "notes" TEXT,
    "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_status_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drivers" (
    "driver_id" TEXT NOT NULL,
    "distributor_id" TEXT NOT NULL,
    "driver_name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "license_number" TEXT,
    "employment_type" TEXT,
    "status" "DriverStatus" NOT NULL DEFAULT 'active',
    "available_today" BOOLEAN NOT NULL DEFAULT true,
    "preferred_vehicle_id" TEXT,
    "joining_date" DATE,
    "deactivated_at" TIMESTAMP(3),
    "deactivation_notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "drivers_pkey" PRIMARY KEY ("driver_id")
);

-- CreateTable
CREATE TABLE "vehicles" (
    "vehicle_id" TEXT NOT NULL,
    "distributor_id" TEXT NOT NULL,
    "vehicle_number" TEXT NOT NULL,
    "vehicle_type" TEXT,
    "capacity" INTEGER,
    "status" "VehicleStatus" NOT NULL DEFAULT 'idle',
    "deactivated_at" TIMESTAMP(3),
    "deactivation_notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "vehicles_pkey" PRIMARY KEY ("vehicle_id")
);

-- CreateTable
CREATE TABLE "driver_vehicle_assignments" (
    "assignment_id" TEXT NOT NULL,
    "driver_id" TEXT NOT NULL,
    "vehicle_id" TEXT NOT NULL,
    "distributor_id" TEXT NOT NULL,
    "assignment_date" DATE NOT NULL,
    "trip_number" INTEGER NOT NULL DEFAULT 1,
    "status" "AssignmentStatus" NOT NULL DEFAULT 'dispatch_ready',
    "is_reconciled" BOOLEAN NOT NULL DEFAULT false,
    "is_submitted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "driver_vehicle_assignments_pkey" PRIMARY KEY ("assignment_id")
);

-- CreateTable
CREATE TABLE "driver_assignments" (
    "assignment_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "driver_id" TEXT NOT NULL,
    "assigned_by" TEXT NOT NULL,
    "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'active',
    "notes" TEXT,

    CONSTRAINT "driver_assignments_pkey" PRIMARY KEY ("assignment_id")
);

-- CreateTable
CREATE TABLE "vehicle_inventory" (
    "id" TEXT NOT NULL,
    "vehicle_id" TEXT NOT NULL,
    "cylinder_type_id" TEXT NOT NULL,
    "full_quantity" INTEGER NOT NULL DEFAULT 0,
    "empty_quantity" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vehicle_inventory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "invoice_id" TEXT NOT NULL,
    "invoice_number" TEXT NOT NULL,
    "distributor_id" TEXT NOT NULL,
    "customer_id" TEXT,
    "order_id" TEXT,
    "issue_date" DATE NOT NULL,
    "due_date" DATE NOT NULL,
    "total_amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "amount_paid" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "outstanding_amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'draft',
    "irn_status" "IrnStatus" NOT NULL DEFAULT 'not_attempted',
    "ewb_status" "EwbStatus" NOT NULL DEFAULT 'not_attempted',
    "irn" TEXT,
    "ack_no" TEXT,
    "ack_date" TIMESTAMP(3),
    "cgst_value" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sgst_value" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "igst_value" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "is_gaslink_billing" BOOLEAN NOT NULL DEFAULT false,
    "issued_by" TEXT,
    "closed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("invoice_id")
);

-- CreateTable
CREATE TABLE "invoice_items" (
    "invoice_item_id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "cylinder_type_id" TEXT,
    "description" TEXT NOT NULL,
    "hsn_code" TEXT NOT NULL DEFAULT '27111900',
    "quantity" INTEGER NOT NULL,
    "unit_price" DOUBLE PRECISION NOT NULL,
    "discount_per_unit" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "gst_rate" DOUBLE PRECISION NOT NULL DEFAULT 18,
    "total_price" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "invoice_items_pkey" PRIMARY KEY ("invoice_item_id")
);

-- CreateTable
CREATE TABLE "credit_notes" (
    "credit_note_id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "credit_note_number" TEXT,
    "total_amount" DOUBLE PRECISION NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "CreditNoteStatus" NOT NULL DEFAULT 'pending',
    "issue_date" DATE,
    "issued_by" TEXT,
    "approved_by" TEXT,
    "approved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "credit_notes_pkey" PRIMARY KEY ("credit_note_id")
);

-- CreateTable
CREATE TABLE "debit_notes" (
    "debit_note_id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "debit_note_number" TEXT,
    "total_amount" DOUBLE PRECISION NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "DebitNoteStatus" NOT NULL DEFAULT 'pending',
    "issue_date" DATE,
    "issued_by" TEXT,
    "approved_by" TEXT,
    "approved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "debit_notes_pkey" PRIMARY KEY ("debit_note_id")
);

-- CreateTable
CREATE TABLE "payment_transactions" (
    "payment_id" TEXT NOT NULL,
    "distributor_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "payment_method" "PaymentMethod" NOT NULL,
    "reference_number" TEXT,
    "transaction_date" DATE NOT NULL,
    "allocation_status" "PaymentAllocationStatus" NOT NULL DEFAULT 'unallocated',
    "received_by" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "payment_transactions_pkey" PRIMARY KEY ("payment_id")
);

-- CreateTable
CREATE TABLE "payment_allocations" (
    "allocation_id" TEXT NOT NULL,
    "payment_id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "allocated_amount" DOUBLE PRECISION NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_allocations_pkey" PRIMARY KEY ("allocation_id")
);

-- CreateTable
CREATE TABLE "inventory_events" (
    "event_id" TEXT NOT NULL,
    "distributor_id" TEXT NOT NULL,
    "cylinder_type_id" TEXT NOT NULL,
    "event_type" "InventoryEventType" NOT NULL,
    "fulls_change" INTEGER NOT NULL DEFAULT 0,
    "empties_change" INTEGER NOT NULL DEFAULT 0,
    "event_date" DATE NOT NULL,
    "reference_id" TEXT,
    "reference_type" TEXT,
    "document_type" TEXT,
    "document_number" TEXT,
    "notes" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_events_pkey" PRIMARY KEY ("event_id")
);

-- CreateTable
CREATE TABLE "inventory_summaries" (
    "summary_id" TEXT NOT NULL,
    "distributor_id" TEXT NOT NULL,
    "cylinder_type_id" TEXT NOT NULL,
    "summary_date" DATE NOT NULL,
    "opening_fulls" INTEGER NOT NULL DEFAULT 0,
    "opening_empties" INTEGER NOT NULL DEFAULT 0,
    "incoming_fulls" INTEGER NOT NULL DEFAULT 0,
    "outgoing_empties" INTEGER NOT NULL DEFAULT 0,
    "delivered_qty" INTEGER NOT NULL DEFAULT 0,
    "collected_empties" INTEGER NOT NULL DEFAULT 0,
    "cancelled_stock_qty" INTEGER NOT NULL DEFAULT 0,
    "manual_adjustment" INTEGER NOT NULL DEFAULT 0,
    "closing_fulls" INTEGER NOT NULL DEFAULT 0,
    "closing_empties" INTEGER NOT NULL DEFAULT 0,
    "is_locked" BOOLEAN NOT NULL DEFAULT false,
    "locked_at" TIMESTAMP(3),
    "locked_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_summaries_pkey" PRIMARY KEY ("summary_id")
);

-- CreateTable
CREATE TABLE "cancelled_stock_events" (
    "event_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "vehicle_id" TEXT,
    "driver_id" TEXT,
    "cylinder_type_id" TEXT NOT NULL,
    "distributor_id" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "cancellation_date" DATE NOT NULL,
    "status" "CancelledStockStatus" NOT NULL DEFAULT 'pending',
    "returned_date" DATE,
    "reconciled_date" DATE,
    "reconciled_by" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cancelled_stock_events_pkey" PRIMARY KEY ("event_id")
);

-- CreateTable
CREATE TABLE "gst_documents" (
    "gst_document_id" TEXT NOT NULL,
    "invoice_id" TEXT,
    "order_id" TEXT,
    "distributor_id" TEXT NOT NULL,
    "gst_doc_no" TEXT,
    "doc_type" "GstDocType" NOT NULL,
    "irn_status" "IrnStatus" NOT NULL DEFAULT 'not_attempted',
    "ewb_status" "EwbStatus" NOT NULL DEFAULT 'not_attempted',
    "irn" TEXT,
    "ack_no" TEXT,
    "ack_date" TIMESTAMP(3),
    "signed_qr" TEXT,
    "ewb_no" TEXT,
    "ewb_date" TIMESTAMP(3),
    "ewb_valid_till" TIMESTAMP(3),
    "request_payload" JSONB,
    "response_payload" JSONB,
    "error_code" TEXT,
    "error_message" TEXT,
    "is_latest" BOOLEAN NOT NULL DEFAULT true,
    "cancelled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "gst_documents_pkey" PRIMARY KEY ("gst_document_id")
);

-- CreateTable
CREATE TABLE "gst_credentials" (
    "credential_id" TEXT NOT NULL,
    "distributor_id" TEXT,
    "scope" TEXT NOT NULL DEFAULT 'einvoice',
    "client_id" TEXT NOT NULL,
    "client_secret" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "password" TEXT NOT NULL DEFAULT '',
    "gstin" TEXT NOT NULL,
    "email" TEXT,
    "is_valid" BOOLEAN NOT NULL DEFAULT false,
    "last_validated" TIMESTAMP(3),
    "token_cache" TEXT,
    "token_expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gst_credentials_pkey" PRIMARY KEY ("credential_id")
);

-- CreateTable
CREATE TABLE "gaslink_billing_cycles" (
    "cycle_id" TEXT NOT NULL,
    "distributor_id" TEXT NOT NULL,
    "period_type" "BillingPeriodType" NOT NULL,
    "period_start_date" DATE NOT NULL,
    "period_end_date" DATE NOT NULL,
    "billing_status" "BillingStatus" NOT NULL DEFAULT 'pending_generation',
    "billing_tier" "BillingTier" NOT NULL,
    "total_amount_excl_gst" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "total_gst_amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "total_amount_incl_gst" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "invoice_id" TEXT,
    "due_date" DATE,
    "suspend_date" DATE,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gaslink_billing_cycles_pkey" PRIMARY KEY ("cycle_id")
);

-- CreateTable
CREATE TABLE "gaslink_billing_items" (
    "item_id" TEXT NOT NULL,
    "billing_cycle_id" TEXT NOT NULL,
    "item_type" "BillingItemType" NOT NULL,
    "description" TEXT NOT NULL,
    "hsn_code" TEXT NOT NULL DEFAULT '998314',
    "uom" TEXT NOT NULL DEFAULT 'NOS',
    "quantity" INTEGER NOT NULL,
    "unit_price_excl_gst" DOUBLE PRECISION NOT NULL,
    "gst_rate" DOUBLE PRECISION NOT NULL DEFAULT 18,
    "discount_amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "line_total_excl_gst" DOUBLE PRECISION NOT NULL,
    "line_gst_amount" DOUBLE PRECISION NOT NULL,
    "line_total_incl_gst" DOUBLE PRECISION NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gaslink_billing_items_pkey" PRIMARY KEY ("item_id")
);

-- CreateTable
CREATE TABLE "pending_actions" (
    "action_id" TEXT NOT NULL,
    "distributor_id" TEXT NOT NULL,
    "module" "PendingActionModule" NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "action_type" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" "PendingActionStatus" NOT NULL DEFAULT 'open',
    "severity" "PendingActionSeverity" NOT NULL DEFAULT 'medium',
    "requires_approval" BOOLEAN NOT NULL DEFAULT false,
    "approved_by" TEXT,
    "approved_at" TIMESTAMP(3),
    "resolved_by" TEXT,
    "resolved_at" TIMESTAMP(3),
    "resolution_notes" TEXT,
    "error_code" TEXT,
    "error_message" TEXT,
    "error_context" JSONB,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "next_retry_at" TIMESTAMP(3),
    "sla_deadline" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pending_actions_pkey" PRIMARY KEY ("action_id")
);

-- CreateTable
CREATE TABLE "accountability_logs" (
    "log_id" TEXT NOT NULL,
    "distributor_id" TEXT NOT NULL,
    "driver_id" TEXT,
    "customer_id" TEXT,
    "cylinder_type_id" TEXT,
    "incident_type" "AccountabilityType" NOT NULL,
    "incident_date" DATE NOT NULL,
    "quantity" INTEGER NOT NULL,
    "cost_amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "description" TEXT NOT NULL,
    "status" "AccountabilityStatus" NOT NULL DEFAULT 'open',
    "resolved_by" TEXT,
    "resolved_at" TIMESTAMP(3),
    "resolution_notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "accountability_logs_pkey" PRIMARY KEY ("log_id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "log_id" TEXT NOT NULL,
    "distributor_id" TEXT,
    "user_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "details" JSONB,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("log_id")
);

-- CreateTable
CREATE TABLE "distributor_settings" (
    "setting_id" TEXT NOT NULL,
    "distributor_id" TEXT NOT NULL,
    "setting_key" TEXT NOT NULL,
    "setting_value" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "distributor_settings_pkey" PRIMARY KEY ("setting_id")
);

-- CreateTable
CREATE TABLE "licenses" (
    "license_id" TEXT NOT NULL,
    "distributor_id" TEXT NOT NULL,
    "license_type" "LicenseType" NOT NULL,
    "license_name" TEXT NOT NULL,
    "license_number" TEXT,
    "expiry_date" DATE,
    "document_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "licenses_pkey" PRIMARY KEY ("license_id")
);

-- CreateTable
CREATE TABLE "contact_submissions" (
    "submission_id" TEXT NOT NULL,
    "distributor_id" TEXT,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "agency" TEXT NOT NULL,
    "agency_name" TEXT NOT NULL,
    "monthly_sale" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'new',
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contact_submissions_pkey" PRIMARY KEY ("submission_id")
);

-- CreateTable
CREATE TABLE "gst_states" (
    "state_code" TEXT NOT NULL,
    "state_name" TEXT NOT NULL,

    CONSTRAINT "gst_states_pkey" PRIMARY KEY ("state_code")
);

-- CreateTable
CREATE TABLE "hsn_codes" (
    "hsn_code" TEXT NOT NULL,
    "description" TEXT NOT NULL,

    CONSTRAINT "hsn_codes_pkey" PRIMARY KEY ("hsn_code")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_email_idx" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_distributor_id_idx" ON "users"("distributor_id");

-- CreateIndex
CREATE INDEX "users_role_status_idx" ON "users"("role", "status");

-- CreateIndex
CREATE INDEX "customers_distributor_id_status_idx" ON "customers"("distributor_id", "status");

-- CreateIndex
CREATE INDEX "customers_distributor_id_customer_name_idx" ON "customers"("distributor_id", "customer_name");

-- CreateIndex
CREATE INDEX "customers_gstin_idx" ON "customers"("gstin");

-- CreateIndex
CREATE UNIQUE INDEX "customer_cylinder_discounts_customer_id_cylinder_type_id_key" ON "customer_cylinder_discounts"("customer_id", "cylinder_type_id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_inventory_balances_customer_id_cylinder_type_id_key" ON "customer_inventory_balances"("customer_id", "cylinder_type_id");

-- CreateIndex
CREATE INDEX "customer_modification_requests_distributor_id_status_idx" ON "customer_modification_requests"("distributor_id", "status");

-- CreateIndex
CREATE INDEX "customer_audit_trail_customer_id_created_at_idx" ON "customer_audit_trail"("customer_id", "created_at");

-- CreateIndex
CREATE INDEX "customer_ledger_entries_distributor_id_customer_id_entry_da_idx" ON "customer_ledger_entries"("distributor_id", "customer_id", "entry_date");

-- CreateIndex
CREATE INDEX "customer_ledger_entries_reference_id_idx" ON "customer_ledger_entries"("reference_id");

-- CreateIndex
CREATE UNIQUE INDEX "cylinder_types_distributor_id_type_name_key" ON "cylinder_types"("distributor_id", "type_name");

-- CreateIndex
CREATE INDEX "cylinder_prices_distributor_id_cylinder_type_id_effective_d_idx" ON "cylinder_prices"("distributor_id", "cylinder_type_id", "effective_date" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "empty_cylinder_prices_distributor_id_cylinder_type_id_key" ON "empty_cylinder_prices"("distributor_id", "cylinder_type_id");

-- CreateIndex
CREATE UNIQUE INDEX "cylinder_thresholds_distributor_id_cylinder_type_id_key" ON "cylinder_thresholds"("distributor_id", "cylinder_type_id");

-- CreateIndex
CREATE UNIQUE INDEX "orders_order_number_key" ON "orders"("order_number");

-- CreateIndex
CREATE UNIQUE INDEX "orders_cancelled_stock_event_id_key" ON "orders"("cancelled_stock_event_id");

-- CreateIndex
CREATE INDEX "orders_distributor_id_status_delivery_date_idx" ON "orders"("distributor_id", "status", "delivery_date");

-- CreateIndex
CREATE INDEX "orders_distributor_id_customer_id_created_at_idx" ON "orders"("distributor_id", "customer_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "orders_driver_id_delivery_date_idx" ON "orders"("driver_id", "delivery_date");

-- CreateIndex
CREATE INDEX "order_status_log_order_id_changed_at_idx" ON "order_status_log"("order_id", "changed_at");

-- CreateIndex
CREATE INDEX "drivers_distributor_id_status_idx" ON "drivers"("distributor_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "vehicles_distributor_id_vehicle_number_key" ON "vehicles"("distributor_id", "vehicle_number");

-- CreateIndex
CREATE INDEX "driver_vehicle_assignments_distributor_id_assignment_date_idx" ON "driver_vehicle_assignments"("distributor_id", "assignment_date");

-- CreateIndex
CREATE INDEX "driver_vehicle_assignments_driver_id_assignment_date_idx" ON "driver_vehicle_assignments"("driver_id", "assignment_date");

-- CreateIndex
CREATE INDEX "driver_assignments_order_id_idx" ON "driver_assignments"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_inventory_vehicle_id_cylinder_type_id_key" ON "vehicle_inventory"("vehicle_id", "cylinder_type_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_invoice_number_key" ON "invoices"("invoice_number");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_order_id_key" ON "invoices"("order_id");

-- CreateIndex
CREATE INDEX "invoices_distributor_id_status_due_date_idx" ON "invoices"("distributor_id", "status", "due_date");

-- CreateIndex
CREATE INDEX "invoices_distributor_id_customer_id_created_at_idx" ON "invoices"("distributor_id", "customer_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "invoices_irn_status_idx" ON "invoices"("irn_status");

-- CreateIndex
CREATE UNIQUE INDEX "credit_notes_credit_note_number_key" ON "credit_notes"("credit_note_number");

-- CreateIndex
CREATE UNIQUE INDEX "debit_notes_debit_note_number_key" ON "debit_notes"("debit_note_number");

-- CreateIndex
CREATE INDEX "payment_transactions_distributor_id_customer_id_created_at_idx" ON "payment_transactions"("distributor_id", "customer_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "payment_transactions_distributor_id_transaction_date_idx" ON "payment_transactions"("distributor_id", "transaction_date");

-- CreateIndex
CREATE INDEX "inventory_events_distributor_id_cylinder_type_id_event_date_idx" ON "inventory_events"("distributor_id", "cylinder_type_id", "event_date");

-- CreateIndex
CREATE INDEX "inventory_events_distributor_id_event_date_idx" ON "inventory_events"("distributor_id", "event_date");

-- CreateIndex
CREATE INDEX "inventory_events_reference_id_reference_type_idx" ON "inventory_events"("reference_id", "reference_type");

-- CreateIndex
CREATE INDEX "inventory_summaries_distributor_id_summary_date_idx" ON "inventory_summaries"("distributor_id", "summary_date");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_summaries_distributor_id_cylinder_type_id_summary_key" ON "inventory_summaries"("distributor_id", "cylinder_type_id", "summary_date");

-- CreateIndex
CREATE INDEX "cancelled_stock_events_distributor_id_status_idx" ON "cancelled_stock_events"("distributor_id", "status");

-- CreateIndex
CREATE INDEX "cancelled_stock_events_vehicle_id_status_idx" ON "cancelled_stock_events"("vehicle_id", "status");

-- CreateIndex
CREATE INDEX "cancelled_stock_events_driver_id_status_idx" ON "cancelled_stock_events"("driver_id", "status");

-- CreateIndex
CREATE INDEX "gst_documents_invoice_id_is_latest_idx" ON "gst_documents"("invoice_id", "is_latest");

-- CreateIndex
CREATE INDEX "gst_documents_distributor_id_idx" ON "gst_documents"("distributor_id");

-- CreateIndex
CREATE INDEX "gst_documents_irn_idx" ON "gst_documents"("irn");

-- CreateIndex
CREATE UNIQUE INDEX "gst_credentials_distributor_id_scope_key" ON "gst_credentials"("distributor_id", "scope");

-- CreateIndex
CREATE INDEX "gaslink_billing_cycles_distributor_id_period_start_date_idx" ON "gaslink_billing_cycles"("distributor_id", "period_start_date");

-- CreateIndex
CREATE INDEX "gaslink_billing_cycles_billing_status_idx" ON "gaslink_billing_cycles"("billing_status");

-- CreateIndex
CREATE INDEX "pending_actions_distributor_id_status_idx" ON "pending_actions"("distributor_id", "status");

-- CreateIndex
CREATE INDEX "pending_actions_module_status_idx" ON "pending_actions"("module", "status");

-- CreateIndex
CREATE INDEX "pending_actions_sla_deadline_idx" ON "pending_actions"("sla_deadline");

-- CreateIndex
CREATE INDEX "accountability_logs_distributor_id_status_idx" ON "accountability_logs"("distributor_id", "status");

-- CreateIndex
CREATE INDEX "accountability_logs_driver_id_status_idx" ON "accountability_logs"("driver_id", "status");

-- CreateIndex
CREATE INDEX "audit_logs_distributor_id_created_at_idx" ON "audit_logs"("distributor_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_user_id_created_at_idx" ON "audit_logs"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_idx" ON "audit_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "distributor_settings_distributor_id_setting_key_key" ON "distributor_settings"("distributor_id", "setting_key");

-- CreateIndex
CREATE INDEX "licenses_distributor_id_expiry_date_idx" ON "licenses"("distributor_id", "expiry_date");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_distributor_id_fkey" FOREIGN KEY ("distributor_id") REFERENCES "distributors"("distributor_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("customer_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_distributor_id_fkey" FOREIGN KEY ("distributor_id") REFERENCES "distributors"("distributor_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_contacts" ADD CONSTRAINT "customer_contacts_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("customer_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_cylinder_discounts" ADD CONSTRAINT "customer_cylinder_discounts_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("customer_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_cylinder_discounts" ADD CONSTRAINT "customer_cylinder_discounts_cylinder_type_id_fkey" FOREIGN KEY ("cylinder_type_id") REFERENCES "cylinder_types"("cylinder_type_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_inventory_balances" ADD CONSTRAINT "customer_inventory_balances_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("customer_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_inventory_balances" ADD CONSTRAINT "customer_inventory_balances_cylinder_type_id_fkey" FOREIGN KEY ("cylinder_type_id") REFERENCES "cylinder_types"("cylinder_type_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_modification_requests" ADD CONSTRAINT "customer_modification_requests_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("customer_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_audit_trail" ADD CONSTRAINT "customer_audit_trail_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("customer_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_ledger_entries" ADD CONSTRAINT "customer_ledger_entries_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("customer_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cylinder_types" ADD CONSTRAINT "cylinder_types_distributor_id_fkey" FOREIGN KEY ("distributor_id") REFERENCES "distributors"("distributor_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cylinder_prices" ADD CONSTRAINT "cylinder_prices_distributor_id_fkey" FOREIGN KEY ("distributor_id") REFERENCES "distributors"("distributor_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cylinder_prices" ADD CONSTRAINT "cylinder_prices_cylinder_type_id_fkey" FOREIGN KEY ("cylinder_type_id") REFERENCES "cylinder_types"("cylinder_type_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "empty_cylinder_prices" ADD CONSTRAINT "empty_cylinder_prices_distributor_id_fkey" FOREIGN KEY ("distributor_id") REFERENCES "distributors"("distributor_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "empty_cylinder_prices" ADD CONSTRAINT "empty_cylinder_prices_cylinder_type_id_fkey" FOREIGN KEY ("cylinder_type_id") REFERENCES "cylinder_types"("cylinder_type_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cylinder_thresholds" ADD CONSTRAINT "cylinder_thresholds_cylinder_type_id_fkey" FOREIGN KEY ("cylinder_type_id") REFERENCES "cylinder_types"("cylinder_type_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_distributor_id_fkey" FOREIGN KEY ("distributor_id") REFERENCES "distributors"("distributor_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("customer_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "drivers"("driver_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("vehicle_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_cancelled_stock_event_id_fkey" FOREIGN KEY ("cancelled_stock_event_id") REFERENCES "cancelled_stock_events"("event_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("order_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_cylinder_type_id_fkey" FOREIGN KEY ("cylinder_type_id") REFERENCES "cylinder_types"("cylinder_type_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_status_log" ADD CONSTRAINT "order_status_log_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("order_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drivers" ADD CONSTRAINT "drivers_distributor_id_fkey" FOREIGN KEY ("distributor_id") REFERENCES "distributors"("distributor_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_distributor_id_fkey" FOREIGN KEY ("distributor_id") REFERENCES "distributors"("distributor_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_vehicle_assignments" ADD CONSTRAINT "driver_vehicle_assignments_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "drivers"("driver_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_vehicle_assignments" ADD CONSTRAINT "driver_vehicle_assignments_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("vehicle_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_assignments" ADD CONSTRAINT "driver_assignments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("order_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_assignments" ADD CONSTRAINT "driver_assignments_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "drivers"("driver_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_assignments" ADD CONSTRAINT "driver_assignments_assigned_by_fkey" FOREIGN KEY ("assigned_by") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_inventory" ADD CONSTRAINT "vehicle_inventory_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("vehicle_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_distributor_id_fkey" FOREIGN KEY ("distributor_id") REFERENCES "distributors"("distributor_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("customer_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("order_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("invoice_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_cylinder_type_id_fkey" FOREIGN KEY ("cylinder_type_id") REFERENCES "cylinder_types"("cylinder_type_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("invoice_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debit_notes" ADD CONSTRAINT "debit_notes_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("invoice_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_distributor_id_fkey" FOREIGN KEY ("distributor_id") REFERENCES "distributors"("distributor_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("customer_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payment_transactions"("payment_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("invoice_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_events" ADD CONSTRAINT "inventory_events_distributor_id_fkey" FOREIGN KEY ("distributor_id") REFERENCES "distributors"("distributor_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_events" ADD CONSTRAINT "inventory_events_cylinder_type_id_fkey" FOREIGN KEY ("cylinder_type_id") REFERENCES "cylinder_types"("cylinder_type_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_summaries" ADD CONSTRAINT "inventory_summaries_distributor_id_fkey" FOREIGN KEY ("distributor_id") REFERENCES "distributors"("distributor_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_summaries" ADD CONSTRAINT "inventory_summaries_cylinder_type_id_fkey" FOREIGN KEY ("cylinder_type_id") REFERENCES "cylinder_types"("cylinder_type_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cancelled_stock_events" ADD CONSTRAINT "cancelled_stock_events_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("order_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cancelled_stock_events" ADD CONSTRAINT "cancelled_stock_events_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("vehicle_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cancelled_stock_events" ADD CONSTRAINT "cancelled_stock_events_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "drivers"("driver_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cancelled_stock_events" ADD CONSTRAINT "cancelled_stock_events_cylinder_type_id_fkey" FOREIGN KEY ("cylinder_type_id") REFERENCES "cylinder_types"("cylinder_type_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gst_documents" ADD CONSTRAINT "gst_documents_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("invoice_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gst_documents" ADD CONSTRAINT "gst_documents_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("order_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gst_credentials" ADD CONSTRAINT "gst_credentials_distributor_id_fkey" FOREIGN KEY ("distributor_id") REFERENCES "distributors"("distributor_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gaslink_billing_cycles" ADD CONSTRAINT "gaslink_billing_cycles_distributor_id_fkey" FOREIGN KEY ("distributor_id") REFERENCES "distributors"("distributor_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gaslink_billing_items" ADD CONSTRAINT "gaslink_billing_items_billing_cycle_id_fkey" FOREIGN KEY ("billing_cycle_id") REFERENCES "gaslink_billing_cycles"("cycle_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pending_actions" ADD CONSTRAINT "pending_actions_distributor_id_fkey" FOREIGN KEY ("distributor_id") REFERENCES "distributors"("distributor_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accountability_logs" ADD CONSTRAINT "accountability_logs_distributor_id_fkey" FOREIGN KEY ("distributor_id") REFERENCES "distributors"("distributor_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accountability_logs" ADD CONSTRAINT "accountability_logs_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "drivers"("driver_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accountability_logs" ADD CONSTRAINT "accountability_logs_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("customer_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accountability_logs" ADD CONSTRAINT "accountability_logs_cylinder_type_id_fkey" FOREIGN KEY ("cylinder_type_id") REFERENCES "cylinder_types"("cylinder_type_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_distributor_id_fkey" FOREIGN KEY ("distributor_id") REFERENCES "distributors"("distributor_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "distributor_settings" ADD CONSTRAINT "distributor_settings_distributor_id_fkey" FOREIGN KEY ("distributor_id") REFERENCES "distributors"("distributor_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "licenses" ADD CONSTRAINT "licenses_distributor_id_fkey" FOREIGN KEY ("distributor_id") REFERENCES "distributors"("distributor_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_submissions" ADD CONSTRAINT "contact_submissions_distributor_id_fkey" FOREIGN KEY ("distributor_id") REFERENCES "distributors"("distributor_id") ON DELETE SET NULL ON UPDATE CASCADE;

