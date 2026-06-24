import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyProviderTrackingStatus,
  getProviderTrackingContext,
  parseProviderTrackingHtml
} from '../src/provider-tracking.js';

const SAMPLE_HTML = `
  <div class="menu_">
    <ul class="clearfix">
      <li class="div_li3 abc">reference No.</li>
      <li class="div_li3 abc">trackingNumber</li>
      <li class="div_li1 abc">country</li>
      <li class="div_li3 abc">date</li>
      <li class="div_li4 abc">the last record</li>
      <li class="div_li3 abc">consigneeName</li>
    </ul>
    <ul class="clearfix">
      <li class="div_li3">CMJ0601174234161</li>
      <li class="div_li3">0082800082809769818715</li>
      <li class="div_li1">ES</li>
      <li class="div_li3">2026-06-18 10:14:57&nbsp;</li>
      <li class="div_li4">转运中Delivery Service Provider/&nbsp;</li>
      <li class="div_li3"><span title=" Marc Cercos"> Marc Cercos&nbsp;</span></li>
    </ul>
  </div>
  <table>
    <tr><td>2026-06-18 10:14:57</td><td></td><td>Delivery Service Provider</td></tr>
    <tr><td>2026-06-16 12:12:49</td><td></td><td>In transit to final service provider</td></tr>
    <tr><td>2026-06-15 00:11:25</td><td></td><td>Truck ready for transfer to final service provider</td></tr>
    <tr><td>2026-06-14 12:11:20</td><td></td><td>Customs clearance completed</td></tr>
    <tr><td>2026-06-13 13:29:45</td><td></td><td>Customs clearance in progress</td></tr>
    <tr><td>2026-06-01 09:17:45</td><td></td><td>Pendiente de recepci&oacute;n en CTT Express</td></tr>
  </table>
`;

const PUBLIC_17TRACK_RECORD = {
  Code: 0,
  Json: {
    info: {
      no: 'ZP13637561201',
      fc: 3011,
      sc: 0,
      order_no: '#2970',
      g: '86c64e2a-d96d-4c26-b12e-dd170cb9153f',
      destCountry: 'ES',
      params: {}
    }
  }
};

const PUBLIC_17TRACK_DETAILS = {
  meta: { code: 200, message: 'Ok' },
  shipments: [
    {
      code: 200,
      number: 'ZP13637561201',
      shipment: {
        shipping_info: {
          recipient_address: { country: 'ES' }
        },
        latest_status: {
          status: 'InTransit',
          sub_status: 'InTransit_Other'
        },
        latest_event: {
          time_iso: '2026-06-22T17:09:13+08:00',
          time_utc: '2026-06-22T09:09:13Z',
          description: '抵达',
          location: 'ES Albacete',
          sub_status: 'InTransit_Other'
        },
        tracking: {
          providers: [
            {
              provider: { key: 3011, name: 'China Post' },
              events: [
                {
                  time_iso: '2026-06-22T17:09:13+08:00',
                  time_utc: '2026-06-22T09:09:13Z',
                  description: '抵达',
                  location: 'ES Albacete',
                  sub_status: 'InTransit_Other'
                },
                {
                  time_iso: '2026-06-21T06:59:15+08:00',
                  time_utc: '2026-06-20T22:59:15Z',
                  description: '启运',
                  location: '郑州',
                  sub_status: 'InTransit_Other'
                },
                {
                  time_iso: '2026-06-20T21:59:40+08:00',
                  time_utc: '2026-06-20T13:59:40Z',
                  description: '干线中转',
                  location: 'CN ShipmentArrived at',
                  sub_status: 'InTransit_Other'
                },
                {
                  time_iso: '2026-06-20T10:19:02+08:00',
                  time_utc: '2026-06-20T02:19:02Z',
                  description: '出口清关完成【郑州】',
                  location: '郑州',
                  sub_status: 'InTransit_CustomsReleased'
                },
                {
                  time_iso: '2026-06-20T06:39:12+08:00',
                  time_utc: '2026-06-19T22:39:12Z',
                  description: '邮件到达始发地海关【郑州】，等待清关',
                  location: '郑州',
                  sub_status: 'InTransit_Other'
                }
              ]
            }
          ]
        }
      }
    }
  ]
};

test('parses provider tracking HTML with customs completed and latest status', () => {
  const result = parseProviderTrackingHtml(SAMPLE_HTML, {
    trackingNumber: '0082800082809769818715'
  });

  assert.equal(result.reference_number, 'CMJ0601174234161');
  assert.equal(result.country, 'ES');
  assert.equal(result.consignee_name, 'Marc Cercos');
  assert.equal(result.last_update_at, '2026-06-18 10:14:57');
  assert.equal(result.last_record, 'Delivery Service Provider');
  assert.equal(result.normalized_status, 'delivery_service_provider');
  assert.equal(result.customs_status, 'customs_clearance_completed');
  assert.equal(result.timeline.length, 6);
  assert.equal(result.latest_events[0].record, 'Delivery Service Provider');
  assert.equal(result.timeline[5].normalized_status, 'local_pending_receipt');
});

test('provider 1 lookup posts tracking number to Mign Jin portal', async () => {
  const calls = [];
  const result = await getProviderTrackingContext({
    provider: { id: 1 },
    order: orderWithTracking('0082800082809769818715'),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        text: async () => SAMPLE_HTML
      };
    }
  });

  assert.equal(calls[0].url, 'http://193.112.141.69:8082/en/trackIndex.htm');
  assert.equal(String(calls[0].options.body), 'documentCode=0082800082809769818715');
  assert.equal(result.available, true);
  assert.equal(result.provider_name, 'Mign Jin');
  assert.equal(result.customs_status, 'customs_clearance_completed');
});

