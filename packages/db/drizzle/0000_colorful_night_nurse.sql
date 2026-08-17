CREATE TYPE "public"."currency" AS ENUM('USD', 'EUR', 'GBP');--> statement-breakpoint
CREATE TYPE "public"."delivery_option" AS ENUM('STANDARD', 'EXPRESS', 'SAME_DAY', 'SCHEDULED', 'PICKUP_AT_LOCATION', 'DROP_OFF_AT_LOCATION');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('ADMIN', 'DISPATCHER', 'BRANCH_OPERATOR', 'DRIVER', 'MERCHANT', 'CUSTOMER');--> statement-breakpoint
CREATE TYPE "public"."shipment_status" AS ENUM('DRAFT', 'BOOKED', 'PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'FAILED_ATTEMPT', 'RETURNING', 'RETURNED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."size_class" AS ENUM('SMALL', 'MEDIUM', 'LARGE', 'EXTRA_LARGE');--> statement-breakpoint
CREATE TYPE "public"."weight_class" AS ENUM('LIGHT', 'MEDIUM', 'HEAVY', 'EXTRA_HEAVY');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('PLANNED', 'ACTIVE', 'COMPLETED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('CASH', 'CARD');--> statement-breakpoint
CREATE TYPE "public"."notification_channel" AS ENUM('EMAIL', 'IN_APP');--> statement-breakpoint
CREATE TABLE "email_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"email" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_verifications_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "role_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_grants_user_role_unique" UNIQUE("user_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" "role" NOT NULL,
	"description" text,
	"permissions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roles_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"refresh_token_hash" text NOT NULL,
	"device_name" text,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_refresh_token_hash_unique" UNIQUE("refresh_token_hash")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"label" text NOT NULL,
	"line1" text NOT NULL,
	"line2" text,
	"city" text NOT NULL,
	"zone_id" uuid,
	"hub_id" uuid,
	"pickup_location_id" uuid,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"phone" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_profiles_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "emergency_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"name" text NOT NULL,
	"phone" text NOT NULL,
	"email" text,
	"relationship" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merchant_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"business_name" text NOT NULL,
	"email" text,
	"phone" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchant_profiles_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "hubs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"address" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hubs_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "pickup_locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hub_id" uuid,
	"name" text NOT NULL,
	"address" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "zones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hub_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "zones_hub_name_unique" UNIQUE("hub_id","name")
);
--> statement-breakpoint
CREATE TABLE "delivery_options" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" "delivery_option" NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_options_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "pricing_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"origin_zone_id" uuid NOT NULL,
	"destination_zone_id" uuid NOT NULL,
	"size_class" "size_class" NOT NULL,
	"weight_class" "weight_class" NOT NULL,
	"delivery_option_id" uuid NOT NULL,
	"currency" "currency" NOT NULL,
	"amount_cents" integer NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_to" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "packages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shipment_id" uuid NOT NULL,
	"size_class" "size_class" NOT NULL,
	"weight_class" "weight_class" NOT NULL,
	"weight_grams" integer,
	"quantity" integer DEFAULT 1 NOT NULL,
	"custom_dimensions" jsonb,
	"category" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shipment_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shipment_id" uuid NOT NULL,
	"from_status" "shipment_status",
	"to_status" "shipment_status" NOT NULL,
	"actor_user_id" uuid,
	"location_label" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipment_events_shipment_occurred_unique" UNIQUE("shipment_id","occurred_at")
);
--> statement-breakpoint
CREATE TABLE "shipments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" "shipment_status" DEFAULT 'DRAFT' NOT NULL,
	"field_lock" boolean DEFAULT false NOT NULL,
	"sender_user_id" uuid,
	"sender_name" text,
	"sender_email" text,
	"sender_phone" text,
	"recipient_name" text,
	"recipient_email" text,
	"recipient_phone" text,
	"pickup_location_id" uuid,
	"destination_zone_id" uuid,
	"delivery_option_id" uuid,
	"quote_amount_cents" integer,
	"quote_currency" "currency",
	"quote_snapshot" jsonb,
	"scheduled_for" timestamp with time zone,
	"special_instructions" text,
	"category" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gps_positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"driver_user_id" uuid,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_sheet_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"shipment_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_sheet_entries_run_shipment_unique" UNIQUE("run_id","shipment_id")
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"driver_user_id" uuid,
	"hub_id" uuid,
	"status" "run_status" DEFAULT 'PLANNED' NOT NULL,
	"scheduled_date" timestamp with time zone,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "collections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shipment_id" uuid NOT NULL,
	"driver_user_id" uuid NOT NULL,
	"run_id" uuid,
	"amount_cents" integer NOT NULL,
	"currency" "currency" NOT NULL,
	"payment_method" "payment_method" NOT NULL,
	"collected_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'COLLECTED' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deposits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"branch_operator_user_id" uuid NOT NULL,
	"hub_id" uuid NOT NULL,
	"driver_user_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" "currency" NOT NULL,
	"deposited_at" timestamp with time zone NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "disputes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"collection_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" "currency" NOT NULL,
	"resolved_by_user_id" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reconciliations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deposit_id" uuid NOT NULL,
	"collection_id" uuid NOT NULL,
	"fx_rate" numeric NOT NULL,
	"functional_currency" "currency" NOT NULL,
	"functional_amount_cents" integer NOT NULL,
	"reconciled_by_user_id" uuid NOT NULL,
	"reconciled_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'MATCHED' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_profile_id" uuid,
	"functional_currency" "currency" NOT NULL,
	"functional_amount_cents" integer NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"channel" "notification_channel" NOT NULL,
	"type" text NOT NULL,
	"subject" text,
	"body" text,
	"payload" jsonb,
	"status" text DEFAULT 'QUEUED' NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "static_references" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	"payload" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "static_references_kind_unique" UNIQUE("kind")
);
--> statement-breakpoint
CREATE TABLE "sync_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"op_id" uuid NOT NULL,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" uuid,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_ledger_device_seq_unique" UNIQUE("device_id","seq")
);
--> statement-breakpoint
CREATE TABLE "sync_ops" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"op_id" uuid NOT NULL,
	"op_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'QUEUED' NOT NULL,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_ops_device_op_id_unique" UNIQUE("device_id","op_id"),
	CONSTRAINT "sync_ops_device_seq_unique" UNIQUE("device_id","seq")
);
--> statement-breakpoint
ALTER TABLE "email_verifications" ADD CONSTRAINT "email_verifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_grants" ADD CONSTRAINT "role_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_grants" ADD CONSTRAINT "role_grants_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_customer_id_customer_profiles_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_hub_id_hubs_id_fk" FOREIGN KEY ("hub_id") REFERENCES "public"."hubs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_pickup_location_id_pickup_locations_id_fk" FOREIGN KEY ("pickup_location_id") REFERENCES "public"."pickup_locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_profiles" ADD CONSTRAINT "customer_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emergency_contacts" ADD CONSTRAINT "emergency_contacts_customer_id_customer_profiles_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_profiles" ADD CONSTRAINT "merchant_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pickup_locations" ADD CONSTRAINT "pickup_locations_hub_id_hubs_id_fk" FOREIGN KEY ("hub_id") REFERENCES "public"."hubs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zones" ADD CONSTRAINT "zones_hub_id_hubs_id_fk" FOREIGN KEY ("hub_id") REFERENCES "public"."hubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricing_rules" ADD CONSTRAINT "pricing_rules_origin_zone_id_zones_id_fk" FOREIGN KEY ("origin_zone_id") REFERENCES "public"."zones"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricing_rules" ADD CONSTRAINT "pricing_rules_destination_zone_id_zones_id_fk" FOREIGN KEY ("destination_zone_id") REFERENCES "public"."zones"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricing_rules" ADD CONSTRAINT "pricing_rules_delivery_option_id_delivery_options_id_fk" FOREIGN KEY ("delivery_option_id") REFERENCES "public"."delivery_options"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packages" ADD CONSTRAINT "packages_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_events" ADD CONSTRAINT "shipment_events_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_events" ADD CONSTRAINT "shipment_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_sender_user_id_users_id_fk" FOREIGN KEY ("sender_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_pickup_location_id_pickup_locations_id_fk" FOREIGN KEY ("pickup_location_id") REFERENCES "public"."pickup_locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_destination_zone_id_zones_id_fk" FOREIGN KEY ("destination_zone_id") REFERENCES "public"."zones"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_delivery_option_id_delivery_options_id_fk" FOREIGN KEY ("delivery_option_id") REFERENCES "public"."delivery_options"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gps_positions" ADD CONSTRAINT "gps_positions_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gps_positions" ADD CONSTRAINT "gps_positions_driver_user_id_users_id_fk" FOREIGN KEY ("driver_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_sheet_entries" ADD CONSTRAINT "run_sheet_entries_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_sheet_entries" ADD CONSTRAINT "run_sheet_entries_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_driver_user_id_users_id_fk" FOREIGN KEY ("driver_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_hub_id_hubs_id_fk" FOREIGN KEY ("hub_id") REFERENCES "public"."hubs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collections" ADD CONSTRAINT "collections_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collections" ADD CONSTRAINT "collections_driver_user_id_users_id_fk" FOREIGN KEY ("driver_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collections" ADD CONSTRAINT "collections_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_branch_operator_user_id_users_id_fk" FOREIGN KEY ("branch_operator_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_hub_id_hubs_id_fk" FOREIGN KEY ("hub_id") REFERENCES "public"."hubs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_driver_user_id_users_id_fk" FOREIGN KEY ("driver_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliations" ADD CONSTRAINT "reconciliations_deposit_id_deposits_id_fk" FOREIGN KEY ("deposit_id") REFERENCES "public"."deposits"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliations" ADD CONSTRAINT "reconciliations_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliations" ADD CONSTRAINT "reconciliations_reconciled_by_user_id_users_id_fk" FOREIGN KEY ("reconciled_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_logs" ADD CONSTRAINT "notification_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_ledger" ADD CONSTRAINT "sync_ledger_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_ops" ADD CONSTRAINT "sync_ops_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_verifications_user_id_idx" ON "email_verifications" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "role_grants_user_id_idx" ON "role_grants" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "addresses_customer_id_idx" ON "addresses" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "emergency_contacts_customer_id_idx" ON "emergency_contacts" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "pickup_locations_hub_id_idx" ON "pickup_locations" USING btree ("hub_id");--> statement-breakpoint
CREATE INDEX "pricing_rules_origin_zone_id_idx" ON "pricing_rules" USING btree ("origin_zone_id");--> statement-breakpoint
CREATE INDEX "pricing_rules_destination_zone_id_idx" ON "pricing_rules" USING btree ("destination_zone_id");--> statement-breakpoint
CREATE INDEX "pricing_rules_delivery_option_id_idx" ON "pricing_rules" USING btree ("delivery_option_id");--> statement-breakpoint
CREATE INDEX "packages_shipment_id_idx" ON "packages" USING btree ("shipment_id");--> statement-breakpoint
CREATE INDEX "shipment_events_shipment_id_idx" ON "shipment_events" USING btree ("shipment_id");--> statement-breakpoint
CREATE INDEX "shipments_sender_user_id_idx" ON "shipments" USING btree ("sender_user_id");--> statement-breakpoint
CREATE INDEX "shipments_destination_zone_id_idx" ON "shipments" USING btree ("destination_zone_id");--> statement-breakpoint
CREATE INDEX "gps_positions_run_id_idx" ON "gps_positions" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "gps_positions_driver_user_id_idx" ON "gps_positions" USING btree ("driver_user_id");--> statement-breakpoint
CREATE INDEX "run_sheet_entries_run_id_idx" ON "run_sheet_entries" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "runs_driver_user_id_idx" ON "runs" USING btree ("driver_user_id");--> statement-breakpoint
CREATE INDEX "runs_hub_id_idx" ON "runs" USING btree ("hub_id");--> statement-breakpoint
CREATE INDEX "collections_shipment_id_idx" ON "collections" USING btree ("shipment_id");--> statement-breakpoint
CREATE INDEX "collections_driver_user_id_idx" ON "collections" USING btree ("driver_user_id");--> statement-breakpoint
CREATE INDEX "deposits_hub_id_idx" ON "deposits" USING btree ("hub_id");--> statement-breakpoint
CREATE INDEX "deposits_driver_user_id_idx" ON "deposits" USING btree ("driver_user_id");--> statement-breakpoint
CREATE INDEX "disputes_collection_id_idx" ON "disputes" USING btree ("collection_id");--> statement-breakpoint
CREATE INDEX "reconciliations_deposit_id_idx" ON "reconciliations" USING btree ("deposit_id");--> statement-breakpoint
CREATE INDEX "reconciliations_collection_id_idx" ON "reconciliations" USING btree ("collection_id");--> statement-breakpoint
CREATE INDEX "notification_logs_user_id_idx" ON "notification_logs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "notification_logs_status_idx" ON "notification_logs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "devices_user_id_idx" ON "devices" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sync_ledger_device_id_idx" ON "sync_ledger" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "sync_ops_device_id_idx" ON "sync_ops" USING btree ("device_id");