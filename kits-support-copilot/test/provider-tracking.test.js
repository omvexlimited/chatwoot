import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyProviderTrackingStatus,
  getProviderTrackingContext,
  parseKits17TrackShipment,
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

const KITS_17TRACK_SHIPMENT = {
  code: 200,
  number: 'ZP13628760901',
  shipment: {
    shipping_info: {
      recipient_address: { country: 'GB' }
    },
    latest_status: {
      status: 'InTransit',
      sub_status: 'InTransit_CustomsReleased'
    },
    latest_event: {
      time_utc: '2026-06-18T10:27:15Z',
      description: '出口清关完成【郑州】',
      location: '郑州',
      sub_status: 'InTransit_CustomsReleased',
      address: { city: '郑州' }
    },
    misc_info: {
      reference_number: null
    },
    tracking: {
      providers: [
        {
          provider: { name: 'China Post' },
          events: [
            {
              time_utc: '2026-06-18T10:27:15Z',
              description: '出口清关完成【郑州】',
              location: '郑州',
              sub_status: 'InTransit_CustomsReleased',
              address: { city: '郑州' }
            },
            {
              time_utc: '2026-06-18T06:40:15Z',
              description: '邮件到达始发地海关【郑州】，等待清关',
              location: '郑州',
              sub_status: 'InTransit_Other',
              address: { city: '郑州' }
            },
            {
              time_utc: '2026-06-17T00:44:37Z',
              description: '邮件离开【平阳县国际揽投部】，正在发往【温州国际】',
              location: '温州市 32540020',
              sub_status: 'InTransit_Other',
              address: { city: '温州市', postal_code: '32540020' }
            },
            {
              time_utc: '2026-06-17T00:44:33Z',
              description: '邮件已在【平阳县国际揽投部】完成分拣，准备发出',
              location: '温州市 32540020',
              sub_status: 'InTransit_Other',
              address: { city: '温州市', postal_code: '32540020' }
            },
            {
              time_utc: '2026-06-16T18:06:52Z',
              description: '中国邮政已收取邮件',
              location: '温州市 32540020',
              sub_status: null,
              address: { city: '温州市', postal_code: '32540020' }
            }
          ]
        }
      ]
    }
  }
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

test('parses Kits 17TRACK shipment with translated events and customs status', () => {
  const result = parseKits17TrackShipment(KITS_17TRACK_SHIPMENT, {
    trackingNumber: 'ZP13628760901',
    info: { destCountry: 'GB' }
  });

  assert.equal(result.country, 'GB');
  assert.equal(result.last_update_at, '2026-06-18 10:27:15 UTC');
  assert.equal(result.last_record, 'Zhengzhou, export customs clearance completed [Zhengzhou]');
  assert.equal(result.normalized_status, 'customs_clearance_completed');
  assert.equal(result.customs_status, 'customs_clearance_completed');
  assert.equal(result.timeline.length, 5);
  assert.match(result.timeline[1].record, /waiting for customs clearance/);
  assert.match(result.timeline[2].record, /Wenzhou International/);
});

test('provider 3 lookup uses Kits 17TRACK public tracking API', async () => {
  const calls = [];
  const result = await getProviderTrackingContext({
    provider: { id: 3, label: '3 - Miss-huang · miss-huang' },
    order: orderWithTracking('ZP13628760901'),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url === 'https://shopify.17track.net/trackcenterapi/call') {
        return {
          ok: true,
          json: async () => ({
            Code: 0,
            Json: {
              info: {
                no: 'ZP13628760901',
                fc: 3011,
                sc: 0,
                g: '2820544b-fdde-4bb6-96e7-ef32aada5e9f',
                destCountry: 'GB'
              }
            }
          })
        };
      }

      return {
        ok: true,
        json: async () => ({
          meta: { code: 200 },
          shipments: [KITS_17TRACK_SHIPMENT]
        })
      };
    }
  });

  assert.equal(calls[0].url, 'https://shopify.17track.net/trackcenterapi/call');
  assert.equal(calls[1].url, 'https://shopify-t.17track.net/track/shopify');
  assert.equal(JSON.parse(calls[0].options.body).Param.track_no, 'ZP13628760901');
  assert.equal(JSON.parse(calls[1].options.body).data[0].num, 'ZP13628760901');
  assert.equal(result.available, true);
  assert.equal(result.source, 'kits_17track');
  assert.equal(result.provider_name, 'Miss-huang');
  assert.equal(result.provider_portal_number, 3);
  assert.equal(result.last_record, 'Zhengzhou, export customs clearance completed [Zhengzhou]');
  assert.equal(result.customs_status, 'customs_clearance_completed');
});

test('unsupported provider returns non-blocking warning without fetching', async () => {
  let called = false;
  const result = await getProviderTrackingContext({
    provider: { id: 9 },
    order: orderWithTracking('NOPE123'),
    fetchImpl: async () => {
      called = true;
    }
  });

  assert.equal(called, false);
  assert.equal(result.available, false);
  assert.equal(result.reason, 'provider_not_supported');
  assert.match(result.warnings[0], /not configured for provider 9/i);
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
  assert.equal(classifyProviderTrackingStatus('waiting for customs clearance'), 'customs_clearance_in_progress');
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