test('provider 2 uses Xiao-ming portal', async () => {
  const calls = [];
  await getProviderTrackingContext({
    provider: { id: 2 },
    order: orderWithTracking('XM123456789'),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        text: async () => SAMPLE_HTML.replaceAll('0082800082809769818715', 'XM123456789')
      };
    }
  });

  assert.equal(calls[0].url, 'http://119.91.41.88:8082/en/trackIndex.htm');
  assert.equal(String(calls[0].options.body), 'documentCode=XM123456789');
});

test('provider lookup resolves Xiao-ming by label when internal id differs', async () => {
  const calls = [];
  const result = await getProviderTrackingContext({
    provider: { id: 36, label: '2 - Xiao-ming · xiao-ming' },
    order: orderWithTracking('0082800082909724139065'),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        text: async () => SAMPLE_HTML.replaceAll('0082800082809769818715', '0082800082909724139065')
      };
    }
  });

  assert.equal(calls[0].url, 'http://119.91.41.88:8082/en/trackIndex.htm');
  assert.equal(String(calls[0].options.body), 'documentCode=0082800082909724139065');
  assert.equal(result.available, true);
  assert.equal(result.provider_id, 36);
  assert.equal(result.provider_portal_number, 2);
  assert.equal(result.provider_name, 'Xiao-ming');
});

test('provider lookup resolves Mign Jin by order assigned provider label', async () => {
  const calls = [];
  await getProviderTrackingContext({
    provider: { id: 99 },
    order: {
      ...orderWithTracking('MJ123456789'),
      assigned_provider: { label: '1 - Mign Jin · 194939' }
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        text: async () => SAMPLE_HTML.replaceAll('0082800082809769818715', 'MJ123456789')
      };
    }
  });

  assert.equal(calls[0].url, 'http://193.112.141.69:8082/en/trackIndex.htm');
  assert.equal(String(calls[0].options.body), 'documentCode=MJ123456789');
});

test('provider 3 uses public Kits tracking fallback', async () => {
  const calls = [];
  const result = await getProviderTrackingContext({
    provider: { id: 3, label: '3 - Miss-huang · miss-huang' },
    order: orderWithTracking('ZP13637561201'),
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return {
        ok: true,
        json: async () => (calls.length === 1 ? PUBLIC_17TRACK_RECORD : PUBLIC_17TRACK_DETAILS)
      };
    }
  });

  assert.equal(calls[0].url, 'https://shopify.17track.net/trackcenterapi/call');
  assert.equal(calls[0].body.Method, 'get-track-record-by-track-no');
  assert.equal(calls[0].body.Param.shop, 'r1arz0-hg');
  assert.equal(calls[0].body.Param.track_no, 'ZP13637561201');
  assert.equal(calls[1].url, 'https://shopify-t.17track.net/track/shopify');
  assert.equal(calls[1].body.data[0].num, 'ZP13637561201');
  assert.equal(result.available, true);
  assert.equal(result.source, 'public_17track');
  assert.equal(result.provider_name, 'Miss-huang');
  assert.equal(result.provider_portal_number, 3);
  assert.equal(result.last_record, 'ES Albacete, arrival');
  assert.equal(result.customs_status, 'customs_clearance_completed');
  assert.equal(result.latest_events[1].record, 'Zhengzhou, departure');
  assert.equal(result.timeline[3].record, 'export customs clearance completed [Zhengzhou]');
});

test('provider lookup resolves Miss-huang by label when internal id differs', async () => {
  const calls = [];
  const result = await getProviderTrackingContext({
    provider: { id: 99, label: '3 - Miss-huang · miss-huang' },
    order: orderWithTracking('ZP13637561201'),
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return {
        ok: true,
        json: async () => (calls.length === 1 ? PUBLIC_17TRACK_RECORD : PUBLIC_17TRACK_DETAILS)
      };
    }
  });

  assert.equal(calls.length, 2);
  assert.equal(result.available, true);
  assert.equal(result.provider_id, 99);
  assert.equal(result.provider_portal_number, 3);
  assert.equal(result.provider_name, 'Miss-huang');
});

test('unsupported provider returns non-blocking warning without fetching', async () => {
  let called = false;
  const result = await getProviderTrackingContext({
    provider: { id: 99, label: 'Unsupported Provider Unsupported Provider' },
    order: orderWithTracking('NOPE123'),
    fetchImpl: async () => {
      called = true;
    }
  });

  assert.equal(called, false);
  assert.equal(result.available, false);
  assert.equal(result.reason, 'provider_not_supported');
  assert.match(result.warnings[0], /not configured for provider Unsupported Provider/i);
  assert.doesNotMatch(result.warnings[0], /Unsupported Provider Unsupported Provider/i);
});

test('provider tracking lookup timeout is non-blocking', async () => {
  const result = await getProviderTrackingContext({
    provider: { id: 1 },
    order: orderWithTracking('TIMEOUT123'),
    fetchImpl: async () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }
  });

  assert.equal(result.available, false);
  assert.equal(result.reason, 'timeout');
  assert.match(result.warnings[0], /timeout/i);
});

test('classifies known provider statuses', () => {
  assert.equal(classifyProviderTrackingStatus('Customs clearance in progress'), 'customs_clearance_in_progress');
  assert.equal(classifyProviderTrackingStatus('Customs clearance completed'), 'customs_clearance_completed');
  assert.equal(classifyProviderTrackingStatus('In transit to final service provider'), 'in_transit_to_final_provider');
  assert.equal(classifyProviderTrackingStatus('Pending receipt at CTT Express'), 'local_pending_receipt');
});

function orderWithTracking(number) {
  return {
    name: '#1234',
    fulfillments: [
      {
        tracking_numbers: [number],
        tracking: [{ number }]
      }
    ]
  };
}
