import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-system-prompt';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import { isAbsolute, resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import { Config, normalizeConfig, type Config as PluginConfig } from './config.js';
import type { JsonObject } from './json.js';
import { makeTools } from './tools.js';
import { WorkspacePool } from './workspace.js';
import type { FsService, SandboxPolicyView, WriteBridges } from './write.js';
import { discoverModRoot } from './discovery.js';

export { Config };
export type { PluginConfig };
export const name = 'eu4-modding';
export const inject = ['tools', 'systemPrompt'];

export const workflow = `For EU4 modding, use ParadoxCode's indexed language intelligence:
1. Call paradoxcode_workspace for the detected Mod root, server version, rule identity, scan coverage and serverFeatures. No plugin configuration is needed: the server is downloaded on first use and Mod roots are detected from the session directory. If the user names a Mod elsewhere or several Mods are available, select it with the workspace parameter. The first download and local game indexing can take a few minutes; explain the wait to the user. Missing Vanilla data does not prevent Mod-only work, but preserve coverage limitations. ParadoxCode 0.5.3 or newer is required; when serverFeatures.upgradeRequired is true, report the missing capabilities (and the server upgrade) instead of treating them as analysis results.
2. Discover existing definitions with paradoxcode_search, check key/value/scope rules with paradoxcode_rules, and inspect usages with paradoxcode_symbol_references before editing definitions.
3. Use paradoxcode_document for hover/completion/definition/references, and paradoxcode_localisation for event titles, descriptions, options and missing localisation keys. When a Mod is a patch layer over a dependency, read the dependency's own text with paradoxcode_read (encoding aware, any indexed root) instead of rebuilding hex pipelines; it returns encoding, damage and hash metadata and never writes.
4. Jointly validate related drafts with paradoxcode_validate_text before writing; the entire temporary batch participates in resolution and originals are restored before returning. Review per-file counts, then write with normal DSH file tools and validate on disk. Use paradoxcode_write instead when the target is not plain UTF-8 (legacy localisation or glyph-encoded sources): it previews by default, requires the expectedSha256 from paradoxcode_read, keeps a backup under _maintenance, and refuses damaged or mixed files.
5. Diagnose changed files first, using files and severity/codes/excludeCodes/line filters. File pages use nextOffset. Finish the diagnostic details inside each page using snapshot and nextDiagnosticOffset before moving to the next file page. For large drafts use the same diagnostic continuation. Native summaries preserve counts and a retrieval token: use paradoxcode_result and its nextOffset to read the complete canonical result. Only conclude clean when coverage and unfiltered counts support it. Treat diagnostic codes as actionable after checking applicability, draft definitions and coverage; zero diagnostics does not prove encoding or in-game behavior.
6. Rename/format tools return previews. Review writability and hashes, use DSH's normal editing tools to apply reviewed changes, then refresh and diagnose. Input cursor lines are 1-based; UTF-16 columns and raw LSP result ranges are 0-based.
7. Workspace analysis settings and dependencies are shared with VS Code via .vscode/settings.json. Use paradoxcode_dependencies inspect to review the dependency chain. Its save actions edit only that shared setting, require a fresh baseHash, and must follow the user's requested dependency changes. sync writes the expanded chain into the explicit list both clients load; inspection alone never changes the load order. Configuration edits are picked up on the next analysis call.
8. Search pagination is capability-dependent. Rules, localisation, symbol search and symbol references accept offset plus revision on ParadoxCode 0.5.3+, which is required; when the server does not advertise pdcQueryPagination, report the upgrade instead of retrying. paradoxcode_query remains the paged search across rules, definitions, localisation and text with root and kind filters, preserving revision, snapshot, source identity, matchCount and limitations. Document completion/references use their returned snapshot and nextOffset. A backend-truncated group remains partial even when its display is fully retrieved.
Use indexed tools for legality, winning definitions and cross-file resolution; normal file tools for bytes, paths and edits. Use localisation keyMatch: exact for known keys, and values:"none" to enumerate a key family before fetching text. Inspect suspicious legacy Chinese files with paradoxcode_read or paradoxcode_transcode_preview before converting; conversion is whole-file and all-or-nothing, so read the refusal (invalidUtf8, brokenEscape with offsets, unencodable with code points) instead of retrying blindly. ParadoxCode 0.5.3 or newer is required. Do not invent regex parsers for duplicate event ids or brace validity.
ParadoxCode analysis does not prove in-game behavior. Only paradoxcode_write touches Mod source files, and only with apply:true after a preview plus a hash guard and a _maintenance backup; every other analysis tool is read-only. paradoxcode_dependencies save actions write only the shared workspace settings. Answer in the user's language.`;

