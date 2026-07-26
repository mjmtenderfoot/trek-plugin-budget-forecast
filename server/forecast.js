'use strict';

/**
 * Forecast calculation engine — computes summary totals across all scenarios.
 * All calculations use trip-currency amounts in minor units.
 */

var money = require('./money');

// Entry type constants
var ENTRY_TYPES = {
  PLANNED_EXPENSE: 'planned_expense',
  ACTUAL_EXPENSE: 'actual_expense',
  CREDIT: 'credit',
  ACCOUNT_PAYMENT: 'account_payment',
};

// Status constants
var STATUSES = {
  CONSIDERING: 'considering',
  ESTIMATED: 'estimated',
  RESERVED: 'reserved',
  COMMITTED: 'committed',
  INCURRED: 'incurred',
  CANCELLED: 'cancelled',
};

// Statuses that count as "active" (not cancelled, not excluded)
var ACTIVE_STATUSES = [
  STATUSES.CONSIDERING,
  STATUSES.ESTIMATED,
  STATUSES.RESERVED,
  STATUSES.COMMITTED,
  STATUSES.INCURRED,
];

// Statuses that count as "committed" (reserved + committed)
var COMMITTED_STATUSES = [STATUSES.RESERVED, STATUSES.COMMITTED];

// Status labels for UI display
var STATUS_LABELS = {};
STATUS_LABELS[STATUSES.CONSIDERING] = 'Considering';
STATUS_LABELS[STATUSES.ESTIMATED] = 'Estimated';
STATUS_LABELS[STATUSES.RESERVED] = 'Reserved';
STATUS_LABELS[STATUSES.COMMITTED] = 'Committed';
STATUS_LABELS[STATUSES.INCURRED] = 'Incurred';
STATUS_LABELS[STATUSES.CANCELLED] = 'Cancelled';

var ENTRY_TYPE_LABELS = {};
ENTRY_TYPE_LABELS[ENTRY_TYPES.PLANNED_EXPENSE] = 'Planned Expense';
ENTRY_TYPE_LABELS[ENTRY_TYPES.ACTUAL_EXPENSE] = 'Actual Expense';
ENTRY_TYPE_LABELS[ENTRY_TYPES.CREDIT] = 'Credit';
ENTRY_TYPE_LABELS[ENTRY_TYPES.ACCOUNT_PAYMENT] = 'Account Payment';

/**
 * Get the trip-currency amount for an entry.
 * Uses frozen trip_amount_minor if available, otherwise the original amount.
 */
function getTripAmount(entry) {
  if (entry.trip_amount_minor != null) return entry.trip_amount_minor;
  return entry.amount_minor;
}

/**
 * Check if an entry is active (not cancelled, not soft-deleted, included in forecast).
 */
function isActive(entry) {
  if (entry.deleted_at) return false;
  if (entry.status === STATUSES.CANCELLED) return false;
  if (entry.include_in_forecast === 0) return false;
  return true;
}

/**
 * Calculate the Actual scenario:
 * Actual net = Actual expenses (incurred) - Actual credits (incurred)
 * Excludes: planned expenses, account payments
 */
function calcActual(entries) {
  var expenses = 0;
  var credits = 0;
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    if (!isActive(e)) continue;
    if (e.status !== STATUSES.INCURRED) continue;
    var amt = getTripAmount(e);
    if (e.entry_type === ENTRY_TYPES.ACTUAL_EXPENSE) {
      expenses = money.add(expenses, amt);
    } else if (e.entry_type === ENTRY_TYPES.CREDIT) {
      credits = money.add(credits, amt);
    }
  }
  return {
    actualExpenses: expenses,
    actualCredits: credits,
    actualNet: money.subtract(expenses, credits),
  };
}

/**
 * Calculate the Committed scenario:
 * Committed = Actual net + Reserved expenses + Committed expenses - Reserved/Committed credits
 */
function calcCommitted(entries) {
  var actual = calcActual(entries);
  var reservedExpenses = 0;
  var committedExpenses = 0;
  var reservedCredits = 0;
  var committedCredits = 0;
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    if (!isActive(e)) continue;
    if (e.status !== STATUSES.RESERVED && e.status !== STATUSES.COMMITTED) continue;
    var amt = getTripAmount(e);
    if (e.entry_type === ENTRY_TYPES.PLANNED_EXPENSE || e.entry_type === ENTRY_TYPES.ACTUAL_EXPENSE) {
      if (e.status === STATUSES.RESERVED) reservedExpenses = money.add(reservedExpenses, amt);
      else committedExpenses = money.add(committedExpenses, amt);
    } else if (e.entry_type === ENTRY_TYPES.CREDIT) {
      if (e.status === STATUSES.RESERVED) reservedCredits = money.add(reservedCredits, amt);
      else committedCredits = money.add(committedCredits, amt);
    }
  }
  var committedForecast = money.add(
    money.add(actual.actualNet, reservedExpenses),
    money.subtract(committedExpenses, money.add(reservedCredits, committedCredits))
  );
  return {
    actual: actual,
    reservedExpenses: reservedExpenses,
    committedExpenses: committedExpenses,
    reservedCredits: reservedCredits,
    committedCredits: committedCredits,
    committedForecast: committedForecast,
  };
}

