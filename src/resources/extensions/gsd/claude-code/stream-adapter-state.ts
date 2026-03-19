/**
 * Stream Adapter State — per-dispatch mutable state for the claude-code provider.
 *
 * auto.ts calls the setters before each pi.sendMessage() dispatch.
 * index.ts wires the getters into StreamAdapterDeps callbacks at registration time.
 * This neutral module breaks what would otherwise be a circular import:
 *   auto.ts -> index.ts -> auto.ts
 */

let currentUnitInfo: { unitType: string; unitId: string } = { unitType: "unknown", unitId: "unknown" };
let currentBasePath: string = process.cwd();
let currentIsUnitDone: () => boolean = () => false;

// ── Setters (called by auto.ts before dispatch) ─────────────────────────────

export function setStreamAdapterUnitInfo(unitType: string, unitId: string): void {
  currentUnitInfo = { unitType, unitId };
}

export function setStreamAdapterBasePath(basePath: string): void {
  currentBasePath = basePath;
}

export function setStreamAdapterIsUnitDone(fn: () => boolean): void {
  currentIsUnitDone = fn;
}

// ── Getters (called by stream adapter deps during dispatch) ──────────────────

export function getStreamAdapterUnitInfo(): { unitType: string; unitId: string } {
  return currentUnitInfo;
}

export function getStreamAdapterBasePath(): string {
  return currentBasePath;
}

export function getStreamAdapterIsUnitDone(): boolean {
  return currentIsUnitDone();
}
