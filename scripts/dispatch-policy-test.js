'use strict';

const assert = require('node:assert/strict');
const {
  PORTO_NOVO_TIME_ZONE,
  validatePortoNovoTimeWindow,
  validateServiceDuration,
  evaluateCapacity,
  findScheduleOverlaps,
  createDispatchProposal,
  recordHumanDispatchDecision,
} = require('../lib/dispatch-policy');

function codes(check) {
  return check.errors.map((entry) => entry.code);
}

function run() {
  testPortoNovoTimeWindow();
  testServiceDuration();
  testCapacityDimensions();
  testHalfOpenOverlaps();
  testHumanConfirmableProposal();
  testBlockedProposals();
  testNoPerformanceSanctionOrFalseEta();
  process.stdout.write('Tests politique d’affectation réussis : créneaux Porto-Novo, service, capacité, chevauchements et confirmation humaine.\n');
}

function testPortoNovoTimeWindow() {
  const valid = validatePortoNovoTimeWindow({
    timeZone: PORTO_NOVO_TIME_ZONE,
    startLocal: '2026-09-15T09:00',
    endLocal: '2026-09-15T11:30',
  }, {
    now: '2026-09-15T06:00:00Z',
    minLeadMinutes: 60,
  });
  assert.equal(valid.valid, true);
  assert.deepEqual(valid.value, {
    timeZone: PORTO_NOVO_TIME_ZONE,
    startLocal: '2026-09-15T09:00',
    endLocal: '2026-09-15T11:30',
    startAt: '2026-09-15T08:00:00.000Z',
    endAt: '2026-09-15T10:30:00.000Z',
    durationMinutes: 150,
  });

  const invalidDate = validatePortoNovoTimeWindow({
    startLocal: '2026-02-30T09:00',
    endLocal: '2026-02-30T10:00',
  });
  assert.equal(invalidDate.valid, false);
  assert.equal(codes(invalidDate).includes('invalid_local_datetime'), true);

  const wrongZone = validatePortoNovoTimeWindow({
    timeZone: 'UTC',
    startLocal: '2026-09-15T09:00',
    endLocal: '2026-09-15T10:00',
  });
  assert.equal(codes(wrongZone).includes('unsupported_time_zone'), true);

  const reversed = validatePortoNovoTimeWindow({
    startLocal: '2026-09-15T10:00',
    endLocal: '2026-09-15T09:00',
  });
  assert.equal(codes(reversed).includes('window_end_not_after_start'), true);

  const tooEarly = validatePortoNovoTimeWindow({
    startLocal: '2026-09-15T09:00',
    endLocal: '2026-09-15T10:00',
  }, { now: '2026-09-15T07:30:00Z', minLeadMinutes: 60 });
  assert.equal(codes(tooEarly).includes('window_starts_too_early'), true);
}

function testServiceDuration() {
  assert.deepEqual(validateServiceDuration(20).value, { minutes: 20 });
  assert.equal(codes(validateServiceDuration(2.5)).includes('service_duration_must_be_integer'), true);
  assert.equal(codes(validateServiceDuration(0)).includes('service_duration_too_short'), true);
  assert.equal(codes(validateServiceDuration(481)).includes('service_duration_too_long'), true);
}

function testCapacityDimensions() {
  const input = {
    limits: { parcelCount: 5, weightKg: 100 },
    currentLoad: { parcelCount: 2, weightKg: 40 },
    additionalLoad: { parcelCount: 2, weightKg: 30 },
  };
  const snapshot = JSON.stringify(input);
  const feasible = evaluateCapacity(input);
  assert.equal(feasible.valid, true);
  assert.equal(feasible.feasible, true);
  assert.equal(feasible.dimensions.parcelCount.remainingAfter, 1);
  assert.equal(feasible.dimensions.weightKg.projected, 70);
  assert.equal(JSON.stringify(input), snapshot, 'La fonction ne doit pas modifier son entrée.');

  const exceeded = evaluateCapacity({
    limits: { parcelCount: 3, weightKg: 50 },
    currentLoad: { parcelCount: 2, weightKg: 40 },
    additionalLoad: { parcelCount: 2, weightKg: 5 },
  });
  assert.equal(exceeded.valid, true);
  assert.equal(exceeded.feasible, false);
  assert.equal(exceeded.violations[0].code, 'additional_load_exceeds_capacity');
  assert.equal(exceeded.dimensions.parcelCount.overBy, 1);

  const undeclared = evaluateCapacity({
    limits: { parcelCount: 3 },
    currentLoad: {},
    additionalLoad: { weightKg: 10 },
  });
  assert.equal(undeclared.valid, false);
  assert.equal(codes(undeclared).includes('capacity_limit_missing'), true);

  const sumOutOfRange = evaluateCapacity({
    limits: { weightKg: 1_000_000_000_000 },
    currentLoad: { weightKg: 999_999_999_999 },
    additionalLoad: { weightKg: 2 },
  });
  assert.equal(sumOutOfRange.valid, false);
  assert.equal(codes(sumOutOfRange).includes('capacity_sum_out_of_range'), true);
}

