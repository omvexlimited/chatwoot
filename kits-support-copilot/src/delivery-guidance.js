export function buildDeliveryTimingGuidance(estimate = {}) {
  if (!hasReliableEstimate(estimate)) {
    return unusableGuidance(estimate, estimate?.reason || 'unreliable_delivery_estimate');
  }

  if (estimate.delivered_at) {
    return unusableGuidance(estimate, 'already_delivered');
  }

  const avgTransitDays = numberOrNull(estimate.avg_transit_days);
  const elapsedDays = numberOrNull(estimate.days_since_fulfillment);
  const remainingDays = numberOrNull(estimate.estimated_remaining_days);
  if (avgTransitDays === null || elapsedDays === null || remainingDays === null) {
    return unusableGuidance(estimate, 'missing_timing_fields');
  }

  const tone = timingTone({ avgTransitDays, elapsedDays, remainingDays });
  return {
    usable: true,
    tone,
    carrier: estimate.carrier || 'the carrier',
    confidence: estimate.confidence,
    avg_transit_days: avgTransitDays,
    elapsed_days: elapsedDays,
    estimated_remaining_days: remainingDays,
    internal_only_exact_values: true,
    customer_guidance: customerGuidance({
      tone,
      carrier: estimate.carrier || 'the carrier'
    })
  };
}

function hasReliableEstimate(estimate = {}) {
  return estimate?.available === true && ['high', 'medium'].includes(estimate?.confidence);
}

function timingTone({ avgTransitDays, elapsedDays, remainingDays }) {
  if (elapsedDays > avgTransitDays) return 'over_average';
  if (remainingDays <= 1 || elapsedDays >= avgTransitDays * 0.85) return 'near_average';
  return 'early';
}

function customerGuidance({ tone, carrier }) {
  if (tone === 'over_average') {
    return `This is taking a little longer than our recent ${carrier} average, but the tracking will update automatically once the parcel is handed over.`;
  }
  if (tone === 'near_average') {
    return `Based on our recent ${carrier} shipments, this stage usually updates around this point after dispatch, so the tracking should update soon once customs clearance is completed.`;
  }
  return `This is still within the usual recent timing we see for ${carrier} shipments.`;
}

function unusableGuidance(estimate = {}, reason) {
  return {
    usable: false,
    tone: 'unusable',
    reason,
    carrier: estimate?.carrier || null,
    confidence: estimate?.confidence || null
  };
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
