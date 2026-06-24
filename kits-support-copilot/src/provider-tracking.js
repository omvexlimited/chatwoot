const PROVIDER_PORTALS = [
  {
    key: 'mign-jin',
    providerNumber: 1,
    name: 'Mign Jin',
    url: 'http://193.112.141.69:8082/en/trackIndex.htm',
    patterns: [/mign\s*jin/i, /^\s*1\s*-/i, /\(1\)/]
  },
  {
    key: 'xiao-ming',
    providerNumber: 2,
    name: 'Xiao-ming',
    url: 'http://119.91.41.88:8082/en/trackIndex.htm',
    patterns: [/xiao[\s-]*ming/i, /^\s*2\s*-/i, /\(2\)/]
  },
  {
    key: 'miss-huang-public-17track',
    providerNumber: 3,
    name: 'Miss-huang',
    source: 'public_17track',
    patterns: [/miss[\s-]*huang/i, /^\s*3\s*-/i, /\(3\)/]
  }
];

const KITS_TRACKING_SHOP = 'r1arz0-hg';
const SEVENTEEN_TRACK_API_URL = 'https://shopify.17track.net/trackcenterapi/call';
const SEVENTEEN_TRACK_SHOPIFY_URL = 'https://shopify-t.17track.net/track/shopify';

export async function getProviderTrackingContext({
  provider,
  order,
  fetchImpl = globalThis.fetch,
  timeoutMs = 5000
}) {
  if (!order) return unavailable('no_order');

  const providerId = Number(provider?.id || order?.assigned_provider?.id) || null;
  const providerLabel = getProviderLabel(provider, order);
  if (!providerId && !providerLabel) return unavailable('no_provider');

  const portal = resolveProviderPortal(provider, order);
  if (!portal) {
    return unavailable(
      'provider_not_supported',
      `Provider tracking lookup is not configured for provider ${providerLabel || providerId}.`
    );
  }

  const trackingNumber = firstTrackingNumberFromOrder(order);
  if (!trackingNumber) return unavailable('no_tracking');

  if (typeof fetchImpl !== 'function') {
    return unavailable('fetch_unavailable', 'Provider tracking fetch is not available in this runtime.');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    if (portal.source === 'public_17track') {
      const parsed = await getPublic17TrackTracking({
        trackingNumber,
        fetchImpl,
        signal: controller.signal
      });

      if (!parsed.timeline.length && !parsed.last_record) {
        return unavailable(
          'no_data',
          `Public tracking lookup returned no tracking events for ${trackingNumber}.`
        );
      }

      return {
        available: true,
        source: 'public_17track',
        provider_id: providerId,
        provider_portal_key: portal.key,
        provider_portal_number: portal.providerNumber,
        provider_name: portal.name,
        tracking_number: trackingNumber,
        ...parsed,
        warnings: []
      };
    }

    const response = await fetchImpl(portal.url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ documentCode: trackingNumber }),
      signal: controller.signal
    });

    if (!response?.ok) {
      return unavailable(
        'http_error',
        `Provider tracking lookup failed for provider ${providerLabel || providerId}: HTTP ${response?.status || 'unknown'}.`
      );
    }

    const html = await response.text();
    const parsed = parseProviderTrackingHtml(html, { trackingNumber });
    if (!parsed.timeline.length && !parsed.last_record) {
      return unavailable(
        'no_data',
        `Provider tracking lookup returned no tracking events for ${trackingNumber}.`
      );
    }

    return {
      available: true,
      source: 'provider_portal',
      provider_id: providerId,
      provider_portal_key: portal.key,
      provider_portal_number: portal.providerNumber,
      provider_name: portal.name,
      tracking_number: trackingNumber,
      ...parsed,
      warnings: []
    };
  } catch (error) {
    const timedOut = error?.name === 'AbortError';
    return unavailable(
      timedOut ? 'timeout' : 'lookup_failed',
      `Provider tracking lookup failed for provider ${providerLabel || providerId}: ${timedOut ? 'timeout' : error.message}.`
    );
  } finally {
    clearTimeout(timer);
  }
}

function resolveProviderPortal(provider, order) {
  const providerId = Number(provider?.id || order?.assigned_provider?.id);
  const byConfiguredNumber = PROVIDER_PORTALS.find(portal => portal.providerNumber === providerId);
  if (byConfiguredNumber) return byConfiguredNumber;

  const label = getProviderLabel(provider, order);
  if (!label) return null;

  return PROVIDER_PORTALS.find(portal => portal.patterns.some(pattern => pattern.test(label))) || null;
}

