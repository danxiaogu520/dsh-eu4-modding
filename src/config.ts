import z from '@deepseek-ai/schemastery';
import { isAbsolute, resolve } from 'node:path';
import type { JsonObject } from './json.js';

export interface Config {
  serverPath: string;
  serverVersion: string;
  serverCacheDirectory: string;
  downloadTimeoutMs: number;
  workspace: string;
  timeoutMs: number;
  maxWorkspaces: number;
  maxOutputChars: number;
  vanillaMode: 'auto' | 'cacheOnly' | 'disabled';
  gameDirectory: string;
  vanillaIndexCache: string;
  dependencies: { id: string; path: string; index?: string }[];
  preferredLocalisationLanguages: string[];
  autoRefresh: boolean;
}

export type Dependency = Config['dependencies'][number];
export const sharedConfigKeys = ['dependencies', 'gameDirectory', 'vanillaIndexCache', 'vanillaMode', 'preferredLocalisationLanguages'] as const;
const overrides = new WeakMap<Config, Set<string>>();
export function configOverrides(config: Config): ReadonlySet<string> { return overrides.get(config) ?? new Set(); }

const dependenciesSchema = z.array(z.object({ id: z.string().required(), path: z.string().required(), index: z.string() }));
const languagesSchema = z.array(z.string());
// Remove implicit [] defaults: omitted arrays inherit settings, explicit [] survives profile saving.
dependenciesSchema.meta.default = undefined;
languagesSchema.meta.default = undefined;

// Keep declaration emission independent of schemastery's transitive implementation types.
export const Config: z<Partial<Config>, Partial<Config>> = z.object({
  serverPath: z.string().default('auto').description('auto downloads a verified GitHub release; otherwise use a local executable path or PATH name (not paradoxcode-mcp).'),
  serverVersion: z.string().default('latest').description('Latest stable GitHub release, or a fixed version such as 0.5.2. Only used with serverPath: auto.'),
  serverCacheDirectory: z.string().default('').description('Managed server cache directory. Empty uses the OS user cache directory.'),
  downloadTimeoutMs: z.number().min(1000).max(600000).default(300000).description('Total release lookup/download deadline in milliseconds; separate from LSP indexing time.'),
  workspace: z.string().default('').description('Mod root. Empty detects the Mod from the calling session directory, its ancestors, or a single child Mod. Each tool can override it.'),
  timeoutMs: z.number().min(1000).max(600000).default(300000).description('LSP request and initial indexing deadline in milliseconds; allows first-time game indexing.'),
  maxWorkspaces: z.number().min(1).max(16).default(3).description('Maximum language server processes; idle sessions are evicted first.'),
  maxOutputChars: z.number().min(1024).max(262144).default(24000).description('Compact native display budget. Oversized results return summaries and a paradoxcode_result retrieval token; PTC retains the complete JSON.'),
  vanillaMode: z.union(['auto', 'cacheOnly', 'disabled']).description('Defaults to automatic game discovery; reuses the VS Code workspace setting unless explicitly overridden here.'),
  gameDirectory: z.string().description('Inherits the VS Code workspace setting; otherwise empty. An explicit value overrides the shared setting.'),
  vanillaIndexCache: z.string().description('Inherits the VS Code workspace setting; otherwise empty. An explicit value overrides the shared setting.'),
  dependencies: dependenciesSchema.description('Inherits shared paradoxcode.dependencies, otherwise []. Explicit values override it in low-to-high priority order; [] clears dependencies.'),
  preferredLocalisationLanguages: languagesSchema.description('Optional override of shared localisation languages; defaults to English.'),
  autoRefresh: z.boolean().default(true).description('Watch external Mod edits and compare declared paths before/after tools; refresh only owning workspaces, using file notifications when possible.'),
});

export const inheritedDefaults: JsonObject = {
  vanillaMode: 'auto', gameDirectory: '', vanillaIndexCache: '', dependencies: [],
  preferredLocalisationLanguages: ['english'],
};

export function normalizeConfig(input: Partial<Config> = {}): Config {
  const parsed = Config(input) as Partial<Config>;
  const config = { ...parsed } as Config;
  config.vanillaMode ??= 'auto';
  config.gameDirectory ??= '';
  config.vanillaIndexCache ??= '';
  config.dependencies ??= [];
  config.preferredLocalisationLanguages ??= ['english'];
  overrides.set(config, new Set(sharedConfigKeys.filter(key => parsed[key] !== undefined)));
  for (const key of ['timeoutMs', 'downloadTimeoutMs', 'maxWorkspaces', 'maxOutputChars'] as const) {
    if (!Number.isSafeInteger(config[key])) throw new Error(`${key} must be an integer`);
  }
  if (!config.serverPath.trim()) throw new Error('serverPath must not be empty');
  config.serverPath = config.serverPath.trim();
  config.serverVersion = config.serverVersion.trim().replace(/^v(?=\d)/, '');
  if (config.serverVersion !== 'latest' && !/^\d+\.\d+\.\d+$/.test(config.serverVersion)) {
    throw new Error('serverVersion must be latest or a stable version such as 0.5.2');
  }
  if (config.serverCacheDirectory) config.serverCacheDirectory = resolve(config.serverCacheDirectory);
  // Resolve a configured relative executable before spawning with the Mod as cwd.
  if (!isAbsolute(config.serverPath) && /[\\/]/.test(config.serverPath)) {
    config.serverPath = resolve(config.serverPath);
  }
  return config;
}

export function initializationOptions(config: Config): JsonObject {
  return {
    vanillaMode: config.vanillaMode,
    workspaceWideDiagnostics: false,
    preferredLocalisationLanguages: config.preferredLocalisationLanguages,
    dependencies: config.dependencies.map(dep => ({ ...dep })),
    ...(config.gameDirectory ? { gameDirectory: config.gameDirectory } : {}),
    ...(config.vanillaIndexCache ? { vanillaIndexCache: config.vanillaIndexCache } : {}),
  };
}
