# Budget Forecast

A production-ready trip budget forecasting plugin for [TREK](https://github.com/liketrek/TREK) — the self-hosted collaborative travel planner.

## Purpose

TREK's native Costs feature records actual trip expenses, but Budget Forecast extends this with a complete financial planning system that tracks planned, committed, and actual expenses, credits, payment accounts, and category budgets.

## Accounting Model

### Entry Types

| Type | Description | Effect on Trip Cost |
|------|-------------|-------------------|
| **Planned Expense** | Future or estimated expense | Counts toward forecast only |
| **Actual Expense** | Charged or paid expense | Counts toward actual spending |
| **Credit** | Refund, rebate, or voucher | Reduces net trip cost |
| **Account Payment** | Credit card bill payment | Reduces account balance only, not trip cost |

### Status Model

| Status | Label | Description |
|--------|-------|-------------|
| `considering` | Considering | Optional purchase being evaluated |
| `estimated` | Estimated | Likely expense with estimated amount |
| `reserved` | Reserved | Reserved but not necessarily charged |
| `committed` | Committed | Obligation exists |
| `incurred` | Incurred | Charged or paid — now actual |
| `cancelled` | Cancelled | Excluded from active totals |

### Forecast Scenarios

**Actual** — What you've actually spent:
```
Actual net = Actual expenses - Actual credits
```

**Committed** — What you're obligated to spend:
```
Committed forecast = Actual net + Reserved expenses + Committed expenses
```

**Full Forecast** — Everything including optional plans:
```
Full forecast = Actual net + All active planned expenses - Forecast credits
```

### Example

```
Plane ticket charged to credit card:
  → Actual expense: positive amount
  → Payment account: selected credit card
  → Outstanding balance: increases

Credit-card bill payment:
  → Account payment
  → Outstanding balance: decreases
  → Trip cost: unchanged

Airline refund:
  → Credit
  → Outstanding balance: decreases when assigned to the card
  → Net trip cost: decreases

Hotel being considered:
  → Planned expense
  → Full forecast: increases
  → Actual spending: unchanged
```

## Installation

1. Install the TREK Plugin SDK:
   ```bash
   npm install
   ```

2. Run the development server:
   ```bash
   npx trek-plugin-sdk dev
   ```

3. Validate the plugin:
   ```bash
   npx trek-plugin-sdk validate
   ```

4. Pack for distribution:
   ```bash
   npx trek-plugin-sdk pack
   ```

## Permissions

| Permission | Purpose |
|-----------|---------|
| `db:own` | Plugin-owned SQLite database |
| `db:read:trips` | Read trip metadata and currency |
| `db:read:costs` | Read native TREK costs |
| `db:write:costs` | Create native TREK costs when converting planned to actual |
| `db:meta` | Store plugin metadata on trips |
| `rates:read` | Access exchange rates for currency conversion |

## Configuration

### Setting a Trip Budget

The trip budget is stored in the plugin database. Use the summary endpoint or UI to set it.

### Category Budgets

Create per-category spending limits for: Flights, Accommodation, Food, Transportation, Activities, Insurance, Shopping, or custom categories.

### Payment Accounts

Track credit cards, debit cards, cash, bank accounts, and travel credits. Each account shows:
- Current outstanding balance
- Projected outstanding balance
- Remaining credit (for credit cards)
- Percentage of limit used

## Converting Planned Costs to Actual

Use the "Mark as Incurred" action to convert a planned expense into a native TREK cost:

1. The plugin creates a native TREK cost via `ctx.costs.create`
2. The forecast entry status changes to `incurred`
3. The native cost ID is stored on the forecast entry
4. Variance (estimate vs actual) is calculated and displayed
5. The conversion is idempotent — repeated clicks cannot create duplicates

## Currency Handling

- Every entry stores its original amount and currency
- Exchange rates are frozen at entry creation time
- Converted trip-currency amounts are stored alongside originals
- Historical entries are not affected by rate changes
- Supports currencies with 0, 2, or 3 minor digits (JPY, USD, BHD)

## CSV Export

Export entries, payment accounts, or category budgets as CSV files. All exports:
- Use spreadsheet-safe escaping
- Prevent formula injection (cells starting with `=`, `+`, `-`, `@` are neutralized)
- Include both type labels and signed-effect columns for credits

## API Routes

| Method | Path | Description |
|--------|------|-------------|
| GET | `/summary` | Full forecast summary with account balances |
| GET | `/entries` | List entries with filtering and sorting |
| POST | `/entries` | Create a new forecast entry |
| PATCH | `/entries/:id` | Update an entry |
| DELETE | `/entries/:id` | Soft-delete an entry |
| POST | `/entries/:id/convert` | Convert planned to actual (creates native cost) |
| POST | `/entries/:id/cancel` | Cancel an entry |
| POST | `/entries/:id/restore` | Restore a soft-deleted entry |
| POST | `/entries/:id/link-cost` | Link to an existing native cost |
| POST | `/entries/:id/unlink-cost` | Unlink from a native cost |
| GET | `/accounts` | List payment accounts |
| POST | `/accounts` | Create a payment account |
| PATCH | `/accounts/:id` | Update a payment account |
| DELETE | `/accounts/:id` | Delete a payment account |
| GET | `/category-budgets` | List category budgets |
| POST | `/category-budgets` | Create a category budget |
| PATCH | `/category-budgets/:id` | Update a category budget |
| DELETE | `/category-budgets/:id` | Delete a category budget |
| GET | `/native-costs` | List native TREK costs for the trip |
| GET | `/reservations` | List TREK reservations for the trip |
| GET | `/export.csv` | CSV export (entries/accounts/categories) |

## Privacy and Security

- All writes occur server-side via authenticated routes
- Every trip-scoped request verifies membership
- Native cost writes use the supported TREK SDK
- No full card numbers, security codes, or credentials are stored
- Only last four digits of payment accounts are retained
- Parameterized SQL prevents injection
- CSV exports are sanitized against formula injection
- No outbound network access is requested

## Development

```bash
# Install dependencies
npm install

# Run development server
npm run dev

# Run tests
npm test

# Validate plugin manifest
npm run validate

# Check status
npm run status

# Package for distribution
npm run pack
```

## Testing

```bash
npm test
```

All 37 tests cover:
- Money arithmetic (cent-accurate, multi-currency, frozen rates)
- Forecast calculations (actual, committed, full forecast)
- Credit and account payment handling
- Account balance calculations
- Variance reporting
- Entry status and filtering

## Known TREK SDK Limitations

- The plugin cannot inject controls into the core Costs UI tab; it runs as a separate trip-page tab
- Native TREK cost negative-amount support depends on the TREK version; credits are kept in the plugin database
- Exchange rates are fetched from TREK's host-provided service; no outbound network access

## License

MIT