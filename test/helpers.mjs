import { Context } from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import * as plugin from '../lib/index.js';

export async function harness(config = {}) {
  const ctx = new Context();
  const promptFork = ctx.plugin(SystemPrompt, {});
  const toolsFork = ctx.plugin(Tools, { mode: 'native' });
  const pluginFork = ctx.plugin(plugin, config);
  await Promise.all([promptFork, toolsFork, pluginFork]);
  return {
    ctx, pluginFork,
    call(name, args = {}, signal = new AbortController().signal, agent) {
      return ctx.tools.execute({ name, arguments: args, callId: `test-${Math.random()}`, signal, ...(agent ? { agent } : {}) });
    },
    async dispose() { await ctx.fiber.dispose(); },
  };
}
