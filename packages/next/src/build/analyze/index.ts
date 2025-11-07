import type { NextConfigComplete } from '../../server/config-shared'
import type { __ApiPreviewProps } from '../../server/api-utils'

import { setGlobal } from '../../trace'
import * as Log from '../output/log'
import * as path from 'node:path'
import loadConfig from '../../server/config'
import { PHASE_ANALYZE } from '../../shared/lib/constants'
import { turbopackAnalyze, type AnalyzeContext } from '../turbopack-analyze'
import { durationToString } from '../duration-to-string'
import { cp, writeFile } from 'node:fs/promises'
import {
  collectAppFiles,
  collectPagesFiles,
  createPagesMapping,
} from '../entries'
import { createValidFileMatcher } from '../../server/lib/find-page-file'
import { findPagesDir } from '../../lib/find-pages-dir'
import { PAGE_TYPES } from '../../lib/page-types'
import loadCustomRoutes from '../../lib/load-custom-routes'
import { generateRoutesManifest } from '../generate-routes-manifest'
import { checkIsAppPPREnabled } from '../../server/lib/experimental/ppr'
import { normalizeAppPath } from '../../shared/lib/router/utils/app-paths'
import http from 'node:http'

// @ts-expect-error types are in @types/serve-handler
import serveHandler from 'next/dist/compiled/serve-handler'
import { Telemetry } from '../../telemetry/storage'
import { eventAnalyzeCompleted } from '../../telemetry/events'
import { traceGlobals } from '../../trace/shared'

const ANALYZE_PATH = '.next/diagnostics/analyze'

export default async function analyze(
  dir: string,
  reactProductionProfiling = false,
  noMangling = false,
  appDirOnly = false,
  serve: boolean,
  port: number
): Promise<void> {
  try {
    const config: NextConfigComplete = await loadConfig(PHASE_ANALYZE, dir, {
      silent: false,
      reactProductionProfiling,
    })

    process.env.NEXT_DEPLOYMENT_ID = config.deploymentId || ''

    const distDir = path.join(dir, '.next')
    const telemetry = new Telemetry({ distDir })
    setGlobal('phase', PHASE_ANALYZE)
    setGlobal('distDir', distDir)
    setGlobal('telemetry', telemetry)

    Log.info('Analyzing a production build...')

    const analyzeContext: AnalyzeContext = {
      config,
      dir,
      distDir,
      noMangling,
      appDirOnly,
    }

    let shutdownPromise = Promise.resolve()
    const { duration: analyzeDuration, shutdownPromise: p } =
      await turbopackAnalyze(analyzeContext)
    shutdownPromise = p

    const durationString = durationToString(analyzeDuration)
    Log.event(`Compiled successfully in ${durationString}`)

    await shutdownPromise

    await cp(
      path.join(__dirname, '../../bundle-analyzer'),
      path.join(dir, ANALYZE_PATH),
      { recursive: true }
    )

    // Collect and write routes for the bundle analyzer
    const routes = await collectRoutesForAnalyze(dir, config, appDirOnly)

    // Write an index of routes for the route picker
    await writeFile(
      path.join(dir, ANALYZE_PATH, 'data/routes.json'),
      JSON.stringify(routes, null, 2)
    )

    telemetry.record(
      eventAnalyzeCompleted({
        success: true,
        durationInSeconds: Math.round(analyzeDuration),
        totalPageCount: routes.length,
      })
    )

    if (serve) {
      await startServer(ANALYZE_PATH, port)
    }
  } catch (e) {
    const telemetry = traceGlobals.get('telemetry') as Telemetry | undefined
    if (telemetry) {
      telemetry.record(
        eventAnalyzeCompleted({
          success: false,
        })
      )
    }

    throw e
  }
}

/**
 * Collects all routes from the project for the bundle analyzer.
 * Returns a list of route paths (both static and dynamic).
 */
async function collectRoutesForAnalyze(
  dir: string,
  config: NextConfigComplete,
  appDirOnly: boolean
): Promise<string[]> {
  const { pagesDir, appDir } = findPagesDir(dir)
  const validFileMatcher = createValidFileMatcher(config.pageExtensions, appDir)

  const { appPaths } = appDir
    ? await collectAppFiles(appDir, validFileMatcher)
    : { appPaths: [] }
  const pagesPaths = pagesDir
    ? await collectPagesFiles(pagesDir, validFileMatcher)
    : null

  const appMapping = await createPagesMapping({
    pagePaths: appPaths,
    isDev: false,
    pagesType: PAGE_TYPES.APP,
    pageExtensions: config.pageExtensions,
    pagesDir,
    appDir,
    appDirOnly,
  })

  const pagesMapping = pagesPaths
    ? await createPagesMapping({
        pagePaths: pagesPaths,
        isDev: false,
        pagesType: PAGE_TYPES.PAGES,
        pageExtensions: config.pageExtensions,
        pagesDir,
        appDir,
        appDirOnly,
      })
    : null

  const pageKeys = {
    pages: pagesMapping ? Object.keys(pagesMapping) : [],
    app: appMapping
      ? Object.keys(appMapping).map((key) => normalizeAppPath(key))
      : undefined,
  }

  // Load custom routes
  const { redirects, headers, rewrites } = await loadCustomRoutes(config)

  // Compute restricted redirect paths
  const restrictedRedirectPaths = ['/_next'].map((pathPrefix) =>
    config.basePath ? `${config.basePath}${pathPrefix}` : pathPrefix
  )

  const isAppPPREnabled = checkIsAppPPREnabled(config.experimental.ppr)

  // Generate routes manifest
  const { routesManifest } = generateRoutesManifest({
    pageKeys,
    config,
    redirects,
    headers,
    rewrites,
    restrictedRedirectPaths,
    isAppPPREnabled,
  })

  return routesManifest.dynamicRoutes
    .map((r) => r.page)
    .concat(routesManifest.staticRoutes.map((r) => r.page))
}

function startServer(dir: string, port: number) {
  const server = http.createServer((req, res) => {
    return serveHandler(req, res, {
      public: dir,
    })
  })

  return new Promise<void>((resolve, reject) => {
    server.listen(port, () => {
      const address = server.address()
      if (address == null) {
        reject('Unable to get server address when launching bundle analyzer')
        return
      }

      let addressString
      if (typeof address === 'string') {
        addressString = address
      } else {
        addressString = `${address.address === '::' ? 'localhost' : address.address}:${address.port}`
      }

      Log.info(`Bundle analyzer available at http://${addressString}`)
      resolve()
    })
  })
}
