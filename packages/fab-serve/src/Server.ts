import * as http from 'http'
import * as https from 'https'
import * as url from 'url'
import * as vm from 'vm'
import * as mime from 'mime-types'
import * as fetch from 'node-fetch'
import * as yauzl from 'yauzl'
import * as getStream from 'get-stream'
import * as express from 'express'

const concat = require('concat-stream')

const getContentType = (pathname: string) => {
  const mimeType = mime.lookup(pathname)
  return (mimeType && mime.contentType(mimeType)) || 'text/html; charset=utf-8'
}

interface Options {
  port: string
  cert?: Buffer
  key?: Buffer
}

export default class Server {
  private file: string
  private port: string
  private cert?: Buffer
  private key?: Buffer

  constructor(file: string, options: Options) {
    this.file = file
    this.port = options.port
    this.cert = options.cert
    this.key = options.key
  }

  async start() {
    const files = {} as { [filename: string]: Buffer }
    await new Promise((resolve, reject) => {
      const promises: Array<Promise<any>> = []
      yauzl.open(this.file, {}, (err, zipfile) => {
        if (err || !zipfile) return reject(err)
        zipfile.on('entry', (entry: yauzl.Entry) => {
          promises.push(
            new Promise((res, rej) => {
              if (entry.fileName.endsWith('/')) return
              zipfile.openReadStream(entry, async (err, stream) => {
                if (err || !stream) return rej(err)
                files[`/${entry.fileName}`] = await getStream.buffer(stream)
                res()
              })
            })
          )
        })
        zipfile.once('end', () => Promise.all(promises).then(resolve, reject))
      })
    })
    // console.log(Object.keys(files))

    const src_buffer = files['/server.js']
    if (!src_buffer) {
      throw new Error('Malformed FAB. Missing /server.js')
    }
    const src = src_buffer.toString('utf8')

    const { Request } = fetch

    const sandbox = {
      fetch: fetch,
      Request: fetch.Request,
      Response: fetch.Response,
      Headers: fetch.Headers,
      URL: URL,
      console: {
        log: console.log,
        error: console.error,
      },
      NODE_ENV: 'server',
      process: {
        env: {
          NODE_ENV: 'server',
        },
      },
      setTimeout,
      setImmediate,
      clearTimeout,
    }

    const script = new vm.Script(src)
    const exp = {}
    const ctx = Object.assign({}, sandbox, { module: { exports: exp } })
    const renderer = script.runInNewContext(ctx)

    await new Promise((resolve, reject) => {
      const app = express()

      app.use((req, res, next) => {
        req.pipe(
          concat((data: any) => {
            req.body = data.toString()
            next()
          })
        )
      })

      app.all('*', async (req, res) => {
        try {
          const pathname = url.parse(req.url!).pathname!
          if (pathname.startsWith('/_assets')) {
            res.setHeader('Content-Type', getContentType(pathname))
            res.setHeader('Cache-Control', 'immutable')
            res.end(files[pathname])
          } else {
            const method = req.method
            const headers: any = req.headers
            const url = `${req.protocol}://${req.headers.host}${req.url}`
            const fetch_req = new Request(url, {
              method,
              headers,
              ...(method === 'POST' ? { body: req.body } : {}),
            })
            const production_settings = renderer.getProdSettings ? renderer.getProdSettings() : {}
            const fetch_res = await renderer.render(
              fetch_req,
              Object.assign(
                {
                  injected: 'variables',
                  should: 'work!',
                },
                production_settings
              )
            )
            res.status(fetch_res.status)
            const response_headers = fetch_res.headers.raw()
            delete response_headers['content-encoding']
            Object.keys(response_headers).forEach((header) => {
              const values = response_headers[header]
              res.set(header, values.length === 1 ? values[0] : values)
            })
            const blob = await fetch_res.arrayBuffer()
            res.send(Buffer.from(blob))
          }
        } catch (e) {
          console.log('ERROR')
          console.log(e)
          res.writeHead(500, 'Internal Error')
          res.end()
        }
      })
      const server = this.cert
        ? https.createServer({ key: this.key, cert: this.cert }, app)
        : http.createServer(app)
      server.listen(this.port, resolve)
    })
  }

  static async start(file: string, options: Options) {
    const server = new Server(file, options)
    return await server.start()
  }
}
