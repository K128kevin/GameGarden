import { bluesky } from "./bluesky";
import { reddit } from "./reddit";
import type { PlatformConnector } from "./types";
import { youtube } from "./youtube";

/**
 * All supported platforms. To add one, implement PlatformConnector (see
 * ./types.ts) and add it here — the UI, OAuth routes, sync, planner and
 * publisher pick it up automatically.
 */
export const connectors: PlatformConnector[] = [bluesky, youtube, reddit];

export function getConnector(id: string): PlatformConnector {
  const c = connectors.find((x) => x.id === id);
  if (!c) throw new Error(`Unknown platform: ${id}`);
  return c;
}

export function findConnector(id: string): PlatformConnector | undefined {
  return connectors.find((x) => x.id === id);
}