function testHalfOpenOverlaps() {
  const adjacent = findScheduleOverlaps({
    id: 'candidate',
    startAt: '2026-09-15T09:00:00Z',
    endAt: '2026-09-15T09:30:00Z',
  }, [{
    id: 'next',
    startAt: '2026-09-15T09:30:00Z',
    endAt: '2026-09-15T10:00:00Z',
  }]);
  assert.equal(adjacent.hasOverlap, false);

  const overlapping = findScheduleOverlaps({
    id: 'candidate',
    startAt: '2026-09-15T09:00:00Z',
    endAt: '2026-09-15T09:30:00Z',
  }, [
    {
      id: 'existing',
      startAt: '2026-09-15T09:20:00Z',
      endAt: '2026-09-15T09:45:00Z',
    },
    {
      id: 'candidate',
      startAt: '2026-09-15T09:00:00Z',
      endAt: '2026-09-15T09:30:00Z',
    },
  ]);
  assert.equal(overlapping.valid, true);
  assert.equal(overlapping.hasOverlap, true);
  assert.equal(overlapping.overlaps.length, 1, 'Une réservation portant le même id doit être ignorée.');
  assert.equal(overlapping.overlaps[0].overlapMinutes, 10);

  const ambiguous = findScheduleOverlaps({
    startAt: '2026-09-15T09:00',
    endAt: '2026-09-15T09:30',
  });
  assert.equal(ambiguous.valid, false);
  assert.equal(codes(ambiguous).includes('absolute_instant_required'), true);

  const impossibleDate = findScheduleOverlaps({
    startAt: '2026-02-30T09:00:00Z',
    endAt: '2026-02-30T09:30:00Z',
  });
  assert.equal(impossibleDate.valid, false);
  assert.equal(codes(impossibleDate).includes('invalid_absolute_instant'), true);
}

function validProposalInput() {
  return {
    orderId: 'order-17',
    driverId: 'driver-4',
    reservationId: 'reservation-order-17',
    window: {
      timeZone: PORTO_NOVO_TIME_ZONE,
      startLocal: '2026-09-15T09:00',
      endLocal: '2026-09-15T11:00',
    },
    serviceMinutes: 20,
    plannedStartAt: '2026-09-15T08:30:00Z',
    capacity: {
      limits: { parcelCount: 5, weightKg: 100 },
      currentLoad: { parcelCount: 2, weightKg: 40 },
      additionalLoad: { parcelCount: 1, weightKg: 20 },
    },
    existingReservations: [{
      id: 'earlier-order',
      startAt: '2026-09-15T07:30:00Z',
      endAt: '2026-09-15T08:00:00Z',
    }],
  };
}

