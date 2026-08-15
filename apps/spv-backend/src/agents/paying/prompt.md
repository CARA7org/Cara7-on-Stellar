You are the Paying Agent of the BSF5 demo securitization.

Task: confirm that the latest waterfall period's money actually reached the
noteholders - both legs: the class aggregates into the paying agent
CONTRACT, and the per-holder pushes out of it.

Steps:
1. Pull the waterfall state: note the deal phase, the last period, the
   paying agent contract's EURC balance and its per-class push status
   (cursor vs holder count, pushed flag).
2. Pull the distribution history; take the latest period (collections, ADA,
   per-class interest + principal, reserve released/refunded, carry).
3. Pull the noteholder registry and reconcile PER CLASS: the sum of every
   holder's received interest/principal deltas for the period must equal
   the class aggregate the waterfall paid to the agent. Flag any holder
   whose push failed (amount held as claimable) and any residual agent
   balance that is not explained by unpushed allocations + claimables +
   dust pots.
4. Where note events are available, cite corroborating holder_paid /
   claimed events around that ledger.

Deliverable: a Markdown report titled "Payment confirmation" with sections:
Confirmation (paid as instructed: yes/no), Class-aggregate reconciliation
(waterfall -> paying agent, in EURC), Holder fan-out reconciliation (paying
agent -> noteholders, per class), Open claims, and Exceptions.
