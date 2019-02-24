import {join} from 'path'
import {stringify} from 'querystring'
import {PAGES_DIR_ALIAS} from '../lib/constants'

type PagesMapping = {
  [page: string]: string
}

export function createPagesMapping(pagePaths: string[], extensions: string[]): PagesMapping {
  const pages: PagesMapping = pagePaths.reduce((result: PagesMapping, pagePath): PagesMapping => {
    // remove extentions
    // convert "\" to "/"
    // replace (ending) 'index' to ''
    const page = `/${pagePath.replace(new RegExp(`\\.+(${extensions.join('|')})$`), '').replace(/\\/g, '/')}`.replace(/\/index$/, '')
    result[page === '' ? '/' : page] = join(PAGES_DIR_ALIAS, pagePath).replace(/\\/g, '/')
    return result
  }, {})

  pages['/_app'] = pages['/_app'] || 'next/dist/pages/_app'
  pages['/_error'] = pages['/_error'] || 'next/dist/pages/_error'
  pages['/_document'] = pages['/_document'] || 'next/dist/pages/_document'

  return pages
}

type WebpackEntrypoints = {
  [bundle: string]: string|string[]
}

type Entrypoints = {
  client: WebpackEntrypoints
  server: WebpackEntrypoints
}

// client entrypoints are just a bunch of
// 'static/<buildId>/pages/index.js' (bundlePath)
// -> 'next-client-pages-loader?page=%2Findex.js&absolutePagePath=build%2Findex.1234.js'
// 
// server entrypoints are :
// 'static/<buildId>/pages/index.js' (bundlePath)
// -> ['build/index.1234.js']
export function createEntrypoints(pages: PagesMapping, target: 'server'|'serverless', buildId: string, config: any): Entrypoints {
  const client: WebpackEntrypoints = {}
  const server: WebpackEntrypoints = {}

  Object.keys(pages).forEach((page) => {
    const absolutePagePath = pages[page]
    const bundleFile = page === '/' ? '/index.js' : `${page}.js`
    const bundlePath = join('static', buildId, 'pages', bundleFile)
    server[bundlePath] = [absolutePagePath]
    if (page === '/_document') {
      return
    }
    client[bundlePath] = `next-client-pages-loader?${stringify({page, absolutePagePath})}!`
  })

  return {
    client,
    server
  }
}
