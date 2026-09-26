# Perpl Exchange ABIs

## Provenance

`Exchange.json` and `ExchangeErrors.json` are **not** from the block explorer.
Monad testnet's explorer (monadscan) serves its ABI endpoint only through the
Etherscan API V2 (`chainid=10143`), which rejects every keyless request with
`Missing/Invalid API Key`, and the web UI sits behind Cloudflare. Sourcify has
no entry for this address on 10143.

They come from the official Rust SDK crate instead:

| | |
| - | - |
| Source | `perpl-sdk` 0.2.9 on crates.io, `abi/dex/Exchange.json` + `abi/dex/Errors.abi.json` |
| Artifact revision | `rc_v1.1.7-203-g0e5902dd` (the crate's `abi/dex/REVISION`) |
| Fetched | 2026-09-26 |

## On-chain cross-check (Monad testnet, chain 10143)

`0x1964C32f0bE608E7D29302AFF5E61268E72080cc` is an **ERC-1967 proxy** (225 bytes
of runtime). The logic lives at the implementation in the standard 1967 slot:

| | |
| - | - |
| Proxy | `0x1964C32f0bE608E7D29302AFF5E61268E72080cc` |
| Implementation | `0xbcbd3701ed0bde8acbb727f0d92a8b85a169adbb` |
| `getContractVersion()` | 1.7.5 |

Every one of the artifact's 166 function selectors appears as a `PUSH4` in the
deployed implementation runtime **except `getPerpetualInfo(uint256)`
(`0x00092cce`)**, which the deployed build dropped in favour of
`getPerpetualInfoV2(uint256)`. The deployed runtime is also slightly longer than
the artifact's `deployedBytecode`, so treat this ABI as *near*-current: correct
for everything we call today, but re-check before relying on a function that is
not exercised by a test.

Do not add market ids, tick sizes or scaling here — those come from
`GET /v1/pub/context` at startup.
