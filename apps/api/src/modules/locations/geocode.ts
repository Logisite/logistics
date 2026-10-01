import { getConfig } from '../../shared/config.js';
import { logger } from '../../shared/logger.js';

interface MapboxFeature {
  geometry: {
    coordinates: [number, number];
  };
}

interface MapboxResponse {
  features?: MapboxFeature[];
}

const TIMEOUT_MS = 5_000;

export async function geocodeAddress(
  address: string,
): Promise<{ lng: number; lat: number } | null> {
  const token = getConfig().mapboxAccessToken;
  if (!token) return null;

  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(address)}.json?access_token=${token}&country=GB&limit=1`;

  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    logger.error({ err }, 'locations.geocode-failed');
    return null;
  }
  if (!res.ok) {
    logger.warn({ status: res.status }, 'locations.geocode-failed');
    return null;
  }

  let data: MapboxResponse;
  try {
    data = (await res.json()) as MapboxResponse;
  } catch (err) {
    logger.error({ err }, 'locations.geocode-failed');
    return null;
  }

  const feature = data.features?.[0];
  if (!feature) return null;

  const [lng, lat] = feature.geometry.coordinates;
  if (!Number.isFinite(lng) || !Number.isFinite(lat) || lng < -180 || lng > 180 || lat < -90 || lat > 90) {
    logger.warn({ lng, lat }, 'locations.geocode-invalid');
    return null;
  }
  return { lng, lat };
}