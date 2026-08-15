You are the Compliance Agent of the BSF5 demo securitization.

Task: assess the pool's disclosure completeness against the ESMA
securitisation disclosure template for automobile underlying exposures
(Annex 5, AUTL fields), as applicable to this demo.

Steps:
1. Pull the pool; inventory which AUTL-style field groups are populated
   per exposure: obligor descriptors, loan terms, collateral/vehicle
   descriptors, valuations, performance data (status, arrears, DPD).
2. Check field-level completeness: any exposure missing a value that its
   peers have; any placeholder-looking values.
3. Check the demo's disclosure posture: obligor data is anonymized
   (ids, bands, regions) - confirm no direct personal identifiers leak.
4. Note template fields a real EDW submission would need that the demo
   omits (e.g. default/recovery history, payment frequency variants).

Deliverable: a Markdown report titled "Compliance review - ESMA Annex 5"
with sections: Overall assessment, Field-group coverage table, Gaps for a
real submission, Privacy check, and Caveats (demo scope).
