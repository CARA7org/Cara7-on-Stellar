### Deal S (D1 sequential, D2 full lifecycle, Circle EURC)

Read on 2026-11-23T13:40:30.966Z (testnet), ledgers 5883017 to 5883514.

| Contract | Id | Code (wasm hash) |
|---|---|---|
| abs-deal | `CAYGDU72HJ6LBDOEEIFH2J3DTPCXECQ5WVTTCFZV6JVH76D2HXOEZRUF` | `5a5fedeaff280170ea28fb618a2587d992012e2fab4cab02504b7e50eaaead7a` |
| paying-agent | `CCE6Q3XUOKX2CYBIHWGZPBYVSWONH3UJA6CYP2RLNJCXDKA4FPVSMZW4` | `667fc2fdea335f73a1e2a8a141eb4ba1525a4202124073cec059c45a5d8c1603` |
| note token, Class A | `CDHQ6BBPIHHL4K4P3H2BT5K2AUG22E3WCQWCXAB7RGDDA72WTPP3FGKS` | `4498e0661fa55f2ee71899fe4bba88a49b4d2f195ee390905e1e01cf544201a2` |
| note token, Class B | `CAUGR4VMYIUELXB2JV2RGBT76F2FHXAPMJ4XFWCGJXXYYJ7ONCTT44CL` | `4498e0661fa55f2ee71899fe4bba88a49b4d2f195ee390905e1e01cf544201a2` |
| note token, Class C | `CDAMV6TE66DY3VZVF5UMEXGVTEJKJ35CGWSLSQUULH64EQUGOKQFJRM6` | `4498e0661fa55f2ee71899fe4bba88a49b4d2f195ee390905e1e01cf544201a2` |
| note token, Class D | `CBZHJDN6JMEFISE3DBZWAO3ETFNXKLATIKCENIZD2PLYJVBOHUGHKETY` | `4498e0661fa55f2ee71899fe4bba88a49b4d2f195ee390905e1e01cf544201a2` |
| rate-oracle | `CAMRPVLUPYCMXAMDJXYSTSTUR3FC4JBDE3C7HOF2SMOQHK4KOQ4N2N5Z` |  |
| asset (EURC) | `CCUUDM434BMZMYWYDITHFXHDMIVTGGD6T2I5UKNX5BSLXLW7HVR4MCGZ` |  |

| Role | Address |
|---|---|
| admin (the operator) | `GC5FLOFIOEKU75I3L6GFJFPBY7AABHYH5SYO77G2H2SDWEIY5NZAYLDU` |
| servicer | `GDKAUFUS6KNDECWWQM4UETOAPHZU2AEOSUYVWHLKBXC6IBXWSGIFYIO4` |
| reporter of the oracle | `GB6N5XUASLSGRGRYUFQZ5IHWCMGYVBJZYSZX7FDLOXCD6WYPC274G5QI` |
| seller | `GCEJ3AEJZF764K2IKREKTZGCGRXLPK6CJF2YEKQNEWXBNMGAH6EX4P5L` |

State: Matured. Reserve 0, carry 0, amounts owed 0, balance 0 EURC.

#### Transactions

