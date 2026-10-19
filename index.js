import { createPlugin } from './lib/plugin.js'
import { PLUGIN_NAME, PLUGIN_VERSION } from './lib/config.js'

export const name = PLUGIN_NAME
export const version = PLUGIN_VERSION
export const inject = ['tools']

/**
 * COMSOL Simulation Assistant.
 *
 * Registers a set of agent tools that drive a local COMSOL Multiphysics
 * installation through its official Java API. The plugin itself never builds
 * shell command strings and never writes outside the configured workspace.
 */
export function apply(ctx, config) {
  const plugin = createPlugin(ctx, config)

  for (const tool of plugin.tools) {
    ctx.effect(() => ctx.tools.register(tool))
  }

  ctx.effect(() => () => {
    plugin.dispose()
  })
}
