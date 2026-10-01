ALTER TABLE "idempotency_keys" DROP CONSTRAINT "idempotency_keys_key_unique";--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD COLUMN "user_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_user_key_unique" UNIQUE("user_id","key");