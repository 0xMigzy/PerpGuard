# RainbowKit swap: plan (raw notes, 2026-10-05)

Status: BUILT 6 Oct 2026 (bot rebuild, Phase 4). Dynamic is gone; the notes
below are the plan as written on 5 Oct, kept for the record.

## Blast radius: every Dynamic reference (grep, 5 Oct)

Web (apps/web):
- package.json: @dynamic-labs/sdk-react-core 5.9.2, @dynamic-labs/ethereum 5.9.2
- src/app/link/layout.tsx: DynamicContextProvider + EthereumWalletConnectors,
  Monad declared via mergeNetworks/overrides.evmNetworks
- src/app/link/WalletProofCard.tsx: DynamicWidget, getAuthToken,
  useDynamicContext, useIsLoggedIn
- src/app/link/dynamicEnv.ts: DYNAMIC_ENVIRONMENT_ID from
  NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID (own module: a layout may not export it)
- src/app/link/LinkView.tsx: gates the wallet card on DYNAMIC_ENVIRONMENT_ID
  and me.dynamicConfigured
- src/lib/api.ts: LinkMe.dynamicConfigured; link.wallet(dynamicToken)
- scripts/build-web.sh: lifts NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID from ../../.env

Backend (apps/backend):
- src/server/protect/dynamic.ts (+ dynamic.test.ts): DynamicVerifier, RS256
  JWT against Dynamic's JWKS (app.dynamicauth.com/api/v0/sdk/<env>/.well-known/jwks),
  checks env id, issuer, exp/iat skew, scope user:basic, sub
- src/server.ts: reads DYNAMIC_ENVIRONMENT_ID, builds the verifier, passes it
  to the link routes and the protect routes
- src/server/link/routes.ts (+ routes.test.ts): POST /api/link/wallet takes
  {dynamicToken}; /me reports dynamicConfigured; 503 when not configured
