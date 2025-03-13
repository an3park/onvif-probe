import { createHash } from 'crypto'
import * as mHttp from 'http'
import { parseStringPromise } from 'xml2js'

export interface Result {
  soap: string
  converted: unknown
  data: unknown
}

const HTTP_TIMEOUT = 3000 // ms

export function parse(soap: string) {
  return parseStringPromise(soap, {
    explicitRoot: false,
    explicitArray: false,
    ignoreAttrs: false,
    tagNameProcessors: [
      (name) => {
        const m = name.match(/^([^\:]+)\:([^\:]+)$/)
        return m ? m[2] : name
      },
    ],
  })
}

export function requestCommand(oxaddr: URL, methodName: string, soap: string): Promise<Result> {
  return new Promise<Result>((resolve, reject) => {
    let xml = ''
    request(oxaddr, soap)
      .then((res) => {
        xml = res
        return parse(res)
      })
      .then((result) => {
        const fault = getFaultReason(result)
        if (fault) {
          reject(new Error(fault))
        } else {
          const parsed = parseResponseResult(methodName, result)
          if (parsed) {
            resolve({
              soap: xml,
              converted: result,
              data: parsed,
            })
          } else {
            reject(new Error('The device seems to not support the ' + methodName + '() method.'))
          }
        }
      })
      .catch((err: unknown) => reject(err instanceof Error ? err : new Error(String(err))))
  })
}

interface SoapParams {
  xmlns?: string[]
  diff?: number
  user?: string
  pass?: string
  body: string
}

export function createRequestSoap(params: SoapParams): string {
  let soap = ''
  soap += '<?xml version="1.0" encoding="UTF-8"?>'
  soap += '<s:Envelope'
  soap += '  xmlns:s="http://www.w3.org/2003/05/soap-envelope"'
  if (params.xmlns) {
    params.xmlns.forEach((ns) => {
      soap += ' ' + ns
    })
  }
  soap += '>'
  soap += '<s:Header>'
  if (params.user) {
    soap += createSoapUserToken(params.diff || 0, params.user, params.pass || '')
  }
  soap += '</s:Header>'
  soap += '<s:Body>' + params.body + '</s:Body>'
  soap += '</s:Envelope>'

  soap = soap.replace(/\>\s+\</g, '><')
  return soap.replace(/\s+/, ' ')
}

function request(oxaddr: URL, soap: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const opts = {
      protocol: oxaddr.protocol,
      hostname: oxaddr.hostname,
      port: oxaddr.port || 80,
      path: oxaddr.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/soap+xml; charset=utf-8;',
        'Content-Length': Buffer.byteLength(soap),
      },
    }
    let req: mHttp.ClientRequest | null = mHttp.request(opts, (res) => {
      res.setEncoding('utf8')
      let xml = ''
      res.on('data', (chunk) => {
        xml += chunk
      })

      res.on('end', () => {
        if (req) {
          req.removeAllListeners('error')
          req.removeAllListeners('timeout')
          req = null
        }

        const statusCode = res.statusCode || 500
        const statusMessage = res.statusMessage || 'Unknown Error'

        if (res) {
          res.removeAllListeners('data')
          res.removeAllListeners('end')
        }

        let responseObj: mHttp.IncomingMessage | null = res
        responseObj = null

        if (statusCode === 200) {
          resolve(xml)
        } else {
          const err = new Error(statusCode + ' ' + statusMessage)
          if (xml) {
            parse(xml)
              .then((parsed) => {
                let msg = parsed.Body?.Fault?.Reason?.Text
                if (typeof msg === 'object') {
                  msg = msg._
                }
                if (msg) {
                  reject(new Error(statusCode + ' ' + statusMessage + '-' + msg))
                } else {
                  reject(err)
                }
              })
              .catch((error: unknown) => {
                reject(error instanceof Error ? error : new Error(String(error)))
              })
          } else {
            reject(err)
          }
        }
      })
    })
    req.setTimeout(HTTP_TIMEOUT)

    req.on('timeout', () => {
      if (req) {
        req.destroy()
      }
    })

    req.on('error', (err) => {
      if (req) {
        req.removeAllListeners('error')
        req.removeAllListeners('timeout')
        req = null
      }
      reject(new Error('Network Error: ' + (err ? err.message : '')))
    })

    req.write(soap, 'utf8')
    req.end()
  })
}

function getFaultReason(r: unknown): string {
  try {
    const reasonEl = (r as any).Body?.Fault?.Reason
    if (reasonEl?.Text) {
      return reasonEl.Text
    }
    const codeEl = (r as any).Body?.Fault?.Code
    if (codeEl?.Value) {
      let reason = codeEl.Value
      const subcodeEl = codeEl.Subcode
      if (subcodeEl?.Value) {
        reason += ' ' + subcodeEl.Value
      }
      return reason
    }
    return ''
  } catch (e) {
    return ''
  }
}

function parseResponseResult(methodName: string, res: unknown): unknown {
  const s0 = (res as any).Body
  if (!s0) {
    return null
  }
  if (methodName + 'Response' in s0) {
    return s0
  }
  return null
}

function createSoapUserToken(diff: number, user: string, pass: string) {
  if (!diff) {
    diff = 0
  }
  if (!pass) {
    pass = ''
  }
  const date = new Date(Date.now() + diff).toISOString()
  const nonceBuffer = createNonce(16)
  const nonceBase64 = nonceBuffer.toString('base64')
  const shasum = createHash('sha1')

  shasum.update(Buffer.concat([nonceBuffer, Buffer.from(date), Buffer.from(pass)]))
  const digest = shasum.digest('base64')
  return `<Security s:mustUnderstand="1" xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">
        <UsernameToken>
            <Username>${user}</Username>
            <Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</Password>
            <Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonceBase64}</Nonce>
            <Created xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">${date}</Created>
        </UsernameToken>
    </Security>`
}

function createNonce(digit: number) {
  const nonce = Buffer.alloc(digit)
  for (let i = 0; i < digit; i++) {
    nonce.writeUInt8(Math.floor(Math.random() * 256), i)
  }
  return nonce
}
