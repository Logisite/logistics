CREATE EXTENSION IF NOT EXISTS postgis;--> statement-breakpoint
ALTER TABLE "hubs" ADD COLUMN "location" geometry('point', 4326);--> statement-breakpoint
CREATE INDEX "hubs_spatial_idx" ON "hubs" USING gist ("location");--> statement-breakpoint
ALTER TABLE "pickup_locations" ADD COLUMN "location" geometry('point', 4326);--> statement-breakpoint
CREATE INDEX "pickup_locations_spatial_idx" ON "pickup_locations" USING gist ("location");--> statement-breakpoint
ALTER TABLE "zones" ADD COLUMN "centroid" geometry('point', 4326);--> statement-breakpoint
CREATE INDEX "zones_centroid_idx" ON "zones" USING gist ("centroid");
