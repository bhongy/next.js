import DynamicEntryPlugin from 'webpack/lib/DynamicEntryPlugin'
import { EventEmitter } from 'events'
import { join } from 'path'
import fs from 'fs'
import promisify from '../lib/promisify'
import globModule from 'glob'
import {pageNotFoundError} from 'next-server/dist/server/require'
import {normalizePagePath} from 'next-server/dist/server/normalize-page-path'
import { ROUTE_NAME_REGEX, IS_BUNDLED_PAGE_REGEX } from 'next-server/constants'
import {stringify} from 'querystring'

// status "*enum" for the entry.status
const ADDED = Symbol('added')
const BUILDING = Symbol('building')
const BUILT = Symbol('built')

const glob = promisify(globModule)
const access = promisify(fs.access)

// Based on https://github.com/webpack/webpack/blob/master/lib/DynamicEntryPlugin.js#L29-L37
function addEntry (compilation, context, name, entry) {
  return new Promise((resolve, reject) => {
    const dep = DynamicEntryPlugin.createDependency(entry, name)
    compilation.addEntry(context, dep, name, (err) => {
      if (err) return reject(err)
      resolve()
    })
  })
}

export default function onDemandEntryHandler (devMiddleware, multiCompiler, {
  buildId,
  dir,
  reload,
  pageExtensions,
  maxInactiveAge,
  pagesBufferLength,
  wsPort
}) {
  const {compilers} = multiCompiler
  const invalidator = new Invalidator(devMiddleware, multiCompiler)
  // this is the entry map webpack use for compilation
  // it is managed here (add/remove) to achieve on-demand entries
  // there is a dispose entries function
  // that runs every 5 seconds (outside webpack hooks)
  // the dispose functino removes entries that is "inactive"
  // so webpack builds only what's needed
  // I'd like to look for a better way to achieve on-demand entries
  let entries = {}
  // keeping track of active pages
  let lastAccessPages = ['']
  let doneCallbacks = new EventEmitter()
  let reloading = false
  let stopped = false
  let reloadCallbacks = new EventEmitter()

  // on "make" give webpack the entries map (what to build)
  // ---
  // for every compiler
  // check all entries if they're still writable
  // -> remove from `entries` and do nothing if not
  // set status on all entries to BUILDING
  // add "all"? of them to the compilation (to be compiled)
  for (const compiler of compilers) {
    compiler.hooks.make.tapPromise('NextJsOnDemandEntries', (compilation) => {
      // mark "building" state
      invalidator.startBuilding()

      // the `entries` object is from the closure (onDemandEntriesHandler)
      const allEntries = Object.keys(entries).map(async (page) => {
        const { name, absolutePagePath } = entries[page]
        try {
          await access(absolutePagePath, (fs.constants || fs).W_OK)
        } catch (err) {
          console.warn('Page was removed', page)
          delete entries[page]
          return
        }

        entries[page].status = BUILDING
        return addEntry(compilation, compiler.context, name, [compiler.name === 'client' ? `next-client-pages-loader?${stringify({page, absolutePagePath})}!` : absolutePagePath])
      })

      // returns a promise because `hooks.make.tapPromise`
      return Promise.all(allEntries)
    })
  }

  multiCompiler.hooks.done.tap('NextJsOnDemandEntries', (multiStats) => {
    const clientStats = multiStats.stats[0]
    // might be a lot easier to work with data to just clientStats.toJson() here
    const { compilation } = clientStats
    const hardFailedPages = compilation.errors
      // keep only failed-page errors
      // IS_BUNDLED_PAGE_REGEX.test(module.name) or (module.dependencies.length) == 0
      .filter(e => {
        // Make sure to only pick errors which marked with missing modules
        const hasNoModuleFoundError = /ENOENT/.test(e.message) || /Module not found/.test(e.message)
        if (!hasNoModuleFoundError) return false

        // The page itself is missing. So this is a failed page.
        if (IS_BUNDLED_PAGE_REGEX.test(e.module.name)) return true

        // No dependencies means this is a top level page.
        // So this is a failed page.
        return e.module.dependencies.length === 0
      })
      .map(e => e.module.chunks)
      .reduce((a, b) => [...a, ...b], []) // concat + flatten all chunks
      // chunks -> pagePath (like '/' or '/foo/bar')
      .map(c => {
        const pageName = ROUTE_NAME_REGEX.exec(c.name)[1]
        return normalizePage(`/${pageName}`)
      })

    // loop through all entrypoints in the compilation that matches `entries` map
    // that is it is a real "page"
    // update page build status
    // update `lastActiveTime`
    // emit event that the page is built
    // ---
    // compilation.entrypoints is a Map object, so iterating over it 0 is the key and 1 is the value
    for (const [, entrypoint] of compilation.entrypoints.entries()) {
      // ROUTE_NAME_REGEX pattern: "static/<buildid>/pages/:page*.js"

      // I wonder maybe it can just skip the first two check and relies only
      // that if it's not in `entries` map

      const result = ROUTE_NAME_REGEX.exec(entrypoint.name)
      // skip if not a page route
      if (!result) {
        continue
      }

      const pagePath = result[1]

      // skip if no page match
      if (!pagePath) {
        continue
      }

      const page = normalizePage('/' + pagePath)

      // the `entries` object is from the closure (onDemandEntriesHandler)
      const entry = entries[page]
      // skip if it's not an entry page (not sure, maybe when it's just a js file in page folder)
      if (!entry) {
        continue
      }

      // skip non BUILDING pages - we just want to update only BUILDING pages
      if (entry.status !== BUILDING) {
        continue
      }

      entry.status = BUILT
      entry.lastActiveTime = Date.now()
      doneCallbacks.emit(page)
    }

    invalidator.doneBuilding()

    // (HotReloader).reload() if there're any hard failed pages
    if (hardFailedPages.length > 0 && !reloading) {
      console.log(`> Reloading webpack due to inconsistant state of pages(s): ${hardFailedPages.join(', ')}`)
      reloading = true
      // this is from (HotReloader).reload
      reload()
        .then(() => {
          console.log('> Webpack reloaded.')
          // `reloadCallbacks` is listened by `this.waitUntilReloaded`
          // which is called in:
          // - `ensurePage`
          // - `middleware` to force client refresh (302)
          //   ^ remember hard failed pages
          reloadCallbacks.emit('done')
          // reload will throw away previous onDemandEntriesHandler
          // and create a new one so we stop (cleanup) this old one
          // because it's discarded
          stop()
        })
        .catch(err => {
          console.error(`> Webpack reloading failed: ${err.message}`)
          console.error(err.stack)
          process.exit(1)
        })
    }
  })

  const disposeHandler = setInterval(function () {
    if (stopped) return
    disposeInactiveEntries(devMiddleware, entries, lastAccessPages, maxInactiveAge)
  }, 5000)

  // fixes setInterval prevents process from exiting
  // https://github.com/zeit/next.js/pull/3540
  // not sure why they don't ensure setInterval is clear on exit instead
  disposeHandler.unref()

  // all teardown we need to do
  function stop () {
    clearInterval(disposeHandler)
    stopped = true
    doneCallbacks = null // is this enough to dereference all registered handlers?
    reloadCallbacks = null
  }

  return {

    // wait for the reloadCallbacks to emit "done" event
    // ---
    // called: in `HotReloader.getCompilationErrors` and locally in `ensurePage` and `middleware`
    // returns a promise that resolves 'once' reloadCallbacks is 'done'
    waitUntilReloaded () {
      // bad idea to use event emitter because you have to ensure
      // not to attach the listener and resolve the promise immediately
      // if it's already resolved
      if (!reloading) return Promise.resolve(true)
      return new Promise((resolve) => {
        reloadCallbacks.once('done', function () {
          resolve()
        })
      })
    },

    // important method: it creates and add "entry" in the `entries` map
    // 
    // the other primary functionality of `ensurePage` is to "wait"
    // on a page to ensure it's built which includes kicking off the build
    // for a page that hasn't been built and wait for it
    // 
    // it's not responsible for handling rebuild when page changes
    // that is handled in `compiler.hooks.make`
    // ---
    // wait until reloaded
    // then glob for the `page` file
    // -> throws pageNotFoundError if glob result is empty
    // wait until the page is built
    // ^ add new entry (`entries[page]`) if it hasn't been built and include it
    async ensurePage (page) {
      await this.waitUntilReloaded()
      page = normalizePage(page)
      let normalizedPagePath
      try {
        normalizedPagePath = normalizePagePath(page)
      } catch (err) {
        console.error(err)
        // throw page not found error if normalizePagePath fails
        throw pageNotFoundError(normalizedPagePath)
      }

      // `pageExtensions` is from next config which could be a list of `.js`, `.ts`, ...
      const extensions = pageExtensions.join('|')
      const pagesDir = join(dir, 'pages')

      // glob all "page" files
      // the result will be relative path like 're/myPage.js' relative to the cwd option
      // .slice(1) to remove leading "/" from path like "/foo/bar" -> "foo/bar"
      let paths = await glob(`{${normalizedPagePath.slice(1)}/index,${normalizedPagePath.slice(1)}}.+(${extensions})`, {cwd: pagesDir})

      // Default the /_error route to the Next.js provided default page
      if (page === '/_error' && paths.length === 0) {
        paths = ['next/dist/pages/_error']
      }

      // throw page not found error if no page files found
      // ... and _not_ requesting for `/_error`
      if (paths.length === 0) {
        throw pageNotFoundError(normalizedPagePath)
      }

      // check `entries[page]`
      // if it's not in the entry, add it and kick off the build (calling invalidate)
      // this will resolve after the page is built
      await new Promise((resolve, reject) => {
        // the `entries` object is from the closure (onDemandEntriesHandler)
        const entryInfo = entries[page]

        if (entryInfo) {
          if (entryInfo.status === BUILT) {
            resolve()
            return
          }

          if (entryInfo.status === BUILDING) {
            doneCallbacks.once(page, handleCallback)
            return
          }
        }

        console.log(`> Building page: ${page}`)

        // this block is just to prepare data
        // for building entry object for `entries[page]`
        const pagePath = paths[0] // glob always return an array - we grab the relative page path
        let pageUrl = `/${pagePath.replace(new RegExp(`\\.+(${extensions})$`), '').replace(/\\/g, '/')}`.replace(/\/index$/, '')
        pageUrl = pageUrl === '' ? '/' : pageUrl
        const bundleFile = pageUrl === '/' ? '/index.js' : `${pageUrl}.js`

        // **important** this is the only place the `enries[page]` is created+assigned
        // the `entries` object is from the closure (onDemandEntriesHandler)
        entries[page] = {
          name: join('static', buildId, 'pages', bundleFile),
          absolutePagePath: pagePath.startsWith('next/dist/pages')
            ? require.resolve(pagePath)
            : join(pagesDir, pagePath),
          status: ADDED,
        }

        doneCallbacks.once(page, handleCallback)

        invalidator.invalidate()

        function handleCallback (err) {
          if (err) return reject(err)
          resolve()
        }
      })
    },

    // attach websocket onmessage listener to:
    // - ws.send (json) data based on the page (entry) status
    // (if the page is BUILT)
    // - update `lastAccessPages` record of this onDemandEntryHandler
    // - update (mutate) the entry `lastActiveTime`
    wsConnection (ws) {
      ws.onmessage = ({ data }) => {
        const page = normalizePage(data)
        // the `entries` object is from the closure (onDemandEntriesHandler)
        const entryInfo = entries[page]

        // If there's no entry.
        // Then it seems like an weird issue.
        if (!entryInfo) {
          const message = `Client pings, but there's no entry for page: ${page}`
          console.error(message)
          return sendJson(ws, { invalid: true })
        }

        // 404 is an on demand entry but when a new page is added we have to refresh the page
        if (page === '/_error') {
          sendJson(ws, { invalid: true })
        } else {
          sendJson(ws, { success: true })
        }

        // We don't need to maintain active state of anything other than BUILT entries
        if (entryInfo.status !== BUILT) return

        // If there's an entryInfo
        if (!lastAccessPages.includes(page)) {
          lastAccessPages.unshift(page)

          // Maintain the buffer max length
          if (lastAccessPages.length > pagesBufferLength) {
            lastAccessPages.pop()
          }
        }
        entryInfo.lastActiveTime = Date.now()
      }
    },

    // reload client (browser) if stop or after reload
    // ignore request to `/_next/on-demand-entries-ping/`
    // otherwise just res.end('200')
    middleware () {
      return (req, res, next) => {
        if (stopped) {
          // If this handler is stopped, we need to reload the user's browser.
          // So the user could connect to the actually running handler.
          res.statusCode = 302
          res.setHeader('Location', req.url)
          res.end('302')
        } else if (reloading) {
          // Webpack config is reloading. So, we need to wait until it's done and
          // reload user's browser.
          // So the user could connect to the new handler and webpack setup.
          this.waitUntilReloaded()
            .then(() => {
              res.statusCode = 302
              res.setHeader('Location', req.url)
              res.end('302')
            })
        } else {
          if (!/^\/_next\/on-demand-entries-ping/.test(req.url)) return next()

          res.statusCode = 200
          res.setHeader('port', wsPort)
          res.end('200')
        }
      }
    }
  }
}

