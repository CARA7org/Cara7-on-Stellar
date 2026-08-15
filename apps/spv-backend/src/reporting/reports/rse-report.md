# ESG snapshot

**Deal:** BSF5-DEMO-POOL (Bavarian Sky French Auto Leases 5, demo) - **Cut-off:** 2026-08-01 - **Source:** pool data room (`get_pool`), 20 vehicles. All amounts in EUR (demo EURC); figures are contract-level EUR, not on-chain base units. This is a demo sample representing the 20,000-vehicle target design.

## Key metrics

| Metric | Value | Inputs |
|---|---|---|
| Electric share | **100%** (20 of 20) | every vehicle reports `energy: "EL"` |
| Vehicles / contracts / obligors | 20 / 20 / 20 | pool aggregates |
| Current principal | 275,500 EUR | pool aggregate (sum of the 20 `currentPrincipal` values checks to 275,500) |
| Average battery capacity | **61.1 kWh** | 1,221.8 kWh fleet total / 20 (per-vehicle `capacityKwh`, from 22 kWh Twingo to 87 kWh Scenic) |
| Average state of health (SoH) | **95.1%** | pool aggregate 95.1; cross-checked against the per-vehicle mean (1,901.9 / 20 = 95.10) |
| SoH range | 90.6% (min) to 98.2% (max) | Zoe R135 ZE50 (2022) and Model 3 Highland (2024) |
| Vehicles below 85% SoH | **0** | lowest observed SoH is 90.6% |
| Average charge cycles | **299** | 5,985 total cycles / 20 (per-vehicle `chargeCycles`, 120 to 610) |
| Battery chemistry mix | NMC 17 (85%), LFP 3 (15%) | Spring (BYD), Model 3 RWD and Model 3 Highland (CATL) are LFP |
| Fleet age profile | 2022: 2 (10%), 2023: 10 (50%), 2024: 8 (40%) | `yearOfRegistration`; approximate average age 2.7 years at cut-off (year-based: (2x4 + 10x3 + 8x2) / 20) |

## Battery health analysis

Batteries are identified by their own serial number (battery identification number), independent of the vehicle VIN, which supports swap and second-life tracking.

SoH distribution (20 batteries):

| SoH band | Count | Vehicles |
|---|---|---|
| 97% and above | 8 | all eight 2024 registrations (SoH 97.2 to 98.2, 120 to 190 cycles) |
| 93% to below 97% | 8 | 2023 registrations (SoH 93.4 to 95.6, 260 to 465 cycles) |
| 90% to below 93% | 4 | e-C4 92.1, e-2008 92.8, Twingo 91.2, Zoe 90.6 |
| Below 90% | 0 | - |

Health tracks vintage and usage cleanly: the 2024 cohort averages the fewest cycles and the highest SoH, while the two 2022 city cars (Zoe at 540 cycles, Twingo at 610 cycles) sit at the bottom of the distribution. Even the weakest battery retains 90.6% of original capacity, well above the 70 to 80% range commonly treated as the automotive end-of-first-life threshold, so no battery in the pool is near second-life transition today. Cell suppliers are diversified across eight manufacturers (LG Energy Solution 4, ACC 4, CATL 4, SK On 3, AESC 2, BYD 1, Panasonic 1, Samsung SDI 1).

## Principal-at-risk (low SoH)

No vehicle breaches the 85% SoH review threshold, so strict principal-at-risk is **0 EUR (0.0%)**. As an early-warning view, two watchlist bands on the 275,500 EUR current principal:

| Watchlist band | Vehicles | Current principal | Share of pool |
|---|---|---|---|
| SoH below 92% | Zoe (90.6%, 6,400 EUR), Twingo (91.2%, 3,200 EUR) | 9,600 EUR | 3.5% (9,600 / 275,500) |
| SoH below 93% | the two above plus e-C4 (92.1%, 8,100 EUR) and e-2008 (92.8%, 11,500 EUR) | 29,200 EUR | 10.6% (29,200 / 275,500) |

The exposure is self-liquidating: the two lowest-SoH loans have 4 (Zoe) and 3 (Twingo) remaining months of term, so the weakest batteries roll off the pool fastest. Note that the Spring (RSTR status, 34 days past due) is a credit watch item, not a battery one - its SoH is a healthy 95.6%.

## Green framing (narrative)

*This section is narrative only. The demo carries no external verification, no second-party opinion and no certification of any kind.*

An all-electric collateral pool is the natural candidate for a green-labelled auto ABS because the use of proceeds maps directly onto zero-tailpipe-emission transport, the activity class that the EU Taxonomy's climate change mitigation criteria single out for road vehicles. Unlike mixed pools, no screening or carve-out is needed: 100% of the receivables finance battery-electric vehicles by construction. The battery telemetry above (per-battery serial, SoH, cycles, chemistry) is also the kind of data the EU battery passport regime will make standard, which would let a real issuer evidence collateral quality and circular-economy readiness (reuse, second life, recycling) rather than assert it. Turning this narrative into an actual green label would require, at minimum, an external review against a recognised standard (ICMA Green Bond Principles or the EU Green Bond Standard) and taxonomy-alignment reporting - none of which exists for this demo.

## Data wishlist

What a real ESG report would add on top of the fields available here:

- **CO2/km baselines**: WLTP figures per model and a displaced-emissions estimate versus a comparable ICE fleet, with the calculation methodology disclosed.
- **Energy mix**: carbon intensity of the charging electricity (country grid factor at minimum; charging-location data ideally), since well-to-wheel impact depends on it.
- **Battery end-of-life plans**: manufacturer take-back commitments, second-life offtake agreements, recycling rates for the eight cell suppliers, and EU battery passport identifiers once mandatory.
- **Manufacturing footprint**: embedded emissions of vehicle and battery production (Scope 3 view), cell provenance and due-diligence data on critical raw materials.
- **Use-phase telematics**: actual kWh consumed per km and annual mileage, replacing odometer snapshots.
- **Taxonomy evidence**: formal alignment assessment (substantial contribution, do-no-significant-harm, minimum safeguards) and an external verifier's opinion.
- **SoH methodology**: how state of health is measured (BMS readout vs independent diagnostic), measurement dates and calibration, so the battery health analysis above is auditable.
