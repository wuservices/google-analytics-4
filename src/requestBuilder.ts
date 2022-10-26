import { ComponentSettings, MCEvent } from '@managed-components/types'
import {
  buildProductRequest,
  EVENTS,
  mapProductToItem,
  PREFIX_PARAMS_MAPPING,
} from './ecommerce'
import { flattenKeys, isNumber } from './utils'

const getRandomInt = () => Math.floor(2147483647 * Math.random())

const getToolRequest = (
  eventType: string,
  event: MCEvent,
  settings: ComponentSettings
) => {
  let payload = {}

  // avoid sending ecommerce flattened products list to GA4
  const { client, payload: fullPayload } = event
  if (eventType === 'ecommerce') {
    const { products, ...restOfPayload } = fullPayload.ecommerce
    payload = restOfPayload
  } else {
    payload = fullPayload
  }

  let eventsCounter = parseInt(client.get('counter'))
  if (!Number.isInteger(eventsCounter)) eventsCounter = 0
  eventsCounter++
  client.set('counter', eventsCounter.toString())

  const requestBody: Record<string, unknown> = {
    v: 2,
    // gtm: '2oe5j0', // TODO: GTM version hash? not clear if we need this
    tid: settings.tid,
    dl: client.url.href,
    ul: client.language,
    dt: client.title,
    // _p: getRandomInt(), // TODO: this doesn't seem random at all, what is this?
    _s: eventsCounter,
    ...(settings.hideOriginalIP && {
      _uip: client.ip,
    }),
    ...(client.referer && { dr: client.referer }),
  }

  // Session counting
  let sessionCounter = parseInt(client.get('session_counter'))
  if (!Number.isInteger(sessionCounter)) {
    sessionCounter = 0
  }
  client.set('session_counter', (sessionCounter + 1).toString(), {
    scope: 'infinite',
  })
  requestBody['sct'] = sessionCounter + 1

  // Create, refresh or renew session id
  const sessionLength = 30 * 60 // By default, GA4 keeps sessions for 30 minutes
  let currentSessionID = client.get('_ga4sid')
  if (currentSessionID) {
    requestBody['seg'] = 1 // Session engaged
  } else {
    requestBody['seg'] = 0
    requestBody['_ss'] = 1 // Session start
    currentSessionID = getRandomInt().toString()
  }
  client.set('_ga4sid', currentSessionID, { expiry: sessionLength })
  requestBody['sid'] = currentSessionID

  // Handle Client ID
  let cid = client.get('_ga4')?.split('.').slice(-2).join('.')
  if (!cid) {
    cid = crypto.randomUUID()
    requestBody['_fv'] = 1 // No Client ID -> setting "First Visit"
  }
  client.set('_ga4', cid, { scope: 'infinite' })
  requestBody['cid'] = cid

  if (parseInt(requestBody['_s'] as string) > 1) {
    const msSinceLastEvent = Date.now() - parseInt(client.get('_let')) // _let = "_lastEventTime"
    requestBody._et = msSinceLastEvent
  }
  client.set('_let', Date.now().toString())

  /* Start of gclid treating */
  if (client.url.searchParams?.get('_gl')) {
    try {
      const _gl = client.url.searchParams?.get('_gl') as string
      const gclaw = atob(_gl.split('*').pop()?.replaceAll('.', '') || '')
      client.set('_gclaw', gclaw, { scope: 'infinite' })
      requestBody.gclid = gclaw.split('.').pop()
    } catch (e) {
      console.log('Google Analytics: Error parsing gclaw', e)
    }
  }
  if (client.get('_gcl_aw')) {
    requestBody.gclid = client.get('_gcl_aw').split('.').pop()
  }
  if (client.get('gclid')) {
    requestBody.gclid = client.get('gclid')
  }
  /* End of gclid treating */

  if (requestBody.gclid) {
    const url = new URL(requestBody.dl as string)
    url.searchParams.get('gclid') ||
      url.searchParams.append('gclid', requestBody.gclid as string)
    requestBody.dl = url
  }

  Object.entries({
    utma: '_utma',
    utmz: '_utmz',
    dpd: '_dpd',
    utm_wtk: 'utm_wtk',
  }).forEach(([searchParam, cookieName]) => {
    if (client.url.searchParams.get(searchParam)) {
      client.set(cookieName, client.url.searchParams.get(searchParam), {
        scope: 'infinite',
      })
    }
  })

  const builtInKeys = ['tid', 'uid', 'en', 'ni']
  const eventData = flattenKeys(payload)

  // `up.X`s are User Properties and should stay with this prefix
  // Otherwise, it's an Event Property. If numerical - prefixed with `epn.`,
  // and if a string, it's just `ep.`
  for (const key in eventData) {
    if (!builtInKeys.includes(key) && !key.startsWith('up.')) {
      if (Number(eventData[key])) eventData['epn.' + key] = eventData[key]
      else eventData['ep.' + key] = eventData[key]
      delete eventData[key]
    }
  }

  const toolRequest = { ...requestBody, ...eventData }
  return toolRequest
}

const getFinalURL = (
  eventType: string,
  event: MCEvent,
  settings: ComponentSettings
) => {
  const { payload } = event
  const toolRequest = getToolRequest(eventType, event, settings)

  // toolRequest['ep.debug_mode'] = true

  toolRequest.en = eventType

  // ecommerce events
  if (eventType === 'ecommerce') {
    const ecommerceData = payload.ecommerce
    let prQueryParams

    // event name and currency will always be added as non prefixed query params
    const eventName = event.name || ''
    toolRequest.en = EVENTS[eventName] ? EVENTS[eventName] : eventName
    ecommerceData.currency && (toolRequest.cu = ecommerceData.currency)

    for (const key of Object.keys(PREFIX_PARAMS_MAPPING)) {
      const param = PREFIX_PARAMS_MAPPING[key]
      const prefix = isNumber(ecommerceData[key]) ? 'epn' : 'ep'
      ecommerceData[key] &&
        (toolRequest[`${prefix}.${param}`] = ecommerceData[key])
    }

    if (ecommerceData.products) {
      // handle products list
      for (const [index, product] of (ecommerceData.products || []).entries()) {
        const item = mapProductToItem(product)
        prQueryParams = buildProductRequest(item)
        toolRequest[`pr${index + 1}`] = prQueryParams
      }
    } else {
      // handle single product data
      const item = mapProductToItem(ecommerceData)
      prQueryParams = buildProductRequest(item)
      if (prQueryParams) toolRequest['pr1'] = prQueryParams
    }
  }

  const queryParams = new URLSearchParams(toolRequest).toString()

  const baseURL = 'https://www.google-analytics.com/g/collect?'
  const finalURL = baseURL + queryParams

  return { finalURL, requestBody: toolRequest }
}

export { getToolRequest, getFinalURL }