// mutate `entries`
// remove inactive pages: pages that exceed `maxInactiveAge` (argument to `onDemandEntryHandler`)
// from `entries` (mutate) then invalidate build (devMiddleware.invalidate) _not_ `invalidator.invalidate`
function disposeInactiveEntries (devMiddleware, entries, lastAccessPages, maxInactiveAge) {
  const disposingPages = []

  Object.keys(entries).forEach((page) => {
    const { lastActiveTime, status } = entries[page]

    // This means this entry is currently building or just added
    // We don't need to dispose those entries.
    if (status !== BUILT) return

    // We should not build the last accessed page even we didn't get any pings
    // Sometimes, it's possible our XHR ping to wait before completing other requests.
    // In that case, we should not dispose the current viewing page
    if (lastAccessPages.includes(page)) return

    if (Date.now() - lastActiveTime > maxInactiveAge) {
      disposingPages.push(page)
    }
  })

  if (disposingPages.length > 0) {
    disposingPages.forEach((page) => {
      delete entries[page]
    })
    console.log(`> Disposing inactive page(s): ${disposingPages.join(', ')}`)
    // this essentially calls `.invalidate` on the webpack WatchCompiler
    devMiddleware.invalidate()
  }
}

// 1) replace \ with /
// 2) replace /index with /
// 3) replace /foo/bar/index with /foo/bar
// /index and / is the same. So, we need to identify both pages as the same.
// This also applies to sub pages as well.
export function normalizePage (page) {
  const unixPagePath = page.replace(/\\/g, '/')
  if (unixPagePath === '/index' || unixPagePath === '/') {
    return '/'
  }
  return unixPagePath.replace(/\/index$/, '')
}

