import { createHash } from 'crypto'
import * as mHttp from 'http'
import * as mHttps from 'https'

interface AuthHeader {
  algorithm?: string
  nonce?: string
  'Digest realm'?: string
  qop: string
}

export class OnvifHttpAuth {
  private user = ''
  private pass = ''
  private method = ''
  private path = ''
  private nonceCount = 0
  private options: mHttp.RequestOptions | mHttps.RequestOptions = {}

  request(
    options: mHttp.RequestOptions | mHttps.RequestOptions,
    callback: (req: mHttp.IncomingMessage) => void
  ): mHttp.ClientRequest {
    this.options = { ...options }
    const http = options && options.protocol === 'https:' ? mHttps : mHttp
    if (options.auth) {
      const [user = '', pass = ''] = options.auth.split(':')
      this.user = user
      this.pass = pass
    }
    if (options.method) {
      this.method = options.method.toUpperCase()
    } else {
      this.method = 'GET'
    }
    if (options.path) {
      this.path = options.path
    }

    return http.request(options, (res) => {
      if (res.statusCode === 401 && res.headers['www-authenticate']) {
        const authHeader = res.headers['www-authenticate']
        if (typeof authHeader === 'string' && authHeader.match(/Digest realm/)) {
          this.handleHttpDigest(http, res, callback)
        } else {
          callback(res)
        }
      } else {
        callback(res)
      }
    })
  }

  private handleHttpDigest(
    http: typeof mHttp | typeof mHttps,
    res: mHttp.IncomingMessage,
    callback: (req: mHttp.IncomingMessage) => void
  ): void {
    const authHeader = res.headers['www-authenticate']
    if (typeof authHeader !== 'string') {
      callback(res)
      return
    }
    const o = this.parseAuthHeader(authHeader)
    if (!this.options.headers) {
      this.options.headers = {}
    }
    this.options.headers.Authorization = this.createAuthReqHeaderValue(o)
    http.request(this.options, callback).end()
  }

  private parseAuthHeader(h: string): AuthHeader {
    const o: AuthHeader = {
      algorithm: 'MD5',
      nonce: '',
      'Digest realm': '',
      qop: '',
    }
    h.split(/,\s*/).forEach((s) => {
      const pair = s.split('=')
      const k = pair[0] as keyof AuthHeader
      let v = pair.slice(1).join('=')
      if (!k || !v) {
        return
      }
      v = v.replace(/^\"/, '')
      v = v.replace(/\"$/, '')
      o[k] = v
    })
    if (!o.algorithm) {
      // workaround for DBPOWER
      o.algorithm = 'MD5'
    }
    return o
  }

  private createAuthReqHeaderValue(o: AuthHeader): string {
    if (!o.algorithm || !o.nonce || !o['Digest realm'] || !o.qop) {
      throw new Error('Missing required authentication parameters')
    }

    const ha1 = this.createHash(o.algorithm, [this.user, o['Digest realm'], this.pass].join(':'))
    const ha2 = this.createHash(o.algorithm, [this.method, this.path].join(':'))
    const cnonce = this.createCnonce(8)
    this.nonceCount++
    const nc = ('0000000' + this.nonceCount.toString(16)).slice(-8)
    const response = this.createHash(o.algorithm, [ha1, o.nonce, nc, cnonce, o.qop, ha2].join(':'))

    return (
      'Digest ' +
      [
        'username="' + this.user + '"',
        'realm="' + o['Digest realm'] + '"',
        'nonce="' + o.nonce + '"',
        'uri="' + this.path + '"',
        'algorithm=' + o.algorithm,
        'qop=' + o.qop,
        'nc=' + nc,
        'cnonce="' + cnonce + '"',
        'response="' + response + '"',
      ].join(', ')
    )
  }

  private createHash(algo: string, data: string): string {
    const hash = algo === 'MD5' ? createHash('MD5') : createHash('sha256')
    hash.update(data, 'utf8')
    return hash.digest('hex')
  }

  private createCnonce(digit: number): string {
    const nonce = Buffer.alloc(digit)
    for (let i = 0; i < digit; i++) {
      nonce.writeUInt8(Math.floor(Math.random() * 256), i)
    }
    return nonce.toString('hex')
  }
}
