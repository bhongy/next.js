// This file is used for when users run `require('next')`
// module.exports = (options) => {
//   if (options.dev) {
//     const Server = require('./next-dev-server').default
//     return new Server(options)
//   }

//   const next = require('next-server')
//   return next(options)
// }

module.exports = function createServer (options) {
  const { dev, ...serverOptions } = options
  const Server =
    dev === true ? require('./next-dev-server') : require('next-server')
  return new Server(serverOptions)
}
