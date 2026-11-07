# Data pack: FDE Challenge (Application/Platform): Ridgeline Quote Approvals

All data is fictional.

| File | What it is |
|---|---|
| `draft_quotes.json` | 10 draft quotes produced by the extraction team |
| `approval_rules.md` | Ridgeline's current approval policy. Implement it as configurable rules |
| `reporting_db/` | Read-only nightly export: `products.csv`, `customers.csv`, `contract_prices.csv`, `approvers.csv`, `export_metadata.json`. Load it into any database you like, or read the CSVs directly |
| `stock_api.md` | Stock API spec |
| `mock_stock_api.py` + `stock_fixture.json` | Local mock of the stock API (Python standard library only) |

Your service must not write to SAP or to the reporting database.
