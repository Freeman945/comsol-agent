import { loadConfig, describeConfig, PLUGIN_NAME, PLUGIN_VERSION } from './config.js'
import { ComsolDriver } from './driver.js'
import { JobManager } from './jobs.js'
import { createTools } from './tools.js'

function createLogger(prefix) {
  const write = (level, message) => {
    try {
      // The Host owns its own logger; keep plugin logging minimal and explicit.
      console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](`[${prefix}] ${message}`)
    } catch {
      // ignore logging failures
    }
  }
  return {
    info: (message) => write('info', message),
    warn: (message) => write('warn', message),
    error: (message) => write('error', message),
  }
}

export function createPlugin(_ctx, rawConfig = {}) {
  const logger = createLogger(PLUGIN_NAME)
  const config = loadConfig(rawConfig ?? {})
  const driver = new ComsolDriver(config, logger)
  const jobs = new JobManager(config, logger)
  const { tools, dispose } = createTools({ config, driver, jobs, logger })

  logger.info(
    `loaded ${PLUGIN_NAME}@${PLUGIN_VERSION}; workspace=${config.workspaceRoot}; comsolHome=${config.comsolHome ?? 'not detected'}`,
  )

  return {
    plugin: { name: PLUGIN_NAME, version: PLUGIN_VERSION },
    config,
    configSummary: describeConfig(config),
    driver,
    jobs,
    tools,
    dispose,
  }
}
