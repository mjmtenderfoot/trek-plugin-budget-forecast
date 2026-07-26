'use strict';

var assert = require('assert');
var test = require('node:test');
var forecast = require('../server/forecast');

function makeEntry(overrides) {
  return Object.assign({
    id: 'test-id',
    trip_id: '1',
    entry_type: 'planned_expense',
    status: 'considering',
    name: 'Test Entry',
    amount_minor: 10000,
    currency: 'USD',
    trip_amount_minor: 10000,
    include_in_forecast: 1,
    deleted_at: null,
  }, overrides);
}

test('calcActual only counts incurred expenses and credits', function() {
  var entries = [
    makeEntry({ entry_type: 'actual_expense', status: 'incurred', amount_minor: 50000, trip_amount_minor: 50000 }),
    makeEntry({ entry_type: 'actual_expense', status: 'incurred', amount_minor: 30000, trip_amount_minor: 30000 }),
    makeEntry({ entry_type: 'credit', status: 'incurred', amount_minor: 10000, trip_amount_minor: 10000 }),
    makeEntry({ entry_type: 'planned_expense', status: 'considering', amount_minor: 20000, trip_amount_minor: 20000 }),
    makeEntry({ entry_type: 'account_payment', status: 'incurred', amount_minor: 5000, trip_amount_minor: 5000 }),
  ];
  var result = forecast.calcActual(entries);
  assert.strictEqual(result.actualExpenses, 80000);
  assert.strictEqual(result.actualCredits, 10000);
  assert.strictEqual(result.actualNet, 70000);
});

test('calcActual excludes cancelled entries', function() {
  var entries = [
    makeEntry({ entry_type: 'actual_expense', status: 'incurred', amount_minor: 50000, trip_amount_minor: 50000 }),
    makeEntry({ entry_type: 'actual_expense', status: 'cancelled', amount_minor: 30000, trip_amount_minor: 30000 }),
  ];
  var result = forecast.calcActual(entries);
  assert.strictEqual(result.actualExpenses, 50000);
});

test('calcActual excludes entries with include_in_forecast=0', function() {
  var entries = [
    makeEntry({ entry_type: 'actual_expense', status: 'incurred', amount_minor: 50000, trip_amount_minor: 50000 }),
    makeEntry({ entry_type: 'actual_expense', status: 'incurred', amount_minor: 30000, trip_amount_minor: 30000, include_in_forecast: 0 }),
  ];
  var result = forecast.calcActual(entries);
  assert.strictEqual(result.actualExpenses, 50000);
});

test('calcCommitted includes reserved and committed expenses', function() {
  var entries = [
    makeEntry({ entry_type: 'actual_expense', status: 'incurred', amount_minor: 50000, trip_amount_minor: 50000 }),
    makeEntry({ entry_type: 'planned_expense', status: 'reserved', amount_minor: 20000, trip_amount_minor: 20000 }),
    makeEntry({ entry_type: 'planned_expense', status: 'committed', amount_minor: 15000, trip_amount_minor: 15000 }),
    makeEntry({ entry_type: 'planned_expense', status: 'considering', amount_minor: 10000, trip_amount_minor: 10000 }),
  ];
  var result = forecast.calcCommitted(entries);
  assert.strictEqual(result.reservedExpenses, 20000);
  assert.strictEqual(result.committedExpenses, 15000);
  assert.strictEqual(result.committedForecast, 85000); // 50000 + 20000 + 15000
});

test('calcFullForecast includes all active planned expenses', function() {
  var entries = [
    makeEntry({ entry_type: 'actual_expense', status: 'incurred', amount_minor: 50000, trip_amount_minor: 50000 }),
    makeEntry({ entry_type: 'planned_expense', status: 'reserved', amount_minor: 20000, trip_amount_minor: 20000 }),
    makeEntry({ entry_type: 'planned_expense', status: 'considering', amount_minor: 10000, trip_amount_minor: 10000 }),
    makeEntry({ entry_type: 'credit', status: 'considering', amount_minor: 5000, trip_amount_minor: 5000 }),
  ];
  var result = forecast.calcFullForecast(entries);
  assert.strictEqual(result.plannedExpenses, 30000);
  assert.strictEqual(result.forecastCredits, 5000);
  assert.strictEqual(result.fullForecast, 75000); // 50000 + 30000 - 5000
});

test('calcRemainingBudget returns null when no budget set', function() {
  var actual = { actualNet: 50000 };
  var committed = { committedForecast: 70000 };
  var full = { fullForecast: 90000 };
  var result = forecast.calcRemainingBudget(null, actual, committed, full);
  assert.strictEqual(result.actual, null);
  assert.strictEqual(result.committed, null);
  assert.strictEqual(result.full, null);
});

test('calcRemainingBudget calculates correctly', function() {
  var actual = { actualNet: 50000 };
  var committed = { committedForecast: 70000 };
  var full = { fullForecast: 90000 };
  var result = forecast.calcRemainingBudget(100000, actual, committed, full);
  assert.strictEqual(result.actual, 50000);
  assert.strictEqual(result.committed, 30000);
  assert.strictEqual(result.full, 10000);
});

test('calcRemainingBudget can go negative (over budget)', function() {
  var actual = { actualNet: 120000 };
  var committed = { committedForecast: 120000 };
  var full = { fullForecast: 120000 };
  var result = forecast.calcRemainingBudget(100000, actual, committed, full);
  assert.strictEqual(result.actual, -20000);
});

