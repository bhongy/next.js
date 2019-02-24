import {loader} from 'webpack'
import loaderUtils from 'loader-utils'

export type ClientPagesLoaderOptions = {
  absolutePagePath: string,
  page: string
}

// just push [page, function to load page on client] to window.__NEXT_P
// to use by `next/client` -> `page-loader`
const nextClientPagesLoader: loader.Loader = function () {
  // next-client-pages-loader?page=%2Findex.js&absolutePagePath=build%2Findex.1234.js
  // { page: '/index.js', absolutePagePath: 'build/index.1234.js' }
  // const {absolutePagePath, page}: any = loaderUtils.getOptions(this)
  // const stringifiedAbsolutePagePath = JSON.stringify(absolutePagePath)
  // const stringifiedPage = JSON.stringify(page)
  const q = loaderUtils.getOptions(this);
  const page = JSON.stringify(q.page);
  const absolutePagePath = JSON.stringify(q.absolutePagePath);

  // window.__NEXT_P = ['/index.js', function => loads page from absolutePagePath 'build/index.1234.js']
  return `
    (window.__NEXT_P=window.__NEXT_P||[]).push([${page}, function() {
      var page = require(${absolutePagePath})
      if(module.hot) {
        module.hot.accept(${absolutePagePath}, function() {
          if(!next.router.components[${page}]) return
          var updatedPage = require(${absolutePagePath})
          next.router.update(${page}, updatedPage.default || updatedPage)
        })
      }
      return { page: page.default || page }
    }]);
  `
}

export default nextClientPagesLoader