function getProviderLabel(provider = {}, order = {}) {
  const parts = [
    provider?.label,
    provider?.name,
    provider?.code,
    provider?.provider,
    order?.provider,
    order?.assigned_provider?.label,
    order?.assigned_provider?.name,
    order?.assigned_provider?.code
  ];

  const seen = new Set();
  return parts
    .map(value => cleanText(value))
    .map(value => collapseRepeatedText(value))
    .filter(Boolean)
    .filter(value => {
      const key = value.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join(' ');
}

function collapseRepeatedText(value = '') {
  const tokens = cleanText(value).split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return cleanText(value);

  for (let chunkSize = 1; chunkSize <= Math.floor(tokens.length / 2); chunkSize += 1) {
    if (tokens.length % chunkSize !== 0) continue;
    const chunk = tokens.slice(0, chunkSize).join(' ').toLowerCase();
    const repeated = [];
    for (let index = 0; index < tokens.length; index += chunkSize) {
      repeated.push(tokens.slice(index, index + chunkSize).join(' ').toLowerCase());
    }
    if (repeated.every(part => part === chunk)) {
      return tokens.slice(0, chunkSize).join(' ');
    }
  }

  return cleanText(value);
}

export function parseProviderTrackingHtml(html = '', { trackingNumber = '' } = {}) {
  const summary = parseSummaryRow(html, trackingNumber);
  const timeline = parseTimeline(html);
  const latestEvent = timeline[0] || null;
  const latestRecord = latestEvent?.record || summary.last_record || null;

  return {
    reference_number: summary.reference_number || null,
    country: summary.country || null,
    consignee_name: summary.consignee_name || null,
    last_update_at: latestEvent?.date || summary.last_update_at || null,
    last_record: latestRecord,
    normalized_status: classifyProviderTrackingStatus(latestRecord),
    customs_status: classifyCustomsStatus(timeline),
    latest_events: timeline.slice(0, 3),
    timeline
  };
}

export function classifyProviderTrackingStatus(value = '') {
  const text = cleanText(value).toLowerCase();
  if (!text) return null;

  if (/delivery service provider/.test(text)) return 'delivery_service_provider';
  if (/in transit to final service provider/.test(text)) return 'in_transit_to_final_provider';
  if (/export customs clearance completed|customs released/.test(text)) return 'customs_clearance_completed';
  if (/truck ready for transfer to final service provider/.test(text)) return 'ready_for_final_service_provider';
  if (/customs clearance completed/.test(text)) return 'customs_clearance_completed';
  if (/customs clearance in progress/.test(text)) return 'customs_clearance_in_progress';
  if (/waiting for customs clearance/.test(text)) return 'customs_clearance_in_progress';
  if (/pending receipt|pendiente de recepci[oó]n|pendiente de entrada en red/.test(text)) return 'local_pending_receipt';
  if (/arrival at the local airport/.test(text)) return 'arrived_local_airport';
  if (/\barrival\b/.test(text)) return 'arrival';
  if (/\bdeparture\b/.test(text)) return 'departure';
  if (/main line transfer/.test(text)) return 'main_line_transfer';
  if (/flight departure/.test(text)) return 'flight_departure';
  if (/cargo handed over to the airline/.test(text)) return 'handed_to_airline';
  if (/domestic customs clearance is completed/.test(text)) return 'origin_customs_clearance_completed';
  if (/arrived at the operating center/.test(text)) return 'arrived_operating_center';
  if (/goods leave the operation center/.test(text)) return 'left_operating_center';

  return null;
}

function classifyCustomsStatus(timeline = []) {
  const statuses = timeline.map(event => event.normalized_status).filter(Boolean);
  if (statuses.includes('customs_clearance_completed')) return 'customs_clearance_completed';
  if (statuses.includes('customs_clearance_in_progress')) return 'customs_clearance_in_progress';
  return null;
}

function parseSummaryRow(html, trackingNumber) {
  const blocks = html.match(/<ul\b[^>]*class=["'][^"']*clearfix[^"']*["'][^>]*>[\s\S]*?<\/ul>/gi) || [];
  for (const block of blocks) {
    const items = [...block.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map(match => cleanHtml(match[1]));
    if (!items.length || items.some(item => /reference no\.|trackingnumber|country/i.test(item))) continue;
    if (trackingNumber && !items.some(item => item === trackingNumber)) continue;
    if (items.length < 5) continue;

    return {
      reference_number: items[0] || null,
      tracking_number: items[1] || null,
      country: items[2] || null,
      last_update_at: items[3] || null,
      last_record: items[4] || null,
      consignee_name: items[5] || null
    };
  }
  return {};
}

function parseTimeline(html) {
  const rows = [];
  const matches = html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi);

  for (const match of matches) {
    const cells = [...match[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(cell => cleanHtml(cell[1]));
    if (cells.length < 3) continue;
    const [date, location, record] = cells;
    if (!/^\d{4}-\d{2}-\d{2}/.test(date) || !record) continue;
    rows.push({
      date,
      location,
      record,
      normalized_status: classifyProviderTrackingStatus(record)
    });
  }

  return rows;
}

async function getPublic17TrackTracking({ trackingNumber, fetchImpl, signal }) {
  const trackRecord = await postJson(fetchImpl, SEVENTEEN_TRACK_API_URL, {
    Version: '1.0',
    Method: 'get-track-record-by-track-no',
    SourceType: '0',
    Cookies: '',
    TimeZoneOffset: new Date().getTimezoneOffset(),
    Param: {
      shop: KITS_TRACKING_SHOP,
      type: 'track',
      track_no: trackingNumber,
      trackActinType: 'Track'
    }
  }, signal);

  if (trackRecord?.Code !== 0 || !trackRecord?.Json?.info?.no) {
    throw new Error(trackRecord?.Message || 'tracking number not found');
  }

  const info = trackRecord.Json.info;
  const trackingResponse = await postJson(fetchImpl, SEVENTEEN_TRACK_SHOPIFY_URL, {
    data: [
      {
        num: info.no,
        fc: info.fc,
        sc: info.sc,
        params: info.params || {}
      }
    ],
    g: info.g,
    lang: 'en',
    timeZoneOffset: new Date().getTimezoneOffset()
  }, signal);

  const shipment = trackingResponse?.shipments?.[0];
  if (trackingResponse?.meta?.code !== 200 || !shipment?.shipment) {
    throw new Error(trackingResponse?.meta?.message || 'tracking details not available');
  }

  return parsePublic17TrackShipment({ info, shipment, trackingNumber });
}

async function postJson(fetchImpl, url, body, signal) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://kitsrepublic.com',
      referer: `https://kitsrepublic.com/apps/17TRACK?nums=${encodeURIComponent(body?.Param?.track_no || '')}`
    },
    body: JSON.stringify(body),
    signal
  });

  if (!response?.ok) {
    throw new Error(`HTTP ${response?.status || 'unknown'}`);
  }

  return response.json();
}

function parsePublic17TrackShipment({ info = {}, shipment = {}, trackingNumber = '' }) {
  const shipmentData = shipment.shipment || {};
  const providerEvents = Array.isArray(shipmentData.tracking?.providers)
    ? shipmentData.tracking.providers.flatMap(provider => provider?.events || [])
    : [];
  const timeline = providerEvents
    .map(event => public17TrackEventToTimeline(event))
    .filter(event => event.date || event.record);
  const latestEvent = timeline[0] || null;
  const latestRecord = latestEvent?.record || formatPublic17TrackEvent(shipmentData.latest_event) || null;

  return {
    reference_number: info.order_no || null,
    country: shipmentData.shipping_info?.recipient_address?.country || info.destCountry || null,
    consignee_name: null,
    last_update_at: latestEvent?.date || shipmentData.latest_event?.time_utc || shipmentData.latest_event?.time_iso || null,
    last_record: latestRecord,
    normalized_status: classifyProviderTrackingStatus(latestRecord) || classify17TrackStatus(shipmentData.latest_status),
    customs_status: classifyCustomsStatus(timeline),
    latest_events: timeline.slice(0, 3),
    timeline,
    public_tracking_number: trackingNumber,
    public_tracking_status: shipmentData.latest_status || null
  };
}

function public17TrackEventToTimeline(event = {}) {
  const record = formatPublic17TrackEvent(event);
  return {
    date: event.time_utc || event.time_iso || public17TrackRawDate(event.time_raw),
    location: translatePublic17TrackLocation(event.location || event.address?.city || ''),
    record,
    normalized_status: classifyProviderTrackingStatus(record) || classify17TrackSubStatus(event.sub_status)
  };
}

function formatPublic17TrackEvent(event = {}) {
  const location = translatePublic17TrackLocation(event.location || event.address?.city || '');
  const description = translatePublic17TrackDescription(event.description || '');
  if (!description && !location) return '';
  if (!location) return description;

  if (/^(arrival|departure)$/i.test(description)) {
    return `${location}, ${description.toLowerCase()}`;
  }
  if (/^main line transfer$/i.test(description)) return description;
  if (description.includes('[Zhengzhou]')) return description;
  return `${location}, ${description}`;
}

function translatePublic17TrackDescription(value = '') {
  const text = cleanText(value);
  if (!text) return '';

  const exactTranslations = new Map([
    ['抵达', 'arrival'],
    ['启运', 'departure'],
    ['干线中转', 'Main line transfer'],
    ['中国邮政已收取邮件', 'Mail has been received by the Post Office']
  ]);
  if (exactTranslations.has(text)) return exactTranslations.get(text);

  if (/出口清关完成/.test(text)) {
    const location = text.match(/【([^】]+)】/)?.[1];
    return `export customs clearance completed${location ? ` [${translatePublic17TrackLocation(location)}]` : ''}`;
  }

  if (/等待清关/.test(text)) {
    const location = text.match(/【([^】]+)】/)?.[1];
    return `the mail arrives at the customs place of origin${location ? ` [${translatePublic17TrackLocation(location)}]` : ''} and is waiting for customs clearance`;
  }

  if (/正在发往/.test(text)) {
    const [, from = '', to = ''] = text.match(/邮件离开【([^】]+)】，正在发往【([^】]+)】/) || [];
    if (from || to) {
      return `The mail has left${from ? ` [${translatePublic17TrackLocation(from)}]` : ''}`
        + `${to ? ` and is being sent to [${translatePublic17TrackLocation(to)}]` : ''}`;
    }
  }

  if (/完成分拣/.test(text)) {
    const location = text.match(/【([^】]+)】/)?.[1];
    return `The mail has been sorted${location ? ` at [${translatePublic17TrackLocation(location)}]` : ''} and is ready to be sent out`;
  }

  return text;
}

function translatePublic17TrackLocation(value = '') {
  return cleanText(value)
    .replace(/郑州/g, 'Zhengzhou')
    .replace(/温州市/g, 'Wenzhou')
    .replace(/温州国际/g, 'Wenzhou International')
    .replace(/平阳县国际揽投部/g, 'Pingyang County International Investment Department')
    .replace(/西班牙/g, 'Spain')
    .replace(/^CN ShipmentArrived at$/i, '');
}

function classify17TrackStatus(status = {}) {
  const value = [status?.status, status?.sub_status, status?.sub_status_descr].filter(Boolean).join(' ');
  return classify17TrackSubStatus(value);
}

function classify17TrackSubStatus(value = '') {
  const text = cleanText(value).toLowerCase();
  if (!text) return null;
  if (/customsreleased|customs_released/.test(text)) return 'customs_clearance_completed';
  if (/customs/.test(text)) return 'customs_clearance_in_progress';
  if (/intransit|in_transit/.test(text)) return 'in_transit';
  if (/delivered/.test(text)) return 'delivered';
  return null;
}

function public17TrackRawDate(raw = {}) {
  return [raw.date, raw.time].filter(Boolean).join(' ') || null;
}

function firstTrackingNumberFromOrder(order = {}) {
  const fulfillments = Array.isArray(order.fulfillments) ? order.fulfillments : [];
  for (const fulfillment of fulfillments) {
    const numbers = Array.isArray(fulfillment?.tracking_numbers) ? fulfillment.tracking_numbers : [];
    const fromNumbers = numbers.find(Boolean);
    if (fromNumbers) return cleanText(fromNumbers);

    const tracking = Array.isArray(fulfillment?.tracking) ? fulfillment.tracking : [];
    const fromTracking = tracking.find(item => item?.number)?.number;
    if (fromTracking) return cleanText(fromTracking);
  }
  return '';
}

function cleanHtml(value = '') {
  return cleanText(decodeHtmlEntities(String(value).replace(/<[^>]+>/g, ' ')));
}

function cleanText(value = '') {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\/$/, '')
    .trim();
}

function decodeHtmlEntities(value = '') {
  const named = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    aacute: 'á',
    eacute: 'é',
    iacute: 'í',
    oacute: 'ó',
    uacute: 'ú',
    Aacute: 'Á',
    Eacute: 'É',
    Iacute: 'Í',
    Oacute: 'Ó',
    Uacute: 'Ú',
    ntilde: 'ñ',
    Ntilde: 'Ñ'
  };

  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&([a-zA-Z]+);/g, (match, name) => named[name] || match);
}

function unavailable(reason, warning = null) {
  return {
    available: false,
    source: null,
    reason,
    provider_id: null,
    provider_portal_key: null,
    provider_portal_number: null,
    provider_name: null,
    tracking_number: null,
    reference_number: null,
    country: null,
    consignee_name: null,
    last_update_at: null,
    last_record: null,
    normalized_status: null,
    customs_status: null,
    latest_events: [],
    timeline: [],
    warnings: warning ? [warning] : []
  };
}