- src/server/link/service.ts: comments only (proveWallet is Dynamic-free)
- src/server/protect/routes.ts, session.ts, types.ts (+ routes.test.ts):
  /api/protect/session has a dynamicToken branch (owner / demo session);
  SessionMethod = 'dynamic' | 'code' | 'demo'; config dynamicConfigured.
  No page calls /api/protect/* any more.

Config/docs: .env.example (DYNAMIC_ENVIRONMENT_ID,
NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID), CLAUDE.md (linking section, build note).
Memory notes: dynamic-login-live-verified, dynamic-dropped-for-rainbowkit.

False positives a "no Dynamic left" grep will hit, all fine:
apps/indexer/abis/Exchange.json (dynamicInitMarginFracHdths),
packages/shared/src/venues/perpl-insurance.ts ("dynamic strings"),
.claude/skills/indexer-* (the word "dynamic").

Env vars to delete afterwards (nano /root/PerpGuard/.env — the ONLY file;
apps/indexer/.env is a symlink to it): DYNAMIC_ENVIRONMENT_ID,
NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID. Never set on Vercel.

## Why the payload must change

Dynamic hands the browser a JWT that Dynamic signed; the backend verifies it
against Dynamic's keys. RainbowKit/wagmi have no token: the browser can only
sign a message with the wallet, and the backend must verify that signature
itself. "Same endpoints, same payloads" is impossible; this is the minimum.

## Challenge / signature design

1. NEW POST /api/link/challenge
   - Requires the existing link-session cookie (30-min session for one
     Telegram identity, minted from a one-time /link code). No cookie → 401.
   - Returns an EIP-4361 (SIWE) message built with viem/siwe createSiweMessage:
     domain = host of PUBLIC_WEB_URL (perpguard.app), uri = PUBLIC_WEB_URL/link,
     chainId = 10143 (linking is for the testnet trading account),
     nonce = 16+ random bytes, issuedAt now, expirationTime now + 5 min,
     statement "Link this wallet's Perpl account to Telegram @<name>".
   - Nonce stored ON THE LINK SESSION (one outstanding at a time; a new
     challenge replaces the old one).
2. POST /api/link/wallet, body {message, signature} (was {dynamicToken})
   - parseSiweMessage; check domain == expected host, uri, chainId,
     nonce == session's outstanding nonce, not expired.
   - verify with viem publicClient(testnet).verifyMessage({address, message,
     signature}) — covers EOAs and smart wallets (ERC-1271/6492).
   - CONSUME the nonce before acting (success or failure) so nothing replays.
   - Then the UNCHANGED service.proveWallet(session.identity, [address]):
     Exchange contract maps wallet → account; env-account owner links at once;
     any other account → proven-needs-key; key for a different account than
     the wallet proved is refused.
3. /me: dynamicConfigured → walletSignIn (true when the project id is set;
   the backend side needs no third-party config at all now).
4. /api/protect/session: delete the dynamicToken branch; bot-code and demo
   sign-in stay. Drop 'dynamic' from SessionMethod.
5. Unchanged: the key path (/api/link/key), cookie session bound to the
   Telegram identity on every request, sealed keys, rotation = re-link.

## Front end

- RainbowKit ConnectButton in place of DynamicWidget, provider wrapping /link
  only (app/link/layout.tsx); root layout stays provider-free.
- Flow: connect → POST /challenge → wagmi useSignMessage(message) →
  POST /wallet {message, signature} → same outcome screens as today.
- Chains: viem ships both — monad (143, rpc.monad.xyz, rpc1.monad.xyz) and
  monadTestnet (10143, testnet-rpc.monad.xyz). No defineChain needed. Order
  [monadTestnet, monad]. personal_sign needs no chain switch.
- RPC: browser gets ONLY the public RPCs above. QuickNode URL (token in the
  URL) stays in the backend .env; never in NEXT_PUBLIC_* or any committed file.
  The pre-commit hook (deploy/git-hooks) would refuse it anyway.
- Theme: custom darkTheme override from the site tokens — accent = site
  purple, accentColorForeground white, radii 8px (modal/actionButton/
  connectButton/menuButton), modalBackground = card, modalBorder = border,
  generalBorder = border2, overlay dark, fontStack = Inter. Not a default
  drop-in.

## Versions (npm, 5 Oct 2026)

- @rainbow-me/rainbowkit 2.2.11 (peer: wagmi ^2.9.0, viem 2.x, react >=18,
  @tanstack/react-query >=5)
- wagmi 2.19.5 — NOT 3.7.7 (latest): RainbowKit 2.2.11 only supports wagmi 2.x
- viem 2.x matched to the workspace (repo resolves 2.54.0 / 2.56.x; latest 2.57.3)
- @tanstack/react-query 5.104.1

## WalletConnect project id

- Get it at dashboard.reown.com (Reown, formerly WalletConnect Cloud). ADD
  perpguard.app TO THE PROJECT'S ALLOWED DOMAINS — same silent-failure shape
  as Dynamic's origin list.
- Env var: NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID (public by design, inlined in
  the bundle) in .env and on Vercel; lift it in build-web.sh like the Dynamic
  id was.
- Without it: build connectors with connectorsForWallets and injected wallets
  only (MetaMask/Rabby/Coinbase extension work; WalletConnect QR / mobile
  hidden). getDefaultConfig would throw without a projectId — don't use it
  unguarded.

## Attack-case tests (routes.test.ts) — must all be refused

(These five were not enumerated in the chat plan; defined here.)
1. REPLAY: a valid {message, signature} posted twice → second is 401 (nonce
   consumed on first use).
2. CROSS-SESSION NONCE: a challenge minted for Telegram user A, signed and
   posted with user B's link cookie → 401 (nonce bound to the session that
   asked for it), and nothing linked for either.
3. EXPIRED: message past expirationTime (fake clock) → 401, even with a valid
   signature and the right nonce.
4. WRONG DOMAIN / PHISHING REUSE: a correctly signed SIWE message whose domain
   or uri is another site (or whose chainId is not 10143) → 401.
5. FORGED SIGNER: message claims address X but the signature recovers to Y
   (or is malformed) → 401; and the address passed to proveWallet is always
   the verified one, never a body field.
Plus the existing pins stay: no secret/key echoed in any reply or log;
unlinked chats still refused server-side in the bot gate.

## Checks when it is built

- Clean build (build-web.sh), not cached.
- End to end: headless with an injected EIP-1193 wallet from a throwaway key
  (connect → challenge → sign → verify → "wallet owns no Perpl account").
  The final "linked" step needs a wallet that OWNS a testnet Perpl account
  (owner of account 710) — owner does that from a real bot /link.
- Disconnect and reconnect; desktop and phone.
- grep: no @dynamic-labs, DynamicVerifier, dynamicToken, DYNAMIC_ENVIRONMENT_ID
  (only the false positives above remain).
- grep: QuickNode token in no committed file (hook + manual).
- Update CLAUDE.md linking section; retire the two Dynamic memory notes.
