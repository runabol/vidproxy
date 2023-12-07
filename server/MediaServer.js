var express = require('express')
var Path = require('path')
var fs = require('fs-extra')
var Sqrl = require('squirrelly')

var Logger = require('./Logger')
var { fetchMediaFiles, slugify } = require('./helpers/utils')
var StreamSession = require('./StreamSession')
var FileInfo = require('./FileInfo')
var EncodingOptions = require('./EncodingOptions')


class MediaServer {
  constructor(port = process.env.PORT, mediaPath = process.env.MEDIA_PATH) {
    this.PORT = port
    this.MEDIA_PATH = mediaPath

    this.sessions = {}
    this.clients = {}

    this.start()
  }

  setHeaders(req, res, next) {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', '*')
    res.setHeader("Access-Control-Allow-Headers", "*")
    if (req.method === 'OPTIONS') {
      res.send(200)
    } else {
      next()
    }
  }

  start() {
    var app = express()
    app.use(this.setHeaders)

    // Opens session and shows hls.js player, requires query ?file=<file_in_media_path>
    app.get('/stream', (req, res) => this.handleStreamRequest(req, res, true))

    // Used by the client players to fetch .m3u8 and .ts file segments
    app.get('/:session/:file', this.handleFileRequest.bind(this))

    app.listen(this.PORT, () => Logger.info('[SERVER] Listening on port', this.PORT))
  }

  handleStreamRequest(req, res) {
    var filename = req.query.file
    var sessionName = req.query.name || slugify(Path.basename(filename, Path.extname(filename)))
    var streamSession = this.sessions[sessionName]
    if (streamSession) {
      var filePath = Path.join(streamSession.streamPath, "master.m3u8")
      return res.sendFile(filePath, (err) => {
        if (err) {
          Logger.error('Oops failed to send file', err)
        }
      })
    }
    const requestIp = (typeof req.headers['x-forwarded-for'] === 'string' && req.headers['x-forwarded-for'].split(',').shift()) || req.connection.remoteAddress
    this.openStream(requestIp, res, sessionName, filename)
  }

  async handleFileRequest(req, res) {
    var sessionId = req.params.session
    var file = req.params.file

    var hlsSession = this.sessions[sessionId]
    if (!hlsSession) { // No Session
      Logger.error('Invalid session', sessionId)
      return res.sendStatus(400)
    }

    var filePath = Path.join(hlsSession.streamPath, file)
    var fileExtname = Path.extname(file)
    var isPlaylist = fileExtname === '.m3u8'
    var isSegment = fileExtname === '.ts'

    if (!isPlaylist && !isSegment) {
      Logger.error('Invalid file', req.url)
      res.statusCode = 400
      res.end()
    }

    var segmentNumber = 0
    var segmentVariation = 0

    if (isSegment) {
      var { number, variation } = hlsSession.parseSegmentFilename(file)
      segmentNumber = number
      segmentVariation = variation

      // Quality Changed
      if (segmentVariation !== hlsSession.currentJobQuality) {
        Logger.clearProgress()
        var isRestarted = await hlsSession.restart(segmentNumber, segmentVariation)
        if (!isRestarted) {
          return res.sendStatus(500)
        }
        var segmentLoaded = await hlsSession.waitForSegment(segmentNumber, filePath)
        if (!segmentLoaded) {
          Logger.error(`Segment ${segmentNumber} still not loaded`)
          return res.sendStatus(404)
        }
      }

      var distanceFromCurrentSegment = segmentNumber - hlsSession.currentSegment
      Logger.log('[REQUEST] Fetching segment', segmentNumber)
      if (distanceFromCurrentSegment === 10) {
        hlsSession.currentSegment++
      }
    } else {
      Logger.log('[REQUEST] Fetching playlist', filePath)
    }

    var fileExists = hlsSession.getIsSegmentCreated(segmentNumber, segmentVariation) || await fs.pathExists(filePath)
    if (!fileExists) {
      if (!isSegment) {
        Logger.error('[REQUEST] Playlist does not exist...', filePath)
        return res.sendStatus(400)
      }

      Logger.verbose('[REQUEST] Segment does not exist...', filePath)

      if (hlsSession.getShouldStartNewEncode(segmentNumber)) {
        var isRestarted = await hlsSession.restart(segmentNumber)
        if (!isRestarted) {
          return res.sendStatus(500)
        }
      }

      Logger.error(`Segment ${segmentNumber} still not loaded`)
      return res.sendStatus(404)
    }

    if (isSegment) {
      hlsSession.setSegmentFetched(segmentNumber)
    }

    res.sendFile(filePath, (err) => {
      if (err) {
        Logger.error('Oops failed to send file', err)
      }
    })
  }

  async openStream(requestIp, res, name, filename) {
    var filepath = Path.resolve(this.MEDIA_PATH, filename)
    var exists = await fs.pathExists(filepath)
    if (!exists) {
      Logger.log('File not found', filepath)
      return res.sendStatus(404)
    }

    var fileInfo = new FileInfo(filepath)
    var successfullyProbed = await fileInfo.probe()
    if (!successfullyProbed) {
      Logger.error('Did not probe successfully')
      return res.sendStatus(500)
    }

    // Set this client with session
    this.clients[requestIp] = {
      id: requestIp,
      session: name
    }

    var encodingOptions = new EncodingOptions(fileInfo)
    var streamSession = new StreamSession(name, fileInfo, encodingOptions)
    this.sessions[name] = streamSession

    encodingOptions.numberOfSegments = await streamSession.generatePlaylist()
    streamSession.run()

    var filePath = Path.join(streamSession.streamPath, "master.m3u8")

    res.sendFile(filePath, (err) => {
      if (err) {
        Logger.error('Oops failed to send file', err)
      }
    })
  }
}
module.exports = MediaServer