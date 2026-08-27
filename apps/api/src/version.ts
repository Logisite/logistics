import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

let cachedPin: Record<string, unknown> | null = null;

export function getVersionPin(operatorName: string): Record<string, unknown> | null {
  if (cachedPin !== null) return cachedPin;

  const pinPath = join(process.cwd(), 'operators', `${operatorName}.json`);
  if (!existsSync(pinPath)) {
    cachedPin = {};
    return null;
  }

  try {
    const raw = readFileSync(pinPath, 'utf-8');
    cachedPin = JSON.parse(raw) as Record<string, unknown>;
    return cachedPin;
  } catch {
    return null;
  }
}
