import { createPlugin } from './lib/plugin.js'
import { PLUGIN_NAME, PLUGIN_VERSION } from './lib/config.js'

export const name = PLUGIN_NAME
export const version = PLUGIN_VERSION
export const inject = ['tools']

// Registers the COMSOL tools with the Host tool registry.
export function apply(ctx, config) {
  const plugin = createPlugin(ctx, config)

  for (const tool of plugin.tools) {
    ctx.effect(() => ctx.tools.register(tool))
  }

  ctx.effect(() => () => {
    plugin.dispose()
  })
}
