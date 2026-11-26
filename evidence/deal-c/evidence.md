### Deal C (D3 Dfns custody, self-issued test EURC)

Read on 2026-11-24T06:55:42.883Z (testnet), ledgers 5893150 to 5895936.

| Contract | Id | Code (wasm hash) |
|---|---|---|
| abs-deal | `CBNPFPUNWJEKX5EJHFS2BJI43V4DN4WWRGTDH44ZKEEN26ZGQWVHOQ2C` | `5a5fedeaff280170ea28fb618a2587d992012e2fab4cab02504b7e50eaaead7a` |
| paying-agent | `CCP7LGA3W6GYEP2CFMIGMFILYDW5HWVDTOVYXNYEDEGQ6IFBCHTLJLQR` | `667fc2fdea335f73a1e2a8a141eb4ba1525a4202124073cec059c45a5d8c1603` |
| note token, Class A | `CAFJORGHJ63AQD55JATT5VX7LZ7WHNA25UQ74I73WL55IEA4FJB543IJ` | `4498e0661fa55f2ee71899fe4bba88a49b4d2f195ee390905e1e01cf544201a2` |
| note token, Class B | `CDNCI4CVPSD6LOJH3Z6N5OFPDWT6442SPO3Q6XFG4323DYG3DNOSQCYY` | `4498e0661fa55f2ee71899fe4bba88a49b4d2f195ee390905e1e01cf544201a2` |
| note token, Class C | `CAMNNSHHKJFYMPZSFSEMVZMT7INTIDFYASAJXRTZIZ6OPAV5MXBWPSFN` | `4498e0661fa55f2ee71899fe4bba88a49b4d2f195ee390905e1e01cf544201a2` |
| rate-oracle | `CATT7CLFJ5HMF62NCX3AQ644R47BKA37QCNO3JO2XGFJBP4XDI56O3F2` |  |
| asset (EURC) | `CBEO2RDQKBM7S3TYOYKBWAJEC6WMYPCW6JJWX47UCLFMUJI2EUZPJOXW` |  |

| Role | Address |
|---|---|
| admin (the operator) | `GAETDRSUVCR3WIMUXDSMTMG3ZVTYVLGIEW4C4ISPTWZWEEVM436ZCMHK` |
| servicer | `GBHYXZJPKYQA4L4N52LUFSKRZ4QKZHKDEPUWMNEBTOACGA5T3IMKYNSG` |
| reporter of the oracle | `GAQ7GZ2OSPIPIIF6WQ5XPHZJZ4IPOSZVH6X4IOHGWT32CYJB45ZJUIQM` |
| seller | `GCV6OX6GKQOJJGD3DTF5AIENK3EKR64OPHCNCX5MGZUT2KTDD5QGFFRI` |

State: Amortizing. Reserve 100, carry 0.14, amounts owed 0, balance 100.14 EURC.

#### Transactions

