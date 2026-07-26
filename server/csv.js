'use strict';

/**
 * CSV export utility — spreadsheet-safe escaping with formula injection prevention.
 */

var money = require('./money');
var forecast = require('./forecast');

// Characters that could trigger formula injection in spreadsheet apps
var FORMULA_PREFIXES = ['=', '+', '-', '@'];

/**
 * Escape a cell value for CSV output.
 * Prevents formula injection by prefixing dangerous cells with a single quote.
 */
function escapeCell(value) {
  if (value == null) return '';
  var str = String(value);
  // Prevent formula injection
  if (str.length > 0 && FORMULA_PREFIXES.indexOf(str[0]) !== -1) {
    str = "'" + str;
  }
  // Escape double quotes and wrap in quotes if contains comma, newline, or quote
  if (str.indexOf('"') !== -1 || str.indexOf(',') !== -1 || str.indexOf('\n') !== -1) {
    str = '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

/**
 * Build a CSV row from an array of values.
 */
function buildRow(values) {
  return values.map(escapeCell).join(',');
}

/**
 * Export forecast entries as CSV.
 */
function exportEntries(entries, tripCurrency) {
  var headers = [
    'Name', 'Type', 'Status', 'Category', 'Original Amount', 'Original Currency',
    'Trip Amount', 'Expected Date', 'Actual Date', 'Payment Account',
    'Reservation ID', 'Native Cost ID', 'Included in Forecast', 'Merchant',
    'Confirmation/Reference', 'Notes', 'Created', 'Updated',
  ];
  var rows = [buildRow(headers)];

  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    var typeLabel = forecast.ENTRY_TYPE_LABELS[e.entry_type] || e.entry_type;
    var statusLabel = forecast.STATUS_LABELS[e.status] || e.status;
    var originalAmt = money.fromMinor(e.amount_minor, e.currency);
    var tripAmt = e.trip_amount_minor != null ? money.fromMinor(e.trip_amount_minor, tripCurrency) : '';
    var signedEffect = '';
    if (e.entry_type === forecast.ENTRY_TYPES.CREDIT) {
      signedEffect = '-' + money.fromMinor(e.trip_amount_minor || e.amount_minor, tripCurrency);
    } else if (e.entry_type !== forecast.ENTRY_TYPES.ACCOUNT_PAYMENT) {
      signedEffect = money.fromMinor(e.trip_amount_minor || e.amount_minor, tripCurrency);
    }

    rows.push(buildRow([
      e.name,
      typeLabel,
      statusLabel,
      e.category_name || '',
      originalAmt,
      e.currency,
      tripAmt,
      e.expected_date || '',
      e.actual_date || '',
      e.payment_account_id || '',
      e.reservation_id || '',
      e.native_cost_id || '',
      e.include_in_forecast ? 'Yes' : 'No',
      e.merchant || '',
      e.confirmation_reference || '',
      e.notes || '',
      e.created_at || '',
      e.updated_at || '',
    ]));
  }

  return rows.join('\n');
}

/**
 * Export payment accounts as CSV.
 */
function exportAccounts(accounts, entries, tripCurrency) {
  var headers = [
    'Name', 'Type', 'Currency', 'Last Four', 'Credit Limit',
    'Current Outstanding', 'Projected Outstanding', 'Remaining Credit',
    'Active', 'Notes',
  ];
  var rows = [buildRow(headers)];

  for (var i = 0; i < accounts.length; i++) {
    var a = accounts[i];
    var balance = forecast.calcAccountBalance(entries, a.id);
    var creditLimit = a.credit_limit_minor != null ? money.fromMinor(a.credit_limit_minor, a.currency) : '';
    var remaining = a.credit_limit_minor != null
      ? money.fromMinor(Math.max(0, a.credit_limit_minor - balance.current), a.currency)
      : '';

    rows.push(buildRow([
      a.name,
      a.account_type,
      a.currency,
      a.last_four || '',
      creditLimit,
      money.fromMinor(balance.current, a.currency),
      money.fromMinor(balance.projected, a.currency),
      remaining,
      a.active ? 'Yes' : 'No',
      a.notes || '',
    ]));
  }

  return rows.join('\n');
}

/**
 * Export category budgets as CSV.
 */
function exportCategoryBudgets(breakdown, tripCurrency) {
  var headers = ['Category', 'Budget', 'Actual', 'Committed', 'Full Forecast', 'Remaining', 'Percentage Used', 'Over Budget'];
  var rows = [buildRow(headers)];

  for (var i = 0; i < breakdown.length; i++) {
    var c = breakdown[i];
    rows.push(buildRow([
      c.category,
      money.fromMinor(c.budget, tripCurrency),
      money.fromMinor(c.actual, tripCurrency),
      money.fromMinor(c.committed, tripCurrency),
      money.fromMinor(c.fullForecast, tripCurrency),
      money.fromMinor(c.remaining, tripCurrency),
      c.percentageUsed + '%',
      c.overBudget ? 'Yes' : 'No',
    ]));
  }

  return rows.join('\n');
}

module.exports = {
  escapeCell: escapeCell,
  buildRow: buildRow,
  exportEntries: exportEntries,
  exportAccounts: exportAccounts,
  exportCategoryBudgets: exportCategoryBudgets,
};