/**
 * Calculate the Full Forecast scenario:
 * Full = Actual net + All active planned expenses - Forecast credits
 */
function calcFullForecast(entries) {
  var actual = calcActual(entries);
  var plannedExpenses = 0;
  var forecastCredits = 0;
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    if (!isActive(e)) continue;
    if (e.status === STATUSES.INCURRED) continue; // already in actual
    var amt = getTripAmount(e);
    if (e.entry_type === ENTRY_TYPES.PLANNED_EXPENSE || e.entry_type === ENTRY_TYPES.ACTUAL_EXPENSE) {
      plannedExpenses = money.add(plannedExpenses, amt);
    } else if (e.entry_type === ENTRY_TYPES.CREDIT) {
      forecastCredits = money.add(forecastCredits, amt);
    }
  }
  var fullForecast = money.subtract(
    money.add(actual.actualNet, plannedExpenses),
    forecastCredits
  );
  return {
    actual: actual,
    plannedExpenses: plannedExpenses,
    forecastCredits: forecastCredits,
    fullForecast: fullForecast,
  };
}

/**
 * Calculate remaining budget for each scenario.
 * @param {number|null} budgetMinor - Trip budget in minor units
 * @param {object} actual - Result of calcActual
 * @param {object} committed - Result of calcCommitted
 * @param {object} full - Result of calcFullForecast
 */
function calcRemainingBudget(budgetMinor, actual, committed, full) {
  if (budgetMinor == null) return { actual: null, committed: null, full: null };
  return {
    actual: money.subtract(budgetMinor, actual.actualNet),
    committed: money.subtract(budgetMinor, committed.committedForecast),
    full: money.subtract(budgetMinor, full.fullForecast),
  };
}

/**
 * Calculate outstanding balance for a payment account.
 * Outstanding = Actual expenses on account - Actual credits on account - Account payments
 */
function calcAccountBalance(entries, accountId) {
  var expenses = 0;
  var credits = 0;
  var payments = 0;
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    if (e.deleted_at) continue;
    if (e.status === STATUSES.CANCELLED) continue;
    if (e.payment_account_id !== accountId) continue;
    var amt = getTripAmount(e);
    if (e.entry_type === ENTRY_TYPES.ACTUAL_EXPENSE && e.status === STATUSES.INCURRED) {
      expenses = money.add(expenses, amt);
    } else if (e.entry_type === ENTRY_TYPES.CREDIT && e.status === STATUSES.INCURRED) {
      credits = money.add(credits, amt);
    } else if (e.entry_type === ENTRY_TYPES.ACCOUNT_PAYMENT) {
      payments = money.add(payments, amt);
    }
  }
  var current = money.subtract(money.subtract(expenses, credits), payments);

  // Projected: include reserved/committed expenses
  var projExpenses = 0;
  var projCredits = 0;
  for (var j = 0; j < entries.length; j++) {
    var ej = entries[j];
    if (ej.deleted_at) continue;
    if (ej.status === STATUSES.CANCELLED) continue;
    if (ej.payment_account_id !== accountId) continue;
    if (ej.status !== STATUSES.RESERVED && ej.status !== STATUSES.COMMITTED) continue;
    var amtj = getTripAmount(ej);
    if (ej.entry_type === ENTRY_TYPES.PLANNED_EXPENSE || ej.entry_type === ENTRY_TYPES.ACTUAL_EXPENSE) {
      projExpenses = money.add(projExpenses, amtj);
    } else if (ej.entry_type === ENTRY_TYPES.CREDIT) {
      projCredits = money.add(projCredits, amtj);
    }
  }
  var projected = money.subtract(money.add(current, projExpenses), projCredits);

  return { current: current, projected: projected };
}

/**
 * Calculate category budget breakdown.
 */
