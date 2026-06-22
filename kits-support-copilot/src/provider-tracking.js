const PROVIDER_PORTALS = [
  {
    key: 'mign-jin',
    providerNumber: 1,
    name: 'Mign Jin',
    type: 'provider_portal',
    url: 'http://193.112.141.69:8082/en/trackIndex.htm',
    patterns: [/mign\s*jin/i, /^\s*1\s*-/i, /\(1\)/]
  },
  {
    key: 'xiao-ming',
    providerNumber: 2,
    name: 'Xiao-ming',
    type: 'provider_portal',
    url: 'http://119.91.41.88:8082/en/trackIndex.htm',
    patterns: [/xiao[\s-]*ming/i, /^\s*2\s*-/i, /\(2\)/]
  },
  {
    key: 'miss-huang',
    providerNumber: 3,
    name: 'Miss-huang',
    type: 'kits_17track',
    url: 'https://shopify.17track.net/trackcenterapi/call',
    trackUrl: 'https://shopify-t.17track.net/track/shopify',
    shop: 'r1arz0-hg',
    patterns: [/miss[\s-]*huang/i, /^\s*3\s*-/i, /\(3\)/]
  }
];

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
    const parsed = portal.type === 'kits_17track'
      ? await fetchKits17TrackContext({ portal, trackingNumber, fetchImpl, signal: controller.signal })
      : await fetchProviderPortalContext({ portal, trackingNumber, fetchImpl, signal: controller.signal });

    if (!parsed.timeline.length && !parsed.last_record) {
      return unavailable(
        'no_data',
        `Provider tracking lookup returned no tracking events for ${trackingNumber}.`
      );
    }

    return {
      available: true,
      source: portal.type,
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
    if (error?.reason === 'http_error') {
      return unavailable(
        'http_error',
        `Provider tracking lookup failed for provider ${providerLabel || providerId}: HTTP ${error.status || 'unknown'}.`
      );
    }

    return unavailable(
      timedOut ? 'timeout' : 'lookup_failed',
      `Provider tracking lookup failed for provider ${providerLabel || providerId}: ${timedOut ? 'timeout' : error.message}.`
    );
  } finally {
    clearTimeout(timer);
  }
}

async function fetchProviderPortalContext({ portal, trackingNumber, fetchImpl, signal }) {
  const response = await fetchImpl(portal.url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ documentCode: trackingNumber }),
    signal
  });

  if (!response?.ok) throw httpError(response?.status);

  const html = await response.text();
  return parseProviderTrackingHtml(html, { trackingNumber });
}

async function fetchKits17TrackContext({ portal, trackingNumber, fetchImpl, signal }) {
  const lookupResponse = await fetchImpl(portal.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://kitsrepublic.com',
      referer: `https://kitsrepublic.com/apps/17TRACK?nums=${encodeURIComponent(trackingNumber)}`
    },
    body: JSON.stringify({
      Version: '1.0',
      Method: 'get-track-record-by-track-no',
      SourceType: '0',
      Cookies: '',
      TimeZoneOffset: new Date().getTimezoneOffset(),
      Param: {
        shop: portal.shop,
        type: 'track',
        track_no: trackingNumber,
        trackActinType: 'URL'
      }
    }),
    signal
  });

  if (!lookupResponse?.ok) throw httpError(lookupResponse?.status);

  const lookupJson = await lookupResponse.json();
  const info = lookupJson?.Json?.info || {};
  if (lookupJson?.Code !== 0 || !info.no) return parseKits17TrackShipment(null, { trackingNumber });

  const trackResponse = await fetchImpl(portal.trackUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://kitsrepublic.com',
      referer: `https://kitsrepublic.com/apps/17TRACK?nums=${encodeURIComponent(trackingNumber)}`
    },
    body: JSON.stringify({
      data: [{
        num: info.no.includes('/') ? info.no.split('/').at(-1) : info.no,
        fc: info.fc,
        sc: info.sc || 0,
        params: info.params || {}
      }],
      g: info.g,
      lang: 'en',
      timeZoneOffset: new Date().getTimezoneOffset()
    }),
    signal
  });

  if (!trackResponse?.ok) throw httpError(trackResponse?.status);

  const trackJson = await trackResponse.json();
  const shipment = trackJson?.shipments?.[0] || null;
  return parseKits17TrackShipment(shipment, { trackingNumber, info });
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
  return [
    provider?.label,
    provider?.name,
    provider?.code,
    provider?.provider,
    order?.provider,
    order?.assigned_provider?.label,
    order?.assigned_provider?.name,
    order?.assigned_provider?.code
  ]
    .filter(Boolean)
    .map(value => cleanText(value))
    .join(' ');
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

