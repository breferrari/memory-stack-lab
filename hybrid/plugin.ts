/**
 * The lab benches the PLUGIN, never a copy of it.
 *
 * These scripts used to import `./memory.ts` — a snapshot of the plugin's write
 * path living in this repo. When the plugin renamed the module the import broke,
 * and the failure mode before that was worse than a break: for as long as both
 * files existed, the benchmark measured a copy that had quietly stopped matching
 * the thing it claimed to measure.
 *
 * VESTIGE_PLUGIN overrides the checkout location; the default assumes the two
 * repos are siblings.
 */
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PLUGIN = process.env.VESTIGE_PLUGIN ?? resolve(import.meta.dirname, "..", "..", "vestige");
const load = (rel: string) => import(pathToFileURL(join(PLUGIN, rel)).href);

export const pluginRoot = PLUGIN;
export const { capture, readPool, visibleTo, isForeign, rankBySpecificity } = await load("core/lib/memory.ts");
export const { scan } = await load("core/lib/sanitize.ts");
