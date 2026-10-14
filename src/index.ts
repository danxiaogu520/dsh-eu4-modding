import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-system-prompt';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import { isAbsolute, resolve } from 'node:path';
import { Config, normalizeConfig, type Config as PluginConfig } from './config.js';
import type { JsonObject } from './json.js';
import { makeTools } from './tools.js';
import { WorkspacePool } from './workspace.js';
import { discoverModRoot } from './discovery.js';

export { Config };
export type { PluginConfig };
export const name = 'eu4-modding';
export const inject = ['tools', 'systemPrompt'];

export const workflow = `For EU4 modding, use ParadoxCode's indexed language intelligence:
1. Call paradoxcode_workspace for the detected Mod root, server version, rule identity and scan coverage. No plugin configuration is needed: the server is downloaded on first use and Mod roots are detected from the session directory. If the user names a Mod elsewhere or several Mods are available, select it with the workspace parameter. The first download and local game indexing can take a few minutes; explain the wait to the user. Missing Vanilla data does not prevent Mod-only work, but preserve coverage limitations.
2. Discover existing definitions with paradoxcode_search, check key/value/scope rules with paradoxcode_rules, and inspect usages with paradoxcode_symbol_references before editing definitions.
3. Use paradoxcode_document for hover/completion/definition/references, and paradoxcode_localisation for event titles, descriptions, options and missing localisation keys.
4. Validate drafts with paradoxcode_validate_text, resolve diagnostic codes, then write with the normal DSH file tools. Draft files are analyzed independently, so new cross-file definitions require disk validation after writing.
5. After edits, call paradoxcode_refresh if needed and paradoxcode_diagnostics on changed files. Page through nextOffset for whole-Mod checks. Treat UnknownKey, InvalidValue, WrongScope and UnknownLocalisationKey as actionable; report coverage gaps and partial/truncated results.
6. Rename/format tools return previews. Review writability and hashes, use DSH's normal editing tools to apply reviewed changes, then refresh and diagnose. Input cursor lines are 1-based; UTF-16 columns and raw LSP result ranges are 0-based.
7. Workspace analysis settings and dependencies are shared with VS Code via .vscode/settings.json. Use paradoxcode_dependencies inspect to review the dependency chain. Its save actions edit only that shared setting, require a fresh baseHash, and must follow the user's requested dependency changes. sync writes the expanded chain into the explicit list both clients load; inspection alone never changes the load order. Configuration edits are picked up on the next analysis call.
ParadoxCode analysis does not prove in-game behavior. Analysis tools never write Mod source files; paradoxcode_dependencies save actions write only the shared workspace settings. Answer in the user's language.`;

export function apply(ctx: Context, input: Partial<PluginConfig> = {}): void {
  const config = normalizeConfig(input);
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
  for (const tool of makeTools(config, pool, getWorkspace)) ctx.tools.register(tool);
  ctx.systemPrompt.section({ name: 'eu4-modding:workflow', order: 4500, interpolate: false, text: workflow });
  ctx.on('tools/result', (exec, result) => {
    if (!exec.name.startsWith('paradoxcode_') && !result.isError && /write|edit|replace|patch|rename|remove|delete|bash|shell|pwsh|terminal|cmd/.test(exec.name)) pool.markDirty();
  });
  ctx.effect(() => () => pool.dispose());
}