test('calcAccountBalance: actual expense increases outstanding', function() {
  var entries = [
    makeEntry({ entry_type: 'actual_expense', status: 'incurred', payment_account_id: 'acct1', amount_minor: 50000, trip_amount_minor: 50000 }),
  ];
  var result = forecast.calcAccountBalance(entries, 'acct1');
  assert.strictEqual(result.current, 50000);
});

test('calcAccountBalance: refund reduces outstanding', function() {
  var entries = [
    makeEntry({ entry_type: 'actual_expense', status: 'incurred', payment_account_id: 'acct1', amount_minor: 50000, trip_amount_minor: 50000 }),
    makeEntry({ entry_type: 'credit', status: 'incurred', payment_account_id: 'acct1', amount_minor: 10000, trip_amount_minor: 10000 }),
  ];
  var result = forecast.calcAccountBalance(entries, 'acct1');
  assert.strictEqual(result.current, 40000);
});

test('calcAccountBalance: account payment reduces outstanding', function() {
  var entries = [
    makeEntry({ entry_type: 'actual_expense', status: 'incurred', payment_account_id: 'acct1', amount_minor: 50000, trip_amount_minor: 50000 }),
    makeEntry({ entry_type: 'account_payment', status: 'incurred', payment_account_id: 'acct1', amount_minor: 20000, trip_amount_minor: 20000 }),
  ];
  var result = forecast.calcAccountBalance(entries, 'acct1');
  assert.strictEqual(result.current, 30000);
});

test('calcAccountBalance: planned expense affects projected but not current', function() {
  var entries = [
    makeEntry({ entry_type: 'actual_expense', status: 'incurred', payment_account_id: 'acct1', amount_minor: 50000, trip_amount_minor: 50000 }),
    makeEntry({ entry_type: 'planned_expense', status: 'committed', payment_account_id: 'acct1', amount_minor: 20000, trip_amount_minor: 20000 }),
  ];
  var result = forecast.calcAccountBalance(entries, 'acct1');
  assert.strictEqual(result.current, 50000);
  assert.strictEqual(result.projected, 70000);
});

test('calcVariance: under estimate', function() {
  var result = forecast.calcVariance(10000, 8000);
  assert.strictEqual(result.amount, -2000);
  assert.strictEqual(result.label, 'Under estimate');
  assert.strictEqual(result.percentage, 20);
});

test('calcVariance: over estimate', function() {
  var result = forecast.calcVariance(10000, 12000);
  assert.strictEqual(result.amount, 2000);
  assert.strictEqual(result.label, 'Over estimate');
  assert.strictEqual(result.percentage, 20);
});

test('calcVariance: on estimate', function() {
  var result = forecast.calcVariance(10000, 10000);
  assert.strictEqual(result.amount, 0);
  assert.strictEqual(result.label, 'On estimate');
});

test('calcVariance: zero estimate', function() {
  var result = forecast.calcVariance(0, 5000);
  assert.strictEqual(result.amount, 5000);
  assert.strictEqual(result.label, 'Over estimate');
});

test('calcVariance: both zero', function() {
  var result = forecast.calcVariance(0, 0);
  assert.strictEqual(result.amount, 0);
  assert.strictEqual(result.label, 'On estimate');
});

test('isActive returns false for cancelled entries', function() {
  assert.strictEqual(forecast.isActive(makeEntry({ status: 'cancelled' })), false);
});

test('isActive returns false for deleted entries', function() {
  assert.strictEqual(forecast.isActive(makeEntry({ deleted_at: '2024-01-01' })), false);
});

test('isActive returns false for excluded entries', function() {
  assert.strictEqual(forecast.isActive(makeEntry({ include_in_forecast: 0 })), false);
});

test('isActive returns true for valid entries', function() {
  assert.strictEqual(forecast.isActive(makeEntry()), true);
});

test('account payment excluded from trip spending totals', function() {
  var entries = [
    makeEntry({ entry_type: 'actual_expense', status: 'incurred', amount_minor: 50000, trip_amount_minor: 50000 }),
    makeEntry({ entry_type: 'account_payment', status: 'incurred', amount_minor: 50000, trip_amount_minor: 50000 }),
  ];
  var actual = forecast.calcActual(entries);
  assert.strictEqual(actual.actualExpenses, 50000);
  assert.strictEqual(actual.actualNet, 50000);
});

test('buildSummary returns complete summary', function() {
  var entries = [
    makeEntry({ entry_type: 'actual_expense', status: 'incurred', amount_minor: 50000, trip_amount_minor: 50000 }),
    makeEntry({ entry_type: 'planned_expense', status: 'considering', amount_minor: 20000, trip_amount_minor: 20000 }),
  ];
  var settings = { budget_amount_minor: 100000, budget_currency: 'USD' };
  var categoryBudgets = [];
  var summary = forecast.buildSummary(entries, settings, categoryBudgets, 'USD');
  assert.strictEqual(summary.budget, 100000);
  assert.strictEqual(summary.actual.actualExpenses, 50000);
  assert.strictEqual(summary.fullForecast.plannedExpenses, 20000);
  assert.strictEqual(summary.remaining.actual, 50000);
});