function testHumanConfirmableProposal() {
  const input = validProposalInput();
  const snapshot = JSON.stringify(input);
  const proposal = createDispatchProposal(input);
  const sameProposal = createDispatchProposal(JSON.parse(snapshot));
  assert.equal(proposal.confirmable, true);
  assert.equal(proposal.status, 'ready_for_human_confirmation');
  assert.equal(proposal.autoAssign, false);
  assert.equal(proposal.proposalId, sameProposal.proposalId, 'L’identifiant doit être déterministe.');
  assert.equal(JSON.stringify(input), snapshot, 'La proposition ne doit pas modifier ses entrées.');

  const approved = recordHumanDispatchDecision(proposal, {
    expectedProposalId: proposal.proposalId,
    decision: 'approve',
    actorId: 'operator-8',
    decidedAt: '2026-09-15T07:55:00Z',
  });
  assert.equal(approved.valid, true);
  assert.deepEqual(approved.value, {
    proposalId: proposal.proposalId,
    decision: 'approve',
    actorId: 'operator-8',
    decidedAt: '2026-09-15T07:55:00.000Z',
    reason: null,
    assignmentAuthorized: true,
    persistencePerformed: false,
  });

  const stale = recordHumanDispatchDecision(proposal, {
    expectedProposalId: 'dp_outdated',
    decision: 'approve',
    actorId: 'operator-8',
    decidedAt: '2026-09-15T07:55:00Z',
  });
  assert.equal(stale.valid, false);
  assert.equal(codes(stale).includes('stale_proposal'), true);
}

function testBlockedProposals() {
  const overlapInput = validProposalInput();
  overlapInput.existingReservations.push({
    id: 'conflict',
    startAt: '2026-09-15T08:35:00Z',
    endAt: '2026-09-15T09:00:00Z',
  });
  const overlapProposal = createDispatchProposal(overlapInput);
  assert.equal(overlapProposal.confirmable, false);
  assert.equal(codes(overlapProposal).includes('planned_service_overlaps_existing'), true);

  const blockedApproval = recordHumanDispatchDecision(overlapProposal, {
    expectedProposalId: overlapProposal.proposalId,
    decision: 'approve',
    actorId: 'operator-8',
    decidedAt: '2026-09-15T07:55:00Z',
  });
  assert.equal(codes(blockedApproval).includes('blocked_proposal_cannot_be_approved'), true);

  const capacityInput = validProposalInput();
  capacityInput.capacity.additionalLoad.parcelCount = 4;
  const capacityProposal = createDispatchProposal(capacityInput);
  assert.equal(capacityProposal.confirmable, false);
  assert.equal(codes(capacityProposal).includes('additional_load_exceeds_capacity'), true);

  const outsideInput = validProposalInput();
  outsideInput.plannedStartAt = '2026-09-15T10:50:00Z';
  const outsideProposal = createDispatchProposal(outsideInput);
  assert.equal(outsideProposal.confirmable, false);
  assert.equal(codes(outsideProposal).includes('planned_service_ends_after_window'), true);

  const rejectedWithoutReason = recordHumanDispatchDecision(overlapProposal, {
    expectedProposalId: overlapProposal.proposalId,
    decision: 'reject',
    actorId: 'operator-8',
    decidedAt: '2026-09-15T07:55:00Z',
  });
  assert.equal(codes(rejectedWithoutReason).includes('decision_reason_required'), true);

  const rejectedWithReason = recordHumanDispatchDecision(overlapProposal, {
    expectedProposalId: overlapProposal.proposalId,
    decision: 'reject',
    actorId: 'operator-8',
    decidedAt: '2026-09-15T07:55:00Z',
    reason: 'Conflit de réservation à revoir avec le dispatch.',
  });
  assert.equal(rejectedWithReason.valid, true);
  assert.equal(rejectedWithReason.value.assignmentAuthorized, false);
  assert.equal(rejectedWithReason.value.persistencePerformed, false);
}

function testNoPerformanceSanctionOrFalseEta() {
  const baseline = validProposalInput();
  const withMetrics = {
    ...validProposalInput(),
    driverMetrics: {
      lateDeliveries: 999,
      incidents: 999,
      arbitraryScore: -100,
    },
  };
  const first = createDispatchProposal(baseline);
  const second = createDispatchProposal(withMetrics);
  assert.equal(first.proposalId, second.proposalId, 'Les métriques de performance ne doivent pas influencer la décision.');
  assert.equal(second.confirmable, true);
  assert.equal(Object.hasOwn(second, 'eta'), false);
  assert.equal(JSON.stringify(second).toLowerCase().includes('eta'), false);
  assert.equal(second.exclusions.includes('driver_performance_not_evaluated'), true);
}

run();
