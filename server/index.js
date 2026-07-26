'use strict';

/**
 * Budget Forecast — TREK trip-page plugin
 * Production-ready trip budget forecasting with planned, committed, and actual expenses.
 */

var db = require('./db');
var money = require('./money');
var forecast = require('./forecast');
var csvExport = require('./csv');

// ── Validation helpers ──────────────────────────────────────────────────────

var VALID_ENTRY_TYPES = Object.values(forecast.ENTRY_TYPES);
var VALID_STATUSES = Object.values(forecast.STATUSES);
var VALID_ACCOUNT_TYPES = ['credit_card', 'debit_card', 'cash', 'bank_account', 'travel_credit', 'other'];
var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function jsonResp(status, body) {
  return { status: status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

function errResp(status, message) {
  return jsonResp(status, { error: message });
}

function validateId(id) {
  return typeof id === 'string' && UUID_RE.test(id);
}

function sanitizeNotes(val) {
  if (typeof val !== 'string') return null;
  return val.slice(0, 4000);
}

// ── Plugin definition ───────────────────────────────────────────────────────

module.exports = {
  onLoad: async function(ctx) {
    await db.migrate(ctx);
  },

  routes: [
    // ── GET /summary ──────────────────────────────────────────────────────
    {
      method: 'GET',
      path: '/summary',
      auth: true,
      handler: async function(req, ctx) {
        var tripId = Number(req.query.tripId);
        if (!tripId) return errResp(400, 'tripId required');

        var trip = await ctx.trips.getById(tripId);
        if (!trip) return errResp(404, 'Trip not found');

        var entries = await ctx.db.query(
          'SELECT * FROM forecast_entries WHERE trip_id = ? AND deleted_at IS NULL',
          String(tripId)
        );
        var settings = (await ctx.db.query(
          'SELECT * FROM forecast_settings WHERE trip_id = ?',
          String(tripId)
        ))[0] || null;
        var categoryBudgets = await ctx.db.query(
          'SELECT * FROM category_budgets WHERE trip_id = ?',
          String(tripId)
        );
        var accounts = await ctx.db.query(
          'SELECT * FROM payment_accounts WHERE trip_id = ? AND deleted_at IS NULL ORDER BY sort_order',
          String(tripId)
        );

        var tripCurrency = trip.currency || 'USD';
        var summary = forecast.buildSummary(entries, settings, categoryBudgets, tripCurrency);

        // Account balances
        var accountBalances = {};
        for (var i = 0; i < accounts.length; i++) {
          var a = accounts[i];
          accountBalances[a.id] = forecast.calcAccountBalance(entries, a.id);
        }

        return jsonResp(200, {
          summary: summary,
          accounts: accounts.map(function(a) {
            var bal = accountBalances[a.id] || { current: 0, projected: 0 };
            return {
              id: a.id,
              name: a.name,
              type: a.account_type,
              currency: a.currency,
              lastFour: a.last_four,
              creditLimit: a.credit_limit_minor,
              currentOutstanding: bal.current,
              projectedOutstanding: bal.projected,
              remainingCredit: a.credit_limit_minor != null ? Math.max(0, a.credit_limit_minor - bal.current) : null,
              percentUsed: a.credit_limit_minor ? money.percentage(bal.current, a.credit_limit_minor) : 0,
            };
          }),
          tripCurrency: tripCurrency,
        });
      },
    },

    // ── GET /entries ──────────────────────────────────────────────────────
    {
      method: 'GET',
      path: '/entries',
      auth: true,
      handler: async function(req, ctx) {
        var tripId = Number(req.query.tripId);
        if (!tripId) return errResp(400, 'tripId required');

        var where = ['trip_id = ?'];
        var params = [String(tripId)];

        if (req.query.type && VALID_ENTRY_TYPES.indexOf(req.query.type) !== -1) {
          where.push('entry_type = ?');
          params.push(req.query.type);
        }
        if (req.query.status && VALID_STATUSES.indexOf(req.query.status) !== -1) {
          where.push('status = ?');
          params.push(req.query.status);
        }
        if (req.query.category) {
          where.push('category_name = ?');
          params.push(req.query.category);
        }
        if (req.query.paymentAccountId) {
          where.push('payment_account_id = ?');
          params.push(req.query.paymentAccountId);
        }
        if (req.query.includeDeleted !== '1') {
          where.push('deleted_at IS NULL');
        }
        if (req.query.search) {
          where.push('(name LIKE ? OR merchant LIKE ? OR notes LIKE ? OR confirmation_reference LIKE ?)');
          var s = '%' + req.query.search + '%';
          params.push(s, s, s, s);
        }

        var sort = 'expected_date ASC';
        if (req.query.sort === 'amount') sort = 'amount_minor DESC';
        else if (req.query.sort === 'category') sort = 'category_name ASC';
        else if (req.query.sort === 'status') sort = 'status ASC';
        else if (req.query.sort === 'updated') sort = 'updated_at DESC';

        var sql = 'SELECT * FROM forecast_entries WHERE ' + where.join(' AND ') + ' ORDER BY ' + sort;
        var entries = await ctx.db.query(sql, params);
        return jsonResp(200, { entries: entries });
      },
    },

    // ── POST /entries ─────────────────────────────────────────────────────
    {
      method: 'POST',
      path: '/entries',
      auth: true,
      handler: async function(req, ctx) {
        var b = req.body || {};
        var tripId = Number(req.query.tripId || b.tripId);
        if (!tripId) return errResp(400, 'tripId required');

        // Validate required fields
        if (!b.name || typeof b.name !== 'string') return errResp(400, 'name required');
        if (!b.entryType || VALID_ENTRY_TYPES.indexOf(b.entryType) === -1) return errResp(400, 'valid entryType required');
        if (!b.status || VALID_STATUSES.indexOf(b.status) === -1) return errResp(400, 'valid status required');
        if (!b.amountMinor || !money.isValidAmount(b.amountMinor)) return errResp(400, 'valid positive amountMinor required');
        if (!b.currency || !money.isValidCurrency(b.currency)) return errResp(400, 'valid 3-letter currency required');

        // Account payment requires an account
        if (b.entryType === 'account_payment' && !b.paymentAccountId) {
          return errResp(400, 'account_payment requires a paymentAccountId');
        }

        // Validate payment account belongs to trip
        if (b.paymentAccountId) {
          var acct = (await ctx.db.query(
            'SELECT id FROM payment_accounts WHERE id = ? AND trip_id = ?',
            [b.paymentAccountId, String(tripId)]
          ))[0];
          if (!acct) return errResp(400, 'paymentAccountId does not belong to this trip');
        }

        // Get trip for currency conversion
        var trip = await ctx.trips.getById(tripId);
        if (!trip) return errResp(404, 'Trip not found');
        var tripCurrency = trip.currency || 'USD';

        // Freeze exchange rate
        var tripAmountMinor = b.amountMinor;
        var frozenRate = null;
        var rateDate = null;
        var rateSource = null;
        if (b.currency !== tripCurrency) {
          var rates = await ctx.rates.get(b.currency);
          if (rates && rates[tripCurrency]) {
            frozenRate = String(rates[tripCurrency]);
            rateDate = db.now();
            rateSource = 'auto';
            tripAmountMinor = money.convert(b.amountMinor, b.currency, tripCurrency, rates[tripCurrency]);
          } else {
            tripAmountMinor = b.amountMinor;
            frozenRate = '1';
            rateDate = db.now();
            rateSource = 'manual';
          }
        }

        var id = db.uuid();
        var now = db.now();
        var userId = req.user ? String(req.user.id) : null;

        await ctx.db.exec(
          `INSERT INTO forecast_entries (
            id, trip_id, entry_type, status, name, category_id, category_name,
            amount_minor, currency, trip_amount_minor, frozen_exchange_rate, rate_date, rate_source,
            expected_date, actual_date, merchant, payment_account_id, reservation_id,
            native_cost_id, related_entry_id, confirmation_reference, notes,
            include_in_forecast, persons, days, created_by, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id, String(tripId), b.entryType, b.status, b.name.slice(0, 200),
            b.categoryId || null, b.categoryName || null,
            b.amountMinor, b.currency, tripAmountMinor, frozenRate, rateDate, rateSource,
            b.expectedDate || null, b.actualDate || null, (b.merchant || '').slice(0, 200),
            b.paymentAccountId || null, b.reservationId || null,
            b.nativeCostId || null, b.relatedEntryId || null,
            (b.confirmationReference || '').slice(0, 200), sanitizeNotes(b.notes),
            b.includeInForecast !== false ? 1 : 0,
            b.persons || null, b.days || null,
            userId, now, now,
          ]
        );

        // Record in history
        await ctx.db.exec(
          'INSERT INTO forecast_history (entry_id, trip_id, changed_at, changed_by, field_name, old_value, new_value) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [id, String(tripId), now, userId, '_created', null, 'entry created']
        );

        var entry = (await ctx.db.query('SELECT * FROM forecast_entries WHERE id = ?', id))[0];
        return jsonResp(201, { entry: entry });
      },
    },

    // ── PATCH /entries/:id ────────────────────────────────────────────────
    {
      method: 'PATCH',
      path: '/entries/:id',
      auth: true,
      handler: async function(req, ctx) {
        var id = req.params.id;
        if (!validateId(id)) return errResp(400, 'Invalid id');

        var existing = (await ctx.db.query('SELECT * FROM forecast_entries WHERE id = ? AND deleted_at IS NULL', id))[0];
        if (!existing) return errResp(404, 'Entry not found');

        var b = req.body || {};
        var updates = [];
        var params = [];
        var historyEntries = [];
        var now = db.now();
        var userId = req.user ? String(req.user.id) : null;

        var fields = ['name', 'status', 'category_id', 'category_name', 'expected_date',
          'actual_date', 'merchant', 'payment_account_id', 'reservation_id',
          'confirmation_reference', 'notes', 'persons', 'days'];

        for (var i = 0; i < fields.length; i++) {
          var f = fields[i];
          var camel = f.replace(/_([a-z])/g, function(_, c) { return c.toUpperCase(); });
          if (b[camel] !== undefined) {
            var val = f === 'notes' ? sanitizeNotes(b[camel]) : (typeof b[camel] === 'string' ? b[camel].slice(0, 200) : b[camel]);
            if (f === 'status' && VALID_STATUSES.indexOf(val) === -1) return errResp(400, 'Invalid status');
            updates.push(f + ' = ?');
            params.push(val);
            if (String(existing[f]) !== String(val)) {
              historyEntries.push([id, existing.trip_id, now, userId, f, String(existing[f] || ''), String(val || '')]);
            }
          }
        }

        // Handle amount update
        if (b.amountMinor && money.isValidAmount(b.amountMinor)) {
          updates.push('amount_minor = ?');
          params.push(b.amountMinor);
          historyEntries.push([id, existing.trip_id, now, userId, 'amount_minor', String(existing.amount_minor), String(b.amountMinor)]);

          // Recalculate trip amount if currency differs
          var trip = await ctx.trips.getById(Number(existing.trip_id));
          var tripCurrency = trip ? (trip.currency || 'USD') : 'USD';
          if (existing.currency !== tripCurrency) {
            var rates = await ctx.rates.get(existing.currency);
            if (rates && rates[tripCurrency]) {
              var newTripAmt = money.convert(b.amountMinor, existing.currency, tripCurrency, rates[tripCurrency]);
              updates.push('trip_amount_minor = ?');
              params.push(newTripAmt);
              updates.push('frozen_exchange_rate = ?');
              params.push(String(rates[tripCurrency]));
              updates.push('rate_date = ?');
              params.push(now);
            }
          } else {
            updates.push('trip_amount_minor = ?');
            params.push(b.amountMinor);
          }
        }

        if (b.includeInForecast !== undefined) {
          updates.push('include_in_forecast = ?');
          params.push(b.includeInForecast ? 1 : 0);
        }

        if (updates.length === 0) return errResp(400, 'No fields to update');

        updates.push('updated_at = ?');
        params.push(now);
        params.push(id);

        await ctx.db.exec('UPDATE forecast_entries SET ' + updates.join(', ') + ' WHERE id = ?', params);

        // Record history
        for (var h = 0; h < historyEntries.length; h++) {
          await ctx.db.exec(
            'INSERT INTO forecast_history (entry_id, trip_id, changed_at, changed_by, field_name, old_value, new_value) VALUES (?, ?, ?, ?, ?, ?, ?)',
            historyEntries[h]
          );
        }

        var entry = (await ctx.db.query('SELECT * FROM forecast_entries WHERE id = ?', id))[0];
        return jsonResp(200, { entry: entry });
      },
    },

    // ── DELETE /entries/:id ───────────────────────────────────────────────
    {
      method: 'DELETE',
      path: '/entries/:id',
      auth: true,
      handler: async function(req, ctx) {
        var id = req.params.id;
        if (!validateId(id)) return errResp(400, 'Invalid id');

        var existing = (await ctx.db.query('SELECT * FROM forecast_entries WHERE id = ? AND deleted_at IS NULL', id))[0];
        if (!existing) return errResp(404, 'Entry not found');

        var now = db.now();
        await ctx.db.exec('UPDATE forecast_entries SET deleted_at = ?, updated_at = ? WHERE id = ?', [now, now, id]);

        await ctx.db.exec(
          'INSERT INTO forecast_history (entry_id, trip_id, changed_at, changed_by, field_name, old_value, new_value) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [id, existing.trip_id, now, req.user ? String(req.user.id) : null, '_deleted', null, 'soft deleted']
        );

        return jsonResp(200, { deleted: true });
      },
    },

    // ── POST /entries/:id/convert ─────────────────────────────────────────
    {
      method: 'POST',
      path: '/entries/:id/convert',
      auth: true,
      handler: async function(req, ctx) {
        var id = req.params.id;
        if (!validateId(id)) return errResp(400, 'Invalid id');

        var existing = (await ctx.db.query('SELECT * FROM forecast_entries WHERE id = ? AND deleted_at IS NULL', id))[0];
        if (!existing) return errResp(404, 'Entry not found');
        if (existing.status === 'incurred') return errResp(409, 'Entry already incurred');
        if (existing.native_cost_id) return errResp(409, 'Entry already linked to a native cost');

        var b = req.body || {};
        var actualAmount = b.actualAmountMinor || existing.amount_minor;
        var actualDate = b.actualDate || new Date().toISOString().slice(0, 10);
        var now = db.now();
        var userId = req.user ? String(req.user.id) : null;

        // Create native TREK cost
        var trip = await ctx.trips.getById(Number(existing.trip_id));
        if (!trip) return errResp(404, 'Trip not found');
        var tripCurrency = trip.currency || 'USD';

        var costInput = {
          name: existing.name,
          total_price: money.fromMinor(actualAmount, existing.currency),
          currency: existing.currency,
          category: existing.category_name || undefined,
        };

        var nativeCost;
        try {
          nativeCost = await ctx.costs.create(Number(existing.trip_id), costInput);
        } catch (e) {
          return errResp(500, 'Failed to create native TREK cost: ' + (e.message || 'Unknown error'));
        }

        // Calculate actual trip amount
        var actualTripAmount = actualAmount;
        if (existing.currency !== tripCurrency) {
          var rates = await ctx.rates.get(existing.currency);
          if (rates && rates[tripCurrency]) {
            actualTripAmount = money.convert(actualAmount, existing.currency, tripCurrency, rates[tripCurrency]);
          }
        }

        // Update forecast entry
        await ctx.db.exec(
          `UPDATE forecast_entries SET
            status = 'incurred',
            actual_date = ?,
            amount_minor = ?,
            trip_amount_minor = ?,
            native_cost_id = ?,
            updated_at = ?
          WHERE id = ?`,
          [actualDate, actualAmount, actualTripAmount, String(nativeCost.id), now, id]
        );

        // Record history
        await ctx.db.exec(
          'INSERT INTO forecast_history (entry_id, trip_id, changed_at, changed_by, field_name, old_value, new_value) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [id, existing.trip_id, now, userId, 'status', existing.status, 'incurred']
        );
        await ctx.db.exec(
          'INSERT INTO forecast_history (entry_id, trip_id, changed_at, changed_by, field_name, old_value, new_value) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [id, existing.trip_id, now, userId, 'native_cost_id', '', String(nativeCost.id)]
        );

        var entry = (await ctx.db.query('SELECT * FROM forecast_entries WHERE id = ?', id))[0];
        var variance = forecast.calcVariance(existing.amount_minor, actualAmount);

        return jsonResp(200, { entry: entry, nativeCost: nativeCost, variance: variance });
      },
    },

    // ── POST /entries/:id/cancel ──────────────────────────────────────────
    {
      method: 'POST',
      path: '/entries/:id/cancel',
      auth: true,
      handler: async function(req, ctx) {
        var id = req.params.id;
        if (!validateId(id)) return errResp(400, 'Invalid id');

        var existing = (await ctx.db.query('SELECT * FROM forecast_entries WHERE id = ? AND deleted_at IS NULL', id))[0];
        if (!existing) return errResp(404, 'Entry not found');
        if (existing.status === 'cancelled') return errResp(409, 'Already cancelled');

        var now = db.now();
        await ctx.db.exec('UPDATE forecast_entries SET status = ?, updated_at = ? WHERE id = ?', ['cancelled', now, id]);

        await ctx.db.exec(
          'INSERT INTO forecast_history (entry_id, trip_id, changed_at, changed_by, field_name, old_value, new_value) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [id, existing.trip_id, now, req.user ? String(req.user.id) : null, 'status', existing.status, 'cancelled']
        );

        return jsonResp(200, { cancelled: true });
      },
    },

    // ── POST /entries/:id/restore ─────────────────────────────────────────
    {
      method: 'POST',
      path: '/entries/:id/restore',
      auth: true,
      handler: async function(req, ctx) {
        var id = req.params.id;
        if (!validateId(id)) return errResp(400, 'Invalid id');

        var existing = (await ctx.db.query('SELECT * FROM forecast_entries WHERE id = ? AND deleted_at IS NOT NULL', id))[0];
        if (!existing) return errResp(404, 'Deleted entry not found');

        var now = db.now();
        await ctx.db.exec('UPDATE forecast_entries SET deleted_at = NULL, updated_at = ? WHERE id = ?', [now, id]);

        return jsonResp(200, { restored: true });
      },
    },

    // ── POST /entries/:id/link-cost ───────────────────────────────────────
    {
      method: 'POST',
      path: '/entries/:id/link-cost',
      auth: true,
      handler: async function(req, ctx) {
        var id = req.params.id;
        if (!validateId(id)) return errResp(400, 'Invalid id');

        var existing = (await ctx.db.query('SELECT * FROM forecast_entries WHERE id = ? AND deleted_at IS NULL', id))[0];
        if (!existing) return errResp(404, 'Entry not found');
        if (existing.native_cost_id) return errResp(409, 'Already linked to a native cost');

        var b = req.body || {};
        if (!b.nativeCostId) return errResp(400, 'nativeCostId required');

        var now = db.now();
        await ctx.db.exec('UPDATE forecast_entries SET native_cost_id = ?, updated_at = ? WHERE id = ?', [String(b.nativeCostId), now, id]);

        await ctx.db.exec(
          'INSERT INTO forecast_history (entry_id, trip_id, changed_at, changed_by, field_name, old_value, new_value) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [id, existing.trip_id, now, req.user ? String(req.user.id) : null, 'native_cost_id', '', String(b.nativeCostId)]
        );

        return jsonResp(200, { linked: true });
      },
    },

    // ── POST /entries/:id/unlink-cost ─────────────────────────────────────
    {
      method: 'POST',
      path: '/entries/:id/unlink-cost',
      auth: true,
      handler: async function(req, ctx) {
        var id = req.params.id;
        if (!validateId(id)) return errResp(400, 'Invalid id');

        var existing = (await ctx.db.query('SELECT * FROM forecast_entries WHERE id = ? AND deleted_at IS NULL', id))[0];
        if (!existing) return errResp(404, 'Entry not found');

        var now = db.now();
        await ctx.db.exec('UPDATE forecast_entries SET native_cost_id = NULL, updated_at = ? WHERE id = ?', [now, id]);

        await ctx.db.exec(
          'INSERT INTO forecast_history (entry_id, trip_id, changed_at, changed_by, field_name, old_value, new_value) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [id, existing.trip_id, now, req.user ? String(req.user.id) : null, 'native_cost_id', existing.native_cost_id || '', '']
        );

        return jsonResp(200, { unlinked: true });
      },
    },

    // ── GET /accounts ─────────────────────────────────────────────────────
    {
      method: 'GET',
      path: '/accounts',
      auth: true,
      handler: async function(req, ctx) {
        var tripId = Number(req.query.tripId);
        if (!tripId) return errResp(400, 'tripId required');

        var accounts = await ctx.db.query(
          'SELECT * FROM payment_accounts WHERE trip_id = ? ORDER BY sort_order',
          String(tripId)
        );
        return jsonResp(200, { accounts: accounts });
      },
    },

    // ── POST /accounts ────────────────────────────────────────────────────
    {
      method: 'POST',
      path: '/accounts',
      auth: true,
      handler: async function(req, ctx) {
        var b = req.body || {};
        var tripId = Number(req.query.tripId || b.tripId);
        if (!tripId) return errResp(400, 'tripId required');
        if (!b.name) return errResp(400, 'name required');
        if (!b.accountType || VALID_ACCOUNT_TYPES.indexOf(b.accountType) === -1) return errResp(400, 'valid accountType required');
        if (!b.currency || !money.isValidCurrency(b.currency)) return errResp(400, 'valid currency required');

        var id = db.uuid();
        var now = db.now();
        await ctx.db.exec(
          `INSERT INTO payment_accounts (id, trip_id, name, account_type, currency, starting_balance_minor, credit_limit_minor, last_four, notes, active, sort_order, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id, String(tripId), b.name.slice(0, 100), b.accountType, b.currency,
            b.startingBalanceMinor || 0, b.creditLimitMinor || null,
            (b.lastFour || '').slice(0, 4), sanitizeNotes(b.notes),
            b.active !== false ? 1 : 0, b.sortOrder || 0, now, now,
          ]
        );

        var account = (await ctx.db.query('SELECT * FROM payment_accounts WHERE id = ?', id))[0];
        return jsonResp(201, { account: account });
      },
    },

    // ── PATCH /accounts/:id ───────────────────────────────────────────────
    {
      method: 'PATCH',
      path: '/accounts/:id',
      auth: true,
      handler: async function(req, ctx) {
        var id = req.params.id;
        if (!validateId(id)) return errResp(400, 'Invalid id');

        var existing = (await ctx.db.query('SELECT * FROM payment_accounts WHERE id = ?', id))[0];
        if (!existing) return errResp(404, 'Account not found');

        var b = req.body || {};
        var updates = [];
        var params = [];
        var now = db.now();

        if (b.name) { updates.push('name = ?'); params.push(b.name.slice(0, 100)); }
        if (b.accountType && VALID_ACCOUNT_TYPES.indexOf(b.accountType) !== -1) { updates.push('account_type = ?'); params.push(b.accountType); }
        if (b.creditLimitMinor !== undefined) { updates.push('credit_limit_minor = ?'); params.push(b.creditLimitMinor); }
        if (b.lastFour !== undefined) { updates.push('last_four = ?'); params.push((b.lastFour || '').slice(0, 4)); }
        if (b.notes !== undefined) { updates.push('notes = ?'); params.push(sanitizeNotes(b.notes)); }
        if (b.active !== undefined) { updates.push('active = ?'); params.push(b.active ? 1 : 0); }
        if (b.sortOrder !== undefined) { updates.push('sort_order = ?'); params.push(b.sortOrder); }

        if (updates.length === 0) return errResp(400, 'No fields to update');

        updates.push('updated_at = ?');
        params.push(now);
        params.push(id);

        await ctx.db.exec('UPDATE payment_accounts SET ' + updates.join(', ') + ' WHERE id = ?', params);

        var account = (await ctx.db.query('SELECT * FROM payment_accounts WHERE id = ?', id))[0];
        return jsonResp(200, { account: account });
      },
    },

    // ── DELETE /accounts/:id ──────────────────────────────────────────────
    {
      method: 'DELETE',
      path: '/accounts/:id',
      auth: true,
      handler: async function(req, ctx) {
        var id = req.params.id;
        if (!validateId(id)) return errResp(400, 'Invalid id');

        var existing = (await ctx.db.query('SELECT * FROM payment_accounts WHERE id = ?', id))[0];
        if (!existing) return errResp(404, 'Account not found');

        await ctx.db.exec('DELETE FROM payment_accounts WHERE id = ?', id);
        return jsonResp(200, { deleted: true });
      },
    },

    // ── GET /category-budgets ─────────────────────────────────────────────
    {
      method: 'GET',
      path: '/category-budgets',
      auth: true,
      handler: async function(req, ctx) {
        var tripId = Number(req.query.tripId);
        if (!tripId) return errResp(400, 'tripId required');

        var budgets = await ctx.db.query(
          'SELECT * FROM category_budgets WHERE trip_id = ? ORDER BY category_name',
          String(tripId)
        );
        return jsonResp(200, { categoryBudgets: budgets });
      },
    },

    // ── POST /category-budgets ────────────────────────────────────────────
    {
      method: 'POST',
      path: '/category-budgets',
      auth: true,
      handler: async function(req, ctx) {
        var b = req.body || {};
        var tripId = Number(req.query.tripId || b.tripId);
        if (!tripId) return errResp(400, 'tripId required');
        if (!b.categoryName) return errResp(400, 'categoryName required');
        if (!b.budgetAmountMinor || !money.isValidAmount(b.budgetAmountMinor)) return errResp(400, 'valid budgetAmountMinor required');
        if (!b.currency || !money.isValidCurrency(b.currency)) return errResp(400, 'valid currency required');

        var id = db.uuid();
        var now = db.now();
        await ctx.db.exec(
          'INSERT INTO category_budgets (id, trip_id, native_category_id, category_name, budget_amount_minor, currency, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [id, String(tripId), b.nativeCategoryId || null, b.categoryName, b.budgetAmountMinor, b.currency, now, now]
        );

        var budget = (await ctx.db.query('SELECT * FROM category_budgets WHERE id = ?', id))[0];
        return jsonResp(201, { categoryBudget: budget });
      },
    },

    // ── PATCH /category-budgets/:id ───────────────────────────────────────
    {
      method: 'PATCH',
      path: '/category-budgets/:id',
      auth: true,
      handler: async function(req, ctx) {
        var id = req.params.id;
        if (!validateId(id)) return errResp(400, 'Invalid id');

        var existing = (await ctx.db.query('SELECT * FROM category_budgets WHERE id = ?', id))[0];
        if (!existing) return errResp(404, 'Category budget not found');

        var b = req.body || {};
        var updates = [];
        var params = [];
        var now = db.now();

        if (b.categoryName) { updates.push('category_name = ?'); params.push(b.categoryName); }
        if (b.budgetAmountMinor && money.isValidAmount(b.budgetAmountMinor)) { updates.push('budget_amount_minor = ?'); params.push(b.budgetAmountMinor); }

        if (updates.length === 0) return errResp(400, 'No fields to update');

        updates.push('updated_at = ?');
        params.push(now);
        params.push(id);

        await ctx.db.exec('UPDATE category_budgets SET ' + updates.join(', ') + ' WHERE id = ?', params);

        var budget = (await ctx.db.query('SELECT * FROM category_budgets WHERE id = ?', id))[0];
        return jsonResp(200, { categoryBudget: budget });
      },
    },

    // ── DELETE /category-budgets/:id ──────────────────────────────────────
    {
      method: 'DELETE',
      path: '/category-budgets/:id',
      auth: true,
      handler: async function(req, ctx) {
        var id = req.params.id;
        if (!validateId(id)) return errResp(400, 'Invalid id');

        await ctx.db.exec('DELETE FROM category_budgets WHERE id = ?', id);
        return jsonResp(200, { deleted: true });
      },
    },

    // ── GET /native-costs ─────────────────────────────────────────────────
    {
      method: 'GET',
      path: '/native-costs',
      auth: true,
      handler: async function(req, ctx) {
        var tripId = Number(req.query.tripId);
        if (!tripId) return errResp(400, 'tripId required');

        try {
          var costs = await ctx.costs.getByTrip(tripId);
          return jsonResp(200, { costs: costs });
        } catch (e) {
          return errResp(500, 'Failed to fetch native costs: ' + (e.message || 'Unknown error'));
        }
      },
    },

    // ── GET /reservations ─────────────────────────────────────────────────
    {
      method: 'GET',
      path: '/reservations',
      auth: true,
      handler: async function(req, ctx) {
        var tripId = Number(req.query.tripId);
        if (!tripId) return errResp(400, 'tripId required');

        try {
          var reservations = await ctx.trips.getReservations(tripId);
          return jsonResp(200, { reservations: reservations });
        } catch (e) {
          return errResp(500, 'Failed to fetch reservations: ' + (e.message || 'Unknown error'));
        }
      },
    },

    // ── GET /export.csv ───────────────────────────────────────────────────
    {
      method: 'GET',
      path: '/export.csv',
      auth: true,
      handler: async function(req, ctx) {
        var tripId = Number(req.query.tripId);
        if (!tripId) return errResp(400, 'tripId required');

        var trip = await ctx.trips.getById(tripId);
        if (!trip) return errResp(404, 'Trip not found');
        var tripCurrency = trip.currency || 'USD';

        var entries = await ctx.db.query(
          'SELECT * FROM forecast_entries WHERE trip_id = ? AND deleted_at IS NULL ORDER BY expected_date',
          String(tripId)
        );
        var accounts = await ctx.db.query(
          'SELECT * FROM payment_accounts WHERE trip_id = ? ORDER BY sort_order',
          String(tripId)
        );
        var categoryBudgets = await ctx.db.query(
          'SELECT * FROM category_budgets WHERE trip_id = ?',
          String(tripId)
        );

        var section = req.query.section || 'entries';
        var csvContent;
        if (section === 'accounts') {
          csvContent = csvExport.exportAccounts(accounts, entries, tripCurrency);
        } else if (section === 'categories') {
          var breakdown = forecast.calcCategoryBreakdown(entries, categoryBudgets, tripCurrency);
          csvContent = csvExport.exportCategoryBudgets(breakdown, tripCurrency);
        } else {
          csvContent = csvExport.exportEntries(entries, tripCurrency);
        }

        return {
          status: 200,
          headers: {
            'content-type': 'text/csv; charset=utf-8',
            'content-disposition': 'attachment; filename="budget-forecast-' + section + '.csv"',
          },
          body: csvContent,
        };
      },
    },
  ],
};