export function parseKits17TrackShipment(shipment = null, { trackingNumber = '', info = {} } = {}) {
  const shipmentInfo = shipment?.shipment || {};
  const providerEvents = Array.isArray(shipmentInfo?.tracking?.providers)
    ? shipmentInfo.tracking.providers
    : [];
  const timeline = providerEvents.flatMap(providerTracking => {
    const providerName = cleanText(providerTracking?.provider?.name);
    const events = Array.isArray(providerTracking?.events) ? providerTracking.events : [];
    return events.map(event => normalizeKits17TrackEvent(event, { providerName })).filter(Boolean);
  });
  const latestEvent = timeline[0] || normalizeKits17TrackEvent(shipmentInfo.latest_event, {
    providerName: cleanText(info?.carrier_info?.first_carrier_info?.name)
  });
  const latestRecord = latestEvent?.record || null;
  const destination = shipmentInfo?.shipping_info?.recipient_address?.country || info.destCountry;

  return {
    reference_number: shipmentInfo?.misc_info?.reference_number || null,
    country: destination || null,
    consignee_name: null,
    last_update_at: latestEvent?.date || null,
    last_record: latestRecord,
    normalized_status: latestEvent?.normalized_status || classifyProviderTrackingStatus(latestRecord),
    customs_status: classifyCustomsStatus(timeline.length ? timeline : [latestEvent].filter(Boolean)),
    latest_events: timeline.slice(0, 3),
    timeline
  };
}

export function classifyProviderTrackingStatus(value = '') {
  const text = cleanText(value).toLowerCase();
  if (!text) return null;

  if (/delivery service provider/.test(text)) return 'delivery_service_provider';
  if (/in transit to final service provider/.test(text)) return 'in_transit_to_final_provider';
  if (/truck ready for transfer to final service provider/.test(text)) return 'ready_for_final_service_provider';
  if (/customs clearance completed|customs released|出口清关完成|清关完成/.test(text)) return 'customs_clearance_completed';
  if (/customs clearance in progress|waiting for customs clearance|等待清关|始发地海关/.test(text)) return 'customs_clearance_in_progress';
  if (/pending receipt|pendiente de recepci[oó]n|pendiente de entrada en red/.test(text)) return 'local_pending_receipt';
  if (/arrival at the local airport/.test(text)) return 'arrived_local_airport';
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

function normalizeKits17TrackEvent(event, { providerName = '' } = {}) {
  if (!event) return null;

  const location = translateKnownLocation(event.location || event.address?.city || '');
  const description = translateKits17TrackDescription(event.description || '');
  const record = formatKits17TrackRecord({ location, description });

  return {
    date: formatKits17TrackDate(event),
    location,
    record,
    provider_name: providerName || null,
    sub_status: event.sub_status || null,
    normalized_status: classifyKits17TrackEvent(event, record)
  };
}

function classifyKits17TrackEvent(event = {}, record = '') {
  const subStatus = cleanText(event.sub_status);
  if (/customsreleased/i.test(subStatus)) return 'customs_clearance_completed';
  if (/customs/i.test(subStatus)) return 'customs_clearance_in_progress';
  return classifyProviderTrackingStatus([record, event.description].filter(Boolean).join(' '));
}

function translateKits17TrackDescription(value = '') {
  const text = cleanText(value);
  if (!text) return '';

  let match = text.match(/^出口清关完成【(.+?)】$/);
  if (match) return `export customs clearance completed [${translateKnownLocation(match[1])}]`;

  match = text.match(/^邮件到达始发地海关【(.+?)】，等待清关$/);
  if (match) {
    return `the mail arrives at the customs place of origin [${translateKnownLocation(match[1])}] and is waiting for customs clearance`;
  }

  match = text.match(/^邮件离开【(.+?)】，正在发往【(.+?)】$/);
  if (match) {
    return `The mail has left [${translateKnownLocation(match[1])}] and is being sent to [${translateKnownLocation(match[2])}]`;
  }

  match = text.match(/^邮件已在【(.+?)】完成分拣，准备发出$/);
  if (match) return `The mail has been sorted at [${translateKnownLocation(match[1])}] and is ready to be sent out`;

  if (/中国邮政已收取邮件/.test(text)) return 'Mail has been received by China Post';

  return translateKnownLocation(text.replace(/【(.+?)】/g, (_, place) => `[${translateKnownLocation(place)}]`));
}

function translateKnownLocation(value = '') {
  const replacements = {
    郑州: 'Zhengzhou',
    温州市: 'Wenzhou',
    温州国际: 'Wenzhou International',
    温州: 'Wenzhou',
    平阳县国际揽投部: 'Pingyang County International Investment Department'
  };

  return Object.entries(replacements).reduce(
    (text, [source, replacement]) => text.replaceAll(source, replacement),
    cleanText(value)
  );
}

function formatKits17TrackRecord({ location, description }) {
  if (!description) return location || '';
  if (!location) return description;
  if (description.toLowerCase().startsWith(location.toLowerCase())) return description;
  return `${location}, ${description}`;
}

function formatKits17TrackDate(event = {}) {
  if (event.time_utc) return event.time_utc.replace('T', ' ').replace(/Z$/, ' UTC');
  if (event.time_iso) return event.time_iso;
  if (event.time_raw?.date && event.time_raw?.time) return `${event.time_raw.date} ${event.time_raw.time}`;
  return event.time_raw?.date || null;
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

function httpError(status) {
  const error = new Error(`HTTP ${status || 'unknown'}`);
  error.reason = 'http_error';
  error.status = status;
  return error;
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