// websocket.send stringified data
function sendJson (ws, data) {
  ws.send(JSON.stringify(data))
}

// basically keep track of "building" state
// and calls compilers and WebpackDevMiddleware invalidate
// building will be set when invalidate is called
// if there's already a current building, rebuildAgain flag is set
// and it will go through the invalidation for another round
// when the current "building" is done ... this feels very hacky/buggy
// ---
// Make sure only one invalidation happens at a time
// Otherwise, webpack hash gets changed and it'll force the client to reload.
class Invalidator {
  constructor (devMiddleware, multiCompiler) {
    this.multiCompiler = multiCompiler
    this.devMiddleware = devMiddleware
    // contains an array of types of compilers currently building
    this.building = false
    this.rebuildAgain = false
  }

  invalidate () {
    // If there's a current build is processing, we won't abort it by invalidating.
    // (If aborted, it'll cause a client side hard reload)
    // But let it to invalidate just after the completion.
    // So, it can re-build the queued pages at once.
    if (this.building) {
      this.rebuildAgain = true
      return
    }

    this.building = true
    // Work around a bug in webpack, calling `invalidate` on Watching.js
    // doesn't trigger the invalid call used to keep track of the `.done` hook on multiCompiler
    for (const compiler of this.multiCompiler.compilers) {
      compiler.hooks.invalid.call()
    }
    this.devMiddleware.invalidate()
  }

  startBuilding () {
    this.building = true
  }

  doneBuilding () {
    this.building = false

    if (this.rebuildAgain) {
      this.rebuildAgain = false
      this.invalidate()
    }
  }
}