function calcCategoryBreakdown(entries, categoryBudgets, tripCurrency) {
  var categories = {};
  // Initialize from category budgets
  for (var i = 0; i < categoryBudgets.length; i++) {
    var cb = categoryBudgets[i];
    categories[cb.category_name] = {
      budget: cb.budget_amount_minor,
      actual: 0,
      committed: 0,
      fullForecast: 0,
    };
  }
  // Aggregate entries
  for (var j = 0; j < entries.length; j++) {
    var e = entries[j];
    if (!isActive(e)) continue;
    var cat = e.category_name || 'Other';
    if (!categories[cat]) {
      categories[cat] = { budget: 0, actual: 0, committed: 0, fullForecast: 0 };
    }
    var amt = getTripAmount(e);
    var isCredit = e.entry_type === ENTRY_TYPES.CREDIT;
    var isAccountPayment = e.entry_type === ENTRY_TYPES.ACCOUNT_PAYMENT;
    if (isAccountPayment) continue;

    var effect = isCredit ? -amt : amt;

    if (e.status === STATUSES.INCURRED) {
      categories[cat].actual = money.add(categories[cat].actual, effect);
      categories[cat].committed = money.add(categories[cat].committed, effect);
      categories[cat].fullForecast = money.add(categories[cat].fullForecast, effect);
    } else if (COMMITTED_STATUSES.indexOf(e.status) !== -1) {
      categories[cat].committed = money.add(categories[cat].committed, effect);
      categories[cat].fullForecast = money.add(categories[cat].fullForecast, effect);
    } else {
      categories[cat].fullForecast = money.add(categories[cat].fullForecast, effect);
    }
  }
  // Calculate remaining
  var result = [];
  var keys = Object.keys(categories);
  for (var k = 0; k < keys.length; k++) {
    var name = keys[k];
    var c = categories[name];
    result.push({
      category: name,
      budget: c.budget,
      actual: c.actual,
      committed: c.committed,
      fullForecast: c.fullForecast,
      remaining: money.subtract(c.budget, c.fullForecast),
      percentageUsed: money.percentage(c.fullForecast, c.budget),
      overBudget: c.fullForecast > c.budget,
    });
  }
  return result;
}

/**
 * Calculate variance for a converted entry.
 */
function calcVariance(estimatedMinor, actualMinor) {
  if (estimatedMinor === 0) {
    return { amount: actualMinor, percentage: actualMinor === 0 ? 0 : 100, label: actualMinor === 0 ? 'On estimate' : 'Over estimate' };
  }
  var variance = money.subtract(actualMinor, estimatedMinor);
  var pct = money.percentage(Math.abs(variance), estimatedMinor);
  var label;
  if (variance < 0) label = 'Under estimate';
  else if (variance === 0) label = 'On estimate';
  else label = 'Over estimate';
  return { amount: variance, percentage: pct, label: label };
}

/**
 * Build the full summary object for a trip.
 */
function buildSummary(entries, settings, categoryBudgets, tripCurrency) {
  var actual = calcActual(entries);
  var committed = calcCommitted(entries);
  var full = calcFullForecast(entries);
  var budgetMinor = settings ? settings.budget_amount_minor : null;
  var remaining = calcRemainingBudget(budgetMinor, actual, committed, full);
  var categories = calcCategoryBreakdown(entries, categoryBudgets, tripCurrency);

  return {
    budget: budgetMinor,
    budgetCurrency: settings ? settings.budget_currency : tripCurrency,
    actual: actual,
    committed: {
      reservedExpenses: committed.reservedExpenses,
      committedExpenses: committed.committedExpenses,
      forecast: committed.committedForecast,
    },
    fullForecast: {
      plannedExpenses: full.plannedExpenses,
      forecastCredits: full.forecastCredits,
      forecast: full.fullForecast,
    },
    remaining: remaining,
    categories: categories,
  };
}

module.exports = {
  ENTRY_TYPES: ENTRY_TYPES,
  STATUSES: STATUSES,
  ACTIVE_STATUSES: ACTIVE_STATUSES,
  COMMITTED_STATUSES: COMMITTED_STATUSES,
  STATUS_LABELS: STATUS_LABELS,
  ENTRY_TYPE_LABELS: ENTRY_TYPE_LABELS,
  getTripAmount: getTripAmount,
  isActive: isActive,
  calcActual: calcActual,
  calcCommitted: calcCommitted,
  calcFullForecast: calcFullForecast,
  calcRemainingBudget: calcRemainingBudget,
  calcAccountBalance: calcAccountBalance,
  calcCategoryBreakdown: calcCategoryBreakdown,
  calcVariance: calcVariance,
  buildSummary: buildSummary,
};