/**
 * Host bridges for the writer. Both services are optional: DSH internals are never imported, and a
 * missing sandbox policy makes the writer fail closed rather than punching through the fence.
 */
function bridges(ctx: Context): WriteBridges {
  return {
    policy(exec: unknown): SandboxPolicyView | undefined {
      const service = ctx.get('sandboxPolicy') as { resolve(request?: { session?: unknown }): SandboxPolicyView } | undefined;
      if (!service) return undefined;
      const session = (exec as { agent?: { session?: unknown } } | undefined)?.agent?.session;
      try { return service.resolve(session === undefined ? {} : { session }); } catch { return undefined; }
    },
    fs(): FsService | undefined {
      return ctx.get('fs') as FsService | undefined;
    },
  };
}

export function apply(ctx: Context, input: Partial<PluginConfig> = {}): void {  const config = normalizeConfig(input);
  const pool = new WorkspacePool(config);
  // The working-directory service was added after DSH 0.2.0. Use it when available.
  const getWorkspace = async (args: JsonObject, exec: ToolRunContext): Promise<string> => {
    const service = ctx.get('workingDirectory') as { get(session: unknown): string } | undefined;
    const cwd = (exec.agent && service ? service.get(exec.agent.session) : undefined)
      ?? exec.agent?.session.header.cwd ?? process.cwd();
    const chosen = args.workspace ?? (config.workspace || cwd);
    if (typeof chosen !== 'string' || !chosen.trim()) throw new Error('workspace must be a non-empty directory');
    const path = isAbsolute(chosen) ? chosen : resolve(cwd, chosen);
    return args.workspace !== undefined || config.workspace ? path : discoverModRoot(path, exec.signal);
  };
  for (const tool of makeTools(config, pool, getWorkspace, bridges(ctx))) ctx.tools.register(tool);
  ctx.systemPrompt.section({ name: 'eu4-modding:workflow', order: 4500, interpolate: false, text: workflow });
  ctx.on('tools/execute', async (exec, next) => {
    if (exec.name.startsWith('paradoxcode_') || !config.autoRefresh) return next();
    const service = ctx.get('workingDirectory') as { get(session: unknown): string } | undefined;
    const cwd = (exec.agent && service ? service.get(exec.agent.session) : undefined) ?? exec.agent?.session.header.cwd ?? process.cwd();
    const paths: string[] = [];
    const collect = (value: unknown, key = ''): void => {
      if (typeof value === 'string' && value.length <= 4096 && !/[\r\n\0]/.test(value) && !/^\w+:\/\//.test(value) && ['path', 'file', 'filename', 'filePath', 'source', 'destination', 'oldPath', 'newPath'].includes(key)) paths.push(resolve(cwd, value));
      else if (Array.isArray(value)) for (const entry of value) collect(entry, key);
      else if (value && typeof value === 'object') for (const [field, entry] of Object.entries(value)) collect(entry, field);
    };
    collect(exec.arguments);
    const stamp = async (path: string): Promise<string> => {
      try { const info = await stat(path, { bigint: true }); return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`; }
      catch (error) { return `unavailable:${String((error as NodeJS.ErrnoException).code)}`; }
    };
    const before = await Promise.all(paths.map(stamp));
    try { return await next(); } finally {
      const after = await Promise.all(paths.map(stamp));
      paths.forEach((path, index) => { if (before[index] !== after[index]) pool.markDirty(path); });
      if (!paths.length) pool.markUnwatched(cwd);
    }
  });
  ctx.effect(() => () => pool.dispose());
}
