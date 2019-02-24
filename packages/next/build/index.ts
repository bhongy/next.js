import { join } from 'path'
import nanoid from 'nanoid'
import loadConfig from 'next-server/next-config'
import { PHASE_PRODUCTION_BUILD } from 'next-server/constants'
import getBaseWebpackConfig from './webpack-config'
import {generateBuildId} from './generate-build-id'
import {writeBuildId} from './write-build-id'
import {isWriteable} from './is-writeable'
import {runCompiler, CompilerResult} from './compiler'
import globModule from 'glob'
import {promisify} from 'util'
import {createPagesMapping, createEntrypoints} from './entries'

const glob = promisify(globModule)

function collectPages (directory: string, pageExtensions: string[]): Promise<string[]> {
  return glob(`**/*.+(${pageExtensions.join('|')})`, {cwd: directory})
}

// default config.pageExtension is ['jsx', 'js']
// glob all "pages" off the file system
//   -> pagePaths (location on file system relative to "pages" folder)
// create a lookup map from globbed pages
//   -> pagesMapping (a mapping from url pathname to pagePath)
// use pageMapping to create webpack config.entry
//   -> entrypoints { client, server } -> client uses next-client-pages-loader plugin
// create webpack server & client configs from entrypoints
// run compiler "once" for each config
// write buildId out - next buildId is __not__ webpack compilation hash
//   just random hash created when this function is called
export default async function build (dir: string, conf = null): Promise<void> {
  if (!await isWriteable(dir)) {
    throw new Error('> Build directory is not writeable. https://err.sh/zeit/next.js/build-dir-not-writeable')
  }

  const config = loadConfig(PHASE_PRODUCTION_BUILD, dir, conf)
  const buildId = await generateBuildId(config.generateBuildId, nanoid)
  const distDir = join(dir, config.distDir)
  const pagesDir = join(dir, 'pages')

  const pagePaths = await collectPages(pagesDir, config.pageExtensions)
  const pages = createPagesMapping(pagePaths, config.pageExtensions)
  const entrypoints = createEntrypoints(pages, config.target, buildId, config)
  const configs: any = await Promise.all([
    getBaseWebpackConfig(dir, { buildId, isServer: false, config, target: config.target, entrypoints: entrypoints.client }),
    getBaseWebpackConfig(dir, { buildId, isServer: true, config, target: config.target, entrypoints: entrypoints.server })
  ])

  let result: CompilerResult = {warnings: [], errors: []}
  // runCompiler -> creates webpack instance from scratch and call `compiler.run` as a promise
  result = await runCompiler(configs);

  if (result.warnings.length > 0) {
    console.warn('> Emitted warnings from webpack')
    result.warnings.forEach((warning) => console.warn(warning))
  }

  if (result.errors.length > 0) {
    result.errors.forEach((error) => console.error(error))
    throw new Error('> Build failed because of webpack errors')
  }

  await writeBuildId(distDir, buildId)
}
