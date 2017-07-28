'use strict'

const qs              = require('qs')
const url             = require('url')
const path            = require('path')
const chalk           = require('chalk')
const express         = require('express')
const bodyParser      = require('body-parser')
const methodOverride  = require('method-override')
const compression     = require('compression')
const morgan          = require('morgan')
const favicon         = require('serve-favicon')
const cookieParser    = require('cookie-parser')
const i18n            = require('i18n')
const moment          = require('moment')
const util            = require('util')
const createError     = require('http-errors')
const helmet          = require('helmet')
const httpShutdown    = require('http-shutdown')
const mongoose        = require('mongoose')
const {
  merge,
  omit,
  floor }             = require('lodash')
const { duration }    = moment

const session         = require( './session' )
const defer           = require( './helpers/create-promise' )
const mail            = require( './mail' )

module.exports = function () {

  const config  = require( './config' )
  const db      = require( './models' )

  db.connectDB( config.database )

  //////
  // SERVER CONFIG
  //////

  var app = express()

  app.set( 'trust proxy', true )
  app.use( helmet() )

  function forcessl(req, res, next) {
    if (req.header('x-forwarded-proto') === 'https') return next()
    res.redirect(301, `https://${config.host}${req.url}`)
  }

  if (config.forcessl) app.use(forcessl)

  app.use(bodyParser.json({
    limit: '5mb'
  }))
  app.use(bodyParser.urlencoded({
    limit: '5mb',
    extended: true,
  }))
  // enable other methods from request (PUT, DELETE…)
  app.use( methodOverride('_method', {methods: ['GET', 'POST']}) )
  app.use( compression() )
  app.use( favicon(path.join(__dirname, '../res/favicon.png')) )
  app.use( cookieParser() )

  //----- SESSION & I18N

  session.init( app )
  i18n.configure({
    locales:        ['fr', 'en',],
    defaultLocale:  'fr',
    extension:      '.js',
    cookie:         'mosaicobackend',
    objectNotation: true,
    directory:      path.join( __dirname, './locales'),
  })
  app.use(i18n.init)

  //----- TEMPLATES

  app.set('views', path.join(__dirname, './views'))
  app.set('view engine', 'pug')

  //----- STATIC

  const md5public             = require( './md5public.json' )
  const maxAge                = config.isDev ? duration( 30, 'minutes') : duration( 1, 'years')
  const staticOptions         = { maxAge: maxAge.as( 'milliseconds' ) }

  app.locals.md5Url    = url => {
    // disable md5 on dev
    // better for hot reload
    if ( config.isDev ) return url
    if ( url in md5public) url = `/${md5public[ url ]}${url}`
    return url
  }

  function removeHash (req, res, next) {
    const { md5 }     = req.params
    const staticPath  = req.url.replace(`/${ md5 }`, '')
    req._restoreUrl   = req.url
    if ( md5public[ staticPath ] === md5 ) {
      req.url           = staticPath
    // we don't want statics to be cached by the browser if the md5 is invalid
    // pass it to the next static handler which doens't set cache
    } else {
      req._staticPath   = staticPath
    }
    next()
  }

  function restoreUrl (req, res, next) {
    // - get here if static middleware fail to find the file
    // - even if the md5 is invalid we can guess that the file exists
    if ( req._staticPath in md5public ) {
      req.url = req._staticPath
    // - if not that mean we have an url for another ressource => restore the original url
    } else {
      console.log( '[MD5] should be another ressource', req._restoreUrl )
      req.url = req._restoreUrl
    }
    next()
  }

  const statics = [
    // first parse the url
    removeHash,
    // then check all static locations
    express.static( path.join(__dirname, '../dist'), staticOptions ),
    express.static( path.join(__dirname, '../res'), staticOptions ),
    express.static( path.join(__dirname, '../node_modules/material-design-lite'), staticOptions ),
    express.static( path.join(__dirname, '../node_modules/material-design-icons-iconfont/dist'), staticOptions ),
    // restore any url
    restoreUrl,
  ]

  app.get( '/:md5([a-zA-Z0-9]{32})*', ...statics )

  // no-cache static backup:

  // compiled assets
  app.use( express.static( path.join(__dirname, '../dist') ) )
  // commited assets
  app.use( express.static( path.join(__dirname, '../res') ) )
  // libs
  app.use( '/lib/skins', express.static( path.join(__dirname,'../res/vendor/skins') ) )
  app.use( express.static( path.join(__dirname, '../node_modules/material-design-lite') ) )
  app.use( express.static( path.join(__dirname, '../node_modules/material-design-icons-iconfont/dist') ) )

  //////
  // LOGGING
  //////

  function getIp(req) {
    if (req.ip) {
      var ip = /([\d\.]+)$/.exec(req.ip)
      if (!Array.isArray(ip)) return ''
      return ip[1]
    }
    return ''
  }

  function logRequest(tokens, req, res) {
    if (/\/img\//.test(req.path)) return
    var method  = chalk.blue(tokens.method(req, res))
    var ips     = getIp(req)
    ips         = ips ? chalk.grey(`- ${ips} -`) : ''
    var url     = chalk.grey(tokens.url(req, res))
    return `${method} ${ips} ${url}`
  }

  function logResponse(tokens, req, res) {
    var method      = chalk.blue(tokens.method(req, res))
    var ips         = getIp(req)
    ips             = ips ? chalk.grey(`- ${ips} -`) : ''
    var url         = chalk.grey(tokens.url(req, res))
    var status      = tokens.status(req, res)
    var time        = floor( tokens['response-time'](req, res) / 1000, 2 )
    var statusColor = status >= 500
      ? 'red' : status >= 400
      ? 'yellow' : status >= 300
      ? 'cyan' : 'green';
    if (/\/img\//.test(req.path) && status < 400) return
    return `${method} ${ips} ${url} ${chalk[statusColor](status)} ${time}s`
  }
  app.use(morgan(logRequest, {immediate: true}))
  app.use(morgan(logResponse))

  //////
  // ROUTING
  //////

  const download        = require( './download' )
  const images          = require( './images' )
  const render          = require( './render' )
  const users           = require( './users' )
  const groups          = require( './groups' )
  const templates       = require( './templates' )
  const mailings        = require( './mailings' )
  const mailingTransfer = require( './mailing-transfer' )
  const filemanager     = require( './filemanager' )
  const guard           = session.guard

  //----- EXPOSE DATAS TO VIEWS

  app.locals._config  = omit(config, ['_', 'configs', 'config'])

  app.locals.printJS  = data => JSON.stringify(data, null, '  ')

  app.locals.formatDate = function formatDate(data) {
    var formatedDate = moment(data).format('DD/MM/YYYY HH:mm')
    return formatedDate === 'Invalid date' ? '' : formatedDate
  }

  function filterQuery(prefix, value) {
    if (value === '' || value === null || typeof value === 'undefined') return
    return value
  }

  app.locals.mergeQueries = function mergeQueries(route, _query, params = {}) {
    const parsedroute = url.parse(route)
    const initParams  = parsedroute.query ? qs.parse( parsedroute.query ) : {}
    route             = parsedroute.pathname
    params  = merge(initParams, _query, params)
    params  = qs.stringify(params, { filter: filterQuery })
    return Object.keys(params).length ? `${route}?${params}` : route
  }

  app.locals.getSorting = function getSorting(key, currentSorting) {
    const sorting = {
      sort: key,
      dir:  'desc',
    }
    if (key !== currentSorting.sort) return sorting
    if (currentSorting.dir === 'asc' ) return {
      sort: null,
      dir:  null,
    }
    sorting.dir = 'asc'
    return sorting
  }

  function brandColorsToCSS() {
    const { brand }   = config
    const properties  = Object.keys( brand ).filter( k => /^color/.test(k) )
    if (!properties.length) return false
    return properties.map( k => `--${ k }: ${ brand[k] };`).join('\n')
  }

  app.locals._brand = {
    colors: brandColorsToCSS(),
  }

  // those datas need to be refreshed on every request
  // and also not exposed to `app` but to `res` ^^
  app.use(function exposeDataToViews(req, res, next) {
    res.locals._query   = req.query
    res.locals._path    = req.path
    res.locals._user    = req.user ? req.user : {}
    if (config.isDev) {
      res.locals._debug = JSON.stringify({
        _user:    res.locals._user,
        messages: req.session && req.session.flash,
        _config:  app.locals._config,
        _query:   res.locals._query,
      }, null, '  ')
    }
    next()
  })

  //----- MORE I18N

  // take care of language query params
  // http://stackoverflow.com/questions/19539332/localization-nodejs-i18n
  app.use( (req, res, next) => {
    if (req.query.lang) {
      res.setLocale(req.query.lang)
      res.cookie('mosaicobackend', req.query.lang, { maxAge: 900000, httpOnly: true })
    }
    next()
  })

  //----- PARAMS CHECK

  // regexp for checking valid mongoDB Ids
  // http://expressjs.com/en/api.html#app.param
  // http://stackoverflow.com/questions/20988446/regex-for-mongodb-objectid#20988824
  app.param(['groupId', 'userId', 'templateId', 'mailingId', 'mongoId'], checkMongoId)
  function checkMongoId(req, res, next, mongoId) {
    if (/^[a-f\d]{24}$/i.test(mongoId)) return next()
    console.log('test mongoId INVALID', mongoId)
    next( createError(404) )
  }

  app.param(['placeholderSize'], (req, res, next, placeholderSize) => {
    if ( /(\d+)x(\d+)\.png/.test(placeholderSize) ) return next()
    console.log('placeholder format INVALID', placeholderSize)
    next( createError(404) )
  })

  // connection
  app.post('/admin/login', session.authenticate('local', {
    successRedirect: '/admin',
    failureRedirect: '/admin/login',
    failureFlash:     true,
    successFlash:     true,
  }))
  app.get('/admin/login',                             render.adminLogin)
  app.get('/admin',                                   guard('admin'), groups.list)
  // groups
  app.all('/groups*',                                 guard('admin'))
  app.get('/groups/:groupId/new-user',                users.show)
  app.get('/groups/:groupId/new-template',            templates.show)
  app.get('/groups/:groupId?',                        groups.show)
  app.post('/groups/:groupId?',                       groups.update)
  // app.post('/users/:userId/delete',                groups.delete)
  // users' groups
  app.all('/users*',                                  guard('admin'))
  app.get('/users/:userId/templates/:templateId?',    groups.show)
  // users
  app.get('/users/:userId/restore',                   users.activate)
  app.delete('/users/:userId',                        users.deactivate)
  app.post('/users/reset',                            users.adminResetPassword)
  app.get('/users/:userId',                           users.show)
  app.post('/users/:userId?',                         users.update)
  app.get('/users',                                   users.list)

  app.get('/templates/select',                        guard('user'), templates.userList)
  app.get('/templates/:templateId/markup',            guard('user'), templates.getMarkup)
  app.all('/templates*',                              guard('admin'))
  app.get('/templates/:templateId/delete',            templates.remove)
  app.get('/templates/:templateId/renderMarkup',      templates.renderMarkup )
  app.get('/templates/:templateId/auto-upload/:templateName', templates.autoUpload )
  app.get('/templates/:templateId/generatePreviews',  templates.generatePreviews)
  app.get('/templates/:templateId',                   templates.show)
  app.post('/templates/:templateId?',                 templates.update)
  app.get('/templates',                               templates.list)

  //----- CONNECTION

  app.post('/login', session.authenticate('local', {
    successRedirect: '/',
    failureRedirect: '/login',
    failureFlash:     true,
  }))
  app.get('/login',                         guard('no-session'), render.login)
  app.get('/forgot',                        guard('no-session'), render.forgot)
  app.post('/forgot',                       guard('no-session'), users.userResetPassword)
  app.get('/password/:token',               guard('no-session'), users.showSetPassword)
  app.post('/password/:token',              guard('no-session'), users.setPassword)
  app.get('/logout',                        guard('user'), session.logout )

  //----- IMAGES

  app.get('/img/:imageName',                images.read)
  app.delete('/img/:imageName',             guard('user'), images.destroy )
  app.get('/placeholder/:placeholderSize',  images.checkImageCache, images.placeholder )
  app.get('/resize/:sizes/:imageName',      images.checkImageCache, images.checkSizes, images.resize )
  app.get('/cover/:sizes/:imageName',       images.checkImageCache, images.checkSizes, images.cover )
  app.get('/img/',                          images.handleOldImageUrl )

  //----- UPLOADS

  app.all('/upload*',                       guard('user'))
  app.get('/upload/:mongoId',               images.listImages )
  app.post('/upload/:mongoId',              images.upload )

  //----- MAILINGS

  app.all('/mailings/:mailingId/transfer',    guard('admin'))
  app.get('/mailings/:mailingId/transfer',    mailingTransfer.get )
  app.post('/mailings/:mailingId/transfer',   mailingTransfer.post )
  app.all('/mailings*',                       guard('user'))
  app.get('/mailings/:mailingId/duplicate',   mailings.duplicate )
  app.post('/mailings/:mailingId/send',       download.send )
  app.post('/mailings/:mailingId/zip',        download.zip )
  app.get('/mailings/:mailingId',             mailings.show)
  app.post('/mailings/:mailingId',            mailings.update)
  app.post('/mailings',                       mailings.create)
  app.delete('/mailings',                     mailings.bulkRemove )
  app.patch('/mailings',                      mailings.updateLabels )
  app.get('/mailings',                        mailings.userList )

  app.get('/about',                           render.about )

  app.get('/',                                guard('user'), mailings.userList )

  //////
  // ERROR HANDLING
  //////

  // everyhting that go there without an error should be treated as a 404
  app.use(function (req, res, next) {
    if (req.xhr) return  res.status(404).send('not found')
    return res.status(404).render('error-404')
  })

  app.use(function (err, req, res, next) {
    var status = err.status || err.statusCode || (err.status = 500)
    console.log('error handling', status)
    if (status >= 500) {
      console.log(util.inspect(err, {showHidden: true}))
      console.trace(err)
    }

    // force status for morgan to catch up
    res.status(status)
    // different formating
    if (req.xhr) return res.send(err)
    if (status === 404) return res.render('error-404')
    if (!err.stacktrace) err.stacktrace = err.stack || new Error(err).stack
    return res.render('error-default', {err})
  })

  //////
  // LAUNCHING
  //////

  const application = defer()

  config.setup.then(function endSetup() {
    // use httpShutdown for being sure that every connection are removed
    // https://github.com/thedillonb/http-shutdown
    // It's important for testing as we need to be sure every process are done…
    // …in order for tape to end properly
    const server = httpShutdown( app.listen(config.PORT, err => {
      if (err) {
        console.log('error')
        application.reject( err )
        throw err
      }
      console.log(
        chalk.green('Server is listening on port'), chalk.cyan(server.address().port),
        chalk.green('on mode'), chalk.cyan(config.NODE_ENV)
      )
      mail
      .status
      .then(function () {
        console.log(chalk.green('[EMAIL] transport mailing – SUCCESS'))
      })
      .catch(function (err) {
        console.log(chalk.red('[EMAIL] transport mailing – ERROR'))
        console.trace(err)
      })
      console.log( chalk.green(`[STORAGE] storage is`), chalk.cyan(config.storage.type) )

      setTimeout( templates.startNightmare, 100 )

      application.resolve( server )
    }) )
    server.on('close', () => {
      // again for being sure that while testing with tape…
      // …every process generated by the app are killed
      templates
      .nightmareInstance
      .end()
      .then( () => {
        server.emit( 'shutdown' )
      })
      mongoose.disconnect()
    })
  })

  return application
}
