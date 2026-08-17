import { rm } from 'node:fs/promises';

export async function setup() {
  await rm('./test-pgdata', { recursive: true, force: true });
}
