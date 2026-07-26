'use strict';

/**
 * Database layer — migrations and query helpers for the Budget Forecast plugin.
 * Uses ctx.db (plugin-owned SQLite) with idempotent migrations.
 */

const MIGRATIONS = [
  {
    id: '001_forecast_settings',
    sql: `CREATE TABLE IF NOT EXISTS forecast_settings (
      trip_id TEXT PRIMARY KEY,
      budget_amount_minor INTEGER,
      budget_currency TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  },
  {
    id: '002_forecast_entries',
    sql: `CREATE TABLE IF NOT EXISTS forecast_entries (
      id TEXT PRIMARY KEY,
      trip_id TEXT NOT NULL,
      entry_type TEXT NOT NULL,
      status TEXT NOT NULL,
      name TEXT NOT NULL,
      category_id TEXT,
      category_name TEXT,
      amount_minor INTEGER NOT NULL,
      currency TEXT NOT NULL,
      trip_amount_minor INTEGER,
      frozen_exchange_rate TEXT,
      rate_date TEXT,
      rate_source TEXT,
      expected_date TEXT,
      actual_date TEXT,
      merchant TEXT,
      payment_account_id TEXT,
      reservation_id TEXT,
      native_cost_id TEXT,
      related_entry_id TEXT,
      confirmation_reference TEXT,
      notes TEXT,
      include_in_forecast INTEGER NOT NULL DEFAULT 1,
      persons INTEGER,
      days INTEGER,
      created_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )`,
  },
  {
    id: '003_forecast_entries_indexes',
    sql: `CREATE INDEX IF NOT EXISTS idx_forecast_entries_trip_id ON forecast_entries(trip_id);
CREATE INDEX IF NOT EXISTS idx_forecast_entries_native_cost_id ON forecast_entries(native_cost_id);
CREATE INDEX IF NOT EXISTS idx_forecast_entries_reservation_id ON forecast_entries(reservation_id);
CREATE INDEX IF NOT EXISTS idx_forecast_entries_payment_account_id ON forecast_entries(payment_account_id)`,
  },
  {
    id: '004_payment_accounts',
    sql: `CREATE TABLE IF NOT EXISTS payment_accounts (
      id TEXT PRIMARY KEY,
      trip_id TEXT NOT NULL,
      name TEXT NOT NULL,
      account_type TEXT NOT NULL,
      currency TEXT NOT NULL,
      starting_balance_minor INTEGER NOT NULL DEFAULT 0,
      credit_limit_minor INTEGER,
      last_four TEXT,
      notes TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  },
  {
    id: '005_payment_accounts_indexes',
    sql: `CREATE INDEX IF NOT EXISTS idx_payment_accounts_trip_id ON payment_accounts(trip_id)`,
  },
  {
    id: '006_category_budgets',
    sql: `CREATE TABLE IF NOT EXISTS category_budgets (
      id TEXT PRIMARY KEY,
      trip_id TEXT NOT NULL,
      native_category_id TEXT,
      category_name TEXT NOT NULL,
      budget_amount_minor INTEGER NOT NULL,
      currency TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  },
  {
    id: '007_category_budgets_indexes',
    sql: `CREATE INDEX IF NOT EXISTS idx_category_budgets_trip_id ON category_budgets(trip_id)`,
  },
  {
    id: '008_forecast_history',
    sql: `CREATE TABLE IF NOT EXISTS forecast_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_id TEXT NOT NULL,
      trip_id TEXT NOT NULL,
      changed_at TEXT NOT NULL,
      changed_by TEXT,
      field_name TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT
    )`,
  },
  {
    id: '009_forecast_history_indexes',
    sql: `CREATE INDEX IF NOT EXISTS idx_forecast_history_entry_id ON forecast_history(entry_id);
CREATE INDEX IF NOT EXISTS idx_forecast_history_trip_id ON forecast_history(trip_id)`,
  },
];

/**
 * Run all migrations in order. Each migration is idempotent.
 * @param {object} ctx - Plugin context with ctx.db
 */
async function migrate(ctx) {
  for (const m of MIGRATIONS) {
    await ctx.db.migrate(m.id, m.sql);
  }
}

/**
 * Generate a UUID v4.
 * @returns {string}
 */
function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    var r = Math.random() * 16 | 0;
    var v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

/**
 * Get current ISO timestamp.
 * @returns {string}
 */
function now() {
  return new Date().toISOString();
}

module.exports = {
  migrate: migrate,
  uuid: uuid,
  now: now,
  MIGRATIONS: MIGRATIONS,
};