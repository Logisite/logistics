import { getConfig } from '../shared/config.js';

interface MapboxFeature {
  geometry: {
    coordinates: [number, number];
  };
}

interface MapboxResponse {
  features?: MapboxFeature[];
}

export async function geocodeAddress(
  address: string,
): Promise<{ lng: number; lat: number } | null> {
  const token = getConfig().mapboxAccessToken;
  if (!token) return null;

  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(address)}.json?access_token=${token}&country=GB&limit=1`;

  const res = await fetch(url);
  if (!res.ok) return null;

  const data = (await res.json()) as MapboxResponse;
  const feature = data.features?.[0];
  if (!feature) return null;

  const [lng, lat] = feature.geometry.coordinates;
  return { lng, lat };
}