| Step | Signer | Transaction |
|---|---|---|
| deploy-deal | crank (GDNAV...H4Q2) | [`8f815edb91c1...`](https://stellar.expert/explorer/testnet/tx/8f815edb91c13d1bfa92a1910c4313620de0b875740bbf3ac352ec70ec1954e4) |
| deploy-note-A | crank (GDNAV...H4Q2) | [`7066df4a57cb...`](https://stellar.expert/explorer/testnet/tx/7066df4a57cb372b48893f599cf0036742341f7411b76a964246a9f5c339bf57) |
| deploy-note-B | crank (GDNAV...H4Q2) | [`22b7f5fc5b2f...`](https://stellar.expert/explorer/testnet/tx/22b7f5fc5b2f64e8ac91e423e5e1cc9b6710910e33ce321e06c74c1e3d460b35) |
| deploy-note-C | crank (GDNAV...H4Q2) | [`f274e45eb05c...`](https://stellar.expert/explorer/testnet/tx/f274e45eb05c37a97a3978760721b17cf1a2a00b036236b4bc8578bc94aece1c) |
| deploy-note-D | crank (GDNAV...H4Q2) | [`b406935a1870...`](https://stellar.expert/explorer/testnet/tx/b406935a1870e0c120327243350d807293432d9bfb51ee03c3e41e426620b005) |
| deploy-paying-agent | crank (GDNAV...H4Q2) | [`12b24f5121ae...`](https://stellar.expert/explorer/testnet/tx/12b24f5121aec5d64c656c7c44e6ad9aa02c5cf110368a230ef1c8b02a4e0489) |
| set-wiring | admin (GC5FL...YLDU) | [`eccbcc6c9177...`](https://stellar.expert/explorer/testnet/tx/eccbcc6c91776304983fc008a5ad92dcaf158fbc7fdf9686d5eee7f781a833c9) |
| set-eligible | admin (GC5FL...YLDU) | [`8d3d545eed98...`](https://stellar.expert/explorer/testnet/tx/8d3d545eed9844071aa4319d1725a9edb4ef10bde240468082bf3631bc8cb11b) |
| subscribe, Class A, 3 note(s) | holder (GCWQG...UA7L) | [`2fb5221b3a0c...`](https://stellar.expert/explorer/testnet/tx/2fb5221b3a0c3426406c05d1d7713c86044b30d967523460bde09fc73117dc1a) |
| subscribe, Class A, 1 note(s) | holder (GANNY...3TJ6) | [`d48f07b34be7...`](https://stellar.expert/explorer/testnet/tx/d48f07b34be799eb636c3e79e921971438869e6495e63c99aa1f6fa9e3ded473) |
| subscribe, Class B, 3 note(s) | holder (GC57K...TYXE) | [`fb73d204720f...`](https://stellar.expert/explorer/testnet/tx/fb73d204720f98702c0a27dc7ce5fa6efd5f38128b6f44150019d488fef3a5f2) |
| subscribe, Class C, 2 note(s) | holder (GCXLO...IQXM) | [`93cfb5470916...`](https://stellar.expert/explorer/testnet/tx/93cfb5470916ce9e11957baf94dc904607a24120bf27589fb135bc83e3a30362) |
| subscribe, Class D, 1 note(s) | holder (GANNY...3TJ6) | [`d8c6c3219695...`](https://stellar.expert/explorer/testnet/tx/d8c6c321969599f4307aa7d46da63ce9a9b544e905c881c50157380ea4f31484) |
| cancel, Class C, 1 note(s) | holder (GCXLO...IQXM) | [`c6a0ad5828cb...`](https://stellar.expert/explorer/testnet/tx/c6a0ad5828cbeffa9c8b6bee56673cbdfb19bf39ed0aab26c3ce47812dd70794) |
| subscribe, Class C, 1 note(s) | holder (GCXLO...IQXM) | [`1ee1f77c9691...`](https://stellar.expert/explorer/testnet/tx/1ee1f77c969120e698a3b5e2fb2522fe980ad4099a09856a8e17e9bdacca5f1c) |
| fund_sub_loan | seller (GCEJ3...4P5L) | [`3009dd66743b...`](https://stellar.expert/explorer/testnet/tx/3009dd66743b886f9a22ca764724e8ee4ca976d1aff6a90247daac6122465c15) |
| close (closing DvP) | admin (GC5FL...YLDU) | [`9880e8c3d4e0...`](https://stellar.expert/explorer/testnet/tx/9880e8c3d4e0a639ed3ff701a1fc53f35db11f7f468f117fb62bc6e73bcc0e0a) |
| distribute, period 1 | servicer (GDKAU...YIO4) | [`ba25223c424b...`](https://stellar.expert/explorer/testnet/tx/ba25223c424b0964faf9b70ff0eb6ed6f7fd7acb66e56ac6e24a8cf5b23ddd03) |
| push_batch, period 1, Class A | crank (GDNAV...H4Q2) | [`461dff4196d3...`](https://stellar.expert/explorer/testnet/tx/461dff4196d3aadf2120df5eb04d374e0fa11e0f09a38e7d7883e17b4ea181f4) |
| push_batch, period 1, Class B, 1 push failed | crank (GDNAV...H4Q2) | [`882c258f4156...`](https://stellar.expert/explorer/testnet/tx/882c258f41565abc7ee0969d55d00e2b2878abfb0f877ee7ee413fc7aca8ad0d) |
| push_batch, period 1, Class C | crank (GDNAV...H4Q2) | [`6e1e7b57d395...`](https://stellar.expert/explorer/testnet/tx/6e1e7b57d395c75cd736c4dee6f593433f83a905ce925aee0113984ffea90f82) |
| push_batch, period 1, Class D | crank (GDNAV...H4Q2) | [`1264257c4a69...`](https://stellar.expert/explorer/testnet/tx/1264257c4a69c6bba008ff1b1d3457cd8cc79d1e291993c9eb30318967958562) |
| note transfer, 1 note(s) | holder (GCWQG...UA7L) | [`976075eaedd1...`](https://stellar.expert/explorer/testnet/tx/976075eaedd1dd8628b939ca17098b6a7cf18a9472a4f08ae21414e1a8e29c02) |
| distribute, period 2 (maturity) | servicer (GDKAU...YIO4) | [`4427c76e7479...`](https://stellar.expert/explorer/testnet/tx/4427c76e7479923ea6be5bf82871b115c1007c2d8fdbc64250cbb1838bf269bf) |
| push_batch, period 2, Class A | crank (GDNAV...H4Q2) | [`a43476b8fc31...`](https://stellar.expert/explorer/testnet/tx/a43476b8fc310a0c1bc8c187dd4c50f7055b1285c08c44e143cc74cf0e2d29c0) |
| push_batch, period 2, Class B, 1 push failed | crank (GDNAV...H4Q2) | [`8833efadbe8b...`](https://stellar.expert/explorer/testnet/tx/8833efadbe8b8f487554e86cc216826f271acc4f6e6397f34f3738626cc9bf19) |
| push_batch, period 2, Class C | crank (GDNAV...H4Q2) | [`ccbe9b3b61d8...`](https://stellar.expert/explorer/testnet/tx/ccbe9b3b61d8fd4587f91e3832d9f895580c3bdfafd43cece1fc052331ccb38c) |
| push_batch, period 2, Class D | crank (GDNAV...H4Q2) | [`fc84897502d8...`](https://stellar.expert/explorer/testnet/tx/fc84897502d8f3a651befe8f0a38f0bdf34798f8719ab358cccb148ac78319d1) |
| claim (paying agent) | holder (GC57K...TYXE) | [`77b55cc14d56...`](https://stellar.expert/explorer/testnet/tx/77b55cc14d56f509ec11a2c83ae1554d2379e36ab907ab720a5bfbb6b280d738) |

#### Period 1: normal order

Transaction [`ba25223c424b...`](https://stellar.expert/explorer/testnet/tx/ba25223c424b0964faf9b70ff0eb6ed6f7fd7acb66e56ac6e24a8cf5b23ddd03).

| Rank | Item | Due | Paid | Dust to the carry |
|---|---|---|---|---|
| `fees` | Fee line 0 | 0.1 | 0.1 | 0 |
| `int_a` | Interest, Class A | 0.3084 | 0.28 | 0.0284 |
| `int_b` | Interest, Class B | 0.1125 | 0.09 | 0.0225 |
| `int_c` | Interest, Class C | 0.125 | 0.12 | 0.005 |
| `int_d` | Interest, Class D | 0.1 | 0.1 | 0 |
| `reserve` | Reserve re-fund | 5 | 5 | 0 |
| `principal` | Principal, Class A | 40 | 34.24 | 0.0141 |
| `principal` | Principal, Class B | 30 | 0 | 0 |
| `principal` | Principal, Class C | 20 | 0 | 0 |
| `principal` | Principal, Class D | 10 | 0 | 0 |

| Collections | Reserve in | Carry in | Drawn | Paid out | Reserve | Carry | Owed | Balance | Surplus |
|---|---|---|---|---|---|---|---|---|---|
| 35 | 5 | 0 | 0 | 34.93 | 5 | 0.07 | 0 | 5.07 | 0 |

Conservation: 35 + 5 + 0 = 34.93 + 5 + 0.07. Balance invariant: 5.07 >= 5.07.

#### Period 2: normal order

Transaction [`4427c76e7479...`](https://stellar.expert/explorer/testnet/tx/4427c76e7479923ea6be5bf82871b115c1007c2d8fdbc64250cbb1838bf269bf).

| Rank | Item | Due | Paid | Dust to the carry |
|---|---|---|---|---|
| `fees` | Fee line 0 | 0.1 | 0.1 | 0 |
| `int_a` | Interest, Class A | 0.0444096 | 0.04 | 0.0044096 |
| `int_b` | Interest, Class B | 0.1125 | 0.09 | 0.0225 |
| `int_c` | Interest, Class C | 0.125 | 0.12 | 0.005 |
| `int_d` | Interest, Class D | 0.1 | 0.1 | 0 |
| `reserve` | Reserve re-fund | 5 | 5 | 0 |
| `principal` | Principal, Class A | 5.76 | 5.76 | 0 |
| `principal` | Principal, Class B | 30 | 30 | 0 |
| `principal` | Principal, Class C | 20 | 20 | 0 |
| `principal` | Principal, Class D | 10 | 10 | 0 |

| Collections | Reserve in | Carry in | Drawn | Paid out | Reserve | Carry | Owed | Balance | Surplus |
|---|---|---|---|---|---|---|---|---|---|
| 66.1719096 | 5 | 0.07 | 0 | 71.2419096 | 0 | 0 | 0 | 0 | 0 |

Conservation: 66.1719096 + 5 + 0.07 = 71.2419096 + 0 + 0. Balance invariant: 0 >= 0.

#### Holders: cumulative counters of the paying agent

| Class | Holder | Notes | Interest received | Principal received | Waits in the paying agent |
|---|---|---|---|---|---|
| A | `GCWQGIECM7NNQ7NV6OQVTCSDVUSCGM3TQB5NWOQV3O5QA6BT2MZFUA7L` | 2 | 0.237 | 28.56 | 0 |
| A | `GANNYPKO4FUVMIMW4EECRQKKCVECXTZI7HM55EFVPU6AZLTTJH4K3TJ6` | 1 | 0.08 | 10 | 0 |
| A | `GCXLOCBQPAS54C3MSBMA223COJE7HRAGJ3KJEN376FNDUL7LQ5JKIQXM` | 1 | 0.003 | 1.44 | 0 |
| B | `GC57KOHW37LN3YFIPXW7A462DZZBOM4KFRLYKBHHQWLE4AVCZYCNTYXE` | 3 | 0.18 | 30 | 0 |
| C | `GCXLOCBQPAS54C3MSBMA223COJE7HRAGJ3KJEN376FNDUL7LQ5JKIQXM` | 2 | 0.24 | 20 | 0 |
| D | `GANNYPKO4FUVMIMW4EECRQKKCVECXTZI7HM55EFVPU6AZLTTJH4K3TJ6` | 1 | 0.2 | 10 | 0 |

#### Operations of the accounts

| Account | Operation | Result | Transaction |
|---|---|---|---|
| `GC57K...TYXE` | payment | success | [`aef28d9b5d7f...`](https://stellar.expert/explorer/testnet/tx/aef28d9b5d7f2562358c70412a6ff46c4d1dc64eeccb3ddfe1b3041c19a5cb60) |
| `GC57K...TYXE` | payment | success | [`75dda162d519...`](https://stellar.expert/explorer/testnet/tx/75dda162d5198413c753a60b3874c49ab1b83b7429569e5ca7ab070cbe780671) |
| `GC57K...TYXE` | subscribe | success | [`fb73d204720f...`](https://stellar.expert/explorer/testnet/tx/fb73d204720f98702c0a27dc7ce5fa6efd5f38128b6f44150019d488fef3a5f2) |
| `GC57K...TYXE` | change_trust EURC (removed) | success | [`13eba94c65d0...`](https://stellar.expert/explorer/testnet/tx/13eba94c65d097722907dafc3608afac48bbd21ea00726d84d0e80bacae88068) |
| `GC57K...TYXE` | change_trust EURC | success | [`42a75113f9ff...`](https://stellar.expert/explorer/testnet/tx/42a75113f9ff2b5e591b1aef61f1f85acef7c5615237ae6db029abe44b330fa1) |
| `GC57K...TYXE` | claim | success | [`77b55cc14d56...`](https://stellar.expert/explorer/testnet/tx/77b55cc14d56f509ec11a2c83ae1554d2379e36ab907ab720a5bfbb6b280d738) |

#### Checks

| Check | Result | Detail |
|---|---|---|
| B1 Same contract code as the other deals | PASS | abs-deal 5a5fedeaff280170ea28fb618a2587d992012e2fab4cab02504b7e50eaaead7a, the same as CCEW5FTOZHOPQLZPJESF7F6RCZCOVAEDIQDXU6FD66XGYINQKLJ4CQI3. |
| R1 The admin, the servicer and the reporter are separate addresses | PASS | Three different addresses. |
| L1 Closing: delivery versus payment | PASS | In one transaction: 100 to the seller, 5 to the reserve, every note issued. |
| C1 One settlement event for each payment date | PASS | 2 payment date(s), each with its period_settled and rank_lines events. |
| C2 The rank lines follow the configured order | PASS | Each line is a rank of the configuration, in its order. |
| C3 Each line pays at most its due | PASS | For each line: 0 <= paid, and paid + dust <= due. |
| C4 Conservation: collections + reserve + carry in = paid out + reserve + carry | PASS | In each period_settled event, and against the payments of the same transaction. |
| C5 Balance invariant: balance >= reserve + carry + amounts owed | PASS | In each period_settled event. Now: balance 0, reserve 0, carry 0, owed 0. |
| C6 Each period opens with the ledgers of the period before | PASS | Reserve and carry chain from the closing to the ledgers of the deal now. |
| C7 The interest, principal and paying agent events agree with the rank lines | PASS | For each class: interest_paid and period_funded carry the amounts of the lines. |
| C8 A replay with the copy of the engine gives the same lines | PASS | 2 payment date(s): the copy of the engine gives the same lines and the same settlement. |
| H1 Each holder: cumulative counters = holder_paid + claimed events | PASS | 6 holder position(s): interest and principal counters equal the events. |
| H2 Each failed push is claimed or waits for its holder | PASS | Failed pushes 30.18 = claimed 30.18 + open 0. |
| H3 Every holder of every class was served at each payment date | PASS | 8 class payment(s): each one has a complete batch_done event. |
| H4 The paying agent holds only the open claims and the rounding remainder | PASS | Balance 0 = open claims 0 + remainder 0. |
| L2 A matured deal has empty ledgers | PASS | Every class is repaid, no interest is unpaid, reserve and carry are 0, and the balance is the amounts owed. |