| Step | Signer | Transaction |
|---|---|---|
| deploy-deal | crank (GAJ2I...REHO) | [`addddd8ebb2a...`](https://stellar.expert/explorer/testnet/tx/addddd8ebb2adcbbf67802a880fa10591e49a1ee7e71a3ebbcc0d3371951f87a) |
| deploy-note-A | crank (GAJ2I...REHO) | [`14443b1486ec...`](https://stellar.expert/explorer/testnet/tx/14443b1486ec998e30fc7b4d88ee77a1f4630d966d41a7c5c820323d01f3f3d9) |
| deploy-note-B | crank (GAJ2I...REHO) | [`d127b7ba5699...`](https://stellar.expert/explorer/testnet/tx/d127b7ba5699a58169882488f0bac774cf049829e4d5b1a9525085c4018c2b34) |
| deploy-note-C | crank (GAJ2I...REHO) | [`ddfaca31a7cf...`](https://stellar.expert/explorer/testnet/tx/ddfaca31a7cf4b58bff2f8a82e69fa58d34ce950697f0b2e9505a29ffdbbc4a8) |
| deploy-paying-agent | crank (GAJ2I...REHO) | [`a7f017148dbb...`](https://stellar.expert/explorer/testnet/tx/a7f017148dbb739c02dc6c7411c9ea7b01199a510acb2df0ac5253c9655abf22) |
| set-wiring | admin (GAETD...CMHK) | [`d76c76e14e01...`](https://stellar.expert/explorer/testnet/tx/d76c76e14e01b353d9938e4f0ebc90764526046d3f47f74d905321a13d388d45) |
| set-eligible | admin (GAETD...CMHK) | [`f3904b8a3554...`](https://stellar.expert/explorer/testnet/tx/f3904b8a3554a1b432df9e751ee39aa3c34fd48461b3799adc34f66232d92d6a) |
| subscribe, Class A, 2 note(s) | holder (GDCXL...NIWV) | [`5edaab51eb1d...`](https://stellar.expert/explorer/testnet/tx/5edaab51eb1d20e92afc08fac2e36c7a1647f655ebe2ff4d04da1c059792e91c) |
| subscribe, Class A, 5 note(s) | holder (GDCXL...NIWV) | [`0f83b44cb92b...`](https://stellar.expert/explorer/testnet/tx/0f83b44cb92bb701f657b440306d78463da3658ce4a4c62851d25809fc8d7667) |
| cancel, Class A, 1 note(s) | holder (GDCXL...NIWV) | [`d5e1bd52738e...`](https://stellar.expert/explorer/testnet/tx/d5e1bd52738e70076027b9d853a586dc82b12e92d3b6f7a66aa58552d65edac8) |
| subscribe, Class A, 1 note(s) | holder (GDCXL...NIWV) | [`b060179132a5...`](https://stellar.expert/explorer/testnet/tx/b060179132a5db96138faac6b5e9419fb64b491156142c80dea8e8d172e0e87d) |
| subscribe, Class B, 1 note(s) | other (GBYGT...KY7V) | [`1c83e4f0c571...`](https://stellar.expert/explorer/testnet/tx/1c83e4f0c571cd3a967bc530841f1cbcb4834d24e166eb8302cfe62af86977a3) |
| cancel, Class B, 1 note(s) | other (GBYGT...KY7V) | [`5ad50b7a5807...`](https://stellar.expert/explorer/testnet/tx/5ad50b7a580725f72ae96276277124f782f8f405763183916d775c1b0b711d2b) |
| subscribe, Class A, 3 note(s) | seller, holder (GCV6O...FFRI) | [`567782b94757...`](https://stellar.expert/explorer/testnet/tx/567782b9475769c687885a6a2c81127720accee5dfcdabfaede3085053d70a09) |
| subscribe, Class B, 5 note(s) | seller, holder (GCV6O...FFRI) | [`49467d54c756...`](https://stellar.expert/explorer/testnet/tx/49467d54c756263854d571a94585177d2fc1cc760e712c6484ab5c1265b524a9) |
| subscribe, Class C, 3 note(s) | seller, holder (GCV6O...FFRI) | [`cf16dc4ca6d1...`](https://stellar.expert/explorer/testnet/tx/cf16dc4ca6d17a7212d949e3b4adce3b5206b8a067277552d0697ce60538425f) |
| fund_sub_loan | seller, holder (GCV6O...FFRI) | [`540f2b992a8a...`](https://stellar.expert/explorer/testnet/tx/540f2b992a8a72cc466522bf3cb884e08acb28943c0aafda5d960f60ce8ba7a7) |
| close (closing DvP) | admin (GAETD...CMHK) | [`2513f5c1c8f1...`](https://stellar.expert/explorer/testnet/tx/2513f5c1c8f14abb2e3cce7e63e39e09cbce25829f6d1b488cdec56c80218b68) |
| set_rate, 2484 units | reporter (GAQ7G...UIQM) | [`faf9ce1f2e93...`](https://stellar.expert/explorer/testnet/tx/faf9ce1f2e9323ee1268bc20cc7a13654df898558d0ebfc22e9184872c029e6b) |
| distribute, period 1 | servicer (GBHYX...YNSG) | [`32010a285df5...`](https://stellar.expert/explorer/testnet/tx/32010a285df5cb4b63d660f0f209f3c49c523194de876100ecd1f8b9843dbe23) |
| push_batch, period 1, Class A, 1 push failed | crank (GAJ2I...REHO) | [`a989bb25bcdd...`](https://stellar.expert/explorer/testnet/tx/a989bb25bcdd095ea7e1f0df7279d163ef0aec2d0c19c15cddf4c58eb6bfe41a) |
| push_batch, period 1, Class B | crank (GAJ2I...REHO) | [`a4b3a7791d92...`](https://stellar.expert/explorer/testnet/tx/a4b3a7791d9220c0b3753e18768204d0d6480baed2744b18ea17f7ee98d8bfbe) |
| push_batch, period 1, Class C | crank (GAJ2I...REHO) | [`29dd0a4ae5e8...`](https://stellar.expert/explorer/testnet/tx/29dd0a4ae5e8db8147da3d1d62b9d2f2ebf1a0ec6fe70bd8d2ca63038bf35121) |
| claim (paying agent) | holder (GDCXL...NIWV) | [`1561e7836777...`](https://stellar.expert/explorer/testnet/tx/1561e7836777d73fd5e0fef3beee0841266ac4c1599fb12dd7defb27ecd95013) |

#### Period 1: normal order

Transaction [`32010a285df5...`](https://stellar.expert/explorer/testnet/tx/32010a285df5cb4b63d660f0f209f3c49c523194de876100ecd1f8b9843dbe23).

| Rank | Item | Due | Paid | Dust to the carry |
|---|---|---|---|---|
| `fees` | Fee line 0 | 5 | 5 | 0 |
| `int_a` | Interest, Class A | 2.57 | 2.5 | 0.07 |
| `int_b` | Interest, Class B | 0.4166666 | 0.4 | 0.0166666 |
| `int_c` | Interest, Class C | 0.375 | 0.36 | 0.015 |
| `reserve` | Reserve re-fund | 100 | 100 | 0 |
| `principal` | Principal, Class A | 1000 | 291.6 | 0.0383334 |
| `principal` | Principal, Class B | 500 | 0 | 0 |
| `principal` | Principal, Class C | 300 | 0 | 0 |

| Collections | Reserve in | Carry in | Drawn | Paid out | Reserve | Carry | Owed | Balance | Surplus |
|---|---|---|---|---|---|---|---|---|---|
| 300 | 100 | 0 | 0 | 299.86 | 100 | 0.14 | 0 | 100.14 | 0 |

Conservation: 300 + 100 + 0 = 299.86 + 100 + 0.14. Balance invariant: 100.14 >= 100.14.

#### Holders: cumulative counters of the paying agent

| Class | Holder | Notes | Interest received | Principal received | Waits in the paying agent |
|---|---|---|---|---|---|
| A | `GDCXLJCUWFHD56327BBOCTGY3ICMDLOSOSQJE37IZOWZP7UWL2HUNIWV` | 7 | 1.75 | 204.12 | 0 |
| A | `GCV6OX6GKQOJJGD3DTF5AIENK3EKR64OPHCNCX5MGZUT2KTDD5QGFFRI` | 3 | 0.75 | 87.48 | 0 |
| B | `GCV6OX6GKQOJJGD3DTF5AIENK3EKR64OPHCNCX5MGZUT2KTDD5QGFFRI` | 5 | 0.4 | 0 | 0 |
| C | `GCV6OX6GKQOJJGD3DTF5AIENK3EKR64OPHCNCX5MGZUT2KTDD5QGFFRI` | 3 | 0.36 | 0 | 0 |

#### Operations of the accounts

| Account | Operation | Result | Transaction |
|---|---|---|---|
| `GDCXL...NIWV` | change_trust EURC | success | [`5f628e5fc2b6...`](https://stellar.expert/explorer/testnet/tx/5f628e5fc2b639f30c0e402703cd3e04ead23a0bae1adaaac20609e02a7e2431) |
| `GDCXL...NIWV` | transfer | success | [`c684a640ee4d...`](https://stellar.expert/explorer/testnet/tx/c684a640ee4decb03caa9fc1d7cf907af44f2a1409bc423b77c36139dfe07f76) |
| `GDCXL...NIWV` | subscribe | success | [`5edaab51eb1d...`](https://stellar.expert/explorer/testnet/tx/5edaab51eb1d20e92afc08fac2e36c7a1647f655ebe2ff4d04da1c059792e91c) |
| `GDCXL...NIWV` | subscribe | success | [`0f83b44cb92b...`](https://stellar.expert/explorer/testnet/tx/0f83b44cb92bb701f657b440306d78463da3658ce4a4c62851d25809fc8d7667) |
| `GDCXL...NIWV` | cancel | success | [`d5e1bd52738e...`](https://stellar.expert/explorer/testnet/tx/d5e1bd52738e70076027b9d853a586dc82b12e92d3b6f7a66aa58552d65edac8) |
| `GDCXL...NIWV` | subscribe | success | [`b060179132a5...`](https://stellar.expert/explorer/testnet/tx/b060179132a5db96138faac6b5e9419fb64b491156142c80dea8e8d172e0e87d) |
| `GDCXL...NIWV` | change_trust EURC (removed) | success | [`18bbfac7bcee...`](https://stellar.expert/explorer/testnet/tx/18bbfac7bcee1086d683bf807ac17aa5a2c713da1348382b8b5f62bf80cf72b3) |
| `GDCXL...NIWV` | change_trust EURC | success | [`8b35ee435473...`](https://stellar.expert/explorer/testnet/tx/8b35ee4354737eb287afad19341db99da3d8d7d5d20087dc226704cc8c51cbc5) |
| `GDCXL...NIWV` | claim | success | [`1561e7836777...`](https://stellar.expert/explorer/testnet/tx/1561e7836777d73fd5e0fef3beee0841266ac4c1599fb12dd7defb27ecd95013) |
| `GBYGT...KY7V` | change_trust EURC | success | [`fd455520028e...`](https://stellar.expert/explorer/testnet/tx/fd455520028eb7cee148ad87d2093430a15b4953e5da7e94c0faeecab726f7d6) |
| `GBYGT...KY7V` | transfer | success | [`0abe3523df17...`](https://stellar.expert/explorer/testnet/tx/0abe3523df17eb58d86a4ffc9e04341bd0b150553629225593d9fb3ba013f4a7) |
| `GBYGT...KY7V` | subscribe | success | [`1c83e4f0c571...`](https://stellar.expert/explorer/testnet/tx/1c83e4f0c571cd3a967bc530841f1cbcb4834d24e166eb8302cfe62af86977a3) |
| `GBYGT...KY7V` | cancel | success | [`5ad50b7a5807...`](https://stellar.expert/explorer/testnet/tx/5ad50b7a580725f72ae96276277124f782f8f405763183916d775c1b0b711d2b) |

#### Checks

| Check | Result | Detail |
|---|---|---|
| B1 Same contract code as the other deals | PASS | abs-deal 5a5fedeaff280170ea28fb618a2587d992012e2fab4cab02504b7e50eaaead7a, the same as CAYGDU72HJ6LBDOEEIFH2J3DTPCXECQ5WVTTCFZV6JVH76D2HXOEZRUF, CCEW5FTOZHOPQLZPJESF7F6RCZCOVAEDIQDXU6FD66XGYINQKLJ4CQI3. |
| R1 The admin, the servicer and the reporter are separate addresses | PASS | Three different addresses. |
| L1 Closing: delivery versus payment | PASS | In one transaction: 1800 to the seller, 100 to the reserve, every note issued. |
| C1 One settlement event for each payment date | PASS | 1 payment date(s), each with its period_settled and rank_lines events. |
| C2 The rank lines follow the configured order | PASS | Each line is a rank of the configuration, in its order. |
| C3 Each line pays at most its due | PASS | For each line: 0 <= paid, and paid + dust <= due. |
| C4 Conservation: collections + reserve + carry in = paid out + reserve + carry | PASS | In each period_settled event, and against the payments of the same transaction. |
| C5 Balance invariant: balance >= reserve + carry + amounts owed | PASS | In each period_settled event. Now: balance 100.14, reserve 100, carry 0.14, owed 0. |
| C6 Each period opens with the ledgers of the period before | PASS | Reserve and carry chain from the closing to the ledgers of the deal now. |
| C7 The interest, principal and paying agent events agree with the rank lines | PASS | For each class: interest_paid and period_funded carry the amounts of the lines. |
| C8 A replay with the copy of the engine gives the same lines | PASS | 1 payment date(s): the copy of the engine gives the same lines and the same settlement. |
| H1 Each holder: cumulative counters = holder_paid + claimed events | PASS | 4 holder position(s): interest and principal counters equal the events. |
| H2 Each failed push is claimed or waits for its holder | PASS | Failed pushes 205.87 = claimed 205.87 + open 0. |
| H3 Every holder of every class was served at each payment date | PASS | 3 class payment(s): each one has a complete batch_done event. |
| H4 The paying agent holds only the open claims and the rounding remainder | PASS | Balance 0 = open claims 0 + remainder 0. |
| L2 A matured deal has empty ledgers | SKIP | The deal is Amortizing. |

