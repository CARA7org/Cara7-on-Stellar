### Deal P (D1, pro rata then sequential)

Read on 2026-11-23T13:39:59.359Z (testnet), ledgers 5882909 to 5883508.

| Contract | Id | Code (wasm hash) |
|---|---|---|
| abs-deal | `CCEW5FTOZHOPQLZPJESF7F6RCZCOVAEDIQDXU6FD66XGYINQKLJ4CQI3` | `5a5fedeaff280170ea28fb618a2587d992012e2fab4cab02504b7e50eaaead7a` |
| paying-agent | `CBGB7CXQPGVBIDMPOZCYZU3ZS32YQYU26SJD3B5VA7IS2IHHVTMXRBHC` | `667fc2fdea335f73a1e2a8a141eb4ba1525a4202124073cec059c45a5d8c1603` |
| note token, Class A | `CC65LFMB2EUBCKVURUYE7ELZOFTDDVUCC5NG4ZNKU332QPWQBDIGVHJO` | `4498e0661fa55f2ee71899fe4bba88a49b4d2f195ee390905e1e01cf544201a2` |
| note token, Class B | `CBKSDTYBZAQALDC2SLBYSN3ZTYMVJ24PPVKC5F42CKO2RDZKUOVNBDMT` | `4498e0661fa55f2ee71899fe4bba88a49b4d2f195ee390905e1e01cf544201a2` |
| note token, Class C | `CC3BTSPG4PDOXYNRGCVPY5AVQ6QTQQY2UP3SIIBTBPLQTZCN7FIWUVM7` | `4498e0661fa55f2ee71899fe4bba88a49b4d2f195ee390905e1e01cf544201a2` |
| rate-oracle | `CAMRPVLUPYCMXAMDJXYSTSTUR3FC4JBDE3C7HOF2SMOQHK4KOQ4N2N5Z` |  |
| asset (EURC) | `CBEO2RDQKBM7S3TYOYKBWAJEC6WMYPCW6JJWX47UCLFMUJI2EUZPJOXW` |  |

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
| deploy-deal | crank (GDNAV...H4Q2) | [`8ffc2996aa6e...`](https://stellar.expert/explorer/testnet/tx/8ffc2996aa6e88765115c8fe56cb0950c0b57f08b26e3ca71aa772d9f1b2adcc) |
| deploy-note-A | crank (GDNAV...H4Q2) | [`62f6285e6aae...`](https://stellar.expert/explorer/testnet/tx/62f6285e6aae62281fca2176e13fe2f82980ea0dc01c923b1004e5a32d274eec) |
| deploy-note-B | crank (GDNAV...H4Q2) | [`ad32b7030558...`](https://stellar.expert/explorer/testnet/tx/ad32b7030558721b65d26fd3ab591217c571868aa5aa3165fe2d7539879b2bf3) |
| deploy-note-C | crank (GDNAV...H4Q2) | [`7ee7646e32d9...`](https://stellar.expert/explorer/testnet/tx/7ee7646e32d94bb08b091b4597ad4c343f62e51917b136ba6271620e79f4aaf4) |
| deploy-paying-agent | crank (GDNAV...H4Q2) | [`a66b4a8198db...`](https://stellar.expert/explorer/testnet/tx/a66b4a8198dba2b6da52296fb245234f1fcd8a6c8fd4e7142b4c8096e8f511c0) |
| set-wiring | admin (GC5FL...YLDU) | [`0794160d173f...`](https://stellar.expert/explorer/testnet/tx/0794160d173f7b357e949cc2f98dd6eea536a5cbef4f21781217eb1cbef2e780) |
| set-eligible | admin (GC5FL...YLDU) | [`a2c5a58b82ee...`](https://stellar.expert/explorer/testnet/tx/a2c5a58b82eef5f422c95620ba075ac82bc2317595f85e3506c2665cfc6de7ee) |
| subscribe, Class A, 6 note(s) | holder (GCWQG...UA7L) | [`4ab3d78bfaea...`](https://stellar.expert/explorer/testnet/tx/4ab3d78bfaea7baa6837148fecef630c3074a73c9bf3a08aef7dbb1989a6dba5) |
| subscribe, Class B, 3 note(s) | holder (GC57K...TYXE) | [`6f2925e1c8b5...`](https://stellar.expert/explorer/testnet/tx/6f2925e1c8b595718648233094029cf43e4a2b7113a466528db953b9e84296f1) |
| subscribe, Class C, 1 note(s) | holder (GCXLO...IQXM) | [`cd12cfcc583b...`](https://stellar.expert/explorer/testnet/tx/cd12cfcc583bbff64c4b6d4b0c0abb9b42963d52dd8216c3fd12d614dcb750b0) |
| fund_sub_loan | seller (GCEJ3...4P5L) | [`592299fe9b69...`](https://stellar.expert/explorer/testnet/tx/592299fe9b69dfb136e907adceebbf6059c766cc40572baf27ef7a66f9f27876) |
| close (closing DvP) | admin (GC5FL...YLDU) | [`0e6df8dbe3ca...`](https://stellar.expert/explorer/testnet/tx/0e6df8dbe3cac3619a4d85530b12f467d324e078390dcba70dbeb7cbf34cd29a) |
| set_rate, 2484 units | reporter (GB6N5...G5QI) | [`35c224283b9a...`](https://stellar.expert/explorer/testnet/tx/35c224283b9aa656dac4adb0fd6d5987b1a6895bc7aaee8e0e766e42d9f1d25f) |
| distribute, period 1 | servicer (GDKAU...YIO4) | [`5846de605e05...`](https://stellar.expert/explorer/testnet/tx/5846de605e051691611313c7041ee971a60bb995934ab7c71d58bc87633c906a) |
| push_batch, period 1, Class A | crank (GDNAV...H4Q2) | [`95dcd7ecc538...`](https://stellar.expert/explorer/testnet/tx/95dcd7ecc538473a6b35e2b7aabbb963a693c6bd20bf855dcc9254eb9d9664b1) |
| push_batch, period 1, Class B | crank (GDNAV...H4Q2) | [`dabc260b281b...`](https://stellar.expert/explorer/testnet/tx/dabc260b281bf9450c32d8390d3f102a5028b0776008da75ee117631a31c5a08) |
| push_batch, period 1, Class C | crank (GDNAV...H4Q2) | [`d1b394b0e5d1...`](https://stellar.expert/explorer/testnet/tx/d1b394b0e5d1dcbc0cad8aee8ba5eb7efd750ad54882a23af098b443454b948b) |
| distribute, period 2 | servicer (GDKAU...YIO4) | [`b7010f2393cb...`](https://stellar.expert/explorer/testnet/tx/b7010f2393cb57451ed7ccdf3c1ba803204df0a58a6d1bd1c20b240e427e32f7) |
| push_batch, period 2, Class A | crank (GDNAV...H4Q2) | [`783e48b6b1aa...`](https://stellar.expert/explorer/testnet/tx/783e48b6b1aae62dde20410081a4085e2ffafc5ecbb1d216c15ba838f33ff632) |
| push_batch, period 2, Class B | crank (GDNAV...H4Q2) | [`d3d8c0bf4879...`](https://stellar.expert/explorer/testnet/tx/d3d8c0bf4879afcfb31a78f0c3924c65dd43a958c7143b1cc4bc47bbffb41678) |
| push_batch, period 2, Class C | crank (GDNAV...H4Q2) | [`e32fcdc379b5...`](https://stellar.expert/explorer/testnet/tx/e32fcdc379b53e048146544230418075b6fae1aefa1afc7b1a65b492f475bba1) |
| distribute, period 3 | servicer (GDKAU...YIO4) | [`98abe04941f6...`](https://stellar.expert/explorer/testnet/tx/98abe04941f62fb4cde9d6e1f063e8e70e44035f47ce970a4661bcd98eec6e7c) |
| push_batch, period 3, Class A | crank (GDNAV...H4Q2) | [`ab96c9b301d0...`](https://stellar.expert/explorer/testnet/tx/ab96c9b301d04812019eaea84df8eedb3b7ec128cfdccc6ea4278818ee8ad185) |
| push_batch, period 3, Class B | crank (GDNAV...H4Q2) | [`06170a854574...`](https://stellar.expert/explorer/testnet/tx/06170a8545746614c986ce130162ae08a5a64046f80ee7cf03665d6e77e8607f) |
| push_batch, period 3, Class C | crank (GDNAV...H4Q2) | [`2c562a331d62...`](https://stellar.expert/explorer/testnet/tx/2c562a331d62cf796f60c235e4f88ff67321bc61c01216e67977f5cba53ae82b) |
| distribute, period 4 (maturity) | servicer (GDKAU...YIO4) | [`580b69bb648d...`](https://stellar.expert/explorer/testnet/tx/580b69bb648d58210839c6b35d04b8d06ef89e23e6e2dd5aa36d3f18ce842884) |
| push_batch, period 4, Class A | crank (GDNAV...H4Q2) | [`3952331bb52e...`](https://stellar.expert/explorer/testnet/tx/3952331bb52e071b023996181cce21adcb37991422ec3584d823823b65a9bc56) |
| push_batch, period 4, Class B | crank (GDNAV...H4Q2) | [`f18e9c58a436...`](https://stellar.expert/explorer/testnet/tx/f18e9c58a43653ec4bf1b07372986b21ec8993a74051f0b045cdd9c9e61ce3d9) |
| push_batch, period 4, Class C | crank (GDNAV...H4Q2) | [`0c42b1a0ab77...`](https://stellar.expert/explorer/testnet/tx/0c42b1a0ab77754deea4ad73cc926b8932314540e762274f003fe099a94e698a) |

#### Period 1: normal order

Transaction [`5846de605e05...`](https://stellar.expert/explorer/testnet/tx/5846de605e051691611313c7041ee971a60bb995934ab7c71d58bc87633c906a).

| Rank | Item | Due | Paid | Dust to the carry |
|---|---|---|---|---|
| `fees` | Fee line 0 | 1 | 1 | 0 |
| `fees` | Fee line 1 | 0.8333333 | 0.8333333 | 0 |
| `int_a` | Interest, Class A | 1.592 | 1.56 | 0.032 |
| `int_b` | Interest, Class B | 0.5 | 0.48 | 0.02 |
| `int_c` | Interest, Class C | 0.4166666 | 0.41 | 0.0066666 |
| `prin_pr` | Principal, Class A | 600 | 180.36 | 0.0348001 |
| `prin_pr` | Principal, Class B | 300 | 90.18 | 0.0174 |
| `prin_pr` | Principal, Class C | 100 | 30.06 | 0.0058 |

| Collections | Reserve in | Carry in | Drawn | Paid out | Reserve | Carry | Owed | Balance | Surplus |
|---|---|---|---|---|---|---|---|---|---|
| 305 | 50 | 0 | 0 | 304.8833333 | 50 | 0.1166667 | 0 | 50.1166667 | 0 |

Conservation: 305 + 50 + 0 = 304.8833333 + 50 + 0.1166667. Balance invariant: 50.1166667 >= 50.1166667.

#### Period 2: normal order

Transaction [`b7010f2393cb...`](https://stellar.expert/explorer/testnet/tx/b7010f2393cb57451ed7ccdf3c1ba803204df0a58a6d1bd1c20b240e427e32f7).

| Rank | Item | Due | Paid | Dust to the carry |
|---|---|---|---|---|
| `fees` | Fee line 0 | 1 | 1 | 0 |
| `fees` | Fee line 1 | 0.5828333 | 0.5828333 | 0 |
| `int_a` | Interest, Class A | 1.1134448 | 1.08 | 0.0334448 |
| `int_b` | Interest, Class B | 0.3497 | 0.33 | 0.0197 |
| `int_c` | Interest, Class C | 0.2914166 | 0.29 | 0.0014166 |
| `prin_pr` | Principal, Class A | 419.64 | 190.08 | 0.0055632 |
| `prin_pr` | Principal, Class B | 209.82 | 95.04 | 0.0027816 |
| `prin_pr` | Principal, Class C | 69.94 | 31.68 | 0.0009272 |

| Collections | Reserve in | Carry in | Drawn | Paid out | Reserve | Carry | Owed | Balance | Surplus |
|---|---|---|---|---|---|---|---|---|---|
| 305 | 50 | 0.1166667 | 0 | 320.0828333 | 34.97 | 0.0638334 | 0 | 35.0338334 | 0 |

Conservation: 305 + 50 + 0.1166667 = 320.0828333 + 34.97 + 0.0638334. Balance invariant: 35.0338334 >= 35.0338334.

#### Period 3: normal order

Transaction [`98abe04941f6...`](https://stellar.expert/explorer/testnet/tx/98abe04941f62fb4cde9d6e1f063e8e70e44035f47ce970a4661bcd98eec6e7c).

| Rank | Item | Due | Paid | Dust to the carry |
|---|---|---|---|---|
| `fees` | Fee line 0 | 1 | 1 | 0 |
| `fees` | Fee line 1 | 0.3188333 | 0.3188333 | 0 |
| `int_a` | Interest, Class A | 0.6090992 | 0.6 | 0.0090992 |
| `int_b` | Interest, Class B | 0.1913 | 0.18 | 0.0113 |
| `int_c` | Interest, Class C | 0.1594166 | 0.15 | 0.0094166 |
| `prin_seq` | Principal, Class A | 229.56 | 117.72 | 0.0351843 |
| `prin_seq` | Principal, Class B | 114.78 | 0 | 0 |
| `prin_seq` | Principal, Class C | 38.26 | 0 | 0 |

Triggers set in this period: `seq`.

| Collections | Reserve in | Carry in | Drawn | Paid out | Reserve | Carry | Owed | Balance | Surplus |
|---|---|---|---|---|---|---|---|---|---|
| 105 | 34.97 | 0.0638334 | 0 | 119.9688333 | 20 | 0.0650001 | 0 | 20.0650001 | 0 |

Conservation: 105 + 34.97 + 0.0638334 = 119.9688333 + 20 + 0.0650001. Balance invariant: 20.0650001 >= 20.0650001.

#### Period 4: normal order

Transaction [`580b69bb648d...`](https://stellar.expert/explorer/testnet/tx/580b69bb648d58210839c6b35d04b8d06ef89e23e6e2dd5aa36d3f18ce842884).

| Rank | Item | Due | Paid | Dust to the carry |
|---|---|---|---|---|
| `fees` | Fee line 0 | 1 | 1 | 0 |
| `fees` | Fee line 1 | 0.2207333 | 0.2207333 | 0 |
| `int_a` | Interest, Class A | 0.2967488 | 0.24 | 0.0567488 |
| `int_b` | Interest, Class B | 0.1913 | 0.18 | 0.0113 |
| `int_c` | Interest, Class C | 0.1594166 | 0.15 | 0.0094166 |
| `prin_seq` | Principal, Class A | 111.84 | 111.84 | 0 |
| `prin_seq` | Principal, Class B | 114.78 | 114.78 | 0 |
| `prin_seq` | Principal, Class C | 38.26 | 38.26 | 0 |

| Collections | Reserve in | Carry in | Drawn | Paid out | Reserve | Carry | Owed | Balance | Surplus |
|---|---|---|---|---|---|---|---|---|---|
| 266.6831986 | 20 | 0.0650001 | 0 | 286.7481987 | 0 | 0 | 0 | 0 | 0 |

Conservation: 266.6831986 + 20 + 0.0650001 = 286.7481987 + 0 + 0. Balance invariant: 0 >= 0.

#### Holders: cumulative counters of the paying agent

| Class | Holder | Notes | Interest received | Principal received | Waits in the paying agent |
|---|---|---|---|---|---|
| A | `GCWQGIECM7NNQ7NV6OQVTCSDVUSCGM3TQB5NWOQV3O5QA6BT2MZFUA7L` | 6 | 3.48 | 600 | 0 |
| B | `GC57KOHW37LN3YFIPXW7A462DZZBOM4KFRLYKBHHQWLE4AVCZYCNTYXE` | 3 | 1.17 | 300 | 0 |
| C | `GCXLOCBQPAS54C3MSBMA223COJE7HRAGJ3KJEN376FNDUL7LQ5JKIQXM` | 1 | 1 | 100 | 0 |

#### Checks

| Check | Result | Detail |
|---|---|---|
| B1 Same contract code as the other deals | PASS | abs-deal 5a5fedeaff280170ea28fb618a2587d992012e2fab4cab02504b7e50eaaead7a, the same as CAYGDU72HJ6LBDOEEIFH2J3DTPCXECQ5WVTTCFZV6JVH76D2HXOEZRUF. |
| R1 The admin, the servicer and the reporter are separate addresses | PASS | Three different addresses. |
| L1 Closing: delivery versus payment | PASS | In one transaction: 1000 to the seller, 50 to the reserve, every note issued. |
| C1 One settlement event for each payment date | PASS | 4 payment date(s), each with its period_settled and rank_lines events. |
| C2 The rank lines follow the configured order | PASS | Each line is a rank of the configuration, in its order. |
| C3 Each line pays at most its due | PASS | For each line: 0 <= paid, and paid + dust <= due. |
| C4 Conservation: collections + reserve + carry in = paid out + reserve + carry | PASS | In each period_settled event, and against the payments of the same transaction. |
| C5 Balance invariant: balance >= reserve + carry + amounts owed | PASS | In each period_settled event. Now: balance 0, reserve 0, carry 0, owed 0. |
| C6 Each period opens with the ledgers of the period before | PASS | Reserve and carry chain from the closing to the ledgers of the deal now. |
| C7 The interest, principal and paying agent events agree with the rank lines | PASS | For each class: interest_paid and period_funded carry the amounts of the lines. |
| C8 A replay with the copy of the engine gives the same lines | PASS | 4 payment date(s): the copy of the engine gives the same lines and the same settlement. |
| H1 Each holder: cumulative counters = holder_paid + claimed events | PASS | 3 holder position(s): interest and principal counters equal the events. |
| H2 Each failed push is claimed or waits for its holder | PASS | Failed pushes 0 = claimed 0 + open 0. |
| H3 Every holder of every class was served at each payment date | PASS | 12 class payment(s): each one has a complete batch_done event. |
| H4 The paying agent holds only the open claims and the rounding remainder | PASS | Balance 0 = open claims 0 + remainder 0. |
| L2 A matured deal has empty ledgers | PASS | Every class is repaid, no interest is unpaid, reserve and carry are 0, and the balance is the amounts owed. |

