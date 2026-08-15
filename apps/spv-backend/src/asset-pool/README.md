# Asset Pool - VIN research notes and sample design

## What a VIN is (research summary)

A Vehicle Identification Number is the 17-character identifier every road
vehicle carries (ISO 3779). In auto ABS it is the key that ties each loan or
lease in the pool to one physical car - collateral tracking, asset-level
disclosures and recovery-value monitoring all hang off it.

Structure (positions):

| Positions | Block | Meaning |
|---|---|---|
| 1-3 | WMI | World Manufacturer Identifier (1-2 country/region, 3 maker) |
| 4-8 | VDS | Vehicle Descriptor Section - model, body, engine (maker-defined) |
| 9 | Check digit | Mandatory in North America and China only; in the EU it is just another manufacturer character - do NOT run the mod-11 check on EU VINs |
| 10 | Model year | Letter/digit cycle (M=2021, N=2022, P=2023, R=2024, S=2025, T=2026); I, O, Q, U, Z and 0 are skipped |
| 11 | Plant | Assembly plant code |
| 12-17 | Serial | Sequential production number |

Character set: `A-H J-N P R-Z 0-9` - the letters I, O and Q are banned
everywhere in the VIN (confusable with 1 and 0). Validation regex used across
this backend: `^[A-HJ-NPR-Z0-9]{17}$`.

Real WMIs used in the sample: Renault `VF1`, Peugeot `VF3`, Citroen `VF7`,
Dacia `UU1`, Volkswagen `WVW`/`WVZ` (Zwickau ID. series), Tesla `5YJ`
(Fremont) / `XP7` (Berlin), BMW `WBA`, Hyundai `TMA` (Czechia) / `KMH`
(Korea), Kia `KNA` (Korea).

## What data travels with a VIN in EU auto ABS

ESMA's securitisation disclosure template for automobile underlying exposures
(Annex 5, field prefix `AUTL`, ingested by the European DataWarehouse) attaches
to each exposure: obligor descriptors (legal form, region, employment status),
loan terms (origination/maturity dates, original/current principal, rate,
payment frequency, product type), collateral descriptors (manufacturer, model,
year of registration, new/used, mileage, valuations, LTV, residual value,
energy type) and performance data (account status, arrears, days past due,
defaults, recoveries). `pool.json` carries a representative subset of those
fields under the same names.

## Sample design (20 vehicles)

- All-electric pool (CARA7 vertical): battery block with capacity, chemistry,
  SoH and charge cycles per car.
- VINs are format-correct (real WMI, year code at position 10 consistent with
  `yearOfRegistration`) with fictional serials - they will not decode to real cars.
- 18 performing loans, 1 in arrears (12 DPD) and 1 restructured (34 DPD):
  gives the anti-fraud/audit agents something real to flag, and makes the
  waterfall's "missed collections" path observable.
- Aggregate current principal (~275k) intentionally exceeds the ~190k EURC of
  tranche notes outstanding: that spread is the overcollateralization of the deal.

Sources: ISO 3779 summaries, Wikibooks WMI registry, ESMA Annex 5 automobile
template and reporting instructions (esma.europa.eu), NHTSA VIN documentation.
