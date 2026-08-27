CREATE TYPE "public"."capability_action" AS ENUM('BOOKING', 'TRACKING', 'CLAIM');--> statement-breakpoint
CREATE TYPE "public"."contact_channel" AS ENUM('PHONE', 'EMAIL', 'WHATSAPP', 'MESSENGER', 'WEB');--> statement-breakpoint
CREATE TABLE "contact_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"channel" "contact_channel" NOT NULL,
	"identifier" text NOT NULL,
	"country" text,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_identities_user_channel_identifier_unique" UNIQUE("user_id","channel","identifier")
);
--> statement-breakpoint
CREATE TABLE "capability_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nonce" text NOT NULL,
	"action" "capability_action" NOT NULL,
	"hmac_signature" text NOT NULL,
	"sender_user_id" uuid,
	"recipient_user_id" uuid,
	"shipment_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "capability_links_nonce_unique" UNIQUE("nonce")
);
--> statement-breakpoint
CREATE TABLE "phone_otps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone" text NOT NULL,
	"code_hash" text NOT NULL,
	"purpose" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "is_shadow" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "shadow_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "upgraded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "contact_identities" ADD CONSTRAINT "contact_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capability_links" ADD CONSTRAINT "capability_links_sender_user_id_users_id_fk" FOREIGN KEY ("sender_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capability_links" ADD CONSTRAINT "capability_links_recipient_user_id_users_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capability_links" ADD CONSTRAINT "capability_links_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capability_links" ADD CONSTRAINT "capability_links_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contact_identities_user_id_idx" ON "contact_identities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "contact_identities_channel_identifier_idx" ON "contact_identities" USING btree ("channel","identifier");--> statement-breakpoint
CREATE INDEX "capability_links_sender_user_id_idx" ON "capability_links" USING btree ("sender_user_id");--> statement-breakpoint
CREATE INDEX "capability_links_recipient_user_id_idx" ON "capability_links" USING btree ("recipient_user_id");--> statement-breakpoint
CREATE INDEX "capability_links_expires_at_idx" ON "capability_links" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "phone_otps_phone_purpose_idx" ON "phone_otps" USING btree ("phone","purpose");--> statement-breakpoint
CREATE INDEX "phone_otps_expires_at_idx" ON "phone_otps" USING btree ("expires_at");
