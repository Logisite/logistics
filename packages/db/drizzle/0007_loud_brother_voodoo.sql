ALTER TABLE "shipment_events" DROP CONSTRAINT "shipment_events_shipment_occurred_unique";--> statement-breakpoint
ALTER TABLE "shipment_events" ADD COLUMN "device_id" uuid;--> statement-breakpoint
ALTER TABLE "shipment_events" ADD COLUMN "op_id" uuid;--> statement-breakpoint
ALTER TABLE "shipment_events" ADD COLUMN "operator_id" text;--> statement-breakpoint
CREATE INDEX "shipment_events_shipment_occurred_idx" ON "shipment_events" USING btree ("shipment_id","occurred_at");--> statement-breakpoint
CREATE INDEX "run_sheet_entries_shipment_id_idx" ON "run_sheet_entries" USING btree ("shipment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shipment_events_device_op_unique" ON "shipment_events" USING btree ("device_id","op_id") WHERE "device_id" IS NOT NULL AND "op_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "sync_ledger" ADD CONSTRAINT "sync_ledger_device_op_unique" UNIQUE("device_id","